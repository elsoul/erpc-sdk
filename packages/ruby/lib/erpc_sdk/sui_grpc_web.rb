# frozen_string_literal: true

require "timeout"
require "uri"

require_relative "sui_proto"

module ERPC
  class SuiGrpcWebEndpointConfig
    attr_reader :base_url, :headers

    def initialize(base_url:, headers: {})
      @base_url = validate_url(base_url)
      values = headers.to_h
      raise ConfigError, "sui_grpc_web headers must contain string names and values", cause: nil unless values.all? { |name, value| name.is_a?(String) && value.is_a?(String) }
      @headers = values.dup.freeze
      freeze
    end

    def inspect
      uri = URI.parse(base_url); uri.path = "/"; uri.query = nil; uri.fragment = nil
      "#<#{self.class} base_url=#{uri.to_s.inspect} header_names=#{headers.keys.inspect}>"
    rescue URI::InvalidURIError
      "#<#{self.class} base_url=\"[REDACTED]\" header_names=#{headers.keys.inspect}>"
    end

    alias to_s inspect

    private

    def validate_url(value)
      input = value.to_s
      uri = URI.parse(input)
      valid = uri.absolute? && uri.host && %w[http https].include?(uri.scheme) && !input.include?("#") && !input.match?(%r{://[^/?#]*@})
      raise ConfigError, "sui_grpc_web base_url must be an absolute HTTP(S) URL", cause: nil unless valid
      input.freeze
    rescue URI::InvalidURIError, ArgumentError
      raise ConfigError, "sui_grpc_web base_url must be an absolute HTTP(S) URL", cause: nil
    end
  end

  SuiTransportFacts = Struct.new(:hosted_target, :method_names, :public_methods, keyword_init: true) do
    def initialize(hosted_target:, method_names:, public_methods: {})
      super(hosted_target: hosted_target.to_s.freeze,
            method_names: method_names.map { |name| name.to_s.dup.freeze }.freeze,
            public_methods: public_methods.each_with_object({}) do |(name, wire), result|
              result[name.to_s.dup.freeze] = wire.to_s.dup.freeze
            end.freeze)
      freeze
    end
  end

  module SuiContract
    module_function

    def facts_from_contract(contract)
      client = contract.fetch("clientContracts").find { |value| value["clientContractId"] == "client-sui-grpc" }
      method_set_id = client.fetch("methodSetId")
      hosted = client.fetch("endpointModes").find { |value| value["mode"] == "hosted" }
      method_set = contract.fetch("methodSets").find { |value| value["methodSetId"] == method_set_id }
      capabilities = method_set.fetch("capabilities")
      selected = capabilities.each_with_object({}) do |item, result|
        public_name = case item.fetch("capabilityId")
                      when "sui-get-service-info" then "get_service_info"
                      when "sui-get-object" then "get_object"
                      when "sui-get-balance" then "get_balance"
                      else raise KeyError
                      end
        result[public_name] = item.fetch("wireOperation")
      end
      SuiTransportFacts.new(hosted_target: hosted.fetch("defaultTarget"), method_names: selected.values, public_methods: selected)
    rescue KeyError, NoMethodError, TypeError
      raise ConfigError, "Sui contract facts are unavailable", cause: nil
    end
  end

  SUI_TRANSPORT_FACTS = SuiContract.facts_from_contract(RPC_NETWORK_CONTRACT)
  SUI_GRPC_WEB_METHODS = %w[get_service_info get_object get_balance].map { |name| SUI_TRANSPORT_FACTS.public_methods.fetch(name) }.freeze
  private_constant :SUI_TRANSPORT_FACTS

  class SuiGrpcWebTransport
    attr_reader :endpoint

    def initialize(facts:, api_key: nil, endpoint: nil, direct_endpoint: nil, headers: {}, timeout: DEFAULT_TIMEOUT,
                   adapter: NetHttpAdapter.new, namespace: "sui.grpc")
      @facts = facts
      @api_key = api_key.is_a?(String) && !api_key.strip.empty? ? api_key.strip : nil
      @timeout = timeout.to_f
      raise ConfigError, "timeout must be positive", cause: nil unless @timeout.positive?
      @adapter = adapter
      @namespace = namespace.to_s.freeze
      @mutex = Mutex.new
      @next_id = 0
      @direct = !direct_endpoint.nil?
      if direct_endpoint
        config = direct_endpoint.is_a?(SuiGrpcWebEndpointConfig) ? direct_endpoint : SuiGrpcWebEndpointConfig.new(base_url: direct_endpoint.http_url, headers: direct_endpoint.headers)
        @target_prefix = config.base_url
        @headers = config.headers.dup
        @redactions = Redaction.send(:direct_variants_with_path, http_url: config.base_url, headers: config.headers)
        @available = true
      elsif @api_key
        @target_prefix = endpoint || facts.hosted_target
        @headers = headers.to_h.dup
        @redactions = [@api_key]
        @available = true
      else
        @target_prefix = nil
        @headers = {}
        @redactions = []
        @available = false
      end
      @endpoint = if @available
                    uri = URI.parse(@target_prefix); uri.path = "/"; uri.query = nil; uri.fragment = nil; uri.to_s
                  else
                    ""
                  end
    rescue URI::InvalidURIError
      raise ConfigError, "sui_grpc_web endpoint is invalid", cause: nil
    end

    def inspect
      "#<#{self.class} endpoint=#{endpoint.inspect} header_names=#{safe_header_names.inspect}>"
    end

    def request(operation, payload, decoder)
      raise NotConfiguredError, @namespace unless @available
      path = SUI_GRPC_WEB_METHODS.fetch(operation)
      target = join(path)
      result = nil
      Timeout.timeout(@timeout) do
        yielded = false
        @adapter.request_stream(method: :post, url: target, headers: request_headers, body: payload, timeout: @timeout) do |status, chunks, response_headers|
          yielded = true
          raise HttpError, status unless status.to_i == 200
          content_types = Array(response_headers && (response_headers["content-type"] || response_headers["Content-Type"])).flatten
          raise InvalidResponseError.new("ERPC returned an invalid Sui response"), cause: nil unless content_types.length == 1 && content_types.first.to_s == SUI_GRPC_WEB_CONTENT_TYPE
          result = decoder.call(SuiProto.decode_response(chunks))
        end
        raise TransportError, "Unable to reach ERPC", cause: nil unless yielded
      end
      result
    rescue ::Timeout::Error
      raise TimeoutError, @timeout, cause: nil
    rescue InvalidResponseError, JsonRpcError, HttpError, NotConfiguredError, ConfigError, TimeoutError, TransportError
      raise
    rescue IOError, EOFError, SocketError, SystemCallError, Net::OpenTimeout, Net::ReadTimeout, Net::WriteTimeout
      raise TransportError, "Unable to reach ERPC", cause: nil
    end

    private

    def join(path)
      uri = URI.parse(@target_prefix)
      base = uri.path.to_s.sub(%r{/+\z}, "")
      uri.path = "#{base}/#{path.sub(%r{\A/+}, "")}"
      if @direct
        uri.to_s
      else
        query = URI.decode_www_form(uri.query.to_s).reject { |key, _| key.casecmp?("api-key") }
        uri.query = URI.encode_www_form(query)
        uri.fragment = nil
        uri.to_s
      end
    end

    def request_headers
      values = @headers.dup
      unless @direct
        values.delete_if { |key, _| key.to_s.casecmp?("authorization") }
        values["authorization"] = "Bearer #{@api_key}"
      end
      values.delete_if { |key, _| %w[accept content-type x-grpc-web].include?(key.to_s.downcase) }
      values["accept"] = SUI_GRPC_WEB_CONTENT_TYPE
      values["content-type"] = SUI_GRPC_WEB_CONTENT_TYPE
      values["x-grpc-web"] = "1"
      values
    end

    def safe_header_names
      @headers.keys.map(&:to_s).sort
    end
  end

  class SuiGrpcWebPendingRequest
    def initialize(&block); @block = block; end
    def send; @block.call; end
  end

  class SuiGrpcWebClient
    attr_reader :endpoint

    def initialize(transport)
      @transport = transport
      @endpoint = transport.endpoint
    end

    def inspect
      "#<#{self.class} endpoint=#{endpoint.inspect}>"
    end

    def get_service_info
      SuiGrpcWebPendingRequest.new { @transport.request(0, SuiProto.service_info_request, SuiProto.method(:parse_service_info)) }
    end

    def get_object(object_id, version = nil)
      SuiGrpcWebPendingRequest.new { @transport.request(1, SuiProto.object_request(object_id, version), SuiProto.method(:parse_object_response)) }
    end

    def get_balance(owner, coin_type)
      SuiGrpcWebPendingRequest.new { @transport.request(2, SuiProto.balance_request(owner, coin_type), SuiProto.method(:parse_balance_response)) }
    end
  end

  class SuiClient
    attr_reader :grpc
    def initialize(transport); @grpc = SuiGrpcWebClient.new(transport); freeze; end
  end

  module Sui
    module_function
    def create_client(transport); SuiClient.new(transport); end
  end

  private_constant :SuiTransportFacts, :SuiContract, :SUI_TRANSPORT_FACTS,
                   :SuiGrpcWebTransport, :SuiGrpcWebPendingRequest
end
