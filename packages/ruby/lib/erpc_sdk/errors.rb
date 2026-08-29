# frozen_string_literal: true

require "uri"

module ERPC
  class Error < StandardError; end

  class ConfigError < Error; end
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

    def text(value, credential)
      result = value.to_s
      variants(credential).each { |secret| result = result.gsub(secret, "[REDACTED]") unless secret.empty? }
      result
    end

    def value(value, credential)
      case value
      when String
        text(value, credential)
      when Array
        value.map { |item| self.value(item, credential) }
      when Hash
        value.to_h do |key, item|
          [text(key, credential), self.value(item, credential)]
        end
      else
        value
      end
    end

    def variants(credential)
      percent_encoded = credential.to_s.b.each_byte.map do |byte|
        character = byte.chr
        character.match?(/[A-Za-z0-9_.~-]/) ? character : format("%%%02X", byte)
      end.join
      [credential.to_s, URI.encode_www_form_component(credential.to_s), percent_encoded].uniq
    end
    private_class_method :variants
  end
end
