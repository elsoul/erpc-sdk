# frozen_string_literal: true

require "uri"

module ERPC
  DEFAULT_ENDPOINT = "https://edge.erpc.global"
  DEFAULT_AVALANCHE_ENDPOINT = "https://ava-rpc.erpc.global"
  DEFAULT_ACCOUNT_ENDPOINT = "https://solana-rpc.erpc.global"
  DEFAULT_USER_ENDPOINT = "https://user-api.erpc.global"

  def self.generated_public_default(client_contract_id, bootstrap_fallback)
    return bootstrap_fallback unless defined?(RPC_NETWORK_CONTRACT)

    client = RPC_NETWORK_CONTRACT.fetch("clientContracts").find do |candidate|
      candidate.is_a?(Hash) && candidate["clientContractId"] == client_contract_id
    end
    hosted = client&.fetch("endpointModes", []).find do |candidate|
      candidate.is_a?(Hash) && candidate["mode"] == "hosted"
    end
    value = hosted&.fetch("publicDefault")
    raise ConfigError, "generated hosted endpoint is unavailable", cause: nil unless value.is_a?(String) && !value.empty?

    value
  rescue KeyError, NoMethodError, TypeError
    raise ConfigError, "generated hosted endpoint is unavailable", cause: nil
  end
  private_class_method :generated_public_default

  DEFAULT_BASE_ENDPOINT = generated_public_default("client-base-rpc", "https://base.erpc.global")
  DEFAULT_ARBITRUM_ENDPOINT = generated_public_default("client-arbitrum-rpc", "https://arbitrum.erpc.global")
  DEFAULT_POLYGON_ENDPOINT = generated_public_default("client-polygon-rpc", "https://polygon.erpc.global")
  DEFAULT_BSC_ENDPOINT = generated_public_default("client-bsc-rpc", "https://bsc.erpc.global")
  DEFAULT_OPTIMISM_ENDPOINT = generated_public_default("client-optimism-rpc", "https://optimism.erpc.global")
  DEFAULT_KAIA_ENDPOINT = generated_public_default("client-kaia-rpc", "https://kaia.erpc.global")
  DEFAULT_SONEIUM_ENDPOINT = generated_public_default("client-soneium-rpc", "https://soneium.erpc.global")
  DEFAULT_MONAD_ENDPOINT = generated_public_default("client-monad-rpc", "https://monad.erpc.global")
  DEFAULT_HYPERLIQUID_ENDPOINT = generated_public_default("client-hyperliquid-rpc", "https://hyperliquid.erpc.global")
  DEFAULT_ARC_ENDPOINT = generated_public_default("client-arc-rpc", "https://arc.erpc.global")
  DEFAULT_ROBINHOOD_ENDPOINT = generated_public_default("client-robinhood-rpc", "https://robinhood.erpc.global")
  DEFAULT_TRON_ENDPOINT = generated_public_default("client-tron-rpc", "https://tron.erpc.global")
  DEFAULT_NEAR_ENDPOINT = generated_public_default("client-near-rpc", "https://near.erpc.global")
  DEFAULT_SUI_ENDPOINT = generated_public_default("client-sui-grpc", "https://sui.erpc.global")
  DEFAULT_TIMEOUT = 30.0

  module URLs
    module_function

    DIRECT_HTTP_SCHEMES = %w[http https].freeze
    DIRECT_WEBSOCKET_SCHEMES = %w[ws wss].freeze

    def direct_endpoint(value, kind:, namespace: "direct endpoint")
      schemes = kind == :websocket ? DIRECT_WEBSOCKET_SCHEMES : DIRECT_HTTP_SCHEMES
      unless value.is_a?(String)
        raise ConfigError, "#{namespace} must be an absolute #{kind == :websocket ? 'WS(S)' : 'HTTP(S)'} URL", cause: nil
      end

      input = value.strip
      scheme_match = input.match?(/\A[a-z][a-z\d+.-]*:\/\//i)
      authority = input[/\A[a-z][a-z\d+.-]*:\/\/([^\/?#]*)/i, 1]
      valid = !input.empty? && scheme_match && !input.include?("#") && authority &&
              !authority.empty? && !authority.include?("@")
      begin
        uri = URI.parse(input)
        valid &&= uri.absolute? && !uri.host.to_s.empty? && schemes.include?(uri.scheme)
      rescue URI::InvalidURIError, ArgumentError
        valid = false
      end
      unless valid
        raise ConfigError, "#{namespace} must be an absolute #{kind == :websocket ? 'WS(S)' : 'HTTP(S)'} URL", cause: nil
      end

      input.freeze
    end

    def normalize_endpoint(value, local_http_only: false)
      uri = URI.parse(value.to_s)
      unless uri.absolute? && uri.host && %w[http https].include?(uri.scheme)
        raise ConfigError, "endpoint must be an absolute HTTP(S) URL"
      end

      local = %w[127.0.0.1 ::1 localhost].include?(uri.hostname)
      if local_http_only && uri.scheme != "https" && !(uri.scheme == "http" && local)
        raise ConfigError, "endpoint must use HTTPS except on localhost"
      end

      uri.query = nil
      uri.fragment = nil
      uri.path = uri.path.sub(%r{/+\z}, "")
      uri.path = "/" if uri.path.empty?
      uri.to_s
    rescue URI::InvalidURIError, ArgumentError
      raise ConfigError, "endpoint must be an absolute HTTP(S) URL", cause: nil
    end

    # New sealed-client hosted roots reject credentials and fragments before
    # any diagnostic rendering. Query parameters are not part of a hosted
    # root; endpoint-specific authentication is applied by its private
    # transport.
    def normalize_new_hosted_endpoint(value, namespace:)
      unless value.is_a?(String)
        raise ConfigError, "#{namespace} must be an absolute HTTP(S) URL", cause: nil
      end

      input = value.strip
      begin
        uri = URI.parse(input)
        valid = uri.absolute? && uri.host && %w[http https].include?(uri.scheme) &&
                !input.include?("#") && !input.match?(%r{://[^/?#]*@})
      rescue URI::InvalidURIError, ArgumentError
        valid = false
      end
      unless valid
        raise ConfigError, "#{namespace} must be an absolute HTTP(S) URL", cause: nil
      end

      uri.query = nil
      uri.fragment = nil
      uri.path = uri.path.sub(%r{/+\z}, "")
      uri.path = "/" if uri.path.empty?
      uri.to_s.freeze
    end

    def public_endpoint(endpoint)
      uri = endpoint.is_a?(URI::Generic) ? endpoint.dup : URI.parse(endpoint.to_s)
      uri.query = nil
      uri.fragment = nil
      uri.user = nil if uri.respond_to?(:user=)
      uri.to_s
    rescue URI::InvalidURIError, ArgumentError
      "[REDACTED]"
    end

    def unavailable_endpoint(namespace)
      safe = namespace.to_s.gsub(/[^a-z\d._-]+/i, "-")
      "https://unconfigured.invalid/#{safe}"
    end

    def with_path(endpoint, path)
      uri = URI.parse(endpoint)
      base = uri.path.sub(%r{/+\z}, "")
      uri.path = "#{base}/#{path.sub(%r{\A/+}, "")}"
      uri.query = nil
      uri.fragment = nil
      uri.to_s
    end

    def websocket(endpoint, api_key, path = "")
      uri = URI.parse(with_path(endpoint, path))
      uri.scheme = uri.scheme == "https" ? "wss" : "ws"
      uri.query = URI.encode_www_form("api-key" => api_key)
      uri.to_s
    end

    def escape_path(value)
      value.to_s.b.each_byte.map do |byte|
        character = byte.chr
        character.match?(/[A-Za-z0-9_.~-]/) ? character : format("%%%02X", byte)
      end.join
    end
  end

  class RpcEndpointConfig
    attr_reader :http_url, :websocket_url, :headers

    def initialize(http_url:, websocket_url: nil, headers: {})
      @http_url = URLs.direct_endpoint(http_url, kind: :http, namespace: "http_url")
      @websocket_url = if websocket_url.nil?
                         nil
                       else
                         URLs.direct_endpoint(websocket_url, kind: :websocket, namespace: "websocket_url")
                       end
      unless headers.is_a?(Hash) || headers.respond_to?(:to_h)
        raise ConfigError, "direct endpoint headers must be a mapping"
      end

      begin
        values = headers.to_h
      rescue StandardError
        raise ConfigError, "direct endpoint headers must be a mapping", cause: nil
      end
      unless values.all? { |name, value| name.is_a?(String) && value.is_a?(String) }
        raise ConfigError, "direct endpoint headers must contain string names and values"
      end

      @headers = values.dup.freeze
      freeze
    end

    def inspect
      websocket = websocket_url.nil? ? "nil" : URLs.public_endpoint(websocket_url).inspect
      "#<#{self.class} http_url=#{URLs.public_endpoint(http_url).inspect} " \
        "websocket_url=#{websocket} " \
        "header_names=#{headers.keys.inspect}>"
    end

    alias to_s inspect
  end

  class ClientConfig
    attr_reader :api_key, :endpoint, :account_endpoint, :user_endpoint, :headers, :timeout,
                :avalanche_endpoint, :solana_rpc, :ethereum_rpc, :avalanche_c_rpc,
                :base_endpoint, :base_rpc, :arbitrum_endpoint, :arbitrum_rpc, :bitcoin_rpc,
                :polygon_endpoint, :polygon_rpc, :bsc_endpoint, :bsc_rpc,
                :optimism_endpoint, :optimism_rpc, :kaia_endpoint, :kaia_rpc,
                :soneium_endpoint, :soneium_rpc, :monad_endpoint, :monad_rpc,
                :hyperliquid_endpoint, :hyperliquid_rpc, :arc_endpoint, :arc_rpc,
                :robinhood_endpoint, :robinhood_rpc, :tron_endpoint, :tron_rpc,
                :near_endpoint, :near_rpc, :sui_endpoint, :sui_rpc, :sui_grpc_web

    def initialize(api_key: nil, endpoint: DEFAULT_ENDPOINT, account_endpoint: DEFAULT_ACCOUNT_ENDPOINT,
                   user_endpoint: DEFAULT_USER_ENDPOINT, headers: {}, timeout: DEFAULT_TIMEOUT,
                   avalanche_endpoint: DEFAULT_AVALANCHE_ENDPOINT, solana_rpc: nil,
                   ethereum_rpc: nil, avalanche_c_rpc: nil,
                   base_endpoint: DEFAULT_BASE_ENDPOINT, base_rpc: nil,
                   arbitrum_endpoint: DEFAULT_ARBITRUM_ENDPOINT, arbitrum_rpc: nil,
                   bitcoin_rpc: nil,
                   polygon_endpoint: DEFAULT_POLYGON_ENDPOINT, polygon_rpc: nil,
                   bsc_endpoint: DEFAULT_BSC_ENDPOINT, bsc_rpc: nil,
                   optimism_endpoint: DEFAULT_OPTIMISM_ENDPOINT, optimism_rpc: nil,
                   kaia_endpoint: DEFAULT_KAIA_ENDPOINT, kaia_rpc: nil,
                   soneium_endpoint: DEFAULT_SONEIUM_ENDPOINT, soneium_rpc: nil,
                   monad_endpoint: DEFAULT_MONAD_ENDPOINT, monad_rpc: nil,
                   hyperliquid_endpoint: DEFAULT_HYPERLIQUID_ENDPOINT, hyperliquid_rpc: nil,
                   arc_endpoint: DEFAULT_ARC_ENDPOINT, arc_rpc: nil,
                   robinhood_endpoint: DEFAULT_ROBINHOOD_ENDPOINT, robinhood_rpc: nil,
                   tron_endpoint: DEFAULT_TRON_ENDPOINT, tron_rpc: nil,
                   near_endpoint: DEFAULT_NEAR_ENDPOINT, near_rpc: nil,
                   sui_endpoint: DEFAULT_SUI_ENDPOINT, sui_rpc: nil, sui_grpc_web: nil)
      direct_endpoints = [solana_rpc, ethereum_rpc, avalanche_c_rpc, base_rpc, arbitrum_rpc, bitcoin_rpc,
                          polygon_rpc, bsc_rpc, optimism_rpc, kaia_rpc, soneium_rpc, monad_rpc,
                          hyperliquid_rpc, arc_rpc, robinhood_rpc, tron_rpc, near_rpc, sui_rpc, sui_grpc_web]
      allowed_sui = defined?(SuiGrpcWebEndpointConfig) ? SuiGrpcWebEndpointConfig : Object
      unless direct_endpoints.all? { |value| value.nil? || value.is_a?(RpcEndpointConfig) || value.is_a?(allowed_sui) }
        raise ConfigError, "direct RPC overrides must use RpcEndpointConfig"
      end

      @api_key = if api_key.nil?
                   nil
                 elsif api_key.is_a?(String)
                   api_key.strip
                 else
                   raise ConfigError, "api_key must be a string"
                 end
      @api_key = nil if @api_key&.empty?
      raise ConfigError, "api_key must not be empty" if @api_key.nil? && direct_endpoints.compact.empty?
      raise ConfigError, "timeout must be positive" unless timeout.is_a?(Numeric) && timeout.finite? && timeout.positive?

      @endpoint = URLs.normalize_endpoint(endpoint)
      @avalanche_endpoint = URLs.normalize_endpoint(avalanche_endpoint)
      @account_endpoint = URLs.normalize_endpoint(account_endpoint)
      @user_endpoint = URLs.normalize_endpoint(user_endpoint)
      @base_endpoint = URLs.normalize_new_hosted_endpoint(base_endpoint, namespace: "base_endpoint")
      @arbitrum_endpoint = URLs.normalize_new_hosted_endpoint(arbitrum_endpoint, namespace: "arbitrum_endpoint")
      @polygon_endpoint = URLs.normalize_new_hosted_endpoint(polygon_endpoint, namespace: "polygon_endpoint")
      @bsc_endpoint = URLs.normalize_new_hosted_endpoint(bsc_endpoint, namespace: "bsc_endpoint")
      @optimism_endpoint = URLs.normalize_new_hosted_endpoint(optimism_endpoint, namespace: "optimism_endpoint")
      @kaia_endpoint = URLs.normalize_new_hosted_endpoint(kaia_endpoint, namespace: "kaia_endpoint")
      @soneium_endpoint = URLs.normalize_new_hosted_endpoint(soneium_endpoint, namespace: "soneium_endpoint")
      @monad_endpoint = URLs.normalize_new_hosted_endpoint(monad_endpoint, namespace: "monad_endpoint")
      @hyperliquid_endpoint = URLs.normalize_new_hosted_endpoint(hyperliquid_endpoint, namespace: "hyperliquid_endpoint")
      @arc_endpoint = URLs.normalize_new_hosted_endpoint(arc_endpoint, namespace: "arc_endpoint")
      @robinhood_endpoint = URLs.normalize_new_hosted_endpoint(robinhood_endpoint, namespace: "robinhood_endpoint")
      @tron_endpoint = URLs.normalize_new_hosted_endpoint(tron_endpoint, namespace: "tron_endpoint")
      @near_endpoint = URLs.normalize_new_hosted_endpoint(near_endpoint, namespace: "near_endpoint")
      @sui_endpoint = URLs.normalize_new_hosted_endpoint(sui_endpoint, namespace: "sui_endpoint")
      @headers = headers.to_h.transform_keys(&:to_s).transform_values(&:to_s).freeze
      @timeout = timeout.to_f
      @solana_rpc = solana_rpc
      @ethereum_rpc = ethereum_rpc
      @avalanche_c_rpc = avalanche_c_rpc
      @base_rpc = base_rpc
      @arbitrum_rpc = arbitrum_rpc
      @bitcoin_rpc = bitcoin_rpc
      @polygon_rpc = polygon_rpc
      @bsc_rpc = bsc_rpc
      @optimism_rpc = optimism_rpc
      @kaia_rpc = kaia_rpc
      @soneium_rpc = soneium_rpc
      @monad_rpc = monad_rpc
      @hyperliquid_rpc = hyperliquid_rpc
      @arc_rpc = arc_rpc
      @robinhood_rpc = robinhood_rpc
      @tron_rpc = tron_rpc
      @near_rpc = near_rpc
      @sui_rpc = sui_rpc
      @sui_grpc_web = sui_grpc_web

      {
        "base_rpc" => base_rpc,
        "arbitrum_rpc" => arbitrum_rpc,
        "bitcoin_rpc" => bitcoin_rpc,
        "polygon_rpc" => polygon_rpc, "bsc_rpc" => bsc_rpc,
        "optimism_rpc" => optimism_rpc, "kaia_rpc" => kaia_rpc,
        "soneium_rpc" => soneium_rpc, "monad_rpc" => monad_rpc,
        "hyperliquid_rpc" => hyperliquid_rpc, "arc_rpc" => arc_rpc,
        "robinhood_rpc" => robinhood_rpc, "tron_rpc" => tron_rpc,
        "near_rpc" => near_rpc, "sui_rpc" => sui_rpc
      }.each do |name, value|
        next if value.nil? || value.websocket_url.nil?

        raise ConfigError, "#{name} does not support WebSocket URLs", cause: nil
      end
    end

    def inspect
      key = api_key.nil? ? nil : "[REDACTED]"
      "#<#{self.class} api_key=#{key.inspect} endpoint=#{endpoint.inspect} " \
        "avalanche_endpoint=#{avalanche_endpoint.inspect} " \
        "account_endpoint=#{account_endpoint.inspect} user_endpoint=#{user_endpoint.inspect} " \
        "header_names=#{headers.keys.inspect} timeout=#{timeout.inspect} " \
        "solana_rpc=#{solana_rpc.inspect} ethereum_rpc=#{ethereum_rpc.inspect} " \
        "avalanche_c_rpc=#{avalanche_c_rpc.inspect} " \
        "base_endpoint=#{new_origin(base_endpoint).inspect} " \
        "base_rpc=#{new_direct_inspect(base_rpc)} " \
        "arbitrum_endpoint=#{new_origin(arbitrum_endpoint).inspect} " \
        "arbitrum_rpc=#{new_direct_inspect(arbitrum_rpc)} " \
        "bitcoin_rpc=#{new_direct_inspect(bitcoin_rpc)}>"
    end

    private

    def new_direct_inspect(value)
      return "nil" if value.nil?

      uri = URI.parse(value.http_url)
      uri.path = "/"
      uri.query = nil
      uri.fragment = nil
      "#<#{value.class} http_url=#{uri.to_s.inspect} websocket_url=nil " \
        "header_names=#{value.headers.keys.inspect}>"
    rescue URI::InvalidURIError, ArgumentError
      "#<#{value.class} http_url=\"[REDACTED]\" websocket_url=nil header_names=#{value.headers.keys.inspect}>"
    end

    def new_origin(value)
      uri = URI.parse(value.to_s)
      uri.path = "/"
      uri.query = nil
      uri.fragment = nil
      uri.user = nil if uri.respond_to?(:user=)
      uri.to_s
    rescue URI::InvalidURIError, ArgumentError
      "[REDACTED]"
    end
  end

  class CloudClientConfig
    attr_reader :access_token, :endpoint, :headers, :timeout

    def initialize(access_token:, endpoint: DEFAULT_USER_ENDPOINT, headers: {}, timeout: DEFAULT_TIMEOUT)
      @access_token = access_token.to_s.strip
      raise ConfigError, "access_token must not be empty" if @access_token.empty?
      raise ConfigError, "timeout must be positive" unless timeout.is_a?(Numeric) && timeout.finite? && timeout.positive?

      @endpoint = URLs.normalize_endpoint(endpoint, local_http_only: true)
      @headers = headers.to_h.transform_keys(&:to_s).transform_values(&:to_s).freeze
      @timeout = timeout.to_f
    end

    def inspect
      "#<#{self.class} access_token=[REDACTED] endpoint=#{endpoint.inspect} " \
        "header_names=#{headers.keys.inspect} timeout=#{timeout.inspect}>"
    end
  end
end
