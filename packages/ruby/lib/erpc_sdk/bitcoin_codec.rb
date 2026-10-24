# frozen_string_literal: true

require "bigdecimal"
require "json"

require_relative "errors"

module ERPC
  # The resource and numeric limits are intentionally private to the new
  # Bitcoin decoder.  Existing JSON-RPC namespaces continue to use their
  # released parser and limits.
  BitcoinResponseLimits = Struct.new(
    :decoded_entity_bytes,
    :container_depth,
    :json_tokens,
    :numeric_lexeme_bytes,
    :coefficient_digits,
    :explicit_exponent_min,
    :explicit_exponent_max,
    :canonical_exponent_min,
    :canonical_exponent_max,
    keyword_init: true
  ) do
    def initialize(**values)
      super
      each_pair { |key, value| self[key] = Integer(value) }
      freeze
    end
  end

  BITCOIN_RESPONSE_LIMITS = BitcoinResponseLimits.new(
    decoded_entity_bytes: 67_108_864,
    container_depth: 64,
    json_tokens: 1_000_000,
    numeric_lexeme_bytes: 1_024,
    coefficient_digits: 1_000,
    explicit_exponent_min: -10_000,
    explicit_exponent_max: 10_000,
    canonical_exponent_min: -10_000,
    canonical_exponent_max: 10_000
  )

  BitcoinNumberTuple = Struct.new(:sign, :coefficient, :exponent10, keyword_init: true) do
    def initialize(sign:, coefficient:, exponent10:)
      super
      freeze
    end
  end

  # Scanner metadata is deliberately small: the parsed JSON object is still
  # constructed by Ruby's JSON parser, while this metadata lets the typed
  # block-count projection retain the selected original result token.
  BitcoinPreflightResult = Struct.new(
    :token_count,
    :numeric_token_count,
    :max_depth,
    :number_tokens,
    :root_result_token,
    keyword_init: true
  ) do
    def initialize(**values)
      values[:number_tokens] = values.fetch(:number_tokens).freeze
      super
      freeze
    end
  end

  BitcoinNumberToken = Struct.new(:raw, :integer, :tuple, keyword_init: true) do
    def initialize(raw:, integer:, tuple:)
      super
      freeze
    end
  end

  module BitcoinCodec
    module_function

    INTEGER_TOKEN = /\A-?(?:0|[1-9][0-9]*)\z/.freeze
    UNSIGNED_INTEGER_TOKEN = /\A(?:0|[1-9][0-9]*)\z/.freeze
    NUMBER_TOKEN = /\A(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?\z/.freeze
    TOKEN_DELIMITERS = " \t\r\n,:[}]".freeze

    # Canonicalize one original JSON number lexeme without converting it to a
    # floating point value or expanding an exponent.
    def canonicalize_number(raw, limits: BITCOIN_RESPONSE_LIMITS)
      unless raw.is_a?(String) && raw.ascii_only? && raw.bytesize <= limits.numeric_lexeme_bytes
        invalid_response!
      end

      match = NUMBER_TOKEN.match(raw)
      invalid_response! unless match

      sign_token, integer_part, fraction_part, exponent_part = match.captures
      fraction_part ||= ""
      explicit_exponent = checked_exponent(exponent_part || "0", limits: limits)
      raw_coefficient = integer_part + fraction_part
      invalid_response! if raw_coefficient.length > limits.coefficient_digits

      without_leading_zeroes = raw_coefficient.sub(/\A0+/, "")
      return BitcoinNumberTuple.new(sign: 0, coefficient: "0", exponent10: "0") if without_leading_zeroes.empty?

      coefficient = without_leading_zeroes.sub(/0+\z/, "")
      trailing_zeroes = without_leading_zeroes.length - coefficient.length
      exponent10 = explicit_exponent - fraction_part.length + trailing_zeroes
      unless exponent10.between?(limits.canonical_exponent_min, limits.canonical_exponent_max)
        invalid_response!
      end

      BitcoinNumberTuple.new(
        sign: sign_token == "-" ? -1 : 1,
        coefficient: coefficient,
        exponent10: exponent10.to_s
      )
    end

    alias canonicalize_bitcoin_number canonicalize_number
    module_function :canonicalize_bitcoin_number

    def preflight(text, limits: BITCOIN_RESPONSE_LIMITS)
      invalid_response! unless text.is_a?(String)
      invalid_response! unless text.encoding == Encoding::UTF_8 && text.valid_encoding?

      scanner = Scanner.new(text, limits)
      scanner.run
    rescue InvalidResponseError
      raise
    rescue StandardError
      invalid_response!
    end

    alias preflight_bitcoin_json preflight
    module_function :preflight_bitcoin_json

    def decode(text, expected_id, redactions: [], projector: nil, limits: BITCOIN_RESPONSE_LIMITS)
      metadata = preflight(text, limits: limits)
      response = parse_document(text, metadata, limits: limits)
      unless response.is_a?(Hash)
        invalid_response!
      end

      actual_id = response["id"]
      unless valid_response_id?(actual_id) && actual_id == expected_id
        invalid_response!
      end

      if response.key?("error") && !response["error"].nil?
        raise_rpc_error(response["error"], redactions)
      end
      invalid_response! unless response.key?("result")

      if projector
        begin
          return projector.call(response["result"], metadata.root_result_token)
        rescue InvalidResponseError
          raise
        rescue StandardError
          invalid_response!
        end
      end

      response["result"]
    rescue InvalidResponseError
      raise
    rescue JSON::ParserError, JSON::NestingError, ArgumentError, EncodingError, SystemStackError
      invalid_response!
    end

    alias unwrap_bitcoin_rpc_response decode
    module_function :unwrap_bitcoin_rpc_response

    def as_string(value, _token = nil)
      invalid_response! unless value.is_a?(String)

      value
    end

    alias as_bitcoin_string as_string
    module_function :as_bitcoin_string

    def as_block_count(value, token = nil)
      raw = token.is_a?(BitcoinNumberToken) ? token.raw : nil
      invalid_response! unless raw&.match?(UNSIGNED_INTEGER_TOKEN)
      invalid_response! unless value.is_a?(Integer) && !value.is_a?(TrueClass) && value >= 0
      invalid_response! if value > 18_446_744_073_709_551_615
      value
    end

    alias as_bitcoin_block_count as_block_count
    module_function :as_bitcoin_block_count

    def as_nullable_object(value, _token = nil)
      return nil if value.nil?

      invalid_response! unless value.is_a?(Hash)

      value
    end

    alias as_bitcoin_nullable_object as_nullable_object
    module_function :as_bitcoin_nullable_object

    def invalid_response!
      raise InvalidResponseError.new("ERPC returned an invalid Bitcoin response"), cause: nil
    end
    private_class_method :invalid_response!

    def checked_exponent(raw, limits: BITCOIN_RESPONSE_LIMITS)
      sign = raw.start_with?("-") ? -1 : 1
      digits = raw.start_with?("+", "-") ? raw[1..] : raw
      invalid_response! if digits.nil? || digits.empty?

      normalized = digits.sub(/\A0+/, "")
      normalized = "0" if normalized.empty?
      value = 0
      normalized.each_byte do |byte|
        invalid_response! unless byte.between?(48, 57)

        value = (value * 10) + byte - 48
        invalid_response! if value > limits.explicit_exponent_max
      end
      result = sign * value
      invalid_response! unless result.between?(limits.explicit_exponent_min, limits.explicit_exponent_max)

      result
    end
    private_class_method :checked_exponent

    def parse_document(text, metadata, limits: BITCOIN_RESPONSE_LIMITS)
      decimal_tokens = metadata.number_tokens.reject(&:integer)
      decimal_index = 0
      adapter = Class.new do
        define_singleton_method(:new) do |raw|
          descriptor = decimal_tokens.fetch(decimal_index) do
            BitcoinCodec.send(:invalid_response!)
          end
          decimal_index += 1
          BitcoinCodec.send(:invalid_response!) unless raw == descriptor.raw

          value = BigDecimal(raw)
          tuple = BitcoinCodec.send(:big_decimal_tuple, value, limits: limits)
          if !value.finite? || (descriptor.tuple.sign != 0 && value.zero?) || tuple != descriptor.tuple
            BitcoinCodec.send(:invalid_response!)
          end
          value
        rescue InvalidResponseError
          raise
        rescue StandardError
          BitcoinCodec.send(:invalid_response!)
        end
      end

      JSON.parse(
        text,
        create_additions: false,
        allow_nan: false,
        max_nesting: limits.container_depth,
        decimal_class: adapter
      )
    rescue InvalidResponseError
      raise
    rescue JSON::ParserError, JSON::NestingError, ArgumentError, TypeError, SystemStackError
      invalid_response!
    end
    private_class_method :parse_document

    def big_decimal_tuple(value, limits: BITCOIN_RESPONSE_LIMITS)
      invalid_response! unless value.is_a?(BigDecimal) && value.finite?
      return BitcoinNumberTuple.new(sign: 0, coefficient: "0", exponent10: "0") if value.zero?

      sign, digits, _base, exponent = value.split
      coefficient = digits.sub(/\A0+/, "")
      invalid_response! if coefficient.empty?
      coefficient = coefficient.sub(/0+\z/, "")
      trailing_zeroes = digits.length - coefficient.length
      exponent10 = exponent - digits.length + trailing_zeroes
      invalid_response! unless exponent10.between?(limits.canonical_exponent_min, limits.canonical_exponent_max)

      BitcoinNumberTuple.new(
        sign: sign.negative? ? -1 : 1,
        coefficient: coefficient,
        exponent10: exponent10.to_s
      )
    end
    private_class_method :big_decimal_tuple

    def valid_response_id?(value)
      (value.is_a?(Integer) && !value.is_a?(TrueClass) && !value.is_a?(FalseClass)) || value.is_a?(String)
    end
    private_class_method :valid_response_id?

    def raise_rpc_error(error, redactions)
      unless error.is_a?(Hash) && error["code"].is_a?(Integer) &&
             !error["code"].is_a?(TrueClass) && !error["code"].is_a?(FalseClass) &&
             error["message"].is_a?(String)
        invalid_response!
      end

      credentials = redactions.is_a?(Array) ? redactions : [redactions]
      data = error.key?("data") ? Redaction.value(error["data"], credentials) : nil
      message = Redaction.text(error["message"], credentials)
      raise JsonRpcError.new(error["code"], message, data), cause: nil
    end
    private_class_method :raise_rpc_error

    class Scanner
      def initialize(text, limits)
        @text = text
        @limits = limits
        @index = 0
        @token_count = 0
        @numeric_token_count = 0
        @max_depth = 0
        @number_tokens = []
        @stack = []
        @root_result_token = nil
        @root_result_seen = false
      end

      def run
        skip_whitespace
        parse_value(root: true)
        skip_whitespace
        invalid! unless @index == @text.length
        invalid! unless @stack.empty?

        BitcoinPreflightResult.new(
          token_count: @token_count,
          numeric_token_count: @numeric_token_count,
          max_depth: @max_depth,
          number_tokens: @number_tokens,
          root_result_token: @root_result_seen ? @root_result_token : nil
        )
      rescue InvalidResponseError
        raise
      rescue StandardError
        invalid!
      end

      private

      def parse_value(root: false, object_key: nil)
        skip_whitespace
        invalid! if @index >= @text.length
        value_start = @index
        character = @text[@index]

        case character
        when '"'
          add_token
          scan_string
          mark_root_result(nil, object_key) if root || object_key == "result"
        when "{"
          add_token
          parse_object
          mark_root_result(nil, object_key) if root || object_key == "result"
        when "["
          add_token
          parse_array
          mark_root_result(nil, object_key) if root || object_key == "result"
        when "-", /[0-9]/
          raw = scan_number
          tuple = BitcoinCodec.canonicalize_number(raw, limits: @limits)
          token = BitcoinNumberToken.new(
            raw: raw,
            integer: !raw.include?(".") && !raw.match?(/[eE]/),
            tuple: tuple
          )
          @number_tokens << token
          @numeric_token_count += 1
          add_token
          mark_root_result(token, object_key) if root || object_key == "result"
        when "t"
          scan_literal("true")
          add_token
          mark_root_result(nil, object_key) if root || object_key == "result"
        when "f"
          scan_literal("false")
          add_token
          mark_root_result(nil, object_key) if root || object_key == "result"
        when "n"
          scan_literal("null")
          add_token
          mark_root_result(nil, object_key) if root || object_key == "result"
        else
          invalid!
        end
        value_start
      end

      def parse_object
        push_container("{")
        @index += 1
        skip_whitespace
        if current_character == "}"
          @index += 1
          pop_container("{")
          return
        end

        loop do
          invalid! unless current_character == '"'
          add_token
          key_start = @index
          scan_string
          key = decode_key(@text[key_start...@index])
          skip_whitespace
          invalid! unless current_character == ":"
          @index += 1
          parse_value(object_key: key)
          skip_whitespace
          case current_character
          when ","
            @index += 1
            skip_whitespace
          when "}"
            @index += 1
            pop_container("{")
            break
          else
            invalid!
          end
        end
      end

      def parse_array
        push_container("[")
        @index += 1
        skip_whitespace
        if current_character == "]"
          @index += 1
          pop_container("[")
          return
        end

        loop do
          parse_value
          skip_whitespace
          case current_character
          when ","
            @index += 1
            skip_whitespace
          when "]"
            @index += 1
            pop_container("[")
            break
          else
            invalid!
          end
        end
      end

      def push_container(type)
        @stack << type
        @max_depth = [@max_depth, @stack.length].max
        invalid! if @stack.length > @limits.container_depth
      end

      def pop_container(type)
        invalid! unless @stack.pop == type
      end

      def scan_string
        invalid! unless current_character == '"'
        @index += 1
        while @index < @text.length
          character = @text[@index]
          if character == '"'
            @index += 1
            return
          elsif character == "\\"
            @index += 1
            invalid! if @index >= @text.length
            escape = @text[@index]
            if escape == "u"
              4.times do
                @index += 1
                invalid! if @index >= @text.length || !@text[@index].match?(/[0-9A-Fa-f]/)
              end
            elsif !%w[" \\ / b f n r t].include?(escape)
              invalid!
            end
          elsif character.ord < 0x20
            invalid!
          end
          @index += 1
        end
        invalid!
      end

      def decode_key(raw)
        JSON.parse(raw, create_additions: false)
      rescue JSON::ParserError, ArgumentError, TypeError
        invalid!
      end

      def scan_number
        start = @index
        @index += 1 if current_character == "-"
        invalid! if @index >= @text.length
        if current_character == "0"
          @index += 1
          invalid! if digit?(current_character)
        elsif current_character&.match?(/[1-9]/)
          @index += 1 while digit?(current_character)
        else
          invalid!
        end

        if current_character == "."
          @index += 1
          fraction_start = @index
          @index += 1 while digit?(current_character)
          invalid! if @index == fraction_start
        end
        if %w[e E].include?(current_character)
          @index += 1
          @index += 1 if %w[+ -].include?(current_character)
          exponent_start = @index
          @index += 1 while digit?(current_character)
          invalid! if @index == exponent_start
        end
        unless @index >= @text.length || TOKEN_DELIMITERS.include?(current_character)
          invalid!
        end

        @text[start...@index]
      end

      def scan_literal(literal)
        invalid! unless @text[@index, literal.length] == literal
        @index += literal.length
        unless @index >= @text.length || TOKEN_DELIMITERS.include?(current_character)
          invalid!
        end
      end

      def mark_root_result(token, object_key)
        return unless @stack.empty? || (@stack.length == 1 && @stack.first == "{")
        return unless object_key == "result"

        @root_result_seen = true
        @root_result_token = token
      end

      def add_token
        @token_count += 1
        invalid! if @token_count > @limits.json_tokens
      end

      def skip_whitespace
        @index += 1 while @index < @text.length && " \t\r\n".include?(@text[@index])
      end

      def current_character
        @text[@index]
      end

      def digit?(character)
        character && character.match?(/[0-9]/)
      end

      def invalid!
        raise InvalidResponseError.new("ERPC returned an invalid Bitcoin response"), cause: nil
      end
    end
    private_constant :Scanner
  end

  BITCOIN_POLICY_ID = "bitcoin-exact-json-v1".freeze
  BITCOIN_CODEC = BitcoinCodec

  private_constant :BitcoinResponseLimits, :BITCOIN_RESPONSE_LIMITS, :BitcoinNumberTuple,
                   :BitcoinPreflightResult, :BitcoinNumberToken, :BitcoinCodec, :BITCOIN_CODEC
end
