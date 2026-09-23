# frozen_string_literal: true

# Local, unsigned construction for the Mayan Swift v2 bridge.  This file is
# intentionally additive: the hosted quote/build/status path remains in
# bridge.rb and local construction never calls the hosted /build endpoint.

require "base64"
require "digest"
require "digest/keccak"
require "json"
require "thread"
require "uri"
require_relative "bridge"

module ERPC
  module MayanSwiftV2BridgeLocal
    module_function

    ETHEREUM_FORWARDER_PROVIDER = "0x337685fdaB40D39bd02028545a4FfA7D287cC3E2"
    SOLANA_SWIFT_PROGRAM = "mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny"
    SOLANA_JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
    SOLANA_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    SOLANA_ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
    SOLANA_SYSTEM_PROGRAM = "11111111111111111111111111111111"
    SOLANA_SYSVAR_RENT = "SysvarRent111111111111111111111111111111111"
    SOLANA_COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111"
    SOLANA_CPI_PROXY_PROGRAM = "D8C8iW6zmoKg5TRr8nQ7h14TMWqQX8FiBdj2ju5MF3wa"
    SOLANA_ANCHOR_EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf"
    SOLANA_FEE_MANAGER_PROGRAM = "5VtQHnhs2pfVEr68qQsbTRwKh4JV5GTu9mBHgHFxpHeQ"
    SOLANA_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
    SOLANA_MAYAN_LOOKUP_TABLE = "Ff3yi1meWQQ19VPZMzGg6H8JQQeRudiV7QtVtyzJyoht"
    SOLANA_ADDRESS_LOOKUP_TABLE_OWNER = "AddressLookupTab1e1111111111111111111111111"
    SOLANA_ROUTE_V2_DISCRIMINATOR = "bb64facc31c4af14"
    SOLANA_ROUTE_V2_WHIRLPOOL_TAIL = "000001000000110010270001"
    SOLANA_ROUTE_V2_RAYDIUM_TAIL = "0000010000001a10270001"
    SOLANA_WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
    SOLANA_WHIRLPOOL_POOL = "ArisQNcbjXPJD7RgPRvysatX3xcfHPTbcTkfD8kDoZ9i"
    SOLANA_RAYDIUM_CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
    SOLANA_RAYDIUM_CLMM_POOL = "2zVV22uNWdJNmkXpj5vCrMzwHGBoJdsyV7qACh29sK1w"
    SOLANA_WHIRLPOOL_TICK_ARRAY_0 = "6i68TM44UYSawGAS4Bx1vX31Af7QNZaRNBLUbc4r8exB"
    SOLANA_WHIRLPOOL_TICK_ARRAY_1 = "8aq9zUXe37KLtXSaEYt7oq65oNAJiu1my2kRNMRPhTD5"
    SOLANA_WHIRLPOOL_TICK_ARRAY_2 = "7qscKXFXCd1WQinZJvSDLsGLTTEwjmd88a871pz2V3Ja"
    SOLANA_WHIRLPOOL_ORACLE = "CaohZGaBaLmXyFQ4cLc83wGZTET7Mt9xMtUqR9EGaMHF"
    SOLANA_WHIRLPOOL_REWARD_VAULT = "7Mr4WYMiGPAXkyt9ePsHHmV6ust3U6dHwBmyfMRiHPA7"
    SOLANA_WHIRLPOOL_REMAINING = "9BjNZYSCZ3ac3XUYVKte4YYtmBGd7ATKfRshTGN99NxQ"
    SOLANA_RAYDIUM_CONFIG = "9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x"
    SOLANA_RAYDIUM_OBSERVATION = "GFwsANMCPK8W3WhqTnwVP8JiwHaAr3cNDe5TJqgHHSPe"
    SOLANA_RAYDIUM_TICK_ARRAY_0 = "ECw2X1TYbsrqFgdiYApNpn2ggznbj8pL5tREpY9Fb8jY"
    SOLANA_RAYDIUM_TICK_ARRAY_1 = "2UQncszfVU7igwDiGN3jq2sUKzziLxDZqNsJEXzEob5x"
    SOLANA_RAYDIUM_TICK_ARRAY_2 = "BVvv13QAQjPYKTWrpX7wQbhBAu3pbWwTb8P9SAqgRNKQ"
    SOLANA_RAYDIUM_TICK_ARRAY_3 = "4HSR9WBSHgw7n5V8WGYYhLW8g92RPSrgnf2CHzbeQrrr"
    SOLANA_RAYDIUM_ORACLE = "HssFpWsQcNbJXBro1NVWCFAYEh8jp6NJV2nyFhE1zMGj"
    SOLANA_RAYDIUM_REMAINING = "DKcmVcrXuiF5FZre6h8GqurR2sKChUGBakxdTX7dSDw9"
    SOLANA_INIT_ORDER_DISCRIMINATOR = "204c290c27a284db"
    EVM_SOURCE_SWAP_SELECTOR = "0x3f0bde25"
    SOLANA_MAYAN_SOURCE_SWAP_ENDPOINT = "https://price-api.mayan.finance/v3"
    MAYAN_REFERENCE_COMMIT = "c4c98031aaad9264d17630d7b4de0cb18688cf78"
    MAYAN_ORACLE_SDK_VERSION = "15_2_2"

    MAX_RESPONSE_BYTES = 1024 * 1024
    MAX_JSON_DEPTH = 32
    MAX_ROUTER_CALLDATA_BYTES = 16_384
    MAX_SOLANA_SWAP_ACCOUNTS = 64
    MAX_SOLANA_SWAP_DATA_BYTES = 4096
    MAX_LOOKUP_TABLES = 8
    MAX_LOOKUP_TABLE_ADDRESSES = 256
    MAX_SOLANA_TRANSACTION_BYTES = 1232
    UINT64_MAX = (1 << 64) - 1
    MAX_SAFE_INTEGER = (1 << 53) - 1
    RESPONSE_DISPOSAL_TIMEOUT = 0.05
    STREAM_QUEUE_CAPACITY = 8
    EVM_ADDRESS = /\A0x[0-9a-fA-F]{40}\z/.freeze
    HEX_BYTES = /\A0x(?:[0-9a-fA-F]{2})*\z/.freeze
    UINT64 = /\A(?:0|[1-9][0-9]*)\z/.freeze
    NONCE = /\A0x[0-9a-f]{32}\z/.freeze
    PLAIN_DECIMAL = /\A(?:0|[1-9][0-9]*)(?:\.[0-9]+)?\z/.freeze
    BASE64 = /\A(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?\z/.freeze
    BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    BASE58_INDEX = BASE58_ALPHABET.each_char.with_index.to_h.freeze

    LocalCapability = Struct.new(
      :row, :is_usdc,
      keyword_init: true
    ) do
      def capability_id = row.fetch("bridgeCapabilityId")
      def source_chain_id = row.fetch("sourceChainId")
      def destination_chain_id = row.fetch("destinationChainId")
      def source_token_deployment_id = row.fetch("sourceTokenDeploymentId")
      def destination_token_deployment_id = row.fetch("destinationTokenDeploymentId")
      def source_token_address = row.fetch("sourceTokenAddress")
      def destination_token_address = row.fetch("destinationTokenAddress")
      def source_usdc_address = row.fetch("sourceUsdcAddress")
      def source_usdc_deployment_id = row.fetch("sourceUsdcDeploymentId")
      def source_name = row.fetch("sourceProviderChainName")
      def destination_name = row.fetch("destinationProviderChainName")
      def source_provider_chain_id = row.fetch("sourceProviderChainId")
      def destination_provider_chain_id = row.fetch("destinationProviderChainId")
      def source_wormhole_chain_id = row.fetch("sourceWormholeChainId")
      def destination_wormhole_chain_id = row.fetch("destinationWormholeChainId")
      def source_token_standard = row.fetch("sourceTokenStandard")
      def destination_token_standard = row.fetch("destinationTokenStandard")
      def source_usdc_standard = row.fetch("sourceUsdcStandard")
      def swift_contract = row.fetch("swiftContract")
      def dependencies = row.fetch("dependencies")
    end

    ParsedSourceQuote = Struct.new(
      :raw, :root, :minimum_intermediate_amount, :mode,
      :cancel_fee, :refund_fee, :submit_fee, :suggested_priority_fee,
      keyword_init: true
    )
    LookupTable = Struct.new(:address, :addresses, :data, keyword_init: true)
    SourceRpcResult = Struct.new(:evidence, :lookup_tables, :recent_blockhash, keyword_init: true)
    KeyMeta = Struct.new(:signer, :writable, :invoked, keyword_init: true)
    LocalValidationError = Class.new(StandardError)
    LocalResponseTooLarge = Class.new(StandardError)
    LocalResponseInvalidEncoding = Class.new(StandardError)

    def local_invalid!
      raise LocalValidationError
    end

    def fail_local(code, status = nil)
      raise BridgeError.new(code, status), cause: nil
    end

    def concat(*parts)
      parts.join.b
    end

    def sha256_hex(value)
      Digest::SHA256.hexdigest(value.is_a?(String) ? value.b : value)
    end

    def keccak_hex(value)
      Digest::Keccak.hexdigest(value.b, 256)
    end

    def stable_json(value)
      case value
      when Hash
        entries = value.map { |key, child| [key.to_s, child] }.sort_by(&:first)
        "{" + entries.map { |key, child| "#{JSON.generate(key)}:#{stable_json(child)}" }.join(",") + "}"
      when Array
        "[#{value.map { |child| stable_json(child) }.join(",")}]"
      when String
        JSON.generate(value)
      when Integer, Float, TrueClass, FalseClass, NilClass
        JSON.generate(value, allow_nan: false)
      else
        local_invalid!
      end
    rescue JSON::GeneratorError, TypeError
      local_invalid!
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

    def hex_to_bytes(value)
      local_invalid! unless value.is_a?(String)
      source = value.start_with?("0x") ? value[2..] : value
      local_invalid! unless source.length.even? && source.match?(/\A[0-9a-fA-F]*\z/)
      [source].pack("H*")
    rescue ArgumentError
      local_invalid!
    end

    def normalize_evm_address(value)
      local_invalid! unless value.is_a?(String) && EVM_ADDRESS.match?(value)
      local_invalid! if value.downcase == "0x#{'0' * 40}"
      value.downcase
    end

    def base58_decode(value)
      local_invalid! unless value.is_a?(String) && !value.empty?
      local_invalid! unless value.each_char.all? { |char| BASE58_INDEX.key?(char) }
      number = 0
      value.each_char { |char| number = number * 58 + BASE58_INDEX.fetch(char) }
      raw = if number.zero?
              "".b
            else
              hex = number.to_s(16)
              hex = "0#{hex}" if hex.length.odd?
              [hex].pack("H*")
            end
      leading = value[/\A1*/].to_s.length
      ("\0".b * leading) + raw
    rescue ArgumentError
      local_invalid!
    end

    def base58_encode(bytes)
      local_invalid! unless bytes.is_a?(String)
      number = bytes.empty? ? 0 : bytes.unpack1("H*").to_i(16)
      result = +""
      while number.positive?
        number, remainder = number.divmod(58)
        result << BASE58_ALPHABET[remainder]
      end
      leading = bytes.bytes.take_while(&:zero?).length
      ("1" * leading) + result.reverse
    end

    def canonical_solana_address(value)
      local_invalid! unless value.is_a?(String)
      bytes = base58_decode(value)
      local_invalid! unless bytes.bytesize == 32 && base58_encode(bytes) == value
      value
    end

    def uint64(value, positive: false)
      local_invalid! unless value.is_a?(String) && value.length <= 20 && UINT64.match?(value)
      parsed = Integer(value, 10)
      local_invalid! if parsed > UINT64_MAX || (positive && parsed.zero?)
      parsed
    rescue ArgumentError
      local_invalid!
    end

    def word_uint(value)
      local_invalid! unless value.is_a?(Integer) && value >= 0 && value < (1 << 256)
      [value].pack("H*") if false
      hex = value.to_s(16).rjust(64, "0")
      [hex].pack("H*")
    end

    def word_address(value)
      "\0".b * 12 + hex_to_bytes(normalize_evm_address(value))
    end

    def word_bytes32(value)
      local_invalid! unless value.is_a?(String) && value.bytesize == 32
      value.b
    end

    def pad32(value)
      value.b + ("\0".b * ((-value.bytesize) % 32))
    end

    def encode_abi_bytes(value)
      word_uint(value.bytesize) + pad32(value)
    end

    def encode_abi_with_dynamics(head, dynamics)
      offset = (head.length + dynamics.length) * 32
      offsets = []
      dynamics.each do |value|
        offsets << word_uint(offset)
        offset += 32 + pad32(value).bytesize
      end
      head.join.b + offsets.join.b + dynamics.map { |value| encode_abi_bytes(value) }.join.b
    end

    def native_address_bytes(value, chain_id)
      return word_address(value) if chain_id == MayanSwiftV2BridgeClient::ETHEREUM_CHAIN_ID

      canonical_solana_address(value)
      base58_decode(value)
    end

    def capability_records
      parsed = JSON.parse(BRIDGE_CAPABILITIES_JSON)
      parsed.is_a?(Array) ? parsed : []
    rescue JSON::ParserError
      []
    end

    def route_for_quote(quote)
      local_invalid! unless quote.is_a?(Hash)
      source_chain = quote["sourceChainId"]
      destination_chain = quote["destinationChainId"]
      source_token = quote["sourceTokenDeploymentId"]
      destination_token = quote["destinationTokenDeploymentId"]
      local_invalid! unless [source_chain, destination_chain, source_token, destination_token].all? { |value| value.is_a?(String) }
      row = capability_records.find do |entry|
        entry.is_a?(Hash) && entry["sourceChainId"] == source_chain &&
          entry["destinationChainId"] == destination_chain &&
          entry["sourceTokenDeploymentId"] == source_token &&
          entry["destinationTokenDeploymentId"] == destination_token
      end
      local_invalid! unless row
      LocalCapability.new(row: row, is_usdc: row.fetch("bridgeCapabilityId").include?("-usdc-"))
    end

    def assert_catalog_token(deployment_id, chain_id, address, standard)
      token = TokenCatalog.get_token_deployment(deployment_id)
      local_invalid! unless token.is_a?(Hash) && token[:address].is_a?(String)
      address_matches = chain_id == MayanSwiftV2BridgeClient::ETHEREUM_CHAIN_ID ?
        token[:address].casecmp?(address) : token[:address] == address
      local_invalid! unless token[:deployment_id] == deployment_id && token[:chain_id] == chain_id &&
        address_matches && token[:standard] == standard && token[:decimals] == 6 && token[:status] == "active"
    end

    def local_quote_validation_copy(quote)
      copy = deep_dup(quote)
      raw = copy.fetch("rawSignedQuoteJson")
      local_invalid! unless raw.is_a?(String)
      # Local fixture snapshots retain the provider's trailing JSON whitespace.
      # The hosted parser keeps its exact framing contract, so validate only a
      # local copy with RFC JSON whitespace removed from the end.
      copy["rawSignedQuoteJson"] = raw.sub(/[ \t\r\n]+\z/, "")
      copy
    end

    def validate_local_route(quote, client)
      route = route_for_quote(quote)
      local_invalid! unless route.row["providerId"] == "mayan-swift-v2" && route.row["status"] == "active"
      assert_catalog_token(route.source_token_deployment_id, route.source_chain_id, route.source_token_address, route.source_token_standard)
      assert_catalog_token(route.destination_token_deployment_id, route.destination_chain_id, route.destination_token_address, route.destination_token_standard)
      assert_catalog_token(route.source_usdc_deployment_id, route.source_chain_id, route.source_usdc_address, route.source_usdc_standard)
      begin
        validation_quote = local_quote_validation_copy(quote)
        hosted_route, = client.__send__(:build_route_from_quote, validation_quote)
        client.__send__(:validate_raw_quote_for_build, validation_quote, hosted_route)
        local_invalid! unless hosted_route.facts.source_chain_id == route.source_chain_id &&
          hosted_route.facts.destination_chain_id == route.destination_chain_id &&
          hosted_route.facts.source_token_deployment_id == route.source_token_deployment_id &&
          hosted_route.facts.destination_token_deployment_id == route.destination_token_deployment_id
      rescue BridgeError => error
        raise error if error.code == BridgeErrorCode::QUOTE_EXPIRED
        local_invalid!
      end
      route
    end

    def local_json_object(text)
      local_invalid! unless text.is_a?(String)
      root = begin
        StrictJsonParser.new(text).parse
      rescue BridgeError
        local_invalid!
      end
      local_invalid! unless root.object_entries && root.value.is_a?(Hash)
      [root, root.value]
    end

    def node_value(root, key)
      entry = root.object_entries&.fetch(key, nil)
      entry ? entry.value : :__bridge_missing__
    end

    def required_node(root, key)
      entry = root.object_entries&.fetch(key, nil)
      local_invalid! unless entry
      entry
    end

    def raw_number_lexeme(root, key)
      value = required_node(root, key).raw_number
      local_invalid! unless value.is_a?(String)
      value
    end

    def raw_number_zero(value)
      return false if value == true || value == false
      return value.finite? && value.zero? if value.is_a?(Numeric)

      value == "0"
    end

    def raw_uint64(raw, key, required: true)
      value = raw.fetch(key, :__bridge_missing__)
      return 0 if value == :__bridge_missing__ && !required

      uint64(value)
    end

    def raw_optional_bounded_integer(raw, key, maximum)
      value = raw.fetch(key, :__bridge_missing__)
      return nil if value == :__bridge_missing__
      local_invalid! if value == true || value == false || !value.is_a?(Numeric) || !value.finite? || value < 0 || value.to_i != value || value.to_i > maximum

      value.to_i
    end

    def raw_address_equals(value, expected)
      return false unless value.is_a?(String)
      MayanSwiftV2BridgeClient::EVM_ADDRESS.match?(expected) ? value.casecmp?(expected) : value == expected
    end

    ExactDecimal = Struct.new(:source, :integer, :scale, keyword_init: true)

    def parse_plain_decimal(value)
      local_invalid! unless value.is_a?(String) && PLAIN_DECIMAL.match?(value)
      separator = value.index(".")
      integer_part = separator ? value[0...separator] : value
      fractional_part = separator ? value[(separator + 1)..] : ""
      integer = Integer(integer_part, 10)
      kept = fractional_part[0, 6].to_s.ljust(6, "0")
      result = integer * 1_000_000 + Integer(kept.empty? ? "0" : kept, 10)
      local_invalid! if result <= 0 || result > UINT64_MAX
      ExactDecimal.new(source: value, integer: result, scale: fractional_part.length)
    rescue ArgumentError
      local_invalid!
    end

    # Reproduce the pinned JS conversion without formatting through a locale or
    # a decimal float.  Ruby Float is IEEE754 binary64 on supported runtimes.
    def binary64_rounded_decimal_units(value)
      local_invalid! unless value.is_a?(String)
      number = Float(value)
      local_invalid! unless number.finite? && number.positive?
      bits = [number].pack("G").unpack1("Q>")
      exponent = (bits >> 52) & 0x7ff
      fraction = bits & ((1 << 52) - 1)
      mantissa = exponent.zero? ? fraction : (1 << 52) | fraction
      binary_exponent = exponent.zero? ? -1074 : exponent - 1023 - 52
      numerator = mantissa * 10_000_000
      denominator = 1
      if binary_exponent >= 0
        numerator <<= binary_exponent
      else
        denominator <<= -binary_exponent
      end
      rounded, remainder = numerator.divmod(denominator)
      rounded += 1 if remainder * 2 >= denominator
      result = rounded / 10
      local_invalid! if result <= 0 || result > UINT64_MAX
      result
    rescue ArgumentError, RangeError
      local_invalid!
    end

    def exact_intermediate_amount(raw, direct, amount_in)
      decimal = parse_plain_decimal(raw)
      exact = decimal.integer
      if direct
        local_invalid! unless exact == uint64(amount_in, positive: true)
        return exact.to_s
      end
      local_invalid! unless binary64_rounded_decimal_units(raw) == exact
      exact.to_s
    end

    def validate_destination_minimum_compatibility(value, root = nil)
      units = uint64(value, positive: true)
      if root
        raw_lexeme = raw_number_lexeme(root, "minAmountOut")
        local_invalid! unless parse_plain_decimal(raw_lexeme).integer == units && binary64_rounded_decimal_units(raw_lexeme) == units
      else
        whole, remainder = units.divmod(1_000_000)
        decimal = "#{whole}.#{format('%06d', remainder)}"
        local_invalid! unless binary64_rounded_decimal_units(decimal) == units
      end
    end

    ED25519_P = (1 << 255) - 19
    ED25519_D = (-121665 * 121666.pow(ED25519_P - 2, ED25519_P)) % ED25519_P
    ED25519_SQRT_M1 = 2.pow((ED25519_P - 1) / 4, ED25519_P)

    def is_on_curve_zip215(bytes)
      return false unless bytes.is_a?(String) && bytes.bytesize == 32
      # Use the integer representation, which is deterministic and bounded.
      encoded = bytes.bytes.each_with_index.sum { |byte, index| byte << (index * 8) }
      sign = encoded >> 255
      y = (encoded & ((1 << 255) - 1)) % ED25519_P
      y_squared = (y * y) % ED25519_P
      numerator = (y_squared - 1) % ED25519_P
      denominator = (ED25519_D * y_squared + 1) % ED25519_P
      return false if denominator.zero?
      x_squared = numerator * denominator.pow(ED25519_P - 2, ED25519_P) % ED25519_P
      x = x_squared.pow((ED25519_P + 3) / 8, ED25519_P)
      if (x * x - x_squared) % ED25519_P != 0
        x = x * ED25519_SQRT_M1 % ED25519_P
      end
      return false if (x * x - x_squared) % ED25519_P != 0
      x = ED25519_P - x if !x.zero? && (x & 1) != sign
      true
    rescue StandardError
      false
    end

    def find_program_address(seeds, program_id)
      local_invalid! unless seeds.is_a?(Array) && seeds.length <= 16 && seeds.all? { |seed| seed.is_a?(String) && seed.bytesize <= 32 }
      program = base58_decode(program_id)
      local_invalid! unless program.bytesize == 32
      suffix = "ProgramDerivedAddress".b
      255.downto(0) do |bump|
        candidate = Digest::SHA256.digest(concat(*seeds, [bump].pack("C"), program, suffix))
        return [base58_encode(candidate), bump] unless is_on_curve_zip215(candidate)
      end
      local_invalid!
    end

    def associated_token_address(owner, mint, allow_owner_off_curve)
      owner_bytes = base58_decode(owner)
      mint_bytes = base58_decode(mint)
      local_invalid! unless owner_bytes.bytesize == 32 && mint_bytes.bytesize == 32
      local_invalid! if !allow_owner_off_curve && !is_on_curve_zip215(owner_bytes)
      find_program_address([owner_bytes, base58_decode(SOLANA_TOKEN_PROGRAM), mint_bytes], SOLANA_ASSOCIATED_TOKEN_PROGRAM).first
    end

    def parse_source_quote(quote, route)
      raw_text = quote.fetch("rawSignedQuoteJson")
      root, raw = local_json_object(raw_text)
      minimum_lexeme = raw_number_lexeme(root, "minMiddleAmount")
      from_token = node_value(root, "fromToken")
      to_token = node_value(root, "toToken")
      local_invalid! unless from_token.is_a?(Hash) && to_token.is_a?(Hash)
      source_standard = route.source_chain_id == MayanSwiftV2BridgeClient::ETHEREUM_CHAIN_ID ? "erc20" : "spl"
      destination_standard = route.destination_chain_id == MayanSwiftV2BridgeClient::ETHEREUM_CHAIN_ID ? "erc20" : "spl"
      source_swap = quote.fetch("sourceSwap")
      local_invalid! unless source_swap.is_a?(Hash)
      local_invalid! unless raw["signature"].is_a?(String) && MayanSwiftV2BridgeClient::EVM_SIGNATURE.match?(raw["signature"]) &&
        raw["signature"].casecmp?(quote.fetch("providerSignature"))
      local_invalid! unless raw["slippageBps"] == quote.fetch("slippageBps")
      local_invalid! unless source_swap["providerMinimumAmount"] == minimum_lexeme
      raw_router = raw.fetch("evmSwapRouterAddress", :__bridge_missing__)
      if route.is_usdc || route.source_chain_id == MayanSwiftV2BridgeClient::SOLANA_CHAIN_ID
        local_invalid! unless raw_router == :__bridge_missing__ || raw_router.nil?
      else
        local_invalid! unless raw_router.is_a?(String) && EVM_ADDRESS.match?(raw_router) &&
          source_swap["routerKind"] == "provider-selected-evm" && raw_address_equals(raw_router, source_swap["routerAddress"])
      end
      raw_calldata = raw.fetch("evmSwapRouterCalldata", :__bridge_missing__)
      if raw_calldata != :__bridge_missing__ && raw_calldata != nil
        local_invalid! unless raw_calldata.is_a?(String) && HEX_BYTES.match?(raw_calldata) && raw_calldata != "0x" &&
          hex_to_bytes(raw_calldata).bytesize <= MAX_ROUTER_CALLDATA_BYTES
      end
      local_invalid! unless raw["type"] == "SWIFT" && raw["swiftVersion"] == "V2" && raw["gasless"] == false &&
        raw["onlyBridging"] == false && raw["swiftWrapAndLock"] != true &&
        raw["fromChain"] == route.source_name && raw["toChain"] == route.destination_name &&
        raw["effectiveAmountIn64"] == quote["amountIn"] && raw["expectedAmountOutBaseUnits"] == quote["expectedAmountOut"] &&
        raw["minAmountOutBaseUnits"] == quote["minimumAmountOut"] && raw["minReceivedBaseUnits"] == quote["minimumReceived"] &&
        raw["deadline64"] == quote["deadline"] && raw["quoteId"].is_a?(String) && raw["quoteId"].casecmp?(quote["quoteId"].to_s) &&
        raw["swiftInputDecimals"] == 6 && raw_address_equals(raw["swiftInputContract"], route.source_usdc_address) &&
        raw["swiftInputContractStandard"] == source_standard && raw_address_equals(raw["swiftMayanContract"], route.swift_contract) &&
        raw["referrerBps"] == 0 && raw["protocolBps"] == 0 && raw_number_zero(raw["gasDrop"]) &&
        raw_address_equals(from_token["contract"], route.source_token_address) && from_token["standard"] == source_standard && from_token["decimals"] == 6 &&
        raw_address_equals(to_token["contract"], route.destination_token_address) && to_token["standard"] == destination_standard && to_token["decimals"] == 6
      mode = raw["swiftAuctionMode"]
      local_invalid! unless mode == 2 || mode == 3
      expected_mode = route.is_usdc ? 3 : 2
      local_invalid! unless mode == expected_mode
      local_invalid! if mode == 3 && (raw["expectedAmountOutBaseUnits"] != raw["minAmountOutBaseUnits"] || raw["minAmountOutBaseUnits"] != raw["minReceivedBaseUnits"])
      local_invalid! if raw.key?("memoHex")
      %w[customPayload referrer referrerAddress swiftRefundAddress permit approval approvalBatch separateSwapTx jito extraInstructions].each do |key|
        value = raw.fetch(key, :__bridge_missing__)
        local_invalid! if value != :__bridge_missing__ && ![nil, false, ""].include?(value)
      end
      minimum_intermediate_amount = exact_intermediate_amount(minimum_lexeme, route.is_usdc, quote.fetch("amountIn"))
      unless route.is_usdc
        numeric = Float(minimum_lexeme)
        local_invalid! unless numeric.finite? && numeric.positive?
      end
      ParsedSourceQuote.new(
        raw: raw, root: root, minimum_intermediate_amount: minimum_intermediate_amount,
        mode: mode, cancel_fee: raw_uint64(raw, "cancelRelayerFee64"),
        refund_fee: raw_uint64(raw, "refundRelayerFee64"), submit_fee: raw_uint64(raw, "submitRelayerFee64"),
        suggested_priority_fee: raw_optional_bounded_integer(raw, "suggestedPriorityFee", 100_000)
      )
    rescue KeyError, TypeError, ArgumentError
      local_invalid!
    end

    def base64_decode(value, maximum_bytes = MAX_SOLANA_SWAP_DATA_BYTES)
      local_invalid! unless value.is_a?(String) && value.bytesize <= ((maximum_bytes * 4.0 / 3).ceil + 4) && BASE64.match?(value)
      decoded = Base64.strict_decode64(value)
      local_invalid! unless decoded.bytesize <= maximum_bytes && Base64.strict_encode64(decoded) == value
      decoded
    rescue ArgumentError
      local_invalid!
    end

    def instruction_from_raw(value)
      local_invalid! unless value.is_a?(Hash) && value.keys.sort == %w[accounts data programId]
      program_id = canonical_solana_address(value["programId"])
      raw_accounts = value["accounts"]
      local_invalid! unless raw_accounts.is_a?(Array) && raw_accounts.length <= MAX_SOLANA_SWAP_ACCOUNTS
      accounts = raw_accounts.map do |raw_account|
        local_invalid! unless raw_account.is_a?(Hash) && raw_account.keys.sort == %w[isSigner isWritable pubkey]
        local_invalid! unless raw_account["isSigner"] == true || raw_account["isSigner"] == false
        local_invalid! unless raw_account["isWritable"] == true || raw_account["isWritable"] == false
        { "pubkey" => canonical_solana_address(raw_account["pubkey"]), "isSigner" => raw_account["isSigner"], "isWritable" => raw_account["isWritable"] }
      end
      data = value["data"]
      base64_decode(data)
      { "programId" => program_id, "accounts" => accounts, "dataBase64" => data }
    end

    def encode_instruction_data(value)
      base64_decode(value)
    end

    def account_at(instruction, index)
      value = instruction.fetch("accounts")[index]
      local_invalid! unless value
      value
    end

    def assert_account(account, pubkey, signer, writable)
      local_invalid! unless account["pubkey"] == pubkey && account["isSigner"] == signer && account["isWritable"] == writable
    end

    def validate_compute_instructions(instructions)
      local_invalid! unless instructions.length <= 2
      tags = []
      instructions.each do |instruction|
        local_invalid! unless instruction["programId"] == SOLANA_COMPUTE_BUDGET_PROGRAM && instruction["accounts"].empty?
        data = encode_instruction_data(instruction["dataBase64"])
        tag = data.getbyte(0)
        local_invalid! unless [2, 3].include?(tag) && !tags.include?(tag)
        tags << tag
        if tag == 2
          local_invalid! unless data.bytesize == 5 && data.byteslice(1, 4).unpack1("V") <= 1_400_000
        else
          local_invalid! unless data.bytesize == 9 && data.byteslice(1, 8).unpack1("Q<") <= 100_000
        end
      end
    end

    def validate_ata_setup(instructions, swapper_address, state_address, source_usdc_address)
      local_invalid! unless !instructions.empty? && instructions.length <= 2
      owners = []
      instructions.each do |instruction|
        local_invalid! unless instruction["programId"] == SOLANA_ASSOCIATED_TOKEN_PROGRAM && instruction["accounts"].length == 6
        assert_account(account_at(instruction, 0), swapper_address, true, true)
        owner = account_at(instruction, 2)["pubkey"]
        local_invalid! unless [swapper_address, state_address].include?(owner) && !owners.include?(owner)
        owners << owner
        assert_account(account_at(instruction, 2), owner, false, false)
        expected_ata = associated_token_address(owner, source_usdc_address, owner == state_address)
        assert_account(account_at(instruction, 1), expected_ata, false, true)
        assert_account(account_at(instruction, 3), source_usdc_address, false, false)
        assert_account(account_at(instruction, 4), SOLANA_SYSTEM_PROGRAM, false, false)
        assert_account(account_at(instruction, 5), SOLANA_TOKEN_PROGRAM, false, false)
        local_invalid! unless ["", "AQ=="].include?(instruction["dataBase64"])
      end
      local_invalid! unless owners.include?(state_address)
    end

    def validate_jupiter_instruction(instruction, route, quote, state_token_account, swapper_address, minimum_intermediate_amount, source_swap_raw)
      local_invalid! unless instruction["programId"] == SOLANA_JUPITER_V6 && instruction["accounts"].length.between?(8, MAX_SOLANA_SWAP_ACCOUNTS)
      data = encode_instruction_data(instruction["dataBase64"])
      local_invalid! unless data.byteslice(0, 8).unpack1("H*") == SOLANA_ROUTE_V2_DISCRIMINATOR
      quote_response = source_swap_raw["quoteResponse"]
      local_invalid! unless quote_response.is_a?(Hash)
      quote_response_raw = quote_response["raw"]
      local_invalid! unless quote_response_raw.is_a?(Hash)
      route_plan = quote_response_raw["routePlan"]
      local_invalid! unless route_plan.is_a?(Array) && route_plan.length == 1 && route_plan[0].is_a?(Hash)
      swap_info = route_plan[0]["swapInfo"]
      local_invalid! unless swap_info.is_a?(Hash)
      local_invalid! unless raw_address_equals(quote_response["inputMint"], route.source_token_address) && raw_address_equals(quote_response["outputMint"], route.source_usdc_address) &&
        raw_address_equals(quote_response_raw["inputMint"], route.source_token_address) && raw_address_equals(quote_response_raw["outputMint"], route.source_usdc_address) &&
        raw_address_equals(swap_info["inputMint"], route.source_token_address) && raw_address_equals(swap_info["outputMint"], route.source_usdc_address) &&
        swap_info["inAmount"].is_a?(String) && swap_info["outAmount"].is_a?(String) &&
        uint64(swap_info["inAmount"], positive: true) == uint64(quote.fetch("amountIn"), positive: true) &&
        uint64(swap_info["outAmount"], positive: true) >= uint64(minimum_intermediate_amount, positive: true)
      label = swap_info["label"]
      expected_tail, expected_count, _expected_dex, expected_pool = case label
                                                                    when "Whirlpool"
                                                                      [SOLANA_ROUTE_V2_WHIRLPOOL_TAIL, 22, SOLANA_WHIRLPOOL_PROGRAM, SOLANA_WHIRLPOOL_POOL]
                                                                    when "Raydium CLMM"
                                                                      [SOLANA_ROUTE_V2_RAYDIUM_TAIL, 25, SOLANA_RAYDIUM_CLMM_PROGRAM, SOLANA_RAYDIUM_CLMM_POOL]
                                                                    else
                                                                      local_invalid!
                                                                    end
      local_invalid! unless data.bytesize == 28 + expected_tail.length / 2 && data.byteslice(28..).unpack1("H*") == expected_tail && instruction["accounts"].length == expected_count
      trader_eurc = associated_token_address(swapper_address, route.source_token_address, false)
      trader_usdc = associated_token_address(swapper_address, route.source_usdc_address, false)
      expected_accounts = if label == "Whirlpool"
                           [
                             [swapper_address, true, false], [trader_eurc, false, true], [trader_usdc, false, true],
                             [route.source_token_address, false, false], [route.source_usdc_address, false, false],
                             [SOLANA_TOKEN_PROGRAM, false, false], [SOLANA_TOKEN_PROGRAM, false, false],
                             [state_token_account, false, true], [SOLANA_ANCHOR_EVENT_AUTHORITY, false, false],
                             [SOLANA_JUPITER_V6, false, false], [SOLANA_WHIRLPOOL_PROGRAM, false, false],
                             [SOLANA_TOKEN_PROGRAM, false, false], [swapper_address, false, false],
                             [SOLANA_WHIRLPOOL_POOL, false, true], [trader_usdc, false, true],
                             [SOLANA_WHIRLPOOL_TICK_ARRAY_0, false, true], [trader_eurc, false, true],
                             [SOLANA_WHIRLPOOL_TICK_ARRAY_1, false, true], [SOLANA_WHIRLPOOL_TICK_ARRAY_2, false, true],
                             [SOLANA_WHIRLPOOL_ORACLE, false, true], [SOLANA_WHIRLPOOL_REWARD_VAULT, false, true],
                             [SOLANA_WHIRLPOOL_REMAINING, false, false]
                           ]
                         else
                           [
                             [swapper_address, true, false], [trader_eurc, false, true], [trader_usdc, false, true],
                             [route.source_token_address, false, false], [route.source_usdc_address, false, false],
                             [SOLANA_TOKEN_PROGRAM, false, false], [SOLANA_TOKEN_PROGRAM, false, false],
                             [state_token_account, false, true], [SOLANA_ANCHOR_EVENT_AUTHORITY, false, false],
                             [SOLANA_JUPITER_V6, false, false], [SOLANA_RAYDIUM_CLMM_PROGRAM, false, false],
                             [swapper_address, false, false], [SOLANA_RAYDIUM_CONFIG, false, false],
                             [SOLANA_RAYDIUM_CLMM_POOL, false, true], [trader_eurc, false, true], [trader_usdc, false, true],
                             [SOLANA_RAYDIUM_OBSERVATION, false, true], [SOLANA_RAYDIUM_TICK_ARRAY_0, false, true],
                             [SOLANA_RAYDIUM_TICK_ARRAY_1, false, true], [SOLANA_TOKEN_PROGRAM, false, false],
                             [SOLANA_RAYDIUM_TICK_ARRAY_2, false, true], [SOLANA_RAYDIUM_TICK_ARRAY_3, false, true],
                             [SOLANA_RAYDIUM_ORACLE, false, true], [SOLANA_RAYDIUM_REMAINING, false, true],
                             [SOLANA_JUPITER_V6, false, false]
                           ]
                         end
      local_invalid! unless expected_accounts.length == instruction["accounts"].length
      expected_accounts.each_with_index do |(pubkey, signer, writable), index|
        assert_account(account_at(instruction, index), pubkey, signer, writable)
      end
      local_invalid! unless swap_info["ammKey"] == expected_pool
      input_amount = data.byteslice(8, 8).unpack1("Q<")
      quoted_output = data.byteslice(16, 8).unpack1("Q<")
      slippage_bps = data.byteslice(24, 2).unpack1("v")
      platform_bps = data.byteslice(26, 2).unpack1("v")
      local_invalid! unless input_amount == uint64(quote.fetch("amountIn"), positive: true) && quoted_output >= uint64(minimum_intermediate_amount, positive: true) && platform_bps.zero? && slippage_bps <= 10_000
    end

    def validate_source_swap_envelope(quote, route, raw, state_address, state_token_account, swapper_address, minimum_intermediate_amount)
      local_invalid! if route.is_usdc
      if route.source_chain_id == MayanSwiftV2BridgeClient::ETHEREUM_CHAIN_ID
        local_invalid! unless raw.keys.sort == %w[swapRouterAddress swapRouterCalldata]
        router = normalize_evm_address(raw["swapRouterAddress"])
        source_swap = quote["sourceSwap"]
        local_invalid! unless source_swap.is_a?(Hash) && source_swap["routerAddress"] == router && source_swap["routerKind"] == "provider-selected-evm"
        calldata = raw["swapRouterCalldata"]
        local_invalid! unless calldata.is_a?(String) && HEX_BYTES.match?(calldata)
        local_invalid! unless calldata != "0x" && calldata.downcase.start_with?(EVM_SOURCE_SWAP_SELECTOR) && hex_to_bytes(calldata).bytesize <= MAX_ROUTER_CALLDATA_BYTES
        return { "kind" => "evm-router", "routerAddress" => router, "calldata" => calldata.downcase, "rawResponseSha256" => "", "rawProviderSourceSwapJson" => "" }
      end
      token_ledger = raw.fetch("tokenLedgerInstruction", :__bridge_missing__)
      local_invalid! if token_ledger != :__bridge_missing__ && !token_ledger.nil?
      compute_value = raw["computeBudgetInstructions"]
      setup_value = raw["setupInstructions"]
      swap_value = raw.fetch("swapInstruction", :__bridge_missing__)
      local_invalid! unless compute_value.is_a?(Array) && setup_value.is_a?(Array) && swap_value.is_a?(Hash)
      cleanup = raw.fetch("cleanupInstruction", :__bridge_missing__)
      local_invalid! if cleanup != :__bridge_missing__ && !cleanup.nil?
      local_invalid! unless raw["otherInstructions"].is_a?(Array) && raw["otherInstructions"].empty?
      simulation_error = raw.fetch("simulationError", :__bridge_missing__)
      local_invalid! if simulation_error != :__bridge_missing__ && !simulation_error.nil?
      separate_swap = raw.fetch("separateSwapTx", :__bridge_missing__)
      local_invalid! if separate_swap != :__bridge_missing__ && separate_swap != false
      jito = raw.fetch("jito", :__bridge_missing__)
      local_invalid! if jito != :__bridge_missing__ && ![false, nil].include?(jito)
      compute = compute_value.map { |item| instruction_from_raw(item) }
      setup = setup_value.map { |item| instruction_from_raw(item) }
      swap = instruction_from_raw(swap_value)
      validate_compute_instructions(compute)
      validate_ata_setup(setup, swapper_address, state_address, route.source_usdc_address)
      validate_jupiter_instruction(swap, route, quote, state_token_account, swapper_address, minimum_intermediate_amount, raw)
      provider_alts = raw["addressLookupTableAddresses"]
      local_invalid! unless provider_alts.is_a?(Array) && provider_alts.length <= MAX_LOOKUP_TABLES && provider_alts.all? { |address| address.is_a?(String) && canonical_solana_address(address) == address }
      priority_fee = raw.fetch("prioritizationFeeLamports", :__bridge_missing__)
      local_invalid! if priority_fee != :__bridge_missing__ && (!priority_fee.is_a?(Integer) || priority_fee.negative?)
      compute_limit = raw.fetch("computeUnitLimit", :__bridge_missing__)
      local_invalid! if compute_limit != :__bridge_missing__ && (!compute_limit.is_a?(Integer) || compute_limit > 1_400_000)
      { "kind" => "solana-jupiter-v6", "instructions" => compute + setup + [swap], "addressLookupTableAddresses" => provider_alts, "rawResponseSha256" => "", "rawProviderSourceSwapJson" => "" }
    end

    def swift_random(quote_id, order_nonce)
      hex_to_bytes(quote_id) + hex_to_bytes(order_nonce)
    end

    def write_uint16_be(value)
      local_invalid! unless value.is_a?(Integer) && value >= 0 && value <= 0xffff
      [value].pack("n")
    end

    def write_uint16_le(value)
      local_invalid! unless value.is_a?(Integer) && value >= 0 && value <= 0xffff
      [value].pack("v")
    end

    def write_uint64_be(value)
      local_invalid! unless value.is_a?(Integer) && value >= 0 && value <= UINT64_MAX
      [value].pack("Q>")
    end

    def write_uint64_le(value)
      local_invalid! unless value.is_a?(Integer) && value >= 0 && value <= UINT64_MAX
      [value].pack("Q<")
    end

    def zero32
      "\0".b * 32
    end

    def order_preimage(quote, route, swapper_address, destination_address, order_nonce, cancel_fee, refund_fee, mode)
      parts = [
        "\x01".b,
        native_address_bytes(swapper_address, route.source_chain_id),
        write_uint16_be(route.source_wormhole_chain_id),
        native_address_bytes(route.source_usdc_address, route.source_chain_id),
        native_address_bytes(destination_address, route.destination_chain_id),
        write_uint16_be(route.destination_wormhole_chain_id),
        native_address_bytes(route.destination_token_address, route.destination_chain_id),
        write_uint64_be(uint64(quote.fetch("minimumAmountOut"), positive: true)),
        write_uint64_be(0), write_uint64_be(cancel_fee), write_uint64_be(refund_fee),
        write_uint64_be(uint64(quote.fetch("deadline"), positive: true)), zero32,
        [0, 0, mode].pack("C3"), swift_random(quote.fetch("quoteId"), order_nonce), zero32
      ]
      result = concat(*parts)
      local_invalid! unless result.bytesize == 272
      result
    end

    def hash_order(quote, route, swapper_address, destination_address, order_nonce, cancel_fee, refund_fee, mode)
      "0x#{keccak_hex(order_preimage(quote, route, swapper_address, destination_address, order_nonce, cancel_fee, refund_fee, mode))}"
    end

    def quote_binding_hash(route, quote, raw_quote_sha256, order_nonce, swapper_address, destination_address)
      value = {
        "capabilityId" => route.capability_id,
        "destinationAddress" => destination_address,
        "destinationChainId" => route.destination_chain_id,
        "destinationTokenDeploymentId" => route.destination_token_deployment_id,
        "orderNonce" => order_nonce,
        "quoteId" => quote.fetch("quoteId"),
        "rawQuoteSha256" => raw_quote_sha256,
        "sourceChainId" => route.source_chain_id,
        "sourceTokenDeploymentId" => route.source_token_deployment_id,
        "swapperAddress" => swapper_address
      }
      sha256_hex(stable_json(value))
    end

    def source_swap_hash_projection(source_swap)
      return source_swap if source_swap["kind"] == "none"

      source_swap.reject { |key, _| key == "rawProviderSourceSwapJson" }
    end

    def plan_hash(binding, source_swap)
      sha256_hex(stable_json("quoteBindingHash" => binding, "sourceSwap" => source_swap_hash_projection(source_swap)))
    end

    def config_value(config, *names)
      return :__bridge_missing__ unless config.is_a?(Hash)
      names.each do |name|
        return config[name] if config.key?(name)
        symbol = name.to_sym
        return config[symbol] if config.key?(symbol)
      end
      :__bridge_missing__
    end

    def endpoint_url(value)
      source = value == :__bridge_missing__ || value.nil? ? SOLANA_MAYAN_SOURCE_SWAP_ENDPOINT : value
      local_invalid! unless source.is_a?(String) && !source.empty? && source.strip == source
      uri = URI.parse(source)
      hostname = uri.hostname.to_s.downcase
      scheme = uri.scheme.to_s.downcase
      local_invalid! if uri.user || uri.password || uri.query || uri.fragment || uri.host.to_s.empty?
      local_invalid! unless scheme == "https" || (scheme == "http" && %w[localhost 127.0.0.1 ::1].include?(hostname))
      uri.scheme = scheme
      uri.path = uri.path.to_s.sub(%r{/+\z}, "")
      uri.path = "/" if uri.path.empty?
      uri.to_s
    rescue URI::InvalidURIError, ArgumentError
      local_invalid!
    end

    def js_string(value)
      return value ? "true" : "false" if value == true || value == false
      if value.is_a?(Float)
        local_invalid! unless value.finite?
        return value.to_i.to_s if value.to_i == value
        return value.to_s
      end
      value.to_s
    end

    def source_swap_url(endpoint, chain, params)
      uri = URI.parse(endpoint)
      base = uri.path.to_s.sub(%r{/+\z}, "")
      uri.path = "#{base}/get-swap/#{chain}".gsub(%r{/+}, "/")
      query = params.map { |key, value| "#{URI.encode_www_form_component(key.to_s)}=#{URI.encode_www_form_component(js_string(value))}" }.join("&")
      uri.query = query
      uri.fragment = nil
      uri.to_s
    rescue URI::InvalidURIError, ArgumentError
      local_invalid!
    end

    def context_mapping(value, build:)
      local_invalid! unless value.is_a?(Hash) && value.keys.all? { |key| key.is_a?(String) }
      expected = build ? %w[destinationAddress orderNonce quote sourceSwapPlan swapperAddress] : %w[destinationAddress orderNonce quote swapperAddress]
      local_invalid! unless value.keys.sort == expected.sort
      value
    end

    def normalize_local_address(value, chain_id)
      chain_id == MayanSwiftV2BridgeClient::ETHEREUM_CHAIN_ID ? normalize_evm_address(value) : canonical_solana_address(value)
    end

    def validate_local_expiry(quote, client)
      deadline = uint64(quote.fetch("deadline"), positive: true)
      now = client.instance_variable_get(:@clock).call.to_i
      local_invalid! if now + client.config.minimum_quote_validity_seconds > deadline
    rescue KeyError, NoMethodError
      local_invalid!
    end

    def check_aborted(client, options)
      client.__send__(:check_aborted, options)
    rescue BridgeError => error
      ERPC.raise_safe_bridge_error(error)
    end

    def local_build_config(client)
      value = client.config.local_build
      return {} if value.nil?
      local_invalid! unless value.is_a?(Hash)
      value
    end

    def local_monotonic_now
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end

    def local_deadline(timeout)
      local_monotonic_now + timeout.to_f
    end

    def local_remaining(deadline)
      remaining = deadline - local_monotonic_now
      raise Timeout::Error if remaining <= 0

      remaining
    end

    def local_with_deadline(deadline)
      Timeout.timeout(local_remaining(deadline), Timeout::Error) { yield }
    end

    def dispose_queued_local_responses(queue)
      loop do
        event, value = queue.pop(true)
        dispose_local_response(value) if event == :response
      rescue ThreadError
        break
      end
    end

    def perform_local_adapter_request(client, options, deadline, request)
      queue = Queue.new
      worker = Thread.new do
        begin
          queue << [:response, client.instance_variable_get(:@http_adapter).request(**request)]
        rescue Exception => error # rubocop:disable Lint/RescueException
          queue << [:error, error]
        end
      end
      completed = false
      begin
        loop do
          check_aborted(client, options)
          local_remaining(deadline)
          event, value = begin
            queue.pop(true)
          rescue ThreadError
            sleep(0.001)
            next
          end
          completed = true
          if event == :response
            return value
          end
          ERPC.raise_safe_bridge_error(value) if value.is_a?(BridgeError)
          raise value
        end
      ensure
        unless completed
          worker.kill
          worker.join(RESPONSE_DISPOSAL_TIMEOUT)
          dispose_queued_local_responses(queue)
        else
          worker.join(RESPONSE_DISPOSAL_TIMEOUT)
        end
      end
    end

    def source_swap_request(client, url, options)
      deadline = local_deadline(client.config.timeout)
      response = nil
      begin
        check_aborted(client, options)
        response = perform_local_adapter_request(
          client, options, deadline,
          method: :get,
          url: url,
          headers: { "accept" => "application/json" },
          body: nil,
          timeout: local_remaining(deadline)
        )
        check_aborted(client, options)
        status = response_status(response)
        fail_local(BridgeErrorCode::PROVIDER_TRANSPORT) unless status.is_a?(Integer)
        fail_local(BridgeErrorCode::PROVIDER_HTTP, status) unless status.between?(200, 299)
        fail_local(BridgeErrorCode::PROVIDER_INVALID_RESPONSE) if response_declared_size(response).to_i > MAX_RESPONSE_BYTES
        body = local_with_deadline(deadline) do
          read_local_response_body(response, client, options, deadline)
        end
        root, raw = local_json_object(body)
        [body, root, raw]
      rescue BridgeError
        dispose_local_response(response)
        raise
      rescue MayanBridgeBodyTooLarge
        dispose_local_response(response)
        fail_local(BridgeErrorCode::PROVIDER_INVALID_RESPONSE)
      rescue TimeoutError, Timeout::Error
        dispose_local_response(response)
        fail_local(BridgeErrorCode::TIMEOUT)
      rescue LocalValidationError, LocalResponseTooLarge, LocalResponseInvalidEncoding
        dispose_local_response(response)
        fail_local(BridgeErrorCode::PROVIDER_INVALID_RESPONSE)
      rescue StandardError
        dispose_local_response(response)
        check_aborted(client, options)
        fail_local(BridgeErrorCode::PROVIDER_TRANSPORT)
      end
    end

    def dispose_local_response(response)
      return if response.nil?

      targets = [response]
      unless response.respond_to?(:read_body)
        begin
          body = if response.is_a?(Hash)
                   response[:body] || response["body"]
                 elsif response.respond_to?(:body)
                   response.body
                 end
          targets << body unless body.nil? || body.equal?(response)
        rescue StandardError
          # Disposal is best effort and must not replace a sanitized public error.
        end
      end
      targets.uniq.each do |target|
        %i[cancel close finish].each do |method|
          next unless target.respond_to?(method)

          begin
            Timeout.timeout(RESPONSE_DISPOSAL_TIMEOUT, Timeout::Error) { target.public_send(method) }
            break
          rescue StandardError
            # Try the next best-effort disposal method within the fixed bound.
          end
        end
      end
    end

    def response_status(response)
      if response.respond_to?(:status)
        response.status
      elsif response.is_a?(Hash)
        response[:status] || response["status"]
      end
    end

    def response_declared_size(response)
      headers = if response.is_a?(Hash)
                  response[:headers] || response["headers"]
                elsif response.respond_to?(:headers)
                  response.headers
                end
      return nil unless headers

      value = if headers.respond_to?(:each_pair)
                headers.each_pair.find { |name, _| name.to_s.downcase == "content-length" }&.last
              elsif headers.respond_to?(:[])
                headers["content-length"] || headers["Content-Length"]
              end
      return nil unless value.is_a?(String) || value.is_a?(Integer)

      text = value.to_s
      return nil unless text.match?(/\A[0-9]+\z/)

      Integer(text, 10)
    rescue ArgumentError, TypeError
      nil
    end

    def response_body_source(response)
      if response.is_a?(Hash)
        response[:body] || response["body"]
      elsif response.respond_to?(:body)
        response.body
      end
    end

    def read_response_chunks(response, queue)
      produced_bytes = 0
      enqueue = lambda do |chunk|
        raise LocalResponseInvalidEncoding unless chunk.is_a?(String)

        produced_bytes += chunk.bytesize
        raise LocalResponseTooLarge if produced_bytes > MAX_RESPONSE_BYTES

        queue.push([:chunk, chunk])
      end
      if response.respond_to?(:read_body)
        response.read_body { |chunk| enqueue.call(chunk) }
      else
        body = response_body_source(response)
        if body.respond_to?(:read) && !body.is_a?(String)
          loop do
            chunk = body.read(16_384)
            break if chunk.nil? || chunk.empty?

            enqueue.call(chunk)
          end
        elsif body.respond_to?(:each) && !body.is_a?(String)
          body.each { |chunk| enqueue.call(chunk) }
        else
          enqueue.call(body)
        end
      end
      queue << [:done, nil]
    rescue Exception => error # rubocop:disable Lint/RescueException
      queue << [:error, error]
    end

    def read_local_response_body(response, client, options, deadline = nil)
      chunks = []
      total = 0
      append = lambda do |chunk|
        check_aborted(client, options)
        local_remaining(deadline) unless deadline.nil?
        raise LocalResponseInvalidEncoding unless chunk.is_a?(String)

        total += chunk.bytesize
        raise LocalResponseTooLarge if total > MAX_RESPONSE_BYTES

        chunks << chunk.b
      end
      streaming = response.respond_to?(:read_body)
      source = streaming ? response : response_body_source(response)
      if streaming || (source.respond_to?(:read) && !source.is_a?(String)) || (source.respond_to?(:each) && !source.is_a?(String))
        queue = SizedQueue.new(STREAM_QUEUE_CAPACITY)
        reader = Thread.new { read_response_chunks(response, queue) }
        completed = false
        begin
          loop do
            check_aborted(client, options)
            local_remaining(deadline) unless deadline.nil?
            event, value = begin
              queue.pop(true)
            rescue ThreadError
              sleep(0.001)
              next
            end
            case event
            when :chunk
              append.call(value)
            when :done
              completed = true
              break
            when :error
              if value.is_a?(BridgeError)
                ERPC.raise_safe_bridge_error(value)
              end
              raise value
            end
          end
        ensure
          unless completed
            reader.kill
            reader.join(RESPONSE_DISPOSAL_TIMEOUT)
          else
            reader.join(RESPONSE_DISPOSAL_TIMEOUT)
          end
        end
      else
        append.call(source)
      end
      check_aborted(client, options)
      local_remaining(deadline) unless deadline.nil?
      text = chunks.join.b.force_encoding(Encoding::UTF_8)
      raise LocalResponseInvalidEncoding unless text.valid_encoding?

      text
    end

    def prepare_source_swap(client, context, options = nil)
      options ||= {}
      value = deep_dup(context)
      begin
        value = context_mapping(value, build: false)
        quote = value.fetch("quote")
        local_invalid! unless quote.is_a?(Hash)
        route = validate_local_route(quote, client)
        parsed_quote = parse_source_quote(quote, route)
        swapper = normalize_local_address(value.fetch("swapperAddress"), route.source_chain_id)
        destination = normalize_local_address(value.fetch("destinationAddress"), route.destination_chain_id)
        nonce = value.fetch("orderNonce")
        local_invalid! unless nonce.is_a?(String) && NONCE.match?(nonce)
        validate_destination_minimum_compatibility(quote.fetch("minimumAmountOut"), parsed_quote.root)
        validate_local_expiry(quote, client)
        raw_quote = quote.fetch("rawSignedQuoteJson")
        local_invalid! unless raw_quote.is_a?(String)
        raw_sha = sha256_hex(raw_quote)
        order_hash = hash_order(quote, route, swapper, destination, nonce, parsed_quote.cancel_fee, parsed_quote.refund_fee, parsed_quote.mode)
        binding = quote_binding_hash(route, quote, raw_sha, nonce, swapper, destination)
      rescue BridgeError
        raise
      rescue LocalValidationError, KeyError, TypeError, ArgumentError
        fail_local(BridgeErrorCode::LOCAL_PLAN_INVALID)
      rescue StandardError
        fail_local(BridgeErrorCode::LOCAL_PLAN_INVALID)
      end

      source_swap = if route.is_usdc
                       { "kind" => "none" }
                     else
                       begin
                         endpoint = endpoint_url(config_value(local_build_config(client), "source_swap_endpoint", "sourceSwapEndpoint"))
                         from_token = parsed_quote.raw["fromToken"]
                         local_invalid! unless from_token.is_a?(Hash)
                         url = if route.source_chain_id == MayanSwiftV2BridgeClient::ETHEREUM_CHAIN_ID
                                 source_swap_url(endpoint, "evm", [
                                   ["forwarderAddress", ETHEREUM_FORWARDER_PROVIDER],
                                   ["slippageBps", quote.fetch("slippageBps")],
                                   ["fromToken", from_token["contract"]],
                                   ["middleToken", route.source_usdc_address],
                                   ["chainName", route.source_name],
                                   ["amountIn64", quote.fetch("amountIn")],
                                   ["sdkVersion", MAYAN_ORACLE_SDK_VERSION]
                                 ])
                               else
                                 state_address = find_program_address(["STATE_SOURCE".b, hex_to_bytes(order_hash), write_uint16_le(2)], SOLANA_SWIFT_PROGRAM).first
                                 minimum_number = Float(raw_number_lexeme(parsed_quote.root, "minMiddleAmount"))
                                 local_invalid! unless minimum_number.finite? && minimum_number.positive?
                                 source_swap_url(endpoint, "solana", [
                                   ["minMiddleAmount", minimum_number],
                                   ["middleToken", route.source_usdc_address],
                                   ["userWallet", swapper],
                                   ["slippageBps", quote.fetch("slippageBps")],
                                   ["fromToken", route.source_token_address],
                                   ["amountIn64", quote.fetch("amountIn")],
                                   ["depositMode", "SWIFT"],
                                   ["fillMaxAccounts", false],
                                   ["chainName", route.source_name],
                                   ["userLedger", state_address],
                                   ["sdkVersion", MAYAN_ORACLE_SDK_VERSION]
                                 ])
                               end
                         text, _root, raw = source_swap_request(client, url, options)
                         if route.source_chain_id == MayanSwiftV2BridgeClient::SOLANA_CHAIN_ID
                           state_address = find_program_address(["STATE_SOURCE".b, hex_to_bytes(order_hash), write_uint16_le(2)], SOLANA_SWIFT_PROGRAM).first
                           state_token = associated_token_address(state_address, route.source_usdc_address, true)
                         else
                           state_address = ""
                           state_token = ""
                         end
                         normalized = validate_source_swap_envelope(quote, route, raw, state_address, state_token, swapper, parsed_quote.minimum_intermediate_amount)
                         local_invalid! if normalized["kind"] == "none"
                         normalized["rawResponseSha256"] = sha256_hex(text)
                         normalized["rawProviderSourceSwapJson"] = text
                         normalized
                       rescue BridgeError
                         raise
                       rescue LocalValidationError, KeyError, TypeError, ArgumentError
                         fail_local(BridgeErrorCode::LOCAL_PLAN_INVALID)
                       rescue StandardError
                         fail_local(BridgeErrorCode::LOCAL_PLAN_INVALID)
                       end
                     end

      plan = {
        "planKind" => "mayan-swift-v2-local-source-swap",
        "providerId" => "mayan-swift-v2",
        "capabilityId" => route.capability_id,
        "sourceChainId" => route.source_chain_id,
        "destinationChainId" => route.destination_chain_id,
        "sourceTokenDeploymentId" => route.source_token_deployment_id,
        "destinationTokenDeploymentId" => route.destination_token_deployment_id,
        "quoteId" => quote.fetch("quoteId"),
        "rawQuoteSha256" => raw_sha,
        "orderNonce" => nonce,
        "swapperAddress" => swapper,
        "destinationAddress" => destination,
        "orderHash" => order_hash,
        "quoteBindingHash" => binding,
        "minimumIntermediateAmount" => parsed_quote.minimum_intermediate_amount,
        "sourceSwap" => source_swap,
        "planHash" => plan_hash(binding, source_swap)
      }
      deep_freeze(plan)
    rescue BridgeError
      raise
    rescue StandardError
      fail_local(BridgeErrorCode::LOCAL_PLAN_INVALID)
    end

    def rpc_endpoint(client, route)
      config = local_build_config(client)
      key, camel = if route.source_chain_id == MayanSwiftV2BridgeClient::ETHEREUM_CHAIN_ID
                     [:ethereum_rpc, "ethereumRpc"]
                   else
                     [:solana_rpc, "solanaRpc"]
                   end
      value = config_value(config, key.to_s, camel)
      fail_local(BridgeErrorCode::LOCAL_RPC_REQUIRED) if value == :__bridge_missing__ || value.nil?
      return value if value.is_a?(RpcEndpointConfig)
      local_invalid! unless value.is_a?(Hash)
      local_invalid! unless value.keys.all? { |item| item.is_a?(String) || item.is_a?(Symbol) }
      allowed = %w[http_url httpUrl headers]
      local_invalid! unless value.keys.all? { |item| allowed.include?(item.to_s) }
      http_url = config_value(value, "http_url", "httpUrl")
      local_invalid! if http_url == :__bridge_missing__
      headers = config_value(value, "headers")
      headers = {} if headers == :__bridge_missing__
      local_invalid! unless headers.is_a?(Hash)
      RpcEndpointConfig.new(http_url: http_url, headers: headers)
    rescue ConfigError, URI::InvalidURIError, ArgumentError, TypeError
      local_invalid!
    end

    def rpc_body(method, params)
      JSON.generate("jsonrpc" => "2.0", "id" => 1, "method" => method, "params" => params)
    end

    def rpc_request(client, endpoint, method, params, options)
      check_aborted(client, options)
      body = rpc_body(method, params)
      headers = endpoint.headers.each_with_object({}) { |(name, value), result| result[name.to_s] = value }
      headers["accept"] = "application/json"
      headers["content-type"] = "application/json"
      deadline = local_deadline(client.config.timeout)
      response = nil
      begin
        response = perform_local_adapter_request(
          client, options, deadline,
          method: :post,
          url: endpoint.http_url,
          headers: headers,
          body: body,
          timeout: local_remaining(deadline)
        )
        check_aborted(client, options)
        status = response_status(response)
        fail_local(BridgeErrorCode::SOURCE_RPC_TRANSPORT) unless status.is_a?(Integer) && status.between?(200, 299)
        fail_local(BridgeErrorCode::SOURCE_RPC_INVALID_RESPONSE) if response_declared_size(response).to_i > MAX_RESPONSE_BYTES
        text = local_with_deadline(deadline) do
          read_local_response_body(response, client, options, deadline)
        end
        root = begin
          StrictJsonParser.new(text).parse
        rescue BridgeError
          fail_local(BridgeErrorCode::SOURCE_RPC_INVALID_RESPONSE)
        end
        local_invalid! unless root.object_entries && root.value.is_a?(Hash)
        version = node_value(root, "jsonrpc")
        local_invalid! unless version == "2.0"
        local_invalid! if root.object_entries.key?("version")
        identifier = node_value(root, "id")
        local_invalid! unless identifier.is_a?(Integer) && identifier == 1
        local_invalid! if root.object_entries.key?("error") || !root.object_entries.key?("result")
        node_value(root, "result")
      rescue BridgeError
        dispose_local_response(response)
        raise
      rescue MayanBridgeBodyTooLarge
        dispose_local_response(response)
        fail_local(BridgeErrorCode::SOURCE_RPC_INVALID_RESPONSE)
      rescue TimeoutError, Timeout::Error
        dispose_local_response(response)
        fail_local(BridgeErrorCode::TIMEOUT)
      rescue LocalValidationError, LocalResponseTooLarge, LocalResponseInvalidEncoding
        dispose_local_response(response)
        fail_local(BridgeErrorCode::SOURCE_RPC_INVALID_RESPONSE)
      rescue StandardError
        dispose_local_response(response)
        check_aborted(client, options)
        fail_local(BridgeErrorCode::SOURCE_RPC_TRANSPORT)
      end
    end

    def parse_rpc_account(value)
      local_invalid! unless value.is_a?(Hash)
      data = value["data"]
      owner = value["owner"]
      local_invalid! unless value["executable"] == false && data.is_a?(Array) && data.length == 2 && data[0].is_a?(String) && data[1] == "base64" && owner.is_a?(String)
      [base64_decode(data[0], 16_384), canonical_solana_address(owner)]
    end

    def decode_lookup_table(address, data, owner, account_context_slot)
      local_invalid! unless owner == SOLANA_ADDRESS_LOOKUP_TABLE_OWNER && data.bytesize >= 56 && ((data.bytesize - 56) % 32).zero?
      local_invalid! unless data.byteslice(0, 4) == "\x01\x00\x00\x00".b
      local_invalid! unless data.byteslice(4, 8).unpack1("Q<") == UINT64_MAX
      last_extended_slot = data.byteslice(12, 8).unpack1("Q<")
      last_extended_start_index = data.getbyte(20)
      authority_option = data.getbyte(21)
      address_count = (data.bytesize - 56) / 32
      local_invalid! if authority_option > 1 || data.byteslice(54, 2) != "\0\0".b
      local_invalid! if authority_option.zero? && data.byteslice(22, 32) != "\0" * 32
      local_invalid! if address_count > MAX_LOOKUP_TABLE_ADDRESSES || last_extended_slot > account_context_slot || last_extended_start_index > address_count
      active_count = last_extended_slot == account_context_slot ? last_extended_start_index : address_count
      addresses = (56...(56 + active_count * 32)).step(32).map { |offset| base58_encode(data.byteslice(offset, 32)) }
      LookupTable.new(address: address, addresses: addresses, data: data)
    end

    def fetch_source_rpc(client, route, plan, options)
      begin
        endpoint = rpc_endpoint(client, route)
        if route.source_chain_id == MayanSwiftV2BridgeClient::ETHEREUM_CHAIN_ID
          chain_id = rpc_request(client, endpoint, "eth_chainId", [], options)
          local_invalid! unless chain_id.is_a?(String) && chain_id.downcase == "0x1"
          addresses = [MayanSwiftV2BridgeClient::ETHEREUM_FORWARDER, route.swift_contract]
          source_swap = plan.fetch("sourceSwap")
          addresses << source_swap["routerAddress"] if source_swap.is_a?(Hash) && source_swap["kind"] == "evm-router"
          code = addresses.map do |address|
            bytecode = rpc_request(client, endpoint, "eth_getCode", [address, "latest"], options)
            local_invalid! unless bytecode.is_a?(String) && HEX_BYTES.match?(bytecode) && bytecode != "0x"
            { "address" => normalize_evm_address(address), "keccak256" => "0x#{keccak_hex(hex_to_bytes(bytecode))}" }
          end
          return SourceRpcResult.new(evidence: { "kind" => "evm", "rpcChainId" => "0x1", "code" => code }, lookup_tables: [], recent_blockhash: nil)
        end

        genesis_hash = rpc_request(client, endpoint, "getGenesisHash", [], options)
        local_invalid! unless genesis_hash == SOLANA_MAINNET_GENESIS_HASH
        blockhash_result = rpc_request(client, endpoint, "getLatestBlockhash", [{ "commitment" => "confirmed" }], options)
        local_invalid! unless blockhash_result.is_a?(Hash)
        blockhash_context = blockhash_result["context"]
        blockhash_value = blockhash_result["value"]
        local_invalid! unless blockhash_context.is_a?(Hash) && blockhash_value.is_a?(Hash)
        blockhash_slot = blockhash_context["slot"]
        recent_blockhash = blockhash_value["blockhash"]
        last_valid = blockhash_value["lastValidBlockHeight"]
        local_invalid! unless blockhash_slot.is_a?(Integer) && blockhash_slot >= 0 && blockhash_slot <= MAX_SAFE_INTEGER &&
          recent_blockhash.is_a?(String) && last_valid.is_a?(Integer) && last_valid >= 0 && last_valid <= MAX_SAFE_INTEGER
        canonical_solana_address(recent_blockhash)
        source_swap = plan.fetch("sourceSwap")
        provider_alts = source_swap.is_a?(Hash) && source_swap["kind"] == "solana-jupiter-v6" ? source_swap.fetch("addressLookupTableAddresses") : []
        alt_addresses = [SOLANA_MAYAN_LOOKUP_TABLE, *provider_alts].each_with_object([]) { |address, out| out << address unless out.include?(address) }
        local_invalid! if alt_addresses.length > MAX_LOOKUP_TABLES
        accounts_result = rpc_request(client, endpoint, "getMultipleAccounts", [alt_addresses, { "encoding" => "base64", "commitment" => "confirmed", "minContextSlot" => blockhash_slot }], options)
        local_invalid! unless accounts_result.is_a?(Hash)
        account_context = accounts_result["context"]
        account_values = accounts_result["value"]
        local_invalid! unless account_context.is_a?(Hash) && account_values.is_a?(Array) && account_context["slot"].is_a?(Integer) &&
          account_context["slot"] >= blockhash_slot && account_context["slot"] <= MAX_SAFE_INTEGER && account_values.length == alt_addresses.length
        lookup_tables = alt_addresses.each_with_index.map do |address, index|
          data, owner = parse_rpc_account(account_values[index])
          decode_lookup_table(address, data, owner, account_context["slot"])
        end
        SourceRpcResult.new(
          evidence: {
            "kind" => "solana", "genesisHash" => genesis_hash,
            "blockhashContextSlot" => blockhash_slot.to_s, "accountContextSlot" => account_context["slot"].to_s,
            "recentBlockhash" => recent_blockhash, "lastValidBlockHeight" => last_valid.to_s,
            "lookupTables" => lookup_tables.map { |table| { "address" => table.address, "dataSha256" => sha256_hex(table.data) } }
          }, lookup_tables: lookup_tables, recent_blockhash: recent_blockhash
        )
      rescue BridgeError
        raise
      rescue LocalValidationError
        fail_local(BridgeErrorCode::SOURCE_RPC_INVALID_RESPONSE)
      rescue StandardError
        fail_local(BridgeErrorCode::SOURCE_RPC_INVALID_RESPONSE)
      end
    end

    def wrap_in_cpi_proxy(instruction)
      {
        "programId" => SOLANA_CPI_PROXY_PROGRAM,
        "accounts" => [{ "pubkey" => instruction["programId"], "isSigner" => false, "isWritable" => false }, *instruction["accounts"]],
        "dataBase64" => instruction["dataBase64"]
      }
    end

    def make_ata_instruction(swapper_address, owner, mint, allow_owner_off_curve)
      {
        "programId" => SOLANA_ASSOCIATED_TOKEN_PROGRAM,
        "accounts" => [
          { "pubkey" => swapper_address, "isSigner" => true, "isWritable" => true },
          { "pubkey" => associated_token_address(owner, mint, allow_owner_off_curve), "isSigner" => false, "isWritable" => true },
          { "pubkey" => owner, "isSigner" => false, "isWritable" => false },
          { "pubkey" => mint, "isSigner" => false, "isWritable" => false },
          { "pubkey" => SOLANA_SYSTEM_PROGRAM, "isSigner" => false, "isWritable" => false },
          { "pubkey" => SOLANA_TOKEN_PROGRAM, "isSigner" => false, "isWritable" => false },
          { "pubkey" => SOLANA_SYSVAR_RENT, "isSigner" => false, "isWritable" => false }
        ],
        "dataBase64" => "AQ=="
      }
    end

    def make_spl_transfer_instruction(source, destination, owner, amount)
      data = [3].pack("C") + write_uint64_le(amount)
      {
        "programId" => SOLANA_TOKEN_PROGRAM,
        "accounts" => [
          { "pubkey" => source, "isSigner" => false, "isWritable" => true },
          { "pubkey" => destination, "isSigner" => false, "isWritable" => true },
          { "pubkey" => owner, "isSigner" => true, "isWritable" => false }
        ],
        "dataBase64" => Base64.strict_encode64(data)
      }
    end

    def make_compute_unit_price_instruction(micro_lamports)
      data = [3].pack("C") + write_uint64_le(micro_lamports)
      { "programId" => SOLANA_COMPUTE_BUDGET_PROGRAM, "accounts" => [], "dataBase64" => Base64.strict_encode64(data) }
    end

    def make_swift_init_instruction(quote, route, swapper_address, destination_address, state_address, state_token_account, minimum_intermediate_amount, cancel_fee, refund_fee, submit_fee, mode, order_nonce)
      relayer_account = associated_token_address(swapper_address, route.source_usdc_address, false)
      data = "\0".b * 198
      data[0, 8] = hex_to_bytes("0x#{SOLANA_INIT_ORDER_DISCRIMINATOR}")
      data[8, 8] = write_uint64_le(uint64(minimum_intermediate_amount, positive: true))
      data.setbyte(16, 0)
      data[17, 8] = write_uint64_le(submit_fee)
      data[25, 32] = native_address_bytes(destination_address, route.destination_chain_id)
      data[57, 2] = write_uint16_le(route.destination_wormhole_chain_id)
      data[59, 32] = native_address_bytes(route.destination_token_address, route.destination_chain_id)
      data[91, 8] = write_uint64_le(uint64(quote.fetch("minimumAmountOut"), positive: true))
      data[99, 8] = write_uint64_le(0)
      data[107, 8] = write_uint64_le(cancel_fee)
      data[115, 8] = write_uint64_le(refund_fee)
      data[123, 8] = write_uint64_le(uint64(quote.fetch("deadline"), positive: true))
      data[131, 32] = zero32
      data.setbyte(163, 0)
      data.setbyte(164, 0)
      data.setbyte(165, mode)
      data[166, 32] = swift_random(quote.fetch("quoteId"), order_nonce)
      {
        "programId" => SOLANA_SWIFT_PROGRAM,
        "accounts" => [
          { "pubkey" => swapper_address, "isSigner" => false, "isWritable" => false },
          { "pubkey" => swapper_address, "isSigner" => true, "isWritable" => true },
          { "pubkey" => state_address, "isSigner" => false, "isWritable" => true },
          { "pubkey" => state_token_account, "isSigner" => false, "isWritable" => true },
          { "pubkey" => relayer_account, "isSigner" => false, "isWritable" => true },
          { "pubkey" => SOLANA_SWIFT_PROGRAM, "isSigner" => false, "isWritable" => false },
          { "pubkey" => route.source_usdc_address, "isSigner" => false, "isWritable" => false },
          { "pubkey" => SOLANA_FEE_MANAGER_PROGRAM, "isSigner" => false, "isWritable" => false },
          { "pubkey" => SOLANA_TOKEN_PROGRAM, "isSigner" => false, "isWritable" => false },
          { "pubkey" => SOLANA_SYSTEM_PROGRAM, "isSigner" => false, "isWritable" => false }
        ],
        "dataBase64" => Base64.strict_encode64(data)
      }
    end

    def encode_shortvec(value)
      local_invalid! unless value.is_a?(Integer) && value >= 0 && value <= 0xffff
      output = +"".b
      current = value
      loop do
        element = current & 0x7f
        current >>= 7
        element |= 0x80 if current.positive?
        output << element
        return output.b if current.zero?
      end
    end

    def compile_solana_v0(payer, recent_blockhash, instructions, lookup_tables)
      key_meta = {}
      get_or_insert = lambda do |address|
        key_meta[address] ||= KeyMeta.new(signer: false, writable: false, invoked: false)
      end
      payer_meta = get_or_insert.call(payer)
      payer_meta.signer = true
      payer_meta.writable = true
      instructions.each do |instruction|
        get_or_insert.call(instruction["programId"]).invoked = true
        instruction["accounts"].each do |account|
          meta = get_or_insert.call(account["pubkey"])
          meta.signer ||= account["isSigner"]
          meta.writable ||= account["isWritable"]
        end
      end

      lookup_table_lookups = []
      writable_lookup_keys = []
      readonly_lookup_keys = []
      lookup_tables.each do |table|
        writable_indexes = []
        readonly_indexes = []
        key_meta.to_a.each do |address, meta|
          next if meta.signer || meta.invoked || !meta.writable
          index = table.addresses.index(address)
          next if index.nil?
          local_invalid! if index > 255
          writable_indexes << index
          writable_lookup_keys << address
          key_meta.delete(address)
        end
        key_meta.to_a.each do |address, meta|
          next if meta.signer || meta.invoked || meta.writable
          index = table.addresses.index(address)
          next if index.nil?
          local_invalid! if index > 255
          readonly_indexes << index
          readonly_lookup_keys << address
          key_meta.delete(address)
        end
        lookup_table_lookups << [table.address, writable_indexes, readonly_indexes] if !writable_indexes.empty? || !readonly_indexes.empty?
      end
      local_invalid! if key_meta.length > 256 || lookup_table_lookups.length > MAX_LOOKUP_TABLES
      entries = key_meta.to_a
      writable_signers = entries.select { |_, meta| meta.signer && meta.writable }
      readonly_signers = entries.select { |_, meta| meta.signer && !meta.writable }
      writable_non_signers = entries.select { |_, meta| !meta.signer && meta.writable }
      readonly_non_signers = entries.select { |_, meta| !meta.signer && !meta.writable }
      local_invalid! if writable_signers.empty? || writable_signers.first.first != payer
      static_keys = [writable_signers, readonly_signers, writable_non_signers, readonly_non_signers].flat_map { |group| group.map(&:first) }
      all_keys = static_keys + writable_lookup_keys + readonly_lookup_keys
      local_invalid! if all_keys.length > 256
      key_indexes = all_keys.each_with_index.to_h
      compiled = instructions.map do |instruction|
        program_index = key_indexes[instruction["programId"]]
        local_invalid! if program_index.nil?
        account_indexes = instruction["accounts"].map do |account|
          index = key_indexes[account["pubkey"]]
          local_invalid! if index.nil?
          index
        end
        [program_index, account_indexes, encode_instruction_data(instruction["dataBase64"])]
      end
      compiled_bytes = encode_shortvec(compiled.length) + compiled.map do |program_index, account_indexes, data|
        [program_index].pack("C") + encode_shortvec(account_indexes.length) + account_indexes.pack("C*") + encode_shortvec(data.bytesize) + data
      end.join.b
      lookup_bytes = encode_shortvec(lookup_table_lookups.length) + lookup_table_lookups.map do |address, writable_indexes, readonly_indexes|
        base58_decode(address) + encode_shortvec(writable_indexes.length) + writable_indexes.pack("C*") + encode_shortvec(readonly_indexes.length) + readonly_indexes.pack("C*")
      end.join.b
      header = [writable_signers.length + readonly_signers.length, readonly_signers.length, readonly_non_signers.length].pack("C3")
      message = "\x80".b + header + encode_shortvec(static_keys.length) + static_keys.map { |address| base58_decode(address) }.join.b + base58_decode(canonical_solana_address(recent_blockhash)) + compiled_bytes + lookup_bytes
      required_signatures = writable_signers.length + readonly_signers.length
      transaction = encode_shortvec(required_signatures) + ("\0".b * (required_signatures * 64)) + message
      local_invalid! if transaction.bytesize > MAX_SOLANA_TRANSACTION_BYTES
      Base64.strict_encode64(transaction)
    end

    def build_evm_order_call(quote, route, plan, swapper_address, destination_address, minimum_intermediate_amount, cancel_fee, refund_fee, mode, order_nonce)
      order_words = [
        word_uint(1),
        word_bytes32(native_address_bytes(swapper_address, route.source_chain_id)),
        word_bytes32(native_address_bytes(destination_address, route.destination_chain_id)),
        word_uint(route.destination_wormhole_chain_id),
        word_bytes32(zero32),
        word_bytes32(native_address_bytes(route.destination_token_address, route.destination_chain_id)),
        word_uint(uint64(quote.fetch("minimumAmountOut"), positive: true)),
        word_uint(0), word_uint(cancel_fee), word_uint(refund_fee),
        word_uint(uint64(quote.fetch("deadline"), positive: true)), word_uint(0), word_uint(mode),
        word_bytes32(swift_random(quote.fetch("quoteId"), order_nonce))
      ]
      swift_data = "\xa3\xa3\x08\x34".b + encode_abi_with_dynamics([
        word_address(route.source_usdc_address), word_uint(uint64(quote.fetch("amountIn"), positive: true)), *order_words
      ], ["".b])
      source_swap = plan.fetch("sourceSwap")
      if source_swap["kind"] == "none"
        return "0xe4269fc4#{encode_abi_with_dynamics([
          word_address(route.source_usdc_address), word_uint(uint64(quote.fetch("amountIn"), positive: true)),
          word_uint(0), word_uint(0), word_uint(0), word_bytes32(zero32), word_bytes32(zero32), word_address(route.swift_contract)
        ], [swift_data]).unpack1("H*")}"
      end
      local_invalid! unless source_swap["kind"] == "evm-router"
      router_data = hex_to_bytes(source_swap.fetch("calldata"))
      router_offset = 13 * 32
      swift_offset = router_offset + 32 + pad32(router_data).bytesize
      head = [
        word_address(route.source_token_address), word_uint(uint64(quote.fetch("amountIn"), positive: true)),
        word_uint(0), word_uint(0), word_uint(0), word_bytes32(zero32), word_bytes32(zero32), word_address(source_swap.fetch("routerAddress")),
        word_uint(router_offset), word_address(route.source_usdc_address), word_uint(uint64(minimum_intermediate_amount, positive: true)),
        word_address(route.swift_contract), word_uint(swift_offset)
      ]
      "0x30dedc57#{(head.join.b + encode_abi_bytes(router_data) + encode_abi_bytes(swift_data)).unpack1('H*')}"
    end

    def build_solana_instructions(quote, route, plan, swapper_address, destination_address, minimum_intermediate_amount, cancel_fee, refund_fee, submit_fee, mode, order_nonce, suggested_priority_fee)
      order_hash = hash_order(quote, route, swapper_address, destination_address, order_nonce, cancel_fee, refund_fee, mode)
      state_address = find_program_address(["STATE_SOURCE".b, hex_to_bytes(order_hash), write_uint16_le(2)], SOLANA_SWIFT_PROGRAM).first
      state_token = associated_token_address(state_address, route.source_usdc_address, true)
      init = make_swift_init_instruction(quote, route, swapper_address, destination_address, state_address, state_token, minimum_intermediate_amount, cancel_fee, refund_fee, submit_fee, mode, order_nonce)
      if route.is_usdc
        instructions = []
        instructions << make_compute_unit_price_instruction(suggested_priority_fee) if suggested_priority_fee && suggested_priority_fee.positive?
        instructions << wrap_in_cpi_proxy(make_ata_instruction(swapper_address, state_address, route.source_usdc_address, true))
        instructions << wrap_in_cpi_proxy(make_spl_transfer_instruction(associated_token_address(swapper_address, route.source_usdc_address, false), state_token, swapper_address, uint64(quote.fetch("amountIn"), positive: true)))
        instructions << wrap_in_cpi_proxy(init)
        return instructions
      end
      source_swap = plan.fetch("sourceSwap")
      local_invalid! unless source_swap.is_a?(Hash) && source_swap["kind"] == "solana-jupiter-v6"
      provider_instructions = source_swap.fetch("instructions")
      local_invalid! unless provider_instructions.is_a?(Array)
      compute_count = provider_instructions.take_while { |instruction| instruction["programId"] == SOLANA_COMPUTE_BUDGET_PROGRAM }.length
      compute = provider_instructions.first(compute_count)
      remainder = provider_instructions.drop(compute_count)
      swap_indexes = remainder.each_index.select { |index| remainder[index]["programId"] == MayanSwiftV2BridgeClient::SOLANA_JUPITER_V6 }
      local_invalid! if swap_indexes.empty? || swap_indexes.first < 1
      swap_index = swap_indexes.first
      setup = remainder.first(swap_index)
      swap = remainder[swap_index]
      local_invalid! unless remainder[(swap_index + 1)..].to_a.empty?
      compute + setup.map { |instruction| wrap_in_cpi_proxy(instruction) } + [swap, wrap_in_cpi_proxy(init)]
    end

    def exact_keys?(value, expected)
      value.is_a?(Hash) && value.keys.sort == expected.sort && value.length == expected.length
    end

    def validate_plan(request, route, parsed_quote, plan, raw_quote_sha256, order_hash, binding, swapper_address, destination_address, build_code)
      expected_keys = %w[planKind providerId capabilityId sourceChainId destinationChainId sourceTokenDeploymentId destinationTokenDeploymentId quoteId rawQuoteSha256 orderNonce swapperAddress destinationAddress orderHash quoteBindingHash minimumIntermediateAmount sourceSwap planHash]
      local_invalid! unless exact_keys?(plan, expected_keys)
      quote = request.fetch("quote")
      local_invalid! unless quote.is_a?(Hash)
      expected = {
        "planKind" => "mayan-swift-v2-local-source-swap", "providerId" => "mayan-swift-v2", "capabilityId" => route.capability_id,
        "sourceChainId" => route.source_chain_id, "destinationChainId" => route.destination_chain_id,
        "sourceTokenDeploymentId" => route.source_token_deployment_id, "destinationTokenDeploymentId" => route.destination_token_deployment_id,
        "quoteId" => quote["quoteId"], "rawQuoteSha256" => raw_quote_sha256, "orderNonce" => request["orderNonce"],
        "swapperAddress" => swapper_address, "destinationAddress" => destination_address, "orderHash" => order_hash,
        "quoteBindingHash" => binding, "minimumIntermediateAmount" => parsed_quote.minimum_intermediate_amount
      }
      local_invalid! unless expected.all? { |key, value| plan[key] == value }
      source_swap = plan["sourceSwap"]
      local_invalid! unless source_swap.is_a?(Hash)
      normalized_source_swap = if route.is_usdc
                                 local_invalid! unless exact_keys?(source_swap, ["kind"]) && source_swap["kind"] == "none"
                                 { "kind" => "none" }
                               else
                                 state_address = ""
                                 state_token = ""
                                 if route.source_chain_id == MayanSwiftV2BridgeClient::SOLANA_CHAIN_ID
                                   state_address = find_program_address(["STATE_SOURCE".b, hex_to_bytes(order_hash), write_uint16_le(2)], SOLANA_SWIFT_PROGRAM).first
                                   state_token = associated_token_address(state_address, route.source_usdc_address, true)
                                 end
                                 raw_source_text = source_swap["rawProviderSourceSwapJson"]
                                 local_invalid! unless raw_source_text.is_a?(String)
                                 _root, raw_source = local_json_object(raw_source_text)
                                 expected_source = validate_source_swap_envelope(quote, route, raw_source, state_address, state_token, swapper_address, parsed_quote.minimum_intermediate_amount)
                                 actual_blank = source_swap.reject { |key, _| %w[rawResponseSha256 rawProviderSourceSwapJson].include?(key) }
                                 expected_blank = expected_source.reject { |key, _| %w[rawResponseSha256 rawProviderSourceSwapJson].include?(key) }
                                 local_invalid! unless actual_blank == expected_blank
                                 local_invalid! unless source_swap["rawResponseSha256"] == sha256_hex(raw_source_text)
                                 source_swap
                               end
      local_invalid! unless plan["planHash"] == plan_hash(binding, normalized_source_swap)
      deep_dup(plan)
    rescue BridgeError
      raise
    rescue StandardError
      fail_local(build_code)
    end

    def local_build_dependencies(route)
      route.dependencies.reject { |dependency| dependency == "mayan-hosted-transaction-builder" } + [route.source_chain_id == MayanSwiftV2BridgeClient::ETHEREUM_CHAIN_ID ? "configured-ethereum-rpc" : "configured-solana-rpc"]
    end

    def build_local_unsigned(client, request, options = nil)
      options ||= {}
      value = deep_dup(request)
      begin
        value = context_mapping(value, build: true)
        quote = value.fetch("quote")
        local_invalid! unless quote.is_a?(Hash)
        route = validate_local_route(quote, client)
        parsed_quote = parse_source_quote(quote, route)
        swapper = normalize_local_address(value.fetch("swapperAddress"), route.source_chain_id)
        destination = normalize_local_address(value.fetch("destinationAddress"), route.destination_chain_id)
        nonce = value.fetch("orderNonce")
        local_invalid! unless nonce.is_a?(String) && NONCE.match?(nonce)
        validate_destination_minimum_compatibility(quote.fetch("minimumAmountOut"), parsed_quote.root)
        validate_local_expiry(quote, client)
        raw_quote = quote.fetch("rawSignedQuoteJson")
        local_invalid! unless raw_quote.is_a?(String)
        raw_sha = sha256_hex(raw_quote)
        order_hash = hash_order(quote, route, swapper, destination, nonce, parsed_quote.cancel_fee, parsed_quote.refund_fee, parsed_quote.mode)
        binding = quote_binding_hash(route, quote, raw_sha, nonce, swapper, destination)
        plan = validate_plan(value, route, parsed_quote, value.fetch("sourceSwapPlan"), raw_sha, order_hash, binding, swapper, destination, BridgeErrorCode::LOCAL_BUILD_INVALID)
      rescue BridgeError
        raise
      rescue LocalValidationError, KeyError, TypeError, ArgumentError
        fail_local(BridgeErrorCode::LOCAL_BUILD_INVALID)
      rescue StandardError
        fail_local(BridgeErrorCode::LOCAL_BUILD_INVALID)
      end

      rpc = fetch_source_rpc(client, route, plan, options)
      begin
        transaction = if route.source_chain_id == MayanSwiftV2BridgeClient::ETHEREUM_CHAIN_ID
                        { "kind" => "evm-unsigned-transaction", "chainId" => MayanSwiftV2BridgeClient::ETHEREUM_CHAIN_ID, "from" => swapper, "to" => MayanSwiftV2BridgeClient::ETHEREUM_FORWARDER, "data" => build_evm_order_call(quote, route, plan, swapper, destination, parsed_quote.minimum_intermediate_amount, parsed_quote.cancel_fee, parsed_quote.refund_fee, parsed_quote.mode, nonce), "value" => "0" }
                      else
                        local_invalid! if rpc.recent_blockhash.nil?
                        instructions = build_solana_instructions(quote, route, plan, swapper, destination, parsed_quote.minimum_intermediate_amount, parsed_quote.cancel_fee, parsed_quote.refund_fee, parsed_quote.submit_fee, parsed_quote.mode, nonce, parsed_quote.suggested_priority_fee)
                        { "kind" => "solana-v0-unsigned-transaction", "chainId" => MayanSwiftV2BridgeClient::SOLANA_CHAIN_ID, "feePayer" => swapper, "transactionBase64" => compile_solana_v0(swapper, rpc.recent_blockhash, instructions, rpc.lookup_tables) }
                      end
        allowance = route.source_chain_id == MayanSwiftV2BridgeClient::ETHEREUM_CHAIN_ID ? { "tokenDeploymentId" => route.source_token_deployment_id, "tokenAddress" => route.source_token_address, "owner" => swapper, "spender" => MayanSwiftV2BridgeClient::ETHEREUM_FORWARDER, "requiredAmount" => quote.fetch("amountIn") } : nil
        {
          "buildKind" => "mayan-swift-v2-local-unsigned", "providerId" => "mayan-swift-v2", "capabilityId" => route.capability_id,
          "quote" => deep_dup(quote), "sourceChainId" => route.source_chain_id, "destinationChainId" => route.destination_chain_id,
          "sourceSwapPlan" => deep_dup(plan), "transaction" => transaction, "allowance" => allowance,
          "construction" => { "mode" => "local", "referenceCommit" => MAYAN_REFERENCE_COMMIT, "orderNonce" => nonce, "orderHash" => order_hash, "minimumIntermediateAmount" => parsed_quote.minimum_intermediate_amount, "effectiveDependencies" => local_build_dependencies(route), "sourceRpcEvidence" => rpc.evidence },
          "validation" => { "level" => "local-structural", "quoteSignatureLocallyVerified" => false, "planBindingLocallyVerified" => true, "transactionBytesLocallyConstructed" => true, "settlementLocallyVerified" => false }
        }
      rescue BridgeError
        raise
      rescue LocalValidationError, KeyError, TypeError, ArgumentError
        fail_local(BridgeErrorCode::LOCAL_BUILD_INVALID)
      rescue StandardError
        fail_local(BridgeErrorCode::LOCAL_BUILD_INVALID)
      end
    end

    class << self
      alias prepareSourceSwap prepare_source_swap
      alias buildLocalUnsigned build_local_unsigned
    end
  end

  class MayanSwiftV2BridgeClient
    def prepare_source_swap(context, options = nil, **keyword_options)
      MayanSwiftV2BridgeLocal.prepare_source_swap(self, context, options || keyword_options)
    end

    alias prepareSourceSwap prepare_source_swap

    def build_local_unsigned(request, options = nil, **keyword_options)
      MayanSwiftV2BridgeLocal.build_local_unsigned(self, request, options || keyword_options)
    end

    alias buildLocalUnsigned build_local_unsigned
  end
end
