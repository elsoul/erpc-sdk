# frozen_string_literal: true

require "uri"

module ERPC
  DEFAULT_ENDPOINT = "https://edge.erpc.global"
  DEFAULT_AVALANCHE_ENDPOINT = "https://ava-rpc.erpc.global"
  DEFAULT_ACCOUNT_ENDPOINT = "https://solana-rpc.erpc.global"
  DEFAULT_USER_ENDPOINT = "https://user-api.erpc.global"
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
                :avalanche_endpoint, :solana_rpc, :ethereum_rpc, :avalanche_c_rpc

    def initialize(api_key: nil, endpoint: DEFAULT_ENDPOINT, account_endpoint: DEFAULT_ACCOUNT_ENDPOINT,
                   user_endpoint: DEFAULT_USER_ENDPOINT, headers: {}, timeout: DEFAULT_TIMEOUT,
                   avalanche_endpoint: DEFAULT_AVALANCHE_ENDPOINT, solana_rpc: nil,
                   ethereum_rpc: nil, avalanche_c_rpc: nil)
      direct_endpoints = [solana_rpc, ethereum_rpc, avalanche_c_rpc]
      unless direct_endpoints.all? { |value| value.nil? || value.is_a?(RpcEndpointConfig) }
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
      @headers = headers.to_h.transform_keys(&:to_s).transform_values(&:to_s).freeze
      @timeout = timeout.to_f
      @solana_rpc = solana_rpc
      @ethereum_rpc = ethereum_rpc
      @avalanche_c_rpc = avalanche_c_rpc
    end

    def inspect
      key = api_key.nil? ? nil : "[REDACTED]"
      "#<#{self.class} api_key=#{key.inspect} endpoint=#{endpoint.inspect} " \
        "avalanche_endpoint=#{avalanche_endpoint.inspect} " \
        "account_endpoint=#{account_endpoint.inspect} user_endpoint=#{user_endpoint.inspect} " \
        "header_names=#{headers.keys.inspect} timeout=#{timeout.inspect} " \
        "solana_rpc=#{solana_rpc.inspect} ethereum_rpc=#{ethereum_rpc.inspect} " \
        "avalanche_c_rpc=#{avalanche_c_rpc.inspect}>"
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
