# frozen_string_literal: true

require "uri"
require "base64"

module ERPC
  class Error < StandardError; end

  class ConfigError < Error; end
  class NotConfiguredError < Error
    attr_reader :namespace

    def initialize(namespace)
      @namespace = namespace.to_s.freeze
      super("ERPC namespace #{@namespace.inspect} is not configured")
    end
  end
  class BatchPolicyError < Error; end
  class InvalidResponseError < Error; end
  class TransportError < Error; end

  class TimeoutError < TransportError
    attr_reader :timeout

    def initialize(timeout)
      @timeout = timeout
      super("ERPC request timed out after #{timeout} seconds")
    end
  end

  class HttpError < Error
    attr_reader :status

    def initialize(status)
      @status = status
      super("ERPC returned HTTP status #{status}")
    end
  end

  class JsonRpcError < Error
    attr_reader :code, :data

    def initialize(code, message, data = nil)
      @code = code
      @data = data
      super(message)
    end
  end

  module Redaction
    module_function

    PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/.freeze

    def text(value, credential)
      result = value.to_s
      variants(credential).each do |secret|
        result = result.gsub(secret, "[REDACTED]") unless secret.empty?
        next unless secret.match?(PERCENT_ESCAPE)

        result = result.gsub(percent_escape_pattern(secret), "[REDACTED]")
      end
      result
    end

    def value(value, credential, depth = 0)
      return "[REDACTED]" if depth >= 32

      case value
      when String
        text(value, credential)
      when Array
        value.map { |item| self.value(item, credential, depth + 1) }
      when Hash
        value.to_h do |key, item|
          [key.is_a?(String) ? text(key, credential) : key, self.value(item, credential, depth + 1)]
        end
      else
        value
      end
    end

    def variants(credential)
      values = credential.is_a?(Array) ? credential : [credential]
      encoded = values.flat_map do |value|
        next [] if value.nil? || value.to_s.empty?

        text = value.to_s
        percent_encoded = text.b.each_byte.map do |byte|
          character = byte.chr
          character.match?(/[A-Za-z0-9_.~-]/) ? character : format("%%%02X", byte)
        end.join
        [
          text,
          URI.encode_www_form_component(text),
          percent_encoded
        ]
      end
      encoded.uniq.sort_by { |value| [-value.length, value] }
    end
    private_class_method :variants

    def percent_escape_pattern(value)
      escaped = Regexp.escape(value.to_s)
      pattern = escaped.gsub(PERCENT_ESCAPE) do |escape|
        "%#{percent_character_class(escape[1])}#{percent_character_class(escape[2])}"
      end
      Regexp.new(pattern)
    end
    private_class_method :percent_escape_pattern

    def percent_character_class(value)
      "[#{[value.upcase, value.downcase].uniq.join}]"
    end
    private_class_method :percent_character_class

    def direct_variants(http_url:, websocket_url: nil, headers: {})
      values = []
      [http_url, websocket_url].compact.each do |endpoint|
        query = URI.parse(endpoint).query.to_s
        query.split("&").each do |component|
          next if component.empty?

          raw_value = component.include?("=") ? component.split("=", 2).last : component
          next if raw_value.empty?

          values << raw_value
          begin
            values << URI.decode_www_form_component(raw_value)
          rescue ArgumentError
            # The endpoint validator rejects invalid percent escapes. Keep
            # the raw value as a defensive fallback for caller-built objects.
          end
        end
      end

      headers.each do |name, value|
        next unless value.is_a?(String) && !value.empty?

        values << value
        next unless %w[authorization proxy-authorization].include?(name.to_s.downcase)

        parts = value.strip.split(/\s+/, 2)
        next unless parts.length == 2 && %w[bearer basic].include?(parts.first.downcase)

        credential = parts.last
        values << credential
        next unless parts.first.casecmp?("basic")

        begin
          decoded = Base64.strict_decode64(credential).force_encoding(Encoding::UTF_8)
          values << decoded
          if decoded.include?(":")
            username, password = decoded.split(":", 2)
            values << username << password
          end
        rescue ArgumentError, EncodingError
          # Raw and encoded forms above still cover malformed Basic values.
        end
      end

      variants(values)
    end
  end
end
