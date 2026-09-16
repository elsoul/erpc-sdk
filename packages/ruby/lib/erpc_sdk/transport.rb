# frozen_string_literal: true

require "json"
require "net/http"
require "openssl"
require "socket"
require "thread"
require "uri"

module ERPC
  HttpResponse = Struct.new(:status, :body, keyword_init: true)

  class NetHttpAdapter
    def request(method:, url:, headers:, body: nil, timeout: DEFAULT_TIMEOUT)
      uri = URI.parse(url)
      request = request_class(method).new(uri.request_uri, headers)
      request.body = body unless body.nil?
      response = start(uri, timeout) { |http| http.request(request) }
      HttpResponse.new(status: response.code.to_i, body: response.body.to_s)
    rescue Net::OpenTimeout, Net::ReadTimeout, Net::WriteTimeout
      raise TimeoutError, timeout, cause: nil
    rescue IOError, EOFError, SocketError, SystemCallError, OpenSSL::SSL::SSLError
      raise TransportError, "Unable to reach ERPC", cause: nil
    end

    def stream(url:, headers:, timeout: DEFAULT_TIMEOUT)
      Enumerator.new do |yielder|
        uri = URI.parse(url)
        request = Net::HTTP::Get.new(uri.request_uri, headers)
        start(uri, timeout) do |http|
          http.request(request) do |response|
            status = response.code.to_i
            raise HttpError, status unless status.between?(200, 299)

            response.read_body { |chunk| yielder << chunk }
          end
        end
      rescue Net::OpenTimeout, Net::ReadTimeout, Net::WriteTimeout
        raise TimeoutError, timeout, cause: nil
      rescue HttpError
        raise
      rescue IOError, EOFError, SocketError, SystemCallError, OpenSSL::SSL::SSLError
        raise TransportError, "Unable to reach ERPC", cause: nil
      end
    end

    private

    def start(uri, timeout, &block)
      Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", open_timeout: timeout,
                      read_timeout: timeout, write_timeout: timeout, &block)
    end

    def request_class(method)
      { get: Net::HTTP::Get, post: Net::HTTP::Post }.fetch(method.to_sym)
    end
  end

  class HttpJsonRpcTransport
    attr_reader :max_batch_size

    def initialize(api_key: nil, endpoint:, headers: {}, timeout:, adapter:, max_batch_size: 256,
                   direct: false, redactions: [], unavailable_namespace: nil)
      @api_key = api_key
      @endpoint = endpoint
      @public_endpoint = URLs.public_endpoint(endpoint)
      @headers = headers.to_h.dup.freeze
      @timeout = timeout
      @adapter = adapter
      @max_batch_size = max_batch_size
      @direct = direct
      @redactions = redactions
      @unavailable_namespace = unavailable_namespace
      @next_id = 0
      @id_mutex = Mutex.new
    end

    def endpoint
      @public_endpoint
    end

    def inspect
      "#<#{self.class} endpoint=#{endpoint.inspect} max_batch_size=#{max_batch_size.inspect}>"
    end

    def request(method, params = nil)
      ensure_configured
      request_id = next_id
      body = { "jsonrpc" => "2.0", "id" => request_id, "method" => method }
      body["params"] = params unless params.nil?
      unwrap(post(body), request_id)
    end

    def batch(calls)
      return [] if calls.empty?
      if calls.length > max_batch_size
        raise InvalidResponseError, "A batch may contain at most #{max_batch_size} calls"
      end
      ensure_configured

      requests = calls.map do |call|
        method = call.fetch(:method) { call.fetch("method") }
        item = { "jsonrpc" => "2.0", "id" => next_id, "method" => method }
        if call.key?(:params) || call.key?("params")
          item["params"] = call.key?(:params) ? call[:params] : call["params"]
        end
        item
      rescue KeyError
        raise ConfigError, "batch calls require a method"
      end

      response = post(requests)
      unless response.is_a?(Array)
        raise_rpc(response["error"]) if response.is_a?(Hash) && response["error"].is_a?(Hash)
        raise InvalidResponseError, "ERPC returned a non-array batch response"
      end

      by_id = {}
      response.each do |item|
        unless item.is_a?(Hash) && valid_id?(item["id"])
          raise InvalidResponseError, "ERPC returned an invalid batch item"
        end
        raise InvalidResponseError, "ERPC returned a duplicate batch id" if by_id.key?(item["id"])

        by_id[item["id"]] = item
      end

      results = requests.map do |request|
        item = by_id.delete(request["id"])
        raise InvalidResponseError, "ERPC omitted a batch response" unless item

        unwrap(item, request["id"])
      end
      raise InvalidResponseError, "ERPC returned an unexpected batch response id" unless by_id.empty?

      results
    end

    private

    def ensure_configured
      return if @unavailable_namespace.nil?

      raise NotConfiguredError, @unavailable_namespace
    end

    def next_id
      @id_mutex.synchronize { @next_id += 1 }
    end

    def post(body)
      ensure_configured
      uri = URI.parse(@endpoint)
      unless @direct
        query = URI.decode_www_form(uri.query.to_s)
        query << ["api-key", @api_key]
        uri.query = URI.encode_www_form(query)
      end
      response = @adapter.request(
        method: :post,
        url: uri.to_s,
        headers: protocol_headers,
        body: JSON.generate(body),
        timeout: @timeout
      )
      raise HttpError, response.status unless response.status.between?(200, 299)

      JSON.parse(response.body)
    rescue JSON::ParserError
      raise InvalidResponseError, "ERPC returned malformed JSON", cause: nil
    end

    def unwrap(response, expected_id)
      unless response.is_a?(Hash) && response["id"] == expected_id
        raise InvalidResponseError, "ERPC returned an unexpected response id"
      end
      raise_rpc(response["error"]) if response.key?("error")
      raise InvalidResponseError, "ERPC returned an invalid response" unless response.key?("result")

      response["result"]
    end

    def raise_rpc(error)
      unless error.is_a?(Hash) && error["code"].is_a?(Integer) && error["message"].is_a?(String)
        raise InvalidResponseError, "ERPC returned an invalid RPC error"
      end

      credentials = @direct ? @redactions : @api_key
      data = error.key?("data") ? Redaction.value(error["data"], credentials) : nil
      raise JsonRpcError.new(error["code"], Redaction.text(error["message"], credentials), data)
    end

    def protocol_headers
      headers = @headers.dup
      if @direct
        headers.delete_if { |name, _| %w[accept content-type].include?(name.to_s.downcase) }
      end
      headers.merge("accept" => "application/json", "content-type" => "application/json")
    end

    def valid_id?(value)
      value.is_a?(Integer) || value.is_a?(String)
    end
  end

  class RestTransport
    def initialize(credential: nil, endpoint:, headers: {}, timeout:, adapter:, unavailable_namespace: nil)
      @credential = credential
      @endpoint = endpoint
      @public_endpoint = URLs.public_endpoint(endpoint)
      @headers = headers.to_h.dup.freeze
      @timeout = timeout
      @adapter = adapter
      @unavailable_namespace = unavailable_namespace
    end

    def endpoint
      @public_endpoint
    end

    def inspect
      "#<#{self.class} endpoint=#{endpoint.inspect}>"
    end

    def get(path, query = nil)
      ensure_configured
      response = @adapter.request(
        method: :get,
        url: url(path, query),
        headers: @headers.merge("authorization" => "Bearer #{@credential}", "accept" => "application/json"),
        timeout: @timeout
      )
      raise HttpError, response.status unless response.status.between?(200, 299)

      JSON.parse(response.body)
    rescue JSON::ParserError
      raise InvalidResponseError, "ERPC returned malformed JSON", cause: nil
    end

    def stream(path, query = nil)
      ensure_configured
      @adapter.stream(
        url: url(path, query),
        headers: @headers.merge("authorization" => "Bearer #{@credential}", "accept" => "text/event-stream"),
        timeout: @timeout
      )
    end

    private

    def ensure_configured
      return if @unavailable_namespace.nil?

      raise NotConfiguredError, @unavailable_namespace
    end

    def url(path, query)
      uri = URI.parse(URLs.with_path(endpoint, path))
      pairs = []
      (query || {}).each do |key, value|
        next if value.nil?

        if value.is_a?(Array)
          value.each { |item| pairs << [key.to_s, item.to_s] }
        else
          rendered = value == true ? "true" : value == false ? "false" : value.to_s
          pairs << [key.to_s, rendered]
        end
      end
      uri.query = URI.encode_www_form(pairs) unless pairs.empty?
      uri.to_s
    end
  end
end
