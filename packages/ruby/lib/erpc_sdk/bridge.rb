# frozen_string_literal: true

require "base64"
require "json"
require "net/http"
require "openssl"
require "socket"
require "timeout"
require "uri"

require_relative "errors"
require_relative "config"
require_relative "transport"
require_relative "token_catalog"
require_relative "generated/bridge_capabilities"

module ERPC
  # Stable machine-readable errors for the optional, standalone Mayan adapter.
  module BridgeErrorCode
    INVALID_ARGUMENT = "BRIDGE_INVALID_ARGUMENT"
    UNSUPPORTED_ROUTE = "BRIDGE_UNSUPPORTED_ROUTE"
    PROVIDER_AUTH_REQUIRED = "BRIDGE_PROVIDER_AUTH_REQUIRED"
    PROVIDER_TRANSPORT = "BRIDGE_PROVIDER_TRANSPORT"
    PROVIDER_HTTP = "BRIDGE_PROVIDER_HTTP"
    PROVIDER_INVALID_RESPONSE = "BRIDGE_PROVIDER_INVALID_RESPONSE"
    QUOTE_UNAVAILABLE = "BRIDGE_QUOTE_UNAVAILABLE"
    QUOTE_EXPIRED = "BRIDGE_QUOTE_EXPIRED"
    QUOTE_MISMATCH = "BRIDGE_QUOTE_MISMATCH"
    BUILD_INVALID = "BRIDGE_BUILD_INVALID"
    STATUS_NOT_FOUND = "BRIDGE_STATUS_NOT_FOUND"
    TIMEOUT = "BRIDGE_TIMEOUT"
    ABORTED = "BRIDGE_ABORTED"

    BRIDGE_INVALID_ARGUMENT = INVALID_ARGUMENT
    BRIDGE_UNSUPPORTED_ROUTE = UNSUPPORTED_ROUTE
    BRIDGE_PROVIDER_AUTH_REQUIRED = PROVIDER_AUTH_REQUIRED
    BRIDGE_PROVIDER_TRANSPORT = PROVIDER_TRANSPORT
    BRIDGE_PROVIDER_HTTP = PROVIDER_HTTP
    BRIDGE_PROVIDER_INVALID_RESPONSE = PROVIDER_INVALID_RESPONSE
    BRIDGE_QUOTE_UNAVAILABLE = QUOTE_UNAVAILABLE
    BRIDGE_QUOTE_EXPIRED = QUOTE_EXPIRED
    BRIDGE_QUOTE_MISMATCH = QUOTE_MISMATCH
    BRIDGE_BUILD_INVALID = BUILD_INVALID
    BRIDGE_STATUS_NOT_FOUND = STATUS_NOT_FOUND
    BRIDGE_TIMEOUT = TIMEOUT
    BRIDGE_ABORTED = ABORTED

    ALL = [
      INVALID_ARGUMENT,
      UNSUPPORTED_ROUTE,
      PROVIDER_AUTH_REQUIRED,
      PROVIDER_TRANSPORT,
      PROVIDER_HTTP,
      PROVIDER_INVALID_RESPONSE,
      QUOTE_UNAVAILABLE,
      QUOTE_EXPIRED,
      QUOTE_MISMATCH,
      BUILD_INVALID,
      STATUS_NOT_FOUND,
      TIMEOUT,
      ABORTED
    ].freeze
  end

  BRIDGE_ERROR_MESSAGES = {
    BridgeErrorCode::INVALID_ARGUMENT => "Bridge request is invalid",
    BridgeErrorCode::UNSUPPORTED_ROUTE => "Bridge route is unsupported",
    BridgeErrorCode::PROVIDER_AUTH_REQUIRED => "Bridge provider authentication is required",
    BridgeErrorCode::PROVIDER_TRANSPORT => "Bridge provider transport failed",
    BridgeErrorCode::PROVIDER_HTTP => "Bridge provider HTTP request failed",
    BridgeErrorCode::PROVIDER_INVALID_RESPONSE => "Bridge provider response is invalid",
    BridgeErrorCode::QUOTE_UNAVAILABLE => "Bridge quote is unavailable",
    BridgeErrorCode::QUOTE_EXPIRED => "Bridge quote is expired",
    BridgeErrorCode::QUOTE_MISMATCH => "Bridge quote does not match the request",
    BridgeErrorCode::BUILD_INVALID => "Bridge provider build is invalid",
    BridgeErrorCode::STATUS_NOT_FOUND => "Bridge status was not found",
    BridgeErrorCode::TIMEOUT => "Bridge provider request timed out",
    BridgeErrorCode::ABORTED => "Bridge provider request was aborted"
  }.freeze

  class BridgeError < Error
    attr_reader :code, :status

    def initialize(code, status = nil)
      @code = code.to_s.freeze
      @status = status
      super(BRIDGE_ERROR_MESSAGES.fetch(@code, "Bridge provider request failed"))
    end
  end

  # Configuration for a standalone Mayan Swift v2 client.
  #
  # The adapter is deliberately independent from ClientConfig.  In particular,
  # no eRPC key, header, cookie, or route is copied into provider requests.
  class MayanSwiftV2BridgeConfig
    DEFAULT_BUILDER_ENDPOINT = "https://tx-builder.mayan.finance"
    DEFAULT_EXPLORER_ENDPOINT = "https://explorer-api.mayan.finance/v3"
    DEFAULT_TIMEOUT = 30.0

    attr_reader :builder_endpoint, :explorer_endpoint, :builder_api_key,
                :allow_unauthenticated_build, :minimum_quote_validity_seconds,
                :timeout, :http_adapter

    def initialize(builder_endpoint: DEFAULT_BUILDER_ENDPOINT,
                   explorer_endpoint: DEFAULT_EXPLORER_ENDPOINT,
                   builder_api_key: nil,
                   allow_unauthenticated_build: false,
                   minimum_quote_validity_seconds: 60,
                   timeout: DEFAULT_TIMEOUT,
                   http_adapter: nil,
                   **aliases)
      if aliases.key?(:builderEndpoint)
        builder_endpoint = aliases.delete(:builderEndpoint)
      end
      if aliases.key?(:explorerEndpoint)
        explorer_endpoint = aliases.delete(:explorerEndpoint)
      end
      if aliases.key?(:builderApiKey)
        builder_api_key = aliases.delete(:builderApiKey)
      end
      if aliases.key?(:allowUnauthenticatedBuild)
        allow_unauthenticated_build = aliases.delete(:allowUnauthenticatedBuild)
      end
      if aliases.key?(:minimumQuoteValiditySeconds)
        minimum_quote_validity_seconds = aliases.delete(:minimumQuoteValiditySeconds)
      end
      if aliases.key?(:timeoutSeconds)
        timeout = aliases.delete(:timeoutSeconds)
      end
      if aliases.key?(:timeout_seconds)
        timeout = aliases.delete(:timeout_seconds)
      end
      if aliases.key?(:timeout_ms)
        timeout = aliases.delete(:timeout_ms).to_f / 1000.0
      end
      if aliases.key?(:timeoutMs)
        timeout = aliases.delete(:timeoutMs).to_f / 1000.0
      end
      if aliases.key?(:httpAdapter)
        http_adapter = aliases.delete(:httpAdapter)
      end
      fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) unless aliases.empty?

      @builder_endpoint = normalize_endpoint(builder_endpoint)
      @explorer_endpoint = normalize_endpoint(explorer_endpoint)
      @builder_api_key = normalize_api_key(builder_api_key)
      unless allow_unauthenticated_build == true || allow_unauthenticated_build == false
        fail_bridge(BridgeErrorCode::INVALID_ARGUMENT)
      end
      unless minimum_quote_validity_seconds.is_a?(Integer) &&
             minimum_quote_validity_seconds >= 0 && minimum_quote_validity_seconds <= 300
        fail_bridge(BridgeErrorCode::INVALID_ARGUMENT)
      end
      unless timeout.is_a?(Numeric) && timeout.finite? && timeout.positive?
        fail_bridge(BridgeErrorCode::INVALID_ARGUMENT)
      end
      if !http_adapter.nil? && !http_adapter.respond_to?(:request)
        fail_bridge(BridgeErrorCode::INVALID_ARGUMENT)
      end

      @allow_unauthenticated_build = allow_unauthenticated_build
      @minimum_quote_validity_seconds = minimum_quote_validity_seconds
      @timeout = timeout.to_f
      @http_adapter = http_adapter
      freeze
    end

    def inspect
      key = builder_api_key.nil? ? nil : "[REDACTED]"
      adapter = http_adapter.nil? ? nil : "[configured]"
      "#<#{self.class} builder_endpoint=#{builder_endpoint.inspect} " \
        "explorer_endpoint=#{explorer_endpoint.inspect} " \
        "builder_api_key=#{key.inspect} " \
        "allow_unauthenticated_build=#{allow_unauthenticated_build.inspect} " \
        "minimum_quote_validity_seconds=#{minimum_quote_validity_seconds.inspect} " \
        "timeout=#{timeout.inspect} http_adapter=#{adapter.inspect}>"
    end

    alias to_s inspect

    private

    def fail_bridge(code)
      raise BridgeError.new(code), cause: nil
    end

    def normalize_api_key(value)
      return nil if value.nil?
      fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) unless value.is_a?(String)
      fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) unless value.ascii_only?
      fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) if value.each_byte.any? { |byte| byte < 0x20 || byte == 0x7f }

      value.empty? ? nil : value.dup.freeze
    end

    def normalize_endpoint(value)
      fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) unless value.is_a?(String)
      fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) if value.empty? || value.strip != value
      fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) if value.each_byte.any? { |byte| byte < 0x20 || byte == 0x7f }
      fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) unless value.match?(%r{\A[a-z][a-z\d+.-]*://}i)
      fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) if value.include?("?") || value.include?("#")

      uri = URI.parse(value)
      scheme = uri.scheme.to_s.downcase
      hostname = uri.hostname.to_s.downcase
      authority = value.split("://", 2).fetch(1).to_s.split(/[\/?#]/, 2).first.to_s
      fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) if authority.empty? || authority.include?("@")
      fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) if uri.host.to_s.empty? || uri.user || uri.password
      valid_http = scheme == "https" || (scheme == "http" && %w[localhost 127.0.0.1 ::1].include?(hostname))
      fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) unless valid_http
      begin
        port = uri.port
        fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) if port && (port.negative? || port > 65_535)
      rescue URI::InvalidURIError, ArgumentError
        fail_bridge(BridgeErrorCode::INVALID_ARGUMENT)
      end
      path = uri.path.to_s.sub(%r{/+\z}, "")
      uri.scheme = scheme
      uri.path = path.empty? ? "/" : path
      uri.query = nil
      uri.fragment = nil
      uri.to_s.freeze
    rescue URI::InvalidURIError, ArgumentError
      fail_bridge(BridgeErrorCode::INVALID_ARGUMENT)
    end
  end

  class MayanBridgeBodyTooLarge < StandardError; end

  # The bridge owns this small adapter so the response limit is enforced while
  # Net::HTTP reads chunks.  It never follows redirects and keeps the timeout
  # active for connection, headers, and body reads.
  class MayanBridgeHttpAdapter
    def initialize(max_response_bytes)
      @max_response_bytes = max_response_bytes
    end

    def request(method:, url:, headers:, body: nil, timeout: MayanSwiftV2BridgeConfig::DEFAULT_TIMEOUT)
      uri = URI.parse(url)
      request = request_class(method).new(uri.request_uri, headers)
      request.body = body unless body.nil?
      response = nil
      response_body = String.new(encoding: Encoding::BINARY)
      start(uri, timeout) do |http|
        http.request(request) do |candidate|
          response = candidate
          candidate.read_body do |chunk|
            response_body << chunk.b
            raise MayanBridgeBodyTooLarge if response_body.bytesize > @max_response_bytes
          end
        end
      end
      HttpResponse.new(status: response.code.to_i, body: response_body)
    rescue MayanBridgeBodyTooLarge
      raise
    rescue Net::OpenTimeout, Net::ReadTimeout, Net::WriteTimeout
      raise TimeoutError, timeout, cause: nil
    rescue IOError, EOFError, SocketError, SystemCallError, OpenSSL::SSL::SSLError, URI::InvalidURIError
      raise TransportError, "Unable to reach bridge provider", cause: nil
    end

    private

    def start(uri, timeout, &block)
      Net::HTTP.start(
        uri.host,
        uri.port,
        use_ssl: uri.scheme == "https",
        open_timeout: timeout,
        read_timeout: timeout,
        write_timeout: timeout,
        &block
      )
    end

    def request_class(method)
      { get: Net::HTTP::Get, post: Net::HTTP::Post }.fetch(method.to_sym)
    end
  end

  JsonNode = Struct.new(:value, :start, :end, :object_entries, :array_items, :raw_number,
                        keyword_init: true)
  DirectionFacts = Struct.new(
    :bridge_capability_id, :source_chain_id, :destination_chain_id,
    :source_token_deployment_id, :destination_token_deployment_id,
    :source_token_address, :destination_token_address,
    :source_token_standard, :destination_token_standard,
    :source_provider_chain_id, :destination_provider_chain_id,
    :source_wormhole_chain_id, :destination_wormhole_chain_id,
    :source_name, :destination_name, :source_eurc_mint, :destination_eurc_mint,
    :source_usdc_deployment_id, :source_usdc_address, :source_usdc_standard,
    :swift_contract, keyword_init: true
  )
  NormalizedRoute = Struct.new(:request, :facts, :capability, keyword_init: true)

  class StrictJsonParser
    NUMBER = /\G-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.freeze
    MAX_DEPTH = 32

    def initialize(source)
      @source = source
      @index = 0
    end

    def parse
      skip_whitespace
      result = value(0)
      skip_whitespace
      invalid unless @index == @source.length
      result
    rescue BridgeError => error
      raise error, cause: nil
    rescue StandardError
      invalid
    end

    private

    def value(depth)
      invalid if depth > MAX_DEPTH
      start = @index
      character = @source[@index]
      case character
      when "{"
        object(start, depth)
      when "["
        array(start, depth)
      when '"'
        JsonNode.new(value: string, start: start, end: @index)
      else
        if @source[@index, 4] == "true"
          @index += 4
          JsonNode.new(value: true, start: start, end: @index)
        elsif @source[@index, 5] == "false"
          @index += 5
          JsonNode.new(value: false, start: start, end: @index)
        elsif @source[@index, 4] == "null"
          @index += 4
          JsonNode.new(value: nil, start: start, end: @index)
        elsif character == "-" || (character && character.match?(/[0-9]/))
          raw = number
          numeric = if raw.include?(".") || raw.match?(/[eE]/)
                      Float(raw)
                    else
                      integer = Integer(raw, 10)
                      invalid unless Float(raw).finite?
                      integer
                    end
          invalid unless numeric.finite?
          JsonNode.new(value: numeric, start: start, end: @index, raw_number: raw)
        else
          invalid
        end
      end
    end

    def object(start, depth)
      @index += 1
      skip_whitespace
      values = {}
      entries = {}
      return finish_object(start, values, entries) if @source[@index] == "}"

      loop do
        invalid unless @source[@index] == '"'
        key = string
        invalid if entries.key?(key)
        skip_whitespace
        invalid unless @source[@index] == ":"
        @index += 1
        skip_whitespace
        child = value(depth + 1)
        values[key] = child.value
        entries[key] = child
        skip_whitespace
        delimiter = @source[@index]
        return finish_object(start, values, entries) if delimiter == "}"
        invalid unless delimiter == ","
        @index += 1
        skip_whitespace
      end
    end

    def finish_object(start, values, entries)
      @index += 1
      JsonNode.new(value: values, start: start, end: @index, object_entries: entries)
    end

    def array(start, depth)
      @index += 1
      skip_whitespace
      values = []
      entries = []
      if @source[@index] == "]"
        @index += 1
        return JsonNode.new(value: values, start: start, end: @index, array_items: entries)
      end
      loop do
        child = value(depth + 1)
        values << child.value
        entries << child
        skip_whitespace
        delimiter = @source[@index]
        if delimiter == "]"
          @index += 1
          return JsonNode.new(value: values, start: start, end: @index, array_items: entries)
        end
        invalid unless delimiter == ","
        @index += 1
        skip_whitespace
      end
    end

    def string
      start = @index
      @index += 1
      while @index < @source.length
        character = @source[@index]
        if character == '"'
          @index += 1
          raw = @source[start...@index]
          begin
            parsed = JSON.parse(raw)
          rescue JSON::ParserError
            invalid
          end
          invalid unless parsed.is_a?(String)
          return parsed
        end
        if character == "\\"
          @index += 1
          invalid if @index >= @source.length
          escape = @source[@index]
          if escape == "u"
            digits = @source[(@index + 1), 4]
            invalid unless digits && digits.match?(/\A[0-9a-fA-F]{4}\z/)
            @index += 5
            next
          end
          invalid unless escape && '"\\/bfnrt'.include?(escape)
          @index += 1
          next
        end
        invalid if character.nil? || character.ord < 0x20
        @index += 1
      end
      invalid
    end

    def number
      match = NUMBER.match(@source, @index)
      invalid unless match
      raw = match[0]
      @index = match.end(0)
      raw
    end

    def skip_whitespace
      @index += 1 while @index < @source.length && " \n\r\t".include?(@source[@index])
    end

    def invalid
      raise BridgeError.new(BridgeErrorCode::PROVIDER_INVALID_RESPONSE), cause: nil
    end
  end

  class MayanSwiftV2BridgeClient
    ETHEREUM_CHAIN_ID = TokenChainIDs::ETHEREUM_MAINNET
    SOLANA_CHAIN_ID = TokenChainIDs::SOLANA_MAINNET
    ETHEREUM_NAME = "ethereum"
    SOLANA_NAME = "solana"
    ETHEREUM_PROVIDER_CHAIN_ID = 1
    SOLANA_PROVIDER_CHAIN_ID = 0
    ETHEREUM_WORMHOLE_CHAIN_ID = 2
    SOLANA_WORMHOLE_CHAIN_ID = 1
    ETHEREUM_EURC_DEPLOYMENT_ID = "deployment-0011"
    SOLANA_EURC_DEPLOYMENT_ID = "deployment-0013"
    ETHEREUM_USDC_DEPLOYMENT_ID = "deployment-0008"
    SOLANA_USDC_DEPLOYMENT_ID = "deployment-0010"
    ETHEREUM_EURC_ADDRESS = "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c"
    SOLANA_EURC_ADDRESS = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr"
    ETHEREUM_USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
    SOLANA_USDC_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    ETHEREUM_SWIFT_CONTRACT = "0x40ffe85a28dc9993541449464d7529a922142960"
    SOLANA_SWIFT_PROGRAM = "mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny"
    ETHEREUM_FORWARDER = "0x337685fdab40d39bd02028545a4ffa7d287cc3e2"
    SOLANA_JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
    ETHEREUM_FORWARDER_SELECTOR = "0x30dedc57"
    DEFAULT_BUILDER_ENDPOINT = MayanSwiftV2BridgeConfig::DEFAULT_BUILDER_ENDPOINT
    DEFAULT_EXPLORER_ENDPOINT = MayanSwiftV2BridgeConfig::DEFAULT_EXPLORER_ENDPOINT
    DEFAULT_TIMEOUT = MayanSwiftV2BridgeConfig::DEFAULT_TIMEOUT
    MAX_RESPONSE_BYTES = 1024 * 1024
    MAX_RAW_QUOTE_BYTES = 256 * 1024
    MAX_QUOTES = 16
    UINT64_MAX = (1 << 64) - 1
    MAX_SAFE_INTEGER = (1 << 53) - 1
    BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    BASE58_INDEX = BASE58_ALPHABET.each_char.with_index.to_h.freeze
    BASE_DEPENDENCIES = [
      "mayan-hosted-quote-api",
      "mayan-hosted-transaction-builder",
      "mayan-hosted-source-swap-builder",
      "swift-auction-solvers",
      "relayers",
      "wormhole-guardian-messaging",
      "mayan-explorer-indexer"
    ].freeze

    EVM_ADDRESS = /\A0x[0-9a-fA-F]{40}\z/.freeze
    EVM_HASH = /\A0x[0-9a-fA-F]{64}\z/.freeze
    QUOTE_ID = /\A0x[0-9a-fA-F]{32}\z/.freeze
    EVM_SIGNATURE = /\A0x[0-9a-fA-F]{130}\z/.freeze
    HEX_BYTES = /\A0x[0-9a-fA-F]*\z/.freeze
    POSITIVE_UINT64 = /\A[1-9][0-9]*\z/.freeze
    CANONICAL_UINT64 = /\A(?:0|[1-9][0-9]*)\z/.freeze
    BASE64 = /\A(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?\z/.freeze
    QUOTE_KEYS = %w[
      quoteKind providerId sourceChainId destinationChainId sourceTokenDeploymentId
      destinationTokenDeploymentId amountIn expectedAmountOut minimumAmountOut
      minimumReceived deadline slippageBps quoteId providerSignature sourceSwap
      dependencies quoteVerification rawSignedQuoteJson
    ].freeze
    SOURCE_SWAP_KEYS = %w[
      required inputTokenDeploymentId intermediateTokenDeploymentId
      intermediateTokenAddress intermediateTokenStandard intermediateTokenDecimals
      providerMinimumAmount routerKind routerAddress
    ].freeze

    attr_reader :config

    def initialize(config = nil, http_adapter: nil, adapter: nil, **config_keywords)
      if !config_keywords.empty?
        fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) unless config.nil?
        config = config_keywords
      end
      @config = normalize_config(config, http_adapter || adapter)
      @http_adapter = @config.http_adapter || MayanBridgeHttpAdapter.new(MAX_RESPONSE_BYTES)
      @clock = -> { Time.now.to_i }
      @closed = false
    end

    def inspect
      "#<#{self.class} config=#{config.inspect}>"
    end

    def quote_exact_input(request, options = nil, **keyword_options)
      route = validate_route(deep_dup(request))
      check_aborted(options || keyword_options)
      body = quote_request_body(route)
      response_text = provider_request(
        endpoint_with_path(@config.builder_endpoint, "/quote"),
        :post,
        body,
        include_builder_key: false,
        operation: :quote,
        options: options || keyword_options
      )
      root = parse_provider_response(response_text)
      selected = quotes_from_response(root, response_text, route.request, route.facts)
      check_aborted(options || keyword_options)
      deep_freeze(selected)
    end

    alias quoteExactInput quote_exact_input

    def build_unsigned(request, options = nil, **keyword_options)
      snapshot = build_request_snapshot(request)
      route, quote = build_route_from_quote(snapshot.fetch("quote"))
      reject_address_from_other_chain(snapshot.fetch("swapperAddress"), route.facts.source_chain_id)
      source_address = normalize_chain_address(
        snapshot.fetch("swapperAddress"), route.facts.source_chain_id, BridgeErrorCode::INVALID_ARGUMENT
      )
      destination_address = normalize_destination_address(
        snapshot.fetch("destinationAddress"), route.facts.destination_chain_id
      )
      refund_address = if snapshot.key?("refundAddress")
                         normalize_chain_address(
                           snapshot["refundAddress"], route.facts.source_chain_id, BridgeErrorCode::INVALID_ARGUMENT
                         )
                       end
      check_aborted(options || keyword_options)
      if @config.builder_api_key.nil? && !@config.allow_unauthenticated_build
        fail_bridge(BridgeErrorCode::PROVIDER_AUTH_REQUIRED)
      end
      quote = validate_raw_quote_for_build(quote, route)
      params = { "swapperAddress" => source_address, "destinationAddress" => destination_address }
      params["signerChainId"] = 1 if route.facts.source_chain_id == ETHEREUM_CHAIN_ID
      params["swiftRefundAddress"] = refund_address unless refund_address.nil?
      body = %({"quote":#{quote.fetch("rawSignedQuoteJson")},"params":#{JSON.generate(params)}})
      response_text = provider_request(
        endpoint_with_path(@config.builder_endpoint, "/build"),
        :post,
        body,
        include_builder_key: true,
        operation: :build,
        options: options || keyword_options
      )
      root = parse_provider_response(response_text)
      ensure_quote_deadline(normalize_positive_uint64(quote.fetch("deadline"), BridgeErrorCode::QUOTE_EXPIRED).last)
      result = validate_build_response(root, response_text, quote, route.facts, source_address)
      check_aborted(options || keyword_options)
      deep_freeze(result)
    end

    alias buildUnsigned build_unsigned

    def get_status(request, options = nil, **keyword_options)
      normalized = normalize_status_request(request)
      check_aborted(options || keyword_options)
      encoded = URLs.escape_path(normalized.fetch("sourceTransactionHash"))
      response_text = provider_request(
        endpoint_with_path(@config.explorer_endpoint, "/swap/trx/#{encoded}"),
        :get,
        nil,
        include_builder_key: false,
        operation: :status,
        options: options || keyword_options
      )
      result = status_from_response(parse_provider_response(response_text), response_text, normalized)
      check_aborted(options || keyword_options)
      deep_freeze(result)
    end

    alias getStatus get_status

    def close
      return if @closed

      @closed = true
      # The default adapter has no persistent client owned by this object, and
      # externally supplied adapters must remain open for their owner.
      nil
    end

    private

    def normalize_config(value, injected_adapter)
      if value.nil?
        config = MayanSwiftV2BridgeConfig.new(http_adapter: injected_adapter)
      elsif value.is_a?(MayanSwiftV2BridgeConfig)
        if injected_adapter.nil?
          config = value
        else
          config = MayanSwiftV2BridgeConfig.new(
            builder_endpoint: value.builder_endpoint,
            explorer_endpoint: value.explorer_endpoint,
            builder_api_key: value.builder_api_key,
            allow_unauthenticated_build: value.allow_unauthenticated_build,
            minimum_quote_validity_seconds: value.minimum_quote_validity_seconds,
            timeout: value.timeout,
            http_adapter: injected_adapter
          )
        end
      elsif value.is_a?(Hash)
        source = value.dup
        aliases = {
          "builderEndpoint" => :builder_endpoint,
          "explorerEndpoint" => :explorer_endpoint,
          "builderApiKey" => :builder_api_key,
          "allowUnauthenticatedBuild" => :allow_unauthenticated_build,
          "minimumQuoteValiditySeconds" => :minimum_quote_validity_seconds,
          "timeoutMs" => :timeout_ms,
          "httpAdapter" => :http_adapter
        }
        normalized = {}
        source.each do |key, item|
          symbol = key.is_a?(String) ? aliases.fetch(key, key.to_sym) : key
          fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) unless symbol.is_a?(Symbol)
          fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) if normalized.key?(symbol)
          normalized[symbol] = item
        end
        if injected_adapter
          fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) if normalized.key?(:http_adapter)
          normalized[:http_adapter] = injected_adapter
        end
        config = MayanSwiftV2BridgeConfig.new(**normalized)
      else
        fail_bridge(BridgeErrorCode::INVALID_ARGUMENT)
      end
      config
    rescue ArgumentError, TypeError
      fail_bridge(BridgeErrorCode::INVALID_ARGUMENT)
    end

    def fail_bridge(code, status = nil)
      raise BridgeError.new(code, status), cause: nil
    end

    def require_record(value, code)
      fail_bridge(code) unless value.is_a?(Hash) && value.keys.all? { |key| key.is_a?(String) }
      value
    end

    def require_string(value, code, allow_empty: false)
      fail_bridge(code) unless value.is_a?(String) && (allow_empty || !value.empty?)
      value
    end

    def exact_keys(value, expected, code)
      fail_bridge(code) unless value.keys.sort == expected.sort && value.length == expected.length
    end

    def normalize_evm_address(value, code)
      address = require_string(value, code)
      fail_bridge(code) unless EVM_ADDRESS.match?(address) && address.downcase != "0x#{'0' * 40}"
      address.downcase
    end

    def normalize_positive_uint64(value, code)
      text = require_string(value, code)
      fail_bridge(code) unless text.length <= 20 && POSITIVE_UINT64.match?(text)
      parsed = Integer(text, 10)
      fail_bridge(code) if parsed <= 0 || parsed > UINT64_MAX
      [text, parsed]
    rescue ArgumentError
      fail_bridge(code)
    end

    def normalize_canonical_uint64(value, code)
      text = require_string(value, code)
      fail_bridge(code) unless text.length <= 20 && CANONICAL_UINT64.match?(text)
      parsed = Integer(text, 10)
      fail_bridge(code) if parsed > UINT64_MAX
      [text, parsed]
    rescue ArgumentError
      fail_bridge(code)
    end

    def normalize_slippage(value, code)
      fail_bridge(code) unless value.is_a?(Integer) && !value.is_a?(TrueClass) && value.between?(0, 500)
      value
    end

    def direction_facts(source_chain_id, destination_chain_id)
      if source_chain_id == ETHEREUM_CHAIN_ID && destination_chain_id == SOLANA_CHAIN_ID
        return DirectionFacts.new(
          bridge_capability_id: "bridge-mayan-swift-v2-eurc-eth-sol",
          source_chain_id: source_chain_id, destination_chain_id: destination_chain_id,
          source_token_deployment_id: ETHEREUM_EURC_DEPLOYMENT_ID,
          destination_token_deployment_id: SOLANA_EURC_DEPLOYMENT_ID,
          source_token_address: ETHEREUM_EURC_ADDRESS, destination_token_address: SOLANA_EURC_ADDRESS,
          source_token_standard: "erc20", destination_token_standard: "spl-token",
          source_provider_chain_id: ETHEREUM_PROVIDER_CHAIN_ID, destination_provider_chain_id: SOLANA_PROVIDER_CHAIN_ID,
          source_wormhole_chain_id: ETHEREUM_WORMHOLE_CHAIN_ID, destination_wormhole_chain_id: SOLANA_WORMHOLE_CHAIN_ID,
          source_name: ETHEREUM_NAME, destination_name: SOLANA_NAME,
          source_eurc_mint: "", destination_eurc_mint: SOLANA_EURC_ADDRESS,
          source_usdc_deployment_id: ETHEREUM_USDC_DEPLOYMENT_ID,
          source_usdc_address: ETHEREUM_USDC_ADDRESS, source_usdc_standard: "erc20",
          swift_contract: ETHEREUM_SWIFT_CONTRACT
        )
      end
      if source_chain_id == SOLANA_CHAIN_ID && destination_chain_id == ETHEREUM_CHAIN_ID
        return DirectionFacts.new(
          bridge_capability_id: "bridge-mayan-swift-v2-eurc-sol-eth",
          source_chain_id: source_chain_id, destination_chain_id: destination_chain_id,
          source_token_deployment_id: SOLANA_EURC_DEPLOYMENT_ID,
          destination_token_deployment_id: ETHEREUM_EURC_DEPLOYMENT_ID,
          source_token_address: SOLANA_EURC_ADDRESS, destination_token_address: ETHEREUM_EURC_ADDRESS,
          source_token_standard: "spl-token", destination_token_standard: "erc20",
          source_provider_chain_id: SOLANA_PROVIDER_CHAIN_ID, destination_provider_chain_id: ETHEREUM_PROVIDER_CHAIN_ID,
          source_wormhole_chain_id: SOLANA_WORMHOLE_CHAIN_ID, destination_wormhole_chain_id: ETHEREUM_WORMHOLE_CHAIN_ID,
          source_name: SOLANA_NAME, destination_name: ETHEREUM_NAME,
          source_eurc_mint: SOLANA_EURC_ADDRESS, destination_eurc_mint: "",
          source_usdc_deployment_id: SOLANA_USDC_DEPLOYMENT_ID,
          source_usdc_address: SOLANA_USDC_ADDRESS, source_usdc_standard: "spl-token",
          swift_contract: SOLANA_SWIFT_PROGRAM
        )
      end
      fail_bridge(BridgeErrorCode::UNSUPPORTED_ROUTE)
    end

    def catalog_token_matches?(deployment_id, chain_id, address, standard)
      token = TokenCatalog.get_token_deployment(deployment_id)
      return false unless token && token[:status] == "active" && token[:address].is_a?(String)

      address_matches = chain_id == ETHEREUM_CHAIN_ID ? token[:address].casecmp?(address) : token[:address] == address
      token[:deployment_id] == deployment_id && token[:chain_id] == chain_id && address_matches &&
        token[:standard] == standard && token[:decimals] == 6
    end

    def capability_records
      parsed = JSON.parse(BRIDGE_CAPABILITIES_JSON)
      parsed.is_a?(Array) ? parsed : []
    rescue JSON::ParserError
      []
    end

    def validate_capability(facts)
      capability = capability_records.find do |entry|
        entry.is_a?(Hash) && entry["bridgeCapabilityId"] == facts.bridge_capability_id &&
          entry["sourceChainId"] == facts.source_chain_id && entry["destinationChainId"] == facts.destination_chain_id &&
          entry["sourceTokenDeploymentId"] == facts.source_token_deployment_id &&
          entry["destinationTokenDeploymentId"] == facts.destination_token_deployment_id
      end
      fail_bridge(BridgeErrorCode::UNSUPPORTED_ROUTE) unless capability
      expected = {
        "bridgeCapabilityId" => facts.bridge_capability_id,
        "providerId" => "mayan-swift-v2", "capabilityKind" => "external-provider-dynamic",
        "sourceChainId" => facts.source_chain_id, "destinationChainId" => facts.destination_chain_id,
        "sourceTokenDeploymentId" => facts.source_token_deployment_id,
        "destinationTokenDeploymentId" => facts.destination_token_deployment_id,
        "sourceTokenAddress" => facts.source_token_address, "destinationTokenAddress" => facts.destination_token_address,
        "sourceTokenStandard" => facts.source_token_standard, "destinationTokenStandard" => facts.destination_token_standard,
        "sourceTokenDecimals" => 6, "destinationTokenDecimals" => 6,
        "sourceProviderChainName" => facts.source_name, "destinationProviderChainName" => facts.destination_name,
        "sourceProviderChainId" => facts.source_provider_chain_id,
        "destinationProviderChainId" => facts.destination_provider_chain_id,
        "sourceWormholeChainId" => facts.source_wormhole_chain_id,
        "destinationWormholeChainId" => facts.destination_wormhole_chain_id,
        "sourceUsdcDeploymentId" => facts.source_usdc_deployment_id,
        "sourceUsdcAddress" => facts.source_usdc_address, "sourceUsdcStandard" => facts.source_usdc_standard,
        "sourceUsdcDecimals" => 6, "swiftContract" => facts.swift_contract,
        "forwarderAddress" => facts.source_chain_id == ETHEREUM_CHAIN_ID ? ETHEREUM_FORWARDER : nil,
        "forwarderFunctionSelector" => facts.source_chain_id == ETHEREUM_CHAIN_ID ? ETHEREUM_FORWARDER_SELECTOR : nil,
        "jupiterProgramAddress" => facts.source_chain_id == SOLANA_CHAIN_ID ? SOLANA_JUPITER_V6 : nil,
        "builderEndpoint" => DEFAULT_BUILDER_ENDPOINT, "explorerEndpoint" => DEFAULT_EXPLORER_ENDPOINT,
        "dependencies" => facts.source_chain_id == SOLANA_CHAIN_ID ? BASE_DEPENDENCIES + ["jupiter-v6-source-swap"] : BASE_DEPENDENCIES,
        "status" => "active"
      }
      fail_bridge(BridgeErrorCode::UNSUPPORTED_ROUTE) unless strict_equal?(capability, expected)
      deep_freeze(capability)
    end

    def validate_route(value)
      request = require_record(value, BridgeErrorCode::INVALID_ARGUMENT)
      exact_keys(request, %w[sourceChainId destinationChainId sourceTokenDeploymentId destinationTokenDeploymentId amountIn slippageBps], BridgeErrorCode::INVALID_ARGUMENT)
      source_chain_id = require_string(request["sourceChainId"], BridgeErrorCode::INVALID_ARGUMENT)
      destination_chain_id = require_string(request["destinationChainId"], BridgeErrorCode::INVALID_ARGUMENT)
      source_token_id = require_string(request["sourceTokenDeploymentId"], BridgeErrorCode::INVALID_ARGUMENT)
      destination_token_id = require_string(request["destinationTokenDeploymentId"], BridgeErrorCode::INVALID_ARGUMENT)
      amount = normalize_positive_uint64(request["amountIn"], BridgeErrorCode::INVALID_ARGUMENT).first
      slippage = normalize_slippage(request["slippageBps"], BridgeErrorCode::INVALID_ARGUMENT)
      facts = direction_facts(source_chain_id, destination_chain_id)
      fail_bridge(BridgeErrorCode::UNSUPPORTED_ROUTE) unless source_token_id == facts.source_token_deployment_id && destination_token_id == facts.destination_token_deployment_id
      unless catalog_token_matches?(facts.source_token_deployment_id, facts.source_chain_id, facts.source_token_address, facts.source_token_standard) &&
             catalog_token_matches?(facts.destination_token_deployment_id, facts.destination_chain_id, facts.destination_token_address, facts.destination_token_standard) &&
             catalog_token_matches?(facts.source_usdc_deployment_id, facts.source_chain_id, facts.source_usdc_address, facts.source_usdc_standard)
        fail_bridge(BridgeErrorCode::UNSUPPORTED_ROUTE)
      end
      capability = validate_capability(facts)
      NormalizedRoute.new(
        request: {
          "sourceChainId" => source_chain_id, "destinationChainId" => destination_chain_id,
          "sourceTokenDeploymentId" => source_token_id, "destinationTokenDeploymentId" => destination_token_id,
          "amountIn" => amount, "slippageBps" => slippage
        }, facts: facts, capability: capability
      )
    end

    def parse_provider_response(text)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless text.is_a?(String)
      StrictJsonParser.new(text).parse
    rescue BridgeError => error
      raise error, cause: nil
    rescue StandardError
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE)
    end

    def object_entry(node, key)
      node.object_entries&.fetch(key, nil)
    end

    def object_value(node, key)
      entry = object_entry(node, key)
      entry ? entry.value : :__bridge_missing__
    end

    def required_node(node, key)
      entry = object_entry(node, key)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless entry
      entry
    end

    def provider_string(node, key, allow_empty: false)
      value = required_node(node, key).value
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless value.is_a?(String) && (allow_empty || !value.empty?)
      value
    end

    def provider_boolean(node, key)
      value = required_node(node, key).value
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless value == true || value == false
      value
    end

    def provider_number(node, key)
      value = required_node(node, key).value
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless value.is_a?(Numeric) && value.finite?
      value
    end

    def provider_integer(node, key)
      value = provider_number(node, key)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless value.to_i == value && value.to_i.abs <= MAX_SAFE_INTEGER
      value.to_i
    end

    def provider_uint64(node, key, positive:)
      value = required_node(node, key).value
      positive ? normalize_positive_uint64(value, BridgeErrorCode::PROVIDER_INVALID_RESPONSE) : normalize_canonical_uint64(value, BridgeErrorCode::PROVIDER_INVALID_RESPONSE)
    end

    def provider_address_equals?(value, expected)
      return false unless value.is_a?(String)
      EVM_ADDRESS.match?(value) ? value.casecmp?(expected) : value == expected
    end

    def provider_address(node, key, expected)
      value = provider_string(node, key)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_address_equals?(value, expected)
      EVM_ADDRESS.match?(value) ? value.downcase : value
    end

    def provider_token(node, address:, standard:, chain_id:, wormhole_chain_id:, mint:)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless node.object_entries && node.value.is_a?(Hash)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_address_equals?(provider_string(node, "contract"), address)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_string(node, "mint", allow_empty: true) == mint
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_address_equals?(provider_string(node, "realOriginContractAddress"), address)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_string(node, "name") == "EuroC"
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_string(node, "standard") == standard
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_integer(node, "chainId") == chain_id
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_integer(node, "wChainId") == wormhole_chain_id
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_integer(node, "realOriginChainId") == wormhole_chain_id
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_integer(node, "decimals") == 6
    end

    def ensure_quote_deadline(deadline)
      fail_bridge(BridgeErrorCode::QUOTE_EXPIRED) if deadline < @clock.call.to_i + @config.minimum_quote_validity_seconds
    end

    def validate_provider_quote(node, text, request, facts)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless node.object_entries && node.value.is_a?(Hash)
      raw = text[node.start...node.end]
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) if raw.bytesize > MAX_RAW_QUOTE_BYTES
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_string(node, "type") == "SWIFT"
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_string(node, "swiftVersion") == "V2"
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) if provider_boolean(node, "gasless")
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_string(node, "fromChain") == facts.source_name
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_string(node, "toChain") == facts.destination_name
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_integer(node, "slippageBps") == request.fetch("slippageBps")
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) if provider_boolean(node, "onlyBridging")

      effective_amount = provider_uint64(node, "effectiveAmountIn64", positive: true)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless effective_amount.first == request.fetch("amountIn")
      expected_amount = provider_uint64(node, "expectedAmountOutBaseUnits", positive: true)
      minimum_amount = provider_uint64(node, "minAmountOutBaseUnits", positive: true)
      minimum_received = provider_uint64(node, "minReceivedBaseUnits", positive: true)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) if minimum_amount.last > expected_amount.last || minimum_received.last > minimum_amount.last
      deadline = provider_uint64(node, "deadline64", positive: true)
      ensure_quote_deadline(deadline.last)

      provider_token(required_node(node, "fromToken"), address: facts.source_token_address, standard: facts.source_chain_id == ETHEREUM_CHAIN_ID ? "erc20" : "spl", chain_id: facts.source_provider_chain_id, wormhole_chain_id: facts.source_wormhole_chain_id, mint: facts.source_eurc_mint)
      provider_token(required_node(node, "toToken"), address: facts.destination_token_address, standard: facts.destination_chain_id == ETHEREUM_CHAIN_ID ? "erc20" : "spl", chain_id: facts.destination_provider_chain_id, wormhole_chain_id: facts.destination_wormhole_chain_id, mint: facts.destination_eurc_mint)
      provider_standard = facts.source_chain_id == ETHEREUM_CHAIN_ID ? "erc20" : "spl"
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_address(node, "swiftInputContract", facts.source_usdc_address) == facts.source_usdc_address
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_string(node, "swiftInputContractStandard") == provider_standard
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_integer(node, "swiftInputDecimals") == 6
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_address(node, "swiftMayanContract", facts.swift_contract) == facts.swift_contract

      middle = required_node(node, "minMiddleAmount")
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless middle.raw_number && middle.value.is_a?(Numeric) && middle.value.finite? && middle.value.positive?
      if facts.source_chain_id == ETHEREUM_CHAIN_ID
        router_address = normalize_evm_address(provider_string(node, "evmSwapRouterAddress"), BridgeErrorCode::PROVIDER_INVALID_RESPONSE)
        router_kind = "provider-selected-evm"
      else
        router_address = SOLANA_JUPITER_V6
        router_kind = "jupiter-v6"
        evm_router = object_value(node, "evmSwapRouterAddress")
        fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless evm_router == :__bridge_missing__ || evm_router.nil?
      end
      quote_id = provider_string(node, "quoteId")
      signature = provider_string(node, "signature")
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless QUOTE_ID.match?(quote_id) && EVM_SIGNATURE.match?(signature)

      dependencies = facts.source_chain_id == SOLANA_CHAIN_ID ? BASE_DEPENDENCIES + ["jupiter-v6-source-swap"] : BASE_DEPENDENCIES
      {
        "quoteKind" => "mayan-swift-v2", "providerId" => "mayan-swift-v2",
        "sourceChainId" => request.fetch("sourceChainId"), "destinationChainId" => request.fetch("destinationChainId"),
        "sourceTokenDeploymentId" => facts.source_token_deployment_id,
        "destinationTokenDeploymentId" => facts.destination_token_deployment_id,
        "amountIn" => effective_amount.first, "expectedAmountOut" => expected_amount.first,
        "minimumAmountOut" => minimum_amount.first, "minimumReceived" => minimum_received.first,
        "deadline" => deadline.first, "slippageBps" => request.fetch("slippageBps"),
        "quoteId" => quote_id.downcase, "providerSignature" => signature.downcase,
        "sourceSwap" => {
          "required" => true, "inputTokenDeploymentId" => facts.source_token_deployment_id,
          "intermediateTokenDeploymentId" => facts.source_usdc_deployment_id,
          "intermediateTokenAddress" => facts.source_usdc_address,
          "intermediateTokenStandard" => provider_standard, "intermediateTokenDecimals" => 6,
          "providerMinimumAmount" => middle.raw_number,
          "routerKind" => router_kind, "routerAddress" => router_address
        },
        "dependencies" => dependencies,
        "quoteVerification" => "provider-signed-not-locally-verified",
        "rawSignedQuoteJson" => raw
      }
    end

    def quote_request_body(route)
      JSON.generate(
        "fromToken" => route.facts.source_token_address,
        "fromChain" => route.facts.source_name,
        "toToken" => route.facts.destination_token_address,
        "toChain" => route.facts.destination_name,
        "amountIn64" => route.request.fetch("amountIn"),
        "slippageBps" => route.request.fetch("slippageBps"),
        "swift" => true, "mctp" => false, "fastMctp" => false, "wormhole" => false,
        "monoChain" => false, "gasless" => false, "fullList" => true,
        "guaranteedOutput" => true, "gasDrop" => 0
      )
    end

    def quotes_from_response(root, text, request, facts)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless root.object_entries && root.value.is_a?(Hash)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless object_value(root, "success") == true
      quotes_node = required_node(root, "quotes")
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless quotes_node.array_items && quotes_node.array_items.length <= MAX_QUOTES
      selected = []
      quotes_node.array_items.each do |node|
        next unless node.object_entries && node.value.is_a?(Hash)
        next unless node.value["type"] == "SWIFT" && node.value["swiftVersion"] == "V2" && node.value["gasless"] == false

        selected << validate_provider_quote(node, text, request, facts)
      end
      fail_bridge(BridgeErrorCode::QUOTE_UNAVAILABLE) if selected.empty?
      selected.each { |quote| ensure_quote_deadline(normalize_positive_uint64(quote.fetch("deadline"), BridgeErrorCode::PROVIDER_INVALID_RESPONSE).last) }
      selected
    end

    def build_request_snapshot(value)
      request = require_record(deep_dup(value), BridgeErrorCode::INVALID_ARGUMENT)
      exact_keys(request, %w[quote swapperAddress destinationAddress refundAddress].select { |key| request.key?(key) }, BridgeErrorCode::INVALID_ARGUMENT) if request.keys.any? { |key| !%w[quote swapperAddress destinationAddress refundAddress].include?(key) }
      fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) unless request.key?("quote") && request.key?("swapperAddress") && request.key?("destinationAddress")
      quote = deep_dup(request.fetch("quote"))
      fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) unless quote.is_a?(Hash)
      request.merge("quote" => quote)
    rescue TypeError, NoMethodError
      fail_bridge(BridgeErrorCode::INVALID_ARGUMENT)
    end

    def normalize_chain_address(value, chain_id, code)
      return normalize_evm_address(value, code) if chain_id == ETHEREUM_CHAIN_ID

      address = require_string(value, code)
      base58_decode(address, 32, code)
      address
    end

    def is_canonical_solana_address?(value)
      return false unless value.is_a?(String)
      base58_decode(value, 32, BridgeErrorCode::INVALID_ARGUMENT)
      true
    rescue BridgeError
      false
    end

    def reject_address_from_other_chain(value, expected_chain_id)
      evm = value.is_a?(String) && EVM_ADDRESS.match?(value) && value.downcase != "0x#{'0' * 40}"
      solana = is_canonical_solana_address?(value)
      fail_bridge(BridgeErrorCode::QUOTE_MISMATCH) if (expected_chain_id == ETHEREUM_CHAIN_ID && solana) || (expected_chain_id == SOLANA_CHAIN_ID && evm)
    end

    def normalize_destination_address(value, destination_chain_id)
      normalize_chain_address(value, destination_chain_id, BridgeErrorCode::INVALID_ARGUMENT)
    end

    def build_route_from_quote(quote)
      normalized = validate_normalized_quote_shape(quote, BridgeErrorCode::QUOTE_MISMATCH)
      fail_bridge(BridgeErrorCode::QUOTE_MISMATCH) unless strict_equal?(quote, normalized)
      route = validate_route(
        "sourceChainId" => normalized.fetch("sourceChainId"),
        "destinationChainId" => normalized.fetch("destinationChainId"),
        "sourceTokenDeploymentId" => normalized.fetch("sourceTokenDeploymentId"),
        "destinationTokenDeploymentId" => normalized.fetch("destinationTokenDeploymentId"),
        "amountIn" => normalized.fetch("amountIn"), "slippageBps" => normalized.fetch("slippageBps")
      )
      [route, normalized]
    rescue BridgeError => error
      raise error, cause: nil
    rescue StandardError
      fail_bridge(BridgeErrorCode::QUOTE_MISMATCH)
    end

    def validate_normalized_quote_shape(value, code)
      quote = require_record(value, code)
      exact_keys(quote, QUOTE_KEYS, code)
      fail_bridge(code) unless quote["quoteKind"] == "mayan-swift-v2" && quote["providerId"] == "mayan-swift-v2"
      source_chain = require_string(quote["sourceChainId"], code)
      destination_chain = require_string(quote["destinationChainId"], code)
      facts = direction_facts(source_chain, destination_chain)
      fail_bridge(code) unless quote["sourceTokenDeploymentId"] == facts.source_token_deployment_id && quote["destinationTokenDeploymentId"] == facts.destination_token_deployment_id
      amount = normalize_positive_uint64(quote["amountIn"], code)
      expected_amount = normalize_positive_uint64(quote["expectedAmountOut"], code)
      minimum_amount = normalize_positive_uint64(quote["minimumAmountOut"], code)
      minimum_received = normalize_positive_uint64(quote["minimumReceived"], code)
      fail_bridge(code) if minimum_amount.last > expected_amount.last || minimum_received.last > minimum_amount.last
      deadline = normalize_positive_uint64(quote["deadline"], code)
      slippage = normalize_slippage(quote["slippageBps"], code)
      fail_bridge(code) unless quote["quoteVerification"] == "provider-signed-not-locally-verified"
      quote_id = require_string(quote["quoteId"], code)
      signature = require_string(quote["providerSignature"], code)
      fail_bridge(code) unless QUOTE_ID.match?(quote_id) && EVM_SIGNATURE.match?(signature)
      source_swap = require_record(quote["sourceSwap"], code)
      exact_keys(source_swap, SOURCE_SWAP_KEYS, code)
      provider_standard = facts.source_chain_id == ETHEREUM_CHAIN_ID ? "erc20" : "spl"
      fail_bridge(code) unless source_swap["required"] == true && source_swap["inputTokenDeploymentId"] == facts.source_token_deployment_id && source_swap["intermediateTokenDeploymentId"] == facts.source_usdc_deployment_id && source_swap["intermediateTokenAddress"] == facts.source_usdc_address && source_swap["intermediateTokenStandard"] == provider_standard && source_swap["intermediateTokenDecimals"] == 6
      provider_minimum = require_string(source_swap["providerMinimumAmount"], code)
      if facts.source_chain_id == ETHEREUM_CHAIN_ID
        router = source_swap["routerAddress"]
        fail_bridge(code) unless source_swap["routerKind"] == "provider-selected-evm" && router.is_a?(String) && EVM_ADDRESS.match?(router) && router.downcase != "0x#{'0' * 40}"
        normalized_router = router.downcase
        router_kind = "provider-selected-evm"
      else
        fail_bridge(code) unless source_swap["routerKind"] == "jupiter-v6" && source_swap["routerAddress"] == SOLANA_JUPITER_V6
        normalized_router = SOLANA_JUPITER_V6
        router_kind = "jupiter-v6"
      end
      dependencies = facts.source_chain_id == SOLANA_CHAIN_ID ? BASE_DEPENDENCIES + ["jupiter-v6-source-swap"] : BASE_DEPENDENCIES
      fail_bridge(code) unless source_swap.is_a?(Hash) && quote["dependencies"].is_a?(Array) && strict_equal?(quote["dependencies"], dependencies)
      raw = require_string(quote["rawSignedQuoteJson"], code)
      fail_bridge(code) if raw.bytesize > MAX_RAW_QUOTE_BYTES
      {
        "quoteKind" => "mayan-swift-v2", "providerId" => "mayan-swift-v2",
        "sourceChainId" => source_chain, "destinationChainId" => destination_chain,
        "sourceTokenDeploymentId" => facts.source_token_deployment_id,
        "destinationTokenDeploymentId" => facts.destination_token_deployment_id,
        "amountIn" => amount.first, "expectedAmountOut" => expected_amount.first,
        "minimumAmountOut" => minimum_amount.first, "minimumReceived" => minimum_received.first,
        "deadline" => deadline.first, "slippageBps" => slippage,
        "quoteId" => quote_id.downcase, "providerSignature" => signature.downcase,
        "sourceSwap" => {
          "required" => true, "inputTokenDeploymentId" => facts.source_token_deployment_id,
          "intermediateTokenDeploymentId" => facts.source_usdc_deployment_id,
          "intermediateTokenAddress" => facts.source_usdc_address,
          "intermediateTokenStandard" => provider_standard, "intermediateTokenDecimals" => 6,
          "providerMinimumAmount" => provider_minimum, "routerKind" => router_kind,
          "routerAddress" => normalized_router
        },
        "dependencies" => dependencies,
        "quoteVerification" => "provider-signed-not-locally-verified", "rawSignedQuoteJson" => raw
      }
    rescue BridgeError => error
      raise error, cause: nil
    rescue StandardError
      fail_bridge(code)
    end

    def validate_raw_quote_for_build(quote, route)
      raw = quote.fetch("rawSignedQuoteJson")
      root = parse_provider_response(raw)
      fail_bridge(BridgeErrorCode::QUOTE_MISMATCH) unless root.object_entries && root.start.zero? && root.end == raw.length
      rebuilt = begin
        validate_provider_quote(root, raw, route.request, route.facts)
      rescue BridgeError => error
        raise error, cause: nil if error.code == BridgeErrorCode::QUOTE_EXPIRED
        fail_bridge(BridgeErrorCode::QUOTE_MISMATCH)
      end
      fail_bridge(BridgeErrorCode::QUOTE_MISMATCH) unless strict_equal?(rebuilt, quote)
      deep_dup(quote)
    rescue BridgeError => error
      raise error, cause: nil if error.code == BridgeErrorCode::QUOTE_MISMATCH || error.code == BridgeErrorCode::QUOTE_EXPIRED
      fail_bridge(BridgeErrorCode::QUOTE_MISMATCH)
    rescue StandardError
      fail_bridge(BridgeErrorCode::QUOTE_MISMATCH)
    end

    def numeric_zero?(value)
      return false if value == true || value == false
      return value.finite? && value.zero? if value.is_a?(Numeric)
      value.is_a?(String) && (value == "0" || value.match?(/\A0x0+\z/i))
    end

    def validate_evm_build_result(wrapper, swapper_address)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_string(wrapper, "chainCategory") == "evm" && provider_string(wrapper, "quoteType") == "SWIFT"
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) if provider_boolean(wrapper, "gasless")
      transaction = required_node(wrapper, "transaction")
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless transaction.object_entries && transaction.value.is_a?(Hash)
      to = provider_string(transaction, "to")
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_address_equals?(to, ETHEREUM_FORWARDER)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_integer(transaction, "chainId") == 1
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless numeric_zero?(object_value(transaction, "value"))
      data = provider_string(transaction, "data").downcase
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless HEX_BYTES.match?(data) && data.length.even? && data.start_with?(ETHEREUM_FORWARDER_SELECTOR) && data.length >= 2 + 8 + 13 * 64
      {
        "kind" => "evm-unsigned-transaction", "chainId" => ETHEREUM_CHAIN_ID,
        "from" => swapper_address, "to" => ETHEREUM_FORWARDER, "data" => data, "value" => "0"
      }
    end

    def base58_decode(value, expected_bytes, code)
      text = require_string(value, code)
      fail_bridge(code) if text.empty? || text.length > expected_bytes * 2 || text.each_char.any? { |char| !BASE58_INDEX.key?(char) }
      number = 0
      text.each_char { |char| number = number * 58 + BASE58_INDEX.fetch(char) }
      if number.zero?
        raw = ""
      else
        hex = number.to_s(16)
        hex = "0#{hex}" if hex.length.odd?
        raw = [hex].pack("H*")
      end
      leading_zeroes = text[/\A1*/].to_s.length
      result = ("\0" * leading_zeroes) + raw
      fail_bridge(code) unless result.bytesize == expected_bytes && base58_encode(result) == text
      result
    rescue ArgumentError
      fail_bridge(code)
    end

    def base58_encode(bytes)
      leading_zeroes = bytes.bytes.take_while(&:zero?).length
      number = bytes.empty? ? 0 : bytes.unpack1("H*").to_i(16)
      return "1" * leading_zeroes if number.zero?
      chars = []
      while number.positive?
        number, remainder = number.divmod(58)
        chars << BASE58_ALPHABET[remainder]
      end
      ("1" * leading_zeroes) + chars.reverse.join
    end

    def decode_base64(value, code)
      text = require_string(value, code)
      fail_bridge(code) unless BASE64.match?(text)
      begin
        decoded = Base64.strict_decode64(text)
      rescue ArgumentError
        fail_bridge(code)
      end
      fail_bridge(code) unless Base64.strict_encode64(decoded) == text
      decoded
    end

    def read_bytes(bytes, cursor, count, code)
      fail_bridge(code) unless count.is_a?(Integer) && count >= 0 && cursor + count <= bytes.bytesize
      value = bytes.byteslice(cursor, count)
      [value, cursor + count]
    end

    def read_short_vec(bytes, cursor, maximum, code)
      value = 0
      shift = 0
      5.times do |count|
        byte_text, cursor = read_bytes(bytes, cursor, 1, code)
        byte = byte_text.getbyte(0)
        payload = byte & 0x7f
        fail_bridge(code) if shift >= 28 || payload > MAX_SAFE_INTEGER / (1 << shift)
        value += payload << shift
        unless (byte & 0x80).positive?
          fail_bridge(code) if count.positive? && payload.zero?
          fail_bridge(code) if value > maximum
          return [value, cursor]
        end
        shift += 7
      end
      fail_bridge(code)
    end

    def validate_solana_transaction(value, fee_payer)
      encoded = require_string(value, BridgeErrorCode::BUILD_INVALID)
      bytes = decode_base64(encoded, BridgeErrorCode::BUILD_INVALID)
      fail_bridge(BridgeErrorCode::BUILD_INVALID) if bytes.empty? || bytes.bytesize > 1232
      cursor = 0
      signature_count, cursor = read_short_vec(bytes, cursor, 1, BridgeErrorCode::BUILD_INVALID)
      signatures, cursor = read_bytes(bytes, cursor, 64, BridgeErrorCode::BUILD_INVALID)
      fail_bridge(BridgeErrorCode::BUILD_INVALID) unless signature_count == 1 && signatures.bytes.all?(&:zero?)
      version, cursor = read_bytes(bytes, cursor, 1, BridgeErrorCode::BUILD_INVALID)
      fail_bridge(BridgeErrorCode::BUILD_INVALID) unless version.getbyte(0) == 0x80
      required, cursor = read_bytes(bytes, cursor, 1, BridgeErrorCode::BUILD_INVALID)
      readonly_signed, cursor = read_bytes(bytes, cursor, 1, BridgeErrorCode::BUILD_INVALID)
      readonly_unsigned, cursor = read_bytes(bytes, cursor, 1, BridgeErrorCode::BUILD_INVALID)
      required_value = required.getbyte(0); readonly_signed_value = readonly_signed.getbyte(0); readonly_unsigned_value = readonly_unsigned.getbyte(0)
      fail_bridge(BridgeErrorCode::BUILD_INVALID) unless required_value == 1 && readonly_signed_value.zero?
      static_key_count, cursor = read_short_vec(bytes, cursor, 64, BridgeErrorCode::BUILD_INVALID)
      fail_bridge(BridgeErrorCode::BUILD_INVALID) if static_key_count.zero? || readonly_unsigned_value >= static_key_count
      static_keys, cursor = read_bytes(bytes, cursor, static_key_count * 32, BridgeErrorCode::BUILD_INVALID)
      payer = base58_decode(fee_payer, 32, BridgeErrorCode::BUILD_INVALID)
      fail_bridge(BridgeErrorCode::BUILD_INVALID) unless static_keys.byteslice(0, 32) == payer
      _blockhash, cursor = read_bytes(bytes, cursor, 32, BridgeErrorCode::BUILD_INVALID)
      instruction_count, cursor = read_short_vec(bytes, cursor, 64, BridgeErrorCode::BUILD_INVALID)
      largest = -1
      instruction_count.times do
        program, cursor = read_bytes(bytes, cursor, 1, BridgeErrorCode::BUILD_INVALID)
        largest = [largest, program.getbyte(0)].max
        account_count, cursor = read_short_vec(bytes, cursor, 64, BridgeErrorCode::BUILD_INVALID)
        accounts, cursor = read_bytes(bytes, cursor, account_count, BridgeErrorCode::BUILD_INVALID)
        largest = [largest, accounts.bytes.max || -1].max
        data_length, cursor = read_short_vec(bytes, cursor, 1024, BridgeErrorCode::BUILD_INVALID)
        _data, cursor = read_bytes(bytes, cursor, data_length, BridgeErrorCode::BUILD_INVALID)
      end
      lookup_count, cursor = read_short_vec(bytes, cursor, 32, BridgeErrorCode::BUILD_INVALID)
      loaded = 0
      lookup_count.times do
        _lookup, cursor = read_bytes(bytes, cursor, 32, BridgeErrorCode::BUILD_INVALID)
        writable_count, cursor = read_short_vec(bytes, cursor, 64, BridgeErrorCode::BUILD_INVALID)
        _writable, cursor = read_bytes(bytes, cursor, writable_count, BridgeErrorCode::BUILD_INVALID)
        readonly_count, cursor = read_short_vec(bytes, cursor, 64, BridgeErrorCode::BUILD_INVALID)
        _readonly, cursor = read_bytes(bytes, cursor, readonly_count, BridgeErrorCode::BUILD_INVALID)
        loaded += writable_count + readonly_count
        fail_bridge(BridgeErrorCode::BUILD_INVALID) if loaded > 256
      end
      fail_bridge(BridgeErrorCode::BUILD_INVALID) if largest >= static_key_count + loaded || cursor != bytes.bytesize
      encoded
    end

    def validate_solana_build_result(wrapper, swapper_address)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_string(wrapper, "chainCategory") == "svm" && provider_string(wrapper, "quoteType") == "SWIFT"
      gasless = object_value(wrapper, "gasless")
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless gasless == :__bridge_missing__ || gasless == false
      encoded = validate_solana_transaction(required_node(wrapper, "transaction").value, swapper_address)
      { "kind" => "solana-v0-unsigned-transaction", "chainId" => SOLANA_CHAIN_ID, "feePayer" => swapper_address, "transactionBase64" => encoded }
    end

    def validate_build_response(root, raw_text, quote, facts, swapper_address)
      fail_bridge(BridgeErrorCode::BUILD_INVALID) unless root.object_entries && root.value.is_a?(Hash) && object_value(root, "success") == true
      wrapper = required_node(root, "transaction")
      fail_bridge(BridgeErrorCode::BUILD_INVALID) unless wrapper.object_entries && wrapper.value.is_a?(Hash)
      signers = object_value(wrapper, "signers")
      fail_bridge(BridgeErrorCode::BUILD_INVALID) unless signers == :__bridge_missing__ || signers.nil? || (signers.is_a?(Array) && signers.empty?)
      swap_message = object_value(wrapper, "swapMessageV0Params")
      fail_bridge(BridgeErrorCode::BUILD_INVALID) unless swap_message == :__bridge_missing__ || swap_message.nil?
      transaction = begin
        facts.source_chain_id == ETHEREUM_CHAIN_ID ? validate_evm_build_result(wrapper, swapper_address) : validate_solana_build_result(wrapper, swapper_address)
      rescue BridgeError => error
        raise error, cause: nil if error.code == BridgeErrorCode::BUILD_INVALID
        fail_bridge(BridgeErrorCode::BUILD_INVALID)
      end
      {
        "buildKind" => "mayan-swift-v2-unsigned", "providerId" => "mayan-swift-v2",
        "quote" => deep_dup(quote), "sourceChainId" => quote.fetch("sourceChainId"),
        "destinationChainId" => quote.fetch("destinationChainId"), "transaction" => transaction,
        "allowance" => facts.source_chain_id == ETHEREUM_CHAIN_ID ? {
          "tokenDeploymentId" => ETHEREUM_EURC_DEPLOYMENT_ID, "tokenAddress" => ETHEREUM_EURC_ADDRESS,
          "owner" => swapper_address, "spender" => ETHEREUM_FORWARDER, "requiredAmount" => quote.fetch("amountIn")
        } : nil,
        "validation" => {
          "level" => "structural", "quoteSignatureLocallyVerified" => false,
          "transactionSemanticsLocallyVerified" => false, "settlementLocallyVerified" => false
        },
        "rawProviderBuildJson" => raw_text
      }
    end

    def normalize_status_request(value)
      request = require_record(deep_dup(value), BridgeErrorCode::INVALID_ARGUMENT)
      exact_keys(request, %w[sourceChainId sourceTransactionHash], BridgeErrorCode::INVALID_ARGUMENT)
      chain_id = require_string(request["sourceChainId"], BridgeErrorCode::INVALID_ARGUMENT)
      tx_hash = require_string(request["sourceTransactionHash"], BridgeErrorCode::INVALID_ARGUMENT)
      if chain_id == ETHEREUM_CHAIN_ID
        fail_bridge(BridgeErrorCode::INVALID_ARGUMENT) unless EVM_HASH.match?(tx_hash)
        return { "sourceChainId" => chain_id, "sourceTransactionHash" => tx_hash.downcase }
      end
      if chain_id == SOLANA_CHAIN_ID
        base58_decode(tx_hash, 64, BridgeErrorCode::INVALID_ARGUMENT)
        return { "sourceChainId" => chain_id, "sourceTransactionHash" => tx_hash }
      end
      fail_bridge(BridgeErrorCode::UNSUPPORTED_ROUTE)
    end

    def status_from_response(root, raw_text, request)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless root.object_entries && root.value.is_a?(Hash)
      client_status = provider_string(root, "clientStatus")
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) if client_status.length > 128
      provider_status = object_value(root, "status")
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless provider_status == :__bridge_missing__ || provider_status.nil? || (provider_status.is_a?(String) && provider_status.length <= 1024)
      provider_status = nil if provider_status == :__bridge_missing__
      state = { "INPROGRESS" => "in-progress", "COMPLETED" => "completed", "REFUNDED" => "refunded" }.fetch(client_status, "unknown")
      {
        "statusKind" => "mayan-explorer-index", "providerId" => "mayan-swift-v2",
        "sourceChainId" => request.fetch("sourceChainId"), "sourceTransactionHash" => request.fetch("sourceTransactionHash"),
        "state" => state, "providerClientStatus" => client_status, "providerStatus" => provider_status,
        "statusVerification" => "provider-indexed-not-locally-verified", "rawProviderStatusJson" => raw_text
      }
    end

    def endpoint_with_path(base, path)
      uri = URI.parse(base)
      base_path = uri.path.to_s.sub(%r{/+\z}, "")
      uri.path = "#{base_path}/#{path.sub(%r{\A/+}, "")}"
      uri.query = nil
      uri.fragment = nil
      uri.to_s
    rescue URI::InvalidURIError, ArgumentError
      fail_bridge(BridgeErrorCode::PROVIDER_TRANSPORT)
    end

    def provider_request(url, method, body, include_builder_key:, operation:, options:)
      check_aborted(options)
      headers = { "accept" => "application/json" }
      headers["content-type"] = "application/json" unless body.nil?
      headers["x-api-key"] = @config.builder_api_key if include_builder_key && @config.builder_api_key
      begin
        response = @http_adapter.request(method: method, url: url, headers: headers, body: body, timeout: @config.timeout)
      rescue BridgeError => error
        raise error, cause: nil
      rescue MayanBridgeBodyTooLarge
        fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE)
      rescue TimeoutError, Timeout::Error
        fail_bridge(BridgeErrorCode::TIMEOUT)
      rescue StandardError
        check_aborted(options)
        fail_bridge(BridgeErrorCode::PROVIDER_TRANSPORT)
      end
      check_aborted(options)
      status = if response.respond_to?(:status)
                 response.status
               elsif response.is_a?(Hash)
                 response[:status] || response["status"]
               end
      fail_bridge(BridgeErrorCode::PROVIDER_TRANSPORT) unless status.is_a?(Integer)
      if operation == :status && status == 404
        fail_bridge(BridgeErrorCode::STATUS_NOT_FOUND)
      elsif status.between?(300, 399)
        fail_bridge(BridgeErrorCode::PROVIDER_TRANSPORT)
      elsif operation == :build && [401, 403].include?(status)
        fail_bridge(BridgeErrorCode::PROVIDER_AUTH_REQUIRED)
      elsif ![200, 201].include?(status)
        fail_bridge(BridgeErrorCode::PROVIDER_HTTP, status)
      end
      body_value = if response.respond_to?(:body)
                     response.body
                   elsif response.is_a?(Hash)
                     response[:body] || response["body"]
                   end
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless body_value.is_a?(String)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) if body_value.bytesize > MAX_RESPONSE_BYTES
      body_value = body_value.dup.force_encoding(Encoding::UTF_8)
      fail_bridge(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) unless body_value.valid_encoding?
      body_value
    end

    def check_aborted(options)
      cancelled = if options.is_a?(Hash)
                    options[:cancelled] || options["cancelled"] || options[:aborted] || options["aborted"]
                  elsif options.respond_to?(:cancelled?)
                    options.cancelled?
                  elsif options.respond_to?(:aborted?)
                    options.aborted?
                  end
      fail_bridge(BridgeErrorCode::ABORTED) if cancelled
    end

    def strict_equal?(left, right)
      return false unless left.class == right.class
      case left
      when Hash
        left.keys.sort == right.keys.sort && left.all? { |key, value| strict_equal?(value, right[key]) }
      when Array
        left.length == right.length && left.each_index.all? { |index| strict_equal?(left[index], right[index]) }
      else
        left == right
      end
    end

    def deep_dup(value)
      case value
      when Hash
        value.each_with_object({}) { |(key, child), copy| copy[deep_dup(key)] = deep_dup(child) }
      when Array
        value.map { |child| deep_dup(child) }
      when String
        value.dup
      else
        value
      end
    end

    def deep_freeze(value)
      case value
      when Hash
        value.each { |key, child| deep_freeze(key); deep_freeze(child) }
      when Array
        value.each { |child| deep_freeze(child) }
      end
      value.freeze
    end
  end

  BridgeClient = MayanSwiftV2BridgeClient

  def self.create_mayan_swift_v2_bridge_client(config = nil, http_adapter: nil, adapter: nil, **config_keywords)
    MayanSwiftV2BridgeClient.new(config, http_adapter: http_adapter, adapter: adapter, **config_keywords)
  end
end
