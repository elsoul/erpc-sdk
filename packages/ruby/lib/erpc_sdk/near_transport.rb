# frozen_string_literal: true

require "bigdecimal"
require "json"
require "timeout"
require "uri"

require_relative "config"
require_relative "errors"
require_relative "transport"

module ERPC
  NearTransportFacts = Struct.new(:hosted_target, :method_names, keyword_init: true) do
    def initialize(hosted_target:, method_names:)
      super(hosted_target: hosted_target.to_s.freeze, method_names: method_names.map { |name| name.to_s.dup.freeze }.freeze)
      freeze
    end
  end

  module NearContract
    module_function

    def facts_from_contract(contract)
      client = contract.fetch("clientContracts").find { |value| value["clientContractId"] == "client-near-rpc" }
      method_set_id = client.fetch("methodSetId")
      hosted = client.fetch("endpointModes").find { |value| value["mode"] == "hosted" }
      method_set = contract.fetch("methodSets").find { |value| value["methodSetId"] == method_set_id }
      NearTransportFacts.new(
        hosted_target: hosted.fetch("defaultTarget"),
        method_names: method_set.fetch("capabilities").map { |item| item.fetch("wireOperation") }
      )
    rescue KeyError, NoMethodError, TypeError
      raise ConfigError, "NEAR contract facts are unavailable", cause: nil
    end
  end

  module NearTokenScanner
    module_function

    NUMBER = /\A-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?\z/.freeze

    def known_integer_tokens!(text, method)
      tokens = scan(text)
      paths = case method
              when "status"
                [["result", "latest_protocol_version"], ["result", "protocol_version"], ["result", "sync_info", "latest_block_height"]]
              when "block"
                [["result", "header", "height"], ["result", "header", "timestamp"]]
              when "query"
                [["result", "storage_usage"], ["result", "block_height"], ["result", "storage_paid_at"], ["result", "bootstrap_nonce"]]
              else
                []
              end
      paths.each do |path|
        raw = tokens[path]
        next if raw.nil?
        unless raw.match?(/\A(?:0|[1-9][0-9]*)\z/) && raw.to_i <= 18_446_744_073_709_551_615
          raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil
        end
      end
      nil
    end

    def scan(text)
      scanner = Scanner.new(text)
      scanner.run
    rescue InvalidResponseError
      raise
    rescue StandardError
      raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil
    end

    class Scanner
      def initialize(text)
        @text = text; @index = 0; @tokens = {}
      end

      def run
        skip; value([]); skip
        raise_invalid! unless @index == @text.length
        @tokens
      end

      private

      def value(path)
        @tokens.delete_if { |candidate, _| candidate.length >= path.length && candidate.first(path.length) == path }
        skip; raise_invalid! if @index >= @text.length
        case @text[@index]
        when '"' then string
        when "{" then object(path)
        when "[" then array(path)
        when "-", /[0-9]/ then number(path)
        when "t" then literal("true")
        when "f" then literal("false")
        when "n" then literal("null")
        else raise_invalid!
        end
      end

      def object(path)
        @index += 1; skip
        if @text[@index] == "}"
          @index += 1; return
        end
        loop do
          raise_invalid! unless @text[@index] == '"'
          key_start = @index; string
          key = JSON.parse(@text[key_start...@index], create_additions: false)
          skip; raise_invalid! unless @text[@index] == ":"; @index += 1
          value(path + [key]); skip
          if @text[@index] == ","
            @index += 1; skip
          elsif @text[@index] == "}"
            @index += 1; break
          else
            raise_invalid!
          end
        end
      end

      def array(path)
        @index += 1; skip; position = 0
        if @text[@index] == "]"
          @index += 1; return
        end
        loop do
          value(path + [position]); position += 1; skip
          if @text[@index] == ","
            @index += 1; skip
          elsif @text[@index] == "]"
            @index += 1; break
          else
            raise_invalid!
          end
        end
      end

      def string
        raise_invalid! unless @text[@index] == '"'; @index += 1
        while @index < @text.length
          char = @text[@index]
          if char == '"'
            @index += 1; return
          elsif char == "\\"
            @index += 1; raise_invalid! if @index >= @text.length
            if @text[@index] == "u"
              4.times { @index += 1; raise_invalid! if @index >= @text.length || !@text[@index].match?(/[0-9A-Fa-f]/) }
            elsif !%w[" \\ / b f n r t].include?(@text[@index])
              raise_invalid!
            end
          elsif char.ord < 0x20
            raise_invalid!
          end
          @index += 1
        end
        raise_invalid!
      end

      def number(path)
        start = @index
        @index += 1 if @text[@index] == "-"
        if @text[@index] == "0"
          @index += 1; raise_invalid! if @text[@index]&.match?(/[0-9]/)
        elsif @text[@index]&.match?(/[1-9]/)
          @index += 1 while @text[@index]&.match?(/[0-9]/)
        else
          raise_invalid!
        end
        if @text[@index] == "."
          @index += 1; start_fraction = @index; @index += 1 while @text[@index]&.match?(/[0-9]/); raise_invalid! if start_fraction == @index
        end
        if %w[e E].include?(@text[@index])
          @index += 1; @index += 1 if %w[+ -].include?(@text[@index]); start_exp = @index
          @index += 1 while @text[@index]&.match?(/[0-9]/); raise_invalid! if start_exp == @index
        end
        raw = @text[start...@index]
        raise_invalid! unless raw.match?(NUMBER)
        @tokens[path] = raw
      end

      def literal(value)
        raise_invalid! unless @text[@index, value.length] == value
        @index += value.length
      end

      def skip
        @index += 1 while @index < @text.length && " \t\r\n".include?(@text[@index])
      end

      def raise_invalid!
        raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil
      end
    end
    private_constant :Scanner
  end

  NEAR_TRANSPORT_FACTS = NearContract.facts_from_contract(RPC_NETWORK_CONTRACT)
  NEAR_RPC_METHODS = NEAR_TRANSPORT_FACTS.method_names
  private_constant :NEAR_TRANSPORT_FACTS

  class NearHttpTransport
    attr_reader :method_names

    def initialize(facts:, api_key: nil, endpoint: nil, direct_endpoint: nil, headers: {}, timeout: DEFAULT_TIMEOUT,
                   adapter: NetHttpAdapter.new, namespace: "near.rpc")
      @facts = facts
      @method_names = facts.method_names
      @api_key = api_key.is_a?(String) && !api_key.strip.empty? ? api_key.strip : nil
      @timeout = timeout.to_f
      raise ConfigError, "timeout must be positive", cause: nil unless @timeout.positive?
      @adapter = adapter
      @namespace = namespace.to_s.freeze
      @mutex = Mutex.new
      @next_id = 0
      @available = false
      @direct = !direct_endpoint.nil?

      if direct_endpoint
        unless direct_endpoint.is_a?(RpcEndpointConfig)
          raise ConfigError, "near_rpc must use RpcEndpointConfig", cause: nil
        end
        raise ConfigError, "near_rpc does not support WebSocket URLs", cause: nil if direct_endpoint.websocket_url
        @target = validate_url(direct_endpoint.http_url)
        @headers = direct_endpoint.headers.dup
        @redactions = Redaction.send(:direct_variants_with_path, http_url: direct_endpoint.http_url, headers: direct_endpoint.headers)
        @available = true
      elsif @api_key
        @target = hosted_target(endpoint || facts.hosted_target)
        @headers = headers.to_h.dup
        @redactions = [@api_key]
        @available = true
      else
        @target = nil
        @headers = {}
        @redactions = []
      end
    end

    def endpoint
      return "" unless @available

      uri = URI.parse(@target)
      uri.path = "/"
      uri.query = nil
      uri.fragment = nil
      uri.to_s
    rescue URI::InvalidURIError
      ""
    end

    def inspect
      "#<#{self.class} endpoint=#{endpoint.inspect} header_names=#{safe_header_names.inspect}>"
    end

    def request(method, params)
      raise ConfigError, "NEAR method is not in the accepted read contract", cause: nil unless @method_names.include?(method)
      raise NotConfiguredError, @namespace unless @available

      id = @mutex.synchronize { @next_id += 1 }
      body = JSON.generate("jsonrpc" => "2.0", "id" => id, "method" => method, "params" => params)
      response = nil
      Timeout.timeout(@timeout) do
        response = @adapter.request(method: :post, url: @target, headers: request_headers, body: body, timeout: @timeout)
      end
      raise HttpError, response.status unless response.respond_to?(:status) && response.status.to_i.between?(200, 299)
      decode(response.body.to_s, id, method)
    rescue ::Timeout::Error
      raise TimeoutError, @timeout, cause: nil
    rescue InvalidResponseError, JsonRpcError, HttpError, NotConfiguredError, ConfigError, TimeoutError, TransportError
      raise
    rescue JSON::ParserError, JSON::GeneratorError, ArgumentError, TypeError
      raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil
    rescue IOError, EOFError, SocketError, SystemCallError, Net::OpenTimeout, Net::ReadTimeout, Net::WriteTimeout
      raise TransportError, "Unable to reach ERPC", cause: nil
    end

    private

    def validate_url(value)
      input = value.to_s
      uri = URI.parse(input)
      valid = uri.absolute? && uri.host && %w[http https].include?(uri.scheme) && !input.include?("#") && !input.match?(%r{://[^/?#]*@})
      raise ConfigError, "HTTP endpoint must be an absolute HTTP(S) URL", cause: nil unless valid
      input.freeze
    rescue URI::InvalidURIError, ArgumentError
      raise ConfigError, "HTTP endpoint must be an absolute HTTP(S) URL", cause: nil
    end

    def hosted_target(value)
      uri = URI.parse(validate_url(value))
      query = URI.decode_www_form(uri.query.to_s).reject { |key, _| key.casecmp?("api-key") }
      query << ["api-key", @api_key]
      uri.query = URI.encode_www_form(query)
      uri.fragment = nil
      uri.to_s
    end

    def request_headers
      values = @headers.dup
      values.delete_if { |key, _| %w[accept content-type].include?(key.to_s.downcase) }
      values["accept"] = "application/json"
      values["content-type"] = "application/json"
      values
    end

    def safe_header_names
      @headers.keys.map(&:to_s).sort
    end

    def decode(text, expected_id, method)
      NearTokenScanner.known_integer_tokens!(text, method)
      decimal_class = Class.new do
        define_singleton_method(:new) do |raw|
          value = BigDecimal(raw)
          zero_token = raw.match?(/\A-?(?:0+\.?0*|0*\.0+)(?:[eE][+-]?\d+)?\z/)
          raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil unless value.finite? && (zero_token || !value.zero?)
          value
        rescue InvalidResponseError
          raise
        rescue StandardError
          raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil
        end
      end
      response = JSON.parse(text, create_additions: false, allow_nan: false, decimal_class: decimal_class)
      raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil unless response.is_a?(Hash) && response["id"] == expected_id
      if response.key?("error") && !response["error"].nil?
        error = response["error"]
        unless error.is_a?(Hash) && error["code"].is_a?(Integer) && error["message"].is_a?(String)
          raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil
        end
        data = error.key?("data") ? Redaction.value(error["data"], @redactions) : nil
        raise JsonRpcError.new(error["code"], Redaction.text(error["message"], @redactions), data), cause: nil
      end
      raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil unless response.key?("result")
      response["result"]
    rescue InvalidResponseError, JsonRpcError
      raise
    rescue JSON::ParserError, JSON::NestingError, ArgumentError, TypeError, SystemStackError
      raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil
    end
  end

  private_constant :NearTransportFacts, :NearContract, :NearTokenScanner, :NearHttpTransport
end
