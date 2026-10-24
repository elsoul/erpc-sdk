# frozen_string_literal: true

require "json"
require "bigdecimal"
require "timeout"
require "uri"

require_relative "config"
require_relative "errors"
require_relative "transport"

module ERPC
  SealedEvmTransportFacts = Struct.new(
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
        raise ConfigError, "sealed EVM public method is absent from the accepted contract", cause: nil
      end
    rescue KeyError
      raise ConfigError, "sealed EVM public method is absent from the accepted contract", cause: nil
    end
  end

  module SealedEvmContract
    module_function

    def facts_from_contract(contract, client_contract_id)
      clients = contract.fetch("clientContracts")
      method_sets = contract.fetch("methodSets")
      client = clients.find do |value|
        value.is_a?(Hash) && value["clientContractId"] == client_contract_id
      end
      raise ConfigError, "sealed EVM contract facts are unavailable", cause: nil unless client

      method_set_id = client.fetch("methodSetId")
      hosted = client.fetch("endpointModes").find { |value| value.is_a?(Hash) && value["mode"] == "hosted" }
      method_set = method_sets.find { |value| value.is_a?(Hash) && value["methodSetId"] == method_set_id }
      capabilities = method_set&.fetch("capabilities")
      target = hosted&.fetch("defaultTarget")
      unless target.is_a?(String) && capabilities.is_a?(Array) && !capabilities.empty?
        raise ConfigError, "sealed EVM contract facts are unavailable", cause: nil
      end

      public_methods = {}
      method_names = []
      capabilities.each do |capability|
        wire = capability.fetch("wireOperation")
        names = capability.fetch("publicNames")
        public_name = names.fetch("ruby")
        unless wire.is_a?(String) && public_name.is_a?(String) && !wire.empty? && !public_name.empty?
          raise ConfigError, "sealed EVM contract facts are unavailable", cause: nil
        end

        method_names << wire
        public_methods[public_name] = wire
      end
      SealedEvmTransportFacts.new(
        hosted_target: target,
        method_names: method_names,
        public_methods: public_methods
      )
    rescue KeyError, NoMethodError, TypeError
      raise ConfigError, "sealed EVM contract facts are unavailable", cause: nil
    end
  end

  if defined?(RPC_NETWORK_CONTRACT)
    BASE_TRANSPORT_FACTS = SealedEvmContract.facts_from_contract(RPC_NETWORK_CONTRACT, "client-base-rpc")
    BASE_RPC_METHODS = BASE_TRANSPORT_FACTS.method_names
    private_constant :BASE_TRANSPORT_FACTS
  end

  class SealedEvmHttpTransport
    attr_reader :method_names

    def initialize(facts:, api_key: nil, endpoint: nil, direct_endpoint: nil, headers: {}, timeout: DEFAULT_TIMEOUT,
                   adapter: NetHttpAdapter.new, namespace:)
      unless facts.is_a?(SealedEvmTransportFacts)
        raise ConfigError, "sealed EVM transport facts are unavailable", cause: nil
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
          raise ConfigError, "#{@namespace} must use RpcEndpointConfig", cause: nil
        end
        if direct_endpoint.websocket_url
          raise ConfigError, "#{@namespace} does not support WebSocket URLs", cause: nil
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
        @target = hosted_target(endpoint || facts.hosted_target, @api_key)
        @headers = headers.to_h.dup
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

    def request(method, params = nil)
      unless @method_names.include?(method.to_s)
        raise ConfigError, "sealed EVM method is not in the accepted named-read contract", cause: nil
      end
      raise NotConfiguredError, @namespace unless @available

      request_id = next_id
      body = {
        "jsonrpc" => "2.0",
        "id" => request_id,
        "method" => method.to_s,
        "params" => params.nil? ? [] : params
      }
      raw_body = JSON.generate(body)
      response = nil
      Timeout.timeout(@timeout) do
        response = @adapter.request(
          method: :post,
          url: @target,
          headers: request_headers,
          body: raw_body,
          timeout: @timeout
        )
      end
      raise HttpError, response.status unless response.respond_to?(:status) && response.status.to_i.between?(200, 299)

      unwrap(response.body, request_id)
    rescue ::Timeout::Error
      raise TimeoutError, @timeout, cause: nil
    rescue InvalidResponseError, JsonRpcError, HttpError, NotConfiguredError, ConfigError, TimeoutError, TransportError
      raise
    rescue JSON::ParserError, JSON::GeneratorError, TypeError, ArgumentError
      raise InvalidResponseError.new("ERPC returned an invalid response"), cause: nil
    rescue IOError, EOFError, SocketError, SystemCallError, Net::OpenTimeout, Net::ReadTimeout, Net::WriteTimeout
      raise TransportError, "Unable to reach ERPC", cause: nil
    end

    private

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

    def hosted_target(value, api_key)
      uri = URI.parse(validate_http_url(value))
      pairs = URI.decode_www_form(uri.query.to_s).reject { |name, _| name.casecmp?("api-key") }
      pairs << ["api-key", api_key]
      uri.query = URI.encode_www_form(pairs)
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

    def safe_header_names
      @headers.keys.map(&:to_s).sort
    end

    def unwrap(raw_body, expected_id)
      parsed = JSON.parse(raw_body.to_s, create_additions: false, allow_nan: false, decimal_class: BigDecimal)
      unless parsed.is_a?(Hash) && parsed["id"] == expected_id
        raise InvalidResponseError.new("ERPC returned an unexpected response id"), cause: nil
      end
      if parsed.key?("error") && !parsed["error"].nil?
        error = parsed["error"]
        unless error.is_a?(Hash) && error["code"].is_a?(Integer) &&
               !error["code"].is_a?(TrueClass) && !error["code"].is_a?(FalseClass) &&
               error["message"].is_a?(String)
          raise InvalidResponseError.new("ERPC returned an invalid RPC error"), cause: nil
        end

        data = error.key?("data") ? Redaction.value(error["data"], @redactions) : nil
        raise JsonRpcError.new(error["code"], Redaction.text(error["message"], @redactions), data), cause: nil
      end
      result = parsed["result"]
      raise InvalidResponseError.new("ERPC returned an invalid response"), cause: nil unless result.is_a?(String)

      result
    rescue InvalidResponseError, JsonRpcError
      raise
    rescue JSON::ParserError, JSON::NestingError, ArgumentError, TypeError, SystemStackError
      raise InvalidResponseError.new("ERPC returned an invalid response"), cause: nil
    end
  end

  class SealedEvmPendingRequest
    def initialize(&block)
      @block = block
    end

    def send
      @block.call
    end
  end

  class BaseRpc
    attr_reader :endpoint

    def initialize(transport)
      @transport = transport
      @endpoint = transport.endpoint
    end

    def inspect
      "#<#{self.class} endpoint=#{endpoint.inspect}>"
    end

    def eth_chain_id
      pending(@transport.wire_method("eth_chain_id"), [])
    end

    def eth_get_balance(address, block = nil)
      params = [address]
      params << block unless block.nil?
      pending(@transport.wire_method("eth_get_balance"), params)
    end

    def eth_call(transaction, block = nil, state_override = nil)
      params = [transaction]
      params << block unless block.nil?
      params << state_override unless state_override.nil?
      pending(@transport.wire_method("eth_call"), params)
    end

    private

    def pending(method, params)
      SealedEvmPendingRequest.new { @transport.request(method, params) }
    end
  end

  class BaseClient
    attr_reader :rpc

    def initialize(transport)
      @rpc = BaseRpc.new(transport)
      freeze
    end
  end

  BaseRpcClient = BaseRpc

  module Base
    module_function

    def create_client(transport)
      BaseClient.new(transport)
    end
  end

  private_constant :SealedEvmTransportFacts, :SealedEvmContract, :SealedEvmHttpTransport,
                   :SealedEvmPendingRequest
end
