# frozen_string_literal: true

require "json"
require "net/http"
require "timeout"
require "uri"

require_relative "bitcoin_codec"
require_relative "config"
require_relative "errors"
require_relative "transport"

module ERPC
  BitcoinTransportFacts = Struct.new(
    :hosted_target,
    :method_names,
    :public_methods,
    keyword_init: true
  ) do
    def initialize(hosted_target:, method_names:, public_methods:)
      super(
        hosted_target: hosted_target.to_s.freeze,
        method_names: method_names.map { |name| name.to_s.dup.freeze }.freeze,
        public_methods: public_methods.to_h.each_with_object({}) do |(name, wire), result|
          result[name.to_s.dup.freeze] = wire.to_s.dup.freeze
        end.freeze
      )
      freeze
    end

    def wire_method(public_name)
      public_methods.fetch(public_name.to_s) do
        raise ConfigError, "Bitcoin public method is absent from the accepted contract", cause: nil
      end
    rescue KeyError
      raise ConfigError, "Bitcoin public method is absent from the accepted contract", cause: nil
    end
  end

  module BitcoinTransportContract
    module_function

    def facts_from_contract(contract)
      clients = contract.fetch("clientContracts")
      method_sets = contract.fetch("methodSets")
      client = clients.find { |value| value.is_a?(Hash) && value["clientContractId"] == "client-bitcoin-rpc" }
      raise ConfigError, "Bitcoin contract facts are unavailable", cause: nil unless client

      method_set_id = client.fetch("methodSetId")
      hosted = client.fetch("endpointModes").find { |value| value.is_a?(Hash) && value["mode"] == "hosted" }
      method_set = method_sets.find { |value| value.is_a?(Hash) && value["methodSetId"] == method_set_id }
      capabilities = method_set&.fetch("capabilities")
      target = hosted&.fetch("defaultTarget")
      unless target.is_a?(String) && capabilities.is_a?(Array) && !capabilities.empty?
        raise ConfigError, "Bitcoin contract facts are unavailable", cause: nil
      end

      public_methods = {}
      method_names = []
      capabilities.each do |capability|
        wire = capability.fetch("wireOperation")
        names = capability.fetch("publicNames")
        public_name = names.fetch("ruby")
        unless wire.is_a?(String) && public_name.is_a?(String) && !wire.empty? && !public_name.empty?
          raise ConfigError, "Bitcoin contract facts are unavailable", cause: nil
        end

        method_names << wire
        public_methods[public_name] = wire
      end
      BitcoinTransportFacts.new(
        hosted_target: target,
        method_names: method_names,
        public_methods: public_methods
      )
    rescue KeyError, NoMethodError, TypeError
      raise ConfigError, "Bitcoin contract facts are unavailable", cause: nil
    end
  end

  class BitcoinHttpTransport
    attr_reader :method_names

    def initialize(facts:, api_key: nil, endpoint: nil, direct_endpoint: nil, headers: {}, timeout: DEFAULT_TIMEOUT,
                   adapter: NetHttpAdapter.new, namespace: "bitcoin.rpc")
      unless facts.is_a?(BitcoinTransportFacts)
        raise ConfigError, "Bitcoin transport facts are unavailable", cause: nil
      end
      raise ConfigError, "timeout must be positive", cause: nil unless timeout.is_a?(Numeric) && timeout.finite? && timeout.positive?

      @facts = facts
      @method_names = facts.method_names
      @api_key = api_key.is_a?(String) && !api_key.strip.empty? ? api_key.strip : nil
      @timeout = timeout.to_f
      @adapter = adapter
      @namespace = namespace.to_s.freeze
      @id_mutex = Mutex.new
      @next_id = 0
      @direct = !direct_endpoint.nil?

      if direct_endpoint
        unless direct_endpoint.is_a?(RpcEndpointConfig)
          raise ConfigError, "bitcoin_rpc must use RpcEndpointConfig", cause: nil
        end
        if direct_endpoint.websocket_url
          raise ConfigError, "bitcoin_rpc does not support WebSocket URLs", cause: nil
        end

        @target = validate_http_url(direct_endpoint.http_url)
        @headers = direct_endpoint.headers.dup
        @redactions = Redaction.send(:direct_variants_with_path,
          http_url: direct_endpoint.http_url,
          websocket_url: direct_endpoint.websocket_url,
          headers: direct_endpoint.headers
        )
        @available = true
      elsif @api_key
        root = endpoint || default_hosted_target
        @target = hosted_target(root)
        @headers = headers.to_h.dup
        @headers.delete_if { |name, _| name.to_s.casecmp?("authorization") }
        @headers["authorization"] = "Bearer #{@api_key}"
        @redactions = [@api_key]
        @available = true
      else
        @target = nil
        @headers = {}
        @redactions = []
        @available = false
      end
    end

    def endpoint
      return "" unless @available

      uri = URI.parse(@target)
      uri.path = "/"
      uri.query = nil
      uri.fragment = nil
      uri.user = nil if uri.respond_to?(:user=)
      uri.to_s
    rescue URI::InvalidURIError, ArgumentError
      ""
    end

    def inspect
      "#<#{self.class} endpoint=#{endpoint.inspect} header_names=#{safe_header_names.inspect}>"
    end

    def wire_method(public_name)
      @facts.wire_method(public_name)
    end

    def request(method, params = nil, projector: nil)
      unless @method_names.include?(method.to_s)
        raise ConfigError, "Bitcoin method is not in the accepted named-read contract", cause: nil
      end
      raise NotConfiguredError, @namespace unless @available
      unless @adapter.respond_to?(:request_stream)
        raise ConfigError, "Bitcoin transport requires a streaming HTTP adapter", cause: nil
      end

      request_id = next_id
      body = {
        "jsonrpc" => "2.0",
        "id" => request_id,
        "method" => method.to_s,
        "params" => params.nil? ? [] : params
      }
      raw_body = JSON.generate(body)
      text = stream_body(raw_body)
      BitcoinCodec.decode(
        text,
        request_id,
        redactions: @redactions,
        projector: projector
      )
    rescue InvalidResponseError, JsonRpcError, HttpError, NotConfiguredError, ConfigError, TimeoutError, TransportError
      raise
    rescue JSON::GeneratorError, TypeError, ArgumentError
      raise InvalidResponseError.new("ERPC returned an invalid Bitcoin response"), cause: nil
    end

    private

    def default_hosted_target
      # The generated projection supplies the accepted target after its
      # visibility gate.  Until then, callers pass the immutable facts' target
      # explicitly through the private constructor path.
      @facts.hosted_target
    end

    def validate_http_url(value)
      input = value.to_s
      uri = URI.parse(input)
      valid = uri.absolute? && uri.host && %w[http https].include?(uri.scheme) && !input.include?("#")
      valid &&= !input.match?(%r{://[^/?#]*@})
      raise ConfigError, "HTTP endpoint must be an absolute HTTP(S) URL", cause: nil unless valid

      input.freeze
    rescue URI::InvalidURIError, ArgumentError
      raise ConfigError, "HTTP endpoint must be an absolute HTTP(S) URL", cause: nil
    end

    def hosted_target(root)
      target = validate_http_url(root)
      uri = URI.parse(target)
      hosted_path = URI.parse(@facts.hosted_target).path.to_s.sub(%r{\A/+}, "").sub(%r{/+\z}, "")
      base_path = uri.path.to_s.sub(%r{/+\z}, "")
      unless hosted_path.empty? || base_path.split("/").last == hosted_path
        base_path = "#{base_path}/#{hosted_path}"
      end
      uri.path = base_path.empty? ? "/" : base_path
      pairs = URI.decode_www_form(uri.query.to_s).reject { |name, _| name.casecmp?("api-key") }
      uri.query = pairs.empty? ? nil : URI.encode_www_form(pairs)
      uri.fragment = nil
      uri.to_s
    rescue URI::InvalidURIError, ArgumentError
      raise ConfigError, "HTTP endpoint must be an absolute HTTP(S) URL", cause: nil
    end

    def request_headers
      values = @headers.dup
      values.delete_if { |name, _| %w[accept content-type].include?(name.to_s.downcase) }
      values["accept"] = "application/json"
      values["content-type"] = "application/json"
      values
    end

    def next_id
      @id_mutex.synchronize do
        @next_id += 1
        @next_id = 1 if @next_id > 2_147_483_647
        @next_id
      end
    end

    def stream_body(raw_body)
      deadline = monotonic_now + @timeout
      consumed = false
      text = nil
      close_resource = nil
      timeout_value = [remaining(deadline), 0.001].max

      Timeout.timeout(timeout_value) do
        result = @adapter.request_stream(
          method: :post,
          url: @target,
          headers: request_headers,
          body: raw_body,
          timeout: remaining(deadline)
        ) do |status, chunks, response_headers|
          consumed = true
          raise HttpError, status unless status.to_i.between?(200, 299)

          encoded = non_identity_content_encoding?(response_headers)
          text, close_resource = read_chunks(
            chunks, deadline,
            expected_bytes: encoded ? nil : response_length(response_headers)
          )
          text
        end

        unless consumed
          status, chunks, close_resource = unpack_stream_response(result)
          raise HttpError, status unless status.to_i.between?(200, 299)

          text = read_chunks(chunks, deadline).first
        end
      end
      text
    rescue ::Timeout::Error
      raise TimeoutError, @timeout, cause: nil
    rescue HttpError, InvalidResponseError
      raise
    rescue ConfigError, TimeoutError, TransportError
      raise
    rescue IOError, EOFError, SocketError, SystemCallError, Net::OpenTimeout, Net::ReadTimeout, Net::WriteTimeout
      raise TransportError, "Unable to reach ERPC", cause: nil
    ensure
      close_stream(close_resource)
    end

    def read_chunks(chunks, deadline, expected_bytes: nil)
      total = 0
      buffer = +"".b
      close_resource = chunks if chunks.respond_to?(:close)
      begin
        enumerable = if chunks.respond_to?(:each)
                       chunks
                     else
                       raise ConfigError, "streaming HTTP adapter returned no body", cause: nil
                     end
        enumerable.each do |chunk|
          raise TimeoutError, @timeout, cause: nil if remaining(deadline) <= 0
          bytes = chunk.to_s.b
          if total + bytes.bytesize > BITCOIN_RESPONSE_LIMITS.decoded_entity_bytes
            raise InvalidResponseError.new("ERPC returned an invalid Bitcoin response"), cause: nil
          end

          buffer << bytes
          total += bytes.bytesize
        end
        if expected_bytes && total != expected_bytes
          raise TransportError, "Unable to reach ERPC", cause: nil
        end
        buffer.force_encoding(Encoding::UTF_8)
        unless buffer.valid_encoding?
          raise InvalidResponseError.new("ERPC returned an invalid Bitcoin response"), cause: nil
        end
        [buffer, close_resource]
      ensure
        close_stream(close_resource)
      end
    end

    def unpack_stream_response(result)
      if result.is_a?(HttpStreamResponse)
        [result.status, result.body, result.close]
      elsif result.respond_to?(:status) && result.respond_to?(:body)
        [result.status, result.body, result.respond_to?(:close) ? result.close : nil]
      elsif result.is_a?(Array) && result.length >= 2
        [result[0], result[1], result[2]]
      else
        raise ConfigError, "streaming HTTP adapter returned no response", cause: nil
      end
    end

    def close_stream(resource)
      resource.close if resource.respond_to?(:close)
    rescue StandardError
      nil
    end

    def monotonic_now
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end

    def remaining(deadline)
      deadline - monotonic_now
    end

    def response_length(headers)
      value = Array(headers && (headers["content-length"] || headers["Content-Length"])).first
      return nil if value.nil?

      Integer(value.to_s, 10)
    rescue ArgumentError, TypeError
      nil
    end

    def non_identity_content_encoding?(headers)
      values = (headers.respond_to?(:to_h) ? headers.to_h : {}).each_with_object([]) do |(name, value), result|
        next unless name.to_s.casecmp?("content-encoding")

        result.concat(Array(value))
      end
      values.flat_map { |value| value.to_s.split(",") }
            .map { |value| value.strip.downcase }
            .any? { |coding| !coding.empty? && coding != "identity" }
    end

    def safe_header_names
      @headers.keys.map(&:to_s).sort
    end
  end

  private_constant :BitcoinTransportFacts, :BitcoinTransportContract, :BitcoinHttpTransport
end
