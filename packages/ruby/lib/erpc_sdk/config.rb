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
      raise ConfigError, "endpoint must be an absolute HTTP(S) URL"
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

  class ClientConfig
    attr_reader :api_key, :endpoint, :account_endpoint, :user_endpoint, :headers, :timeout, :avalanche_endpoint

    def initialize(api_key:, endpoint: DEFAULT_ENDPOINT, account_endpoint: DEFAULT_ACCOUNT_ENDPOINT,
                   user_endpoint: DEFAULT_USER_ENDPOINT, headers: {}, timeout: DEFAULT_TIMEOUT,
                   avalanche_endpoint: DEFAULT_AVALANCHE_ENDPOINT)
      @api_key = api_key.to_s.strip
      raise ConfigError, "api_key must not be empty" if @api_key.empty?
      raise ConfigError, "timeout must be positive" unless timeout.is_a?(Numeric) && timeout.finite? && timeout.positive?

      @endpoint = URLs.normalize_endpoint(endpoint)
      @avalanche_endpoint = URLs.normalize_endpoint(avalanche_endpoint)
      @account_endpoint = URLs.normalize_endpoint(account_endpoint)
      @user_endpoint = URLs.normalize_endpoint(user_endpoint)
      @headers = headers.to_h.transform_keys(&:to_s).transform_values(&:to_s).freeze
      @timeout = timeout.to_f
    end

    def inspect
      "#<#{self.class} api_key=[REDACTED] endpoint=#{endpoint.inspect} " \
        "avalanche_endpoint=#{avalanche_endpoint.inspect} " \
        "account_endpoint=#{account_endpoint.inspect} user_endpoint=#{user_endpoint.inspect} " \
        "header_names=#{headers.keys.inspect} timeout=#{timeout.inspect}>"
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
