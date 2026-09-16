# frozen_string_literal: true

require_relative "dex_catalog"

module ERPC
  # Stable local failures raised by the RPC-only exact-input quote path.
  # Transport, timeout, JSON-RPC, and adapter errors are allowed to pass
  # through unchanged so callers retain their native error and cause.
  class SwapQuoteError < Error
    MESSAGES = {
      "SWAP_INVALID_ARGUMENT" => "Swap request is invalid",
      "SWAP_UNSUPPORTED_CHAIN" => "Swap chain is unsupported",
      "SWAP_UNKNOWN_POOL" => "Swap pool is unknown",
      "SWAP_CHAIN_MISMATCH" => "Swap chain does not match the selected records",
      "SWAP_INVALID_POOL_STATE" => "Swap pool state is invalid",
      "SWAP_UNKNOWN_TOKEN" => "Swap token is unknown",
      "SWAP_TOKEN_NOT_ACTIVE" => "Swap token is not active",
      "SWAP_UNSUPPORTED_TOKEN_STANDARD" => "Swap token standard is unsupported",
      "SWAP_UNSUPPORTED_TOKEN" => "Swap token is unsupported for the selected pool",
      "SWAP_POOL_TOKEN_MISMATCH" => "Swap pool tokens do not match the request",
      "SWAP_UNSUPPORTED_ADAPTER" => "Swap adapter is unsupported",
      "SWAP_PROGRAM_MISMATCH" => "Swap program does not match the selected records",
      "SWAP_STATE_STALE" => "Swap pool state is stale",
      "SWAP_INSUFFICIENT_LIQUIDITY" => "Swap pool liquidity is insufficient",
      "SWAP_ARITHMETIC" => "Swap arithmetic overflowed or produced an invalid result"
    }.freeze

    attr_reader :code

    def initialize(code)
      @code = code.to_s.freeze
      super(MESSAGES.fetch(@code, "Swap quote failed"))
    end
  end

  # Configured RPC-backed exact-input quote client.
  class SwapClient
    SUPPORTED_QUOTE_ADAPTER = "evm-constant-product-v2"
    # Quote eligibility is a handwritten review boundary. Catalog growth may
    # add lookup or ranking records without granting them RPC quote access.
    SUPPORTED_QUOTE_CAPABILITIES = [
      {
        chain_id: "eip155:1",
        dex_deployment_id: "dex-deployment-0001",
        factory_address: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
        pool_definition_id: "pool-0001",
        pool_address: "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc",
        token0_deployment_id: "deployment-0008",
        token0_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        token0_decimals: 6,
        token0_standard: "erc20",
        token1_deployment_id: "deployment-0002",
        token1_address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        token1_decimals: 18,
        token1_standard: "erc20",
        adapter_kind: SUPPORTED_QUOTE_ADAPTER,
        fee_numerator: "3",
        fee_denominator: "1000"
      }.freeze,
      {
        chain_id: "eip155:43114",
        dex_deployment_id: "dex-deployment-0002",
        factory_address: "0x9ad6c38be94206ca50bb0d90783181662f0cfa10",
        pool_definition_id: "pool-0002",
        pool_address: "0xf4003f4efbe8691b60249e6afbd307abe7758adb",
        token0_deployment_id: "deployment-0004",
        token0_address: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
        token0_decimals: 18,
        token0_standard: "erc20",
        token1_deployment_id: "deployment-0009",
        token1_address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
        token1_decimals: 6,
        token1_standard: "erc20",
        adapter_kind: SUPPORTED_QUOTE_ADAPTER,
        fee_numerator: "3",
        fee_denominator: "1000"
      }.freeze
    ].freeze
    UINT256_MAX = (1 << 256) - 1
    UINT256_DECIMAL_MAX_LENGTH = 78
    UINT112_MAX = (1 << 112) - 1
    UINT32_MAX = (1 << 32) - 1

    FACTORY_GET_PAIR_SELECTOR = "0xe6a43905"
    PAIR_FACTORY_SELECTOR = "0xc45a0155"
    PAIR_TOKEN0_SELECTOR = "0x0dfe1681"
    PAIR_TOKEN1_SELECTOR = "0xd21220a7"
    PAIR_GET_RESERVES_SELECTOR = "0x0902f1ac"

    REQUEST_KEY_ALIASES = {
      "chainId" => :chain_id,
      :chainId => :chain_id,
      "chain_id" => :chain_id,
      :chain_id => :chain_id,
      "poolDefinitionId" => :pool_definition_id,
      :poolDefinitionId => :pool_definition_id,
      "pool_definition_id" => :pool_definition_id,
      :pool_definition_id => :pool_definition_id,
      "inputTokenDeploymentId" => :input_token_deployment_id,
      :inputTokenDeploymentId => :input_token_deployment_id,
      "input_token_deployment_id" => :input_token_deployment_id,
      :input_token_deployment_id => :input_token_deployment_id,
      "outputTokenDeploymentId" => :output_token_deployment_id,
      :outputTokenDeploymentId => :output_token_deployment_id,
      "output_token_deployment_id" => :output_token_deployment_id,
      :output_token_deployment_id => :output_token_deployment_id,
      "amountIn" => :amount_in,
      :amountIn => :amount_in,
      "amount_in" => :amount_in,
      :amount_in => :amount_in,
      "freshness" => :freshness,
      :freshness => :freshness
    }.freeze

    FRESHNESS_KEY_ALIASES = {
      "maxBlockAgeSeconds" => :max_block_age_seconds,
      :maxBlockAgeSeconds => :max_block_age_seconds,
      "max_block_age_seconds" => :max_block_age_seconds,
      :max_block_age_seconds => :max_block_age_seconds,
      "maxBlockLag" => :max_block_lag,
      :maxBlockLag => :max_block_lag,
      "max_block_lag" => :max_block_lag,
      :max_block_lag => :max_block_lag,
      "maxClockSkewSeconds" => :max_clock_skew_seconds,
      :maxClockSkewSeconds => :max_clock_skew_seconds,
      "max_clock_skew_seconds" => :max_clock_skew_seconds,
      :max_clock_skew_seconds => :max_clock_skew_seconds
    }.freeze

    REQUIRED_REQUEST_KEYS = %i[
      chain_id
      pool_definition_id
      input_token_deployment_id
      output_token_deployment_id
      amount_in
    ].freeze

    NormalizedFreshness = Struct.new(
      :max_block_age_seconds,
      :max_block_lag,
      :max_clock_skew_seconds,
      keyword_init: true
    )
    NormalizedRequest = Struct.new(
      :chain_id,
      :pool_definition_id,
      :input_token_deployment_id,
      :output_token_deployment_id,
      :amount_in_text,
      :amount_in,
      :freshness,
      :pool,
      :dex,
      :input,
      :output,
      keyword_init: true
    )
    BlockHeader = Struct.new(:number, :hash, :timestamp, keyword_init: true)
    EvmState = Struct.new(
      :initial,
      :latest_after_reads,
      :reserve0,
      :reserve1,
      keyword_init: true
    )
    CalculatedQuote = Struct.new(
      :amount_out,
      :fee_numerator,
      :fee_denominator,
      keyword_init: true
    )

    private_constant :REQUEST_KEY_ALIASES
    private_constant :FRESHNESS_KEY_ALIASES
    private_constant :REQUIRED_REQUEST_KEYS
    private_constant :SUPPORTED_QUOTE_CAPABILITIES
    private_constant :NormalizedFreshness
    private_constant :NormalizedRequest
    private_constant :BlockHeader
    private_constant :EvmState
    private_constant :CalculatedQuote

    def initialize(ethereum_transport:, avalanche_transport:)
      @ethereum_transport = ethereum_transport
      @avalanche_transport = avalanche_transport
      # Tests replace this private implementation slot with a fixed clock for
      # fixture replay. There is no public time or clock bypass.
      @clock = -> { Time.now.to_i }
    end

    # Execute an exact-input quote through the configured EVM transport.
    # The request is normalized and copied before the first RPC call.
    def quote_exact_input(request)
      normalized = normalize_request(request)
      unless normalized.pool.fetch(:adapter).fetch(:kind) == SUPPORTED_QUOTE_ADAPTER &&
             normalized.dex.fetch(:adapter_kind) == SUPPORTED_QUOTE_ADAPTER
        return domain_error("SWAP_UNSUPPORTED_ADAPTER")
      end

      transport = case normalized.chain_id
                  when DexChainIDs::ETHEREUM_MAINNET then @ethereum_transport
                  when DexChainIDs::AVALANCHE_C_MAINNET then @avalanche_transport
                  else return domain_error("SWAP_UNSUPPORTED_ADAPTER")
                  end

      state = read_evm_state(transport, normalized)
      assert_freshness(state.initial, state.latest_after_reads, normalized.freshness)
      calculated = calculate_quote(normalized, state)
      # Recheck at completion so a clock change while the buffered state is
      # being decoded cannot turn an old quote into a fresh one.
      assert_freshness(state.initial, state.latest_after_reads, normalized.freshness)
      build_quote_result(normalized, state, calculated)
    end

    private

    def normalize_request(request)
      return domain_error("SWAP_INVALID_ARGUMENT") unless request.is_a?(Hash)

      values = {}
      request.each do |key, value|
        canonical = REQUEST_KEY_ALIASES[key]
        return domain_error("SWAP_INVALID_ARGUMENT") unless canonical
        return domain_error("SWAP_INVALID_ARGUMENT") if values.key?(canonical)

        values[canonical] = value
      end
      return domain_error("SWAP_INVALID_ARGUMENT") unless REQUIRED_REQUEST_KEYS.all? { |key| values.key?(key) }
      return domain_error("SWAP_INVALID_ARGUMENT") if values.key?(:freshness) && values[:freshness].nil?

      chain_id = copy_request_string(values[:chain_id])
      pool_definition_id = copy_request_string(values[:pool_definition_id])
      input_token_deployment_id = copy_request_string(values[:input_token_deployment_id])
      output_token_deployment_id = copy_request_string(values[:output_token_deployment_id])
      amount_in_text = copy_request_string(values[:amount_in])
      return domain_error("SWAP_INVALID_ARGUMENT") unless [
        chain_id,
        pool_definition_id,
        input_token_deployment_id,
        output_token_deployment_id,
        amount_in_text
      ].all?

      [pool_definition_id, input_token_deployment_id, output_token_deployment_id].each do |identifier|
        return domain_error("SWAP_INVALID_ARGUMENT") unless opaque_id?(identifier)
      end
      amount_in = parse_canonical_decimal(amount_in_text, positive: true, code: "SWAP_INVALID_ARGUMENT")
      freshness = normalize_freshness(values[:freshness])

      return domain_error("SWAP_UNSUPPORTED_CHAIN") unless known_chain_id?(chain_id)

      pool = DexCatalog.get_pool_definition(pool_definition_id)
      return domain_error("SWAP_UNKNOWN_POOL") unless pool
      return domain_error("SWAP_CHAIN_MISMATCH") unless pool.fetch(:chain_id) == chain_id
      return domain_error("SWAP_INVALID_POOL_STATE") unless pool.fetch(:status) == "active"

      dex = DexCatalog.get_dex_deployment(pool.fetch(:dex_deployment_id))
      return domain_error("SWAP_INVALID_POOL_STATE") unless dex && dex.fetch(:status) == "active"

      input = TokenCatalog.get_token_deployment(input_token_deployment_id)
      return domain_error("SWAP_UNKNOWN_TOKEN") unless input
      output = TokenCatalog.get_token_deployment(output_token_deployment_id)
      return domain_error("SWAP_UNKNOWN_TOKEN") unless output
      return domain_error("SWAP_CHAIN_MISMATCH") unless input.fetch(:chain_id) == chain_id && output.fetch(:chain_id) == chain_id
      return domain_error("SWAP_TOKEN_NOT_ACTIVE") unless input.fetch(:status) == "active" && output.fetch(:status) == "active"

      [input, output].each do |token|
        standard = token.fetch(:standard)
        return domain_error("SWAP_UNSUPPORTED_TOKEN_STANDARD") unless %w[erc20 spl-token].include?(standard)
      end

      return domain_error("SWAP_POOL_TOKEN_MISMATCH") if input_token_deployment_id == output_token_deployment_id

      requested_pair = [input_token_deployment_id, output_token_deployment_id].sort
      pool_pair = [pool.fetch(:token0_deployment_id), pool.fetch(:token1_deployment_id)].sort
      return domain_error("SWAP_POOL_TOKEN_MISMATCH") unless requested_pair == pool_pair

      unless pool.fetch(:adapter).fetch(:kind) == SUPPORTED_QUOTE_ADAPTER &&
             dex.fetch(:adapter_kind) == SUPPORTED_QUOTE_ADAPTER
        return domain_error("SWAP_UNSUPPORTED_ADAPTER")
      end
      return domain_error("SWAP_UNSUPPORTED_TOKEN_STANDARD") unless input.fetch(:standard) == "erc20" && output.fetch(:standard) == "erc20"
      return domain_error("SWAP_UNSUPPORTED_TOKEN") unless supported_quote_capability?(pool, dex, input, output)

      NormalizedRequest.new(
        chain_id: chain_id,
        pool_definition_id: pool_definition_id,
        input_token_deployment_id: input_token_deployment_id,
        output_token_deployment_id: output_token_deployment_id,
        amount_in_text: amount_in_text,
        amount_in: amount_in,
        freshness: freshness,
        pool: pool,
        dex: dex,
        input: input,
        output: output
      )
    end

    def copy_request_string(value)
      return nil unless value.is_a?(String)
      return nil if value.empty? || value.strip != value

      value.dup.freeze
    end

    def normalize_freshness(value)
      values = {
        max_block_age_seconds: 120,
        max_block_lag: 3,
        max_clock_skew_seconds: 5
      }
      return NormalizedFreshness.new(**values) if value.nil?
      return domain_error("SWAP_INVALID_ARGUMENT") unless value.is_a?(Hash)

      seen = {}
      value.each do |key, child|
        canonical = FRESHNESS_KEY_ALIASES[key]
        return domain_error("SWAP_INVALID_ARGUMENT") unless canonical
        return domain_error("SWAP_INVALID_ARGUMENT") if seen[canonical]
        return domain_error("SWAP_INVALID_ARGUMENT") unless child.is_a?(Integer)

        maximum = {
          max_block_age_seconds: 86_400,
          max_block_lag: 1_024,
          max_clock_skew_seconds: 300
        }.fetch(canonical)
        return domain_error("SWAP_INVALID_ARGUMENT") unless child.between?(0, maximum)

        seen[canonical] = true
        values[canonical] = child
      end
      NormalizedFreshness.new(**values)
    end

    def known_chain_id?(chain_id)
      DexCatalog::KNOWN_CHAIN_IDS.include?(chain_id)
    end

    def supported_quote_capability?(pool, dex, input, output)
      capability = SUPPORTED_QUOTE_CAPABILITIES.find do |value|
        value.fetch(:pool_definition_id) == pool.fetch(:pool_definition_id)
      end
      return false unless capability

      input_asset = TokenCatalog.get_token_asset(input.fetch(:asset_id))
      output_asset = TokenCatalog.get_token_asset(output.fetch(:asset_id))
      return false if [input_asset, output_asset].any? do |asset|
        asset && asset.fetch(:representation_kind) == "unclassified"
      end

      matches_token = lambda do |token, deployment_key, address_key, decimals_key, standard_key|
        token.fetch(:chain_id) == capability.fetch(:chain_id) &&
          token.fetch(:deployment_id) == capability.fetch(deployment_key) &&
          token.fetch(:address) == capability.fetch(address_key) &&
          token.fetch(:decimals) == capability.fetch(decimals_key) &&
          token.fetch(:standard) == capability.fetch(standard_key)
      end

      pool.fetch(:chain_id) == capability.fetch(:chain_id) &&
        pool.fetch(:dex_deployment_id) == capability.fetch(:dex_deployment_id) &&
        pool.fetch(:address) == capability.fetch(:pool_address) &&
        pool.fetch(:token0_deployment_id) == capability.fetch(:token0_deployment_id) &&
        pool.fetch(:token1_deployment_id) == capability.fetch(:token1_deployment_id) &&
        dex.fetch(:chain_id) == capability.fetch(:chain_id) &&
        dex.fetch(:dex_deployment_id) == capability.fetch(:dex_deployment_id) &&
        dex.fetch(:program_address) == capability.fetch(:factory_address) &&
        dex.fetch(:adapter_kind) == capability.fetch(:adapter_kind) &&
        pool.fetch(:adapter).fetch(:kind) == capability.fetch(:adapter_kind) &&
        pool.fetch(:adapter).fetch(:fee_numerator) == capability.fetch(:fee_numerator) &&
        pool.fetch(:adapter).fetch(:fee_denominator) == capability.fetch(:fee_denominator) &&
        (matches_token.call(input, :token0_deployment_id, :token0_address, :token0_decimals, :token0_standard) ||
          matches_token.call(input, :token1_deployment_id, :token1_address, :token1_decimals, :token1_standard)) &&
        (matches_token.call(output, :token0_deployment_id, :token0_address, :token0_decimals, :token0_standard) ||
          matches_token.call(output, :token1_deployment_id, :token1_address, :token1_decimals, :token1_standard))
    end

    def opaque_id?(value)
      value.match?(/\A[A-Za-z0-9][A-Za-z0-9._:-]*\z/)
    end

    def parse_canonical_decimal(value, positive:, code:)
      return domain_error(code) unless value.is_a?(String) &&
        value.length.between?(1, UINT256_DECIMAL_MAX_LENGTH) &&
        value.match?(/\A[0-9]+\z/) &&
        (value.length == 1 || value[0] != "0")

      parsed = Integer(value, 10)
      return domain_error(code) if parsed > UINT256_MAX || (positive && parsed.zero?)

      parsed
    rescue ArgumentError
      domain_error(code)
    end

    def parse_decimal_quantity(value, code)
      return domain_error(code) unless value.is_a?(String) &&
        value.length.between?(1, UINT256_DECIMAL_MAX_LENGTH) &&
        value.match?(/\A[0-9]+\z/) &&
        (value.length == 1 || value[0] != "0")

      parsed = Integer(value, 10)
      return domain_error(code) if parsed > UINT256_MAX

      parsed
    rescue ArgumentError
      domain_error(code)
    end

    def read_evm_state(transport, normalized)
      network_chain_id = parse_hex_quantity(
        rpc_request(transport, "eth_chainId", []),
        "SWAP_CHAIN_MISMATCH"
      )
      expected_chain_id = normalized.chain_id == DexChainIDs::ETHEREUM_MAINNET ? 1 : 43_114
      return domain_error("SWAP_CHAIN_MISMATCH") unless network_chain_id == expected_chain_id

      initial = parse_block_header(rpc_request(transport, "eth_getBlockByNumber", ["latest", false]))
      selector = rpc_selector(initial.hash)
      factory_code_raw = rpc_request(
        transport,
        "eth_getCode",
        [normalized.dex.fetch(:program_address), selector]
      )
      pool_code_raw = rpc_request(
        transport,
        "eth_getCode",
        [normalized.pool.fetch(:address), selector]
      )

      token0 = TokenCatalog.get_token_deployment(normalized.pool.fetch(:token0_deployment_id))
      token1 = TokenCatalog.get_token_deployment(normalized.pool.fetch(:token1_deployment_id))
      return domain_error("SWAP_INVALID_POOL_STATE") unless token0 && token1
      token0_address = token0[:address]
      token1_address = token1[:address]
      return domain_error("SWAP_INVALID_POOL_STATE") unless token0_address && token1_address

      pair_data = FACTORY_GET_PAIR_SELECTOR + encode_address_argument(token0_address) + encode_address_argument(token1_address)
      factory_pair_raw = rpc_request(
        transport,
        "eth_call",
        [abi_call(normalized.dex.fetch(:program_address), pair_data), selector]
      )
      pair_factory_raw = rpc_request(
        transport,
        "eth_call",
        [abi_call(normalized.pool.fetch(:address), PAIR_FACTORY_SELECTOR), selector]
      )
      pair_token0_raw = rpc_request(
        transport,
        "eth_call",
        [abi_call(normalized.pool.fetch(:address), PAIR_TOKEN0_SELECTOR), selector]
      )
      pair_token1_raw = rpc_request(
        transport,
        "eth_call",
        [abi_call(normalized.pool.fetch(:address), PAIR_TOKEN1_SELECTOR), selector]
      )
      reserves_raw = rpc_request(
        transport,
        "eth_call",
        [abi_call(normalized.pool.fetch(:address), PAIR_GET_RESERVES_SELECTOR), selector]
      )

      latest_after_reads = parse_block_header(rpc_request(transport, "eth_getBlockByNumber", ["latest", false]))
      snapshot_number = "0x#{initial.number.to_s(16)}"
      reread = parse_block_header(rpc_request(transport, "eth_getBlockByNumber", [snapshot_number, false]))
      if reread.number != initial.number || reread.hash != initial.hash || reread.timestamp != initial.timestamp
        return domain_error("SWAP_STATE_STALE")
      end

      # Freshness is checked before decoding any buffered ABI response, so a
      # stale snapshot deterministically wins over malformed pool state.
      assert_freshness(initial, latest_after_reads, normalized.freshness)

      factory_code = parse_hex_bytes(factory_code_raw, expected_bytes: nil, code: "SWAP_INVALID_POOL_STATE")
      return domain_error("SWAP_PROGRAM_MISMATCH") if factory_code.length <= 2
      pool_code = parse_hex_bytes(pool_code_raw, expected_bytes: nil, code: "SWAP_INVALID_POOL_STATE")
      return domain_error("SWAP_INVALID_POOL_STATE") if pool_code.length <= 2

      factory_pair = parse_address_word(factory_pair_raw)
      return domain_error("SWAP_PROGRAM_MISMATCH") unless factory_pair.casecmp?(normalized.pool.fetch(:address))
      pair_factory = parse_address_word(pair_factory_raw)
      return domain_error("SWAP_PROGRAM_MISMATCH") unless pair_factory.casecmp?(normalized.dex.fetch(:program_address))
      pair_token0 = parse_address_word(pair_token0_raw)
      pair_token1 = parse_address_word(pair_token1_raw)
      return domain_error("SWAP_POOL_TOKEN_MISMATCH") unless pair_token0.casecmp?(token0_address) && pair_token1.casecmp?(token1_address)

      reserve0, reserve1 = parse_reserves(reserves_raw)
      EvmState.new(
        initial: initial,
        latest_after_reads: latest_after_reads,
        reserve0: reserve0,
        reserve1: reserve1
      )
    end

    def rpc_request(transport, method, params)
      transport.request(method, params)
    end

    def parse_hex_quantity(value, code)
      return domain_error(code) unless value.is_a?(String) &&
        value.length.between?(3, 66) &&
        value.start_with?("0x") &&
        value[2..].match?(/\A[0-9a-fA-F]+\z/) &&
        (value.length == 3 || value[2] != "0")

      parsed = Integer(value[2..], 16)
      return domain_error(code) if parsed > UINT256_MAX

      parsed
    rescue ArgumentError
      domain_error(code)
    end

    def parse_hex_bytes(value, expected_bytes:, code:)
      return domain_error(code) unless value.is_a?(String) && value.start_with?("0x")
      hex = value[2..]
      return domain_error(code) unless hex && hex.match?(/\A[0-9a-fA-F]*\z/) && hex.length.even?
      return domain_error(code) if expected_bytes && hex.length != expected_bytes * 2

      "0x#{hex.downcase}"
    end

    def parse_block_header(value)
      return domain_error("SWAP_STATE_STALE") unless value.is_a?(Hash)

      number = parse_hex_quantity(value["number"] || value[:number], "SWAP_STATE_STALE")
      hash = parse_hex_bytes(value["hash"] || value[:hash], expected_bytes: 32, code: "SWAP_STATE_STALE")
      timestamp = parse_hex_quantity(value["timestamp"] || value[:timestamp], "SWAP_STATE_STALE")
      BlockHeader.new(number: number, hash: hash, timestamp: timestamp)
    end

    def parse_address_word(value)
      parsed = parse_hex_bytes(value, expected_bytes: 32, code: "SWAP_INVALID_POOL_STATE")
      word = parsed[2..]
      return domain_error("SWAP_INVALID_POOL_STATE") unless word[0, 24] == "0" * 24

      "0x#{word[24, 40]}"
    end

    def parse_uint_word(word, maximum, code:)
      return domain_error(code) unless word.is_a?(String) && word.length == 64 && word.match?(/\A[0-9a-fA-F]{64}\z/)

      parsed = Integer(word, 16)
      return domain_error(code) if parsed > maximum

      parsed
    rescue ArgumentError
      domain_error(code)
    end

    def parse_reserves(value)
      parsed = parse_hex_bytes(value, expected_bytes: 96, code: "SWAP_INVALID_POOL_STATE")
      payload = parsed[2..]
      reserve0 = parse_uint_word(payload[0, 64], UINT112_MAX, code: "SWAP_INVALID_POOL_STATE")
      reserve1 = parse_uint_word(payload[64, 64], UINT112_MAX, code: "SWAP_INVALID_POOL_STATE")
      parse_uint_word(payload[128, 64], UINT32_MAX, code: "SWAP_INVALID_POOL_STATE")
      [reserve0, reserve1]
    end

    def rpc_selector(hash)
      { "blockHash" => hash, "requireCanonical" => true }
    end

    def abi_call(to, data)
      { "to" => to, "data" => data }
    end

    def encode_address_argument(address)
      return domain_error("SWAP_INVALID_POOL_STATE") unless evm_address?(address)

      "0" * 24 + address[2..].downcase
    end

    def evm_address?(address)
      address.is_a?(String) && address.match?(/\A0x[0-9A-Fa-f]{40}\z/)
    end

    def current_time
      value = @clock.call
      return domain_error("SWAP_INVALID_ARGUMENT") unless value.is_a?(Integer) && value >= 0

      value
    end

    def assert_freshness(initial, latest_after_reads, freshness)
      now = current_time
      timestamps = [initial.timestamp, latest_after_reads.timestamp]
      timestamps.each do |timestamp|
        return domain_error("SWAP_STATE_STALE") if timestamp > now + freshness.max_clock_skew_seconds
        return domain_error("SWAP_STATE_STALE") if now > timestamp && now - timestamp > freshness.max_block_age_seconds
      end

      return domain_error("SWAP_STATE_STALE") if latest_after_reads.number < initial.number
      return domain_error("SWAP_STATE_STALE") if latest_after_reads.number - initial.number > freshness.max_block_lag
      if latest_after_reads.number == initial.number
        return domain_error("SWAP_STATE_STALE") if latest_after_reads.hash != initial.hash
      elsif latest_after_reads.timestamp < initial.timestamp
        return domain_error("SWAP_STATE_STALE")
      end
      if latest_after_reads.number == initial.number && latest_after_reads.hash == initial.hash &&
         latest_after_reads.timestamp != initial.timestamp
        return domain_error("SWAP_STATE_STALE")
      end
      true
    end

    def calculate_quote(normalized, state)
      fee_numerator = parse_decimal_quantity(
        normalized.pool.fetch(:adapter).fetch(:fee_numerator),
        "SWAP_ARITHMETIC"
      )
      fee_denominator = parse_decimal_quantity(
        normalized.pool.fetch(:adapter).fetch(:fee_denominator),
        "SWAP_ARITHMETIC"
      )
      return domain_error("SWAP_ARITHMETIC") if fee_denominator <= fee_numerator

      token0 = TokenCatalog.get_token_deployment(normalized.pool.fetch(:token0_deployment_id))
      token0_address = token0 && token0[:address]
      input_address = normalized.input[:address]
      output_address = normalized.output[:address]
      return domain_error("SWAP_INVALID_POOL_STATE") unless token0_address && input_address && output_address

      input_is_token0 = input_address.casecmp?(token0_address)
      output_is_token0 = output_address.casecmp?(token0_address)
      return domain_error("SWAP_INVALID_POOL_STATE") if input_is_token0 == output_is_token0

      reserve_in, reserve_out = input_is_token0 ? [state.reserve0, state.reserve1] : [state.reserve1, state.reserve0]
      return domain_error("SWAP_INSUFFICIENT_LIQUIDITY") if reserve_in.zero? || reserve_out.zero?

      fee_factor = fee_denominator - fee_numerator
      adjusted = checked_uint256(normalized.amount_in * fee_factor)
      reserve_product = checked_uint256(reserve_in * fee_denominator)
      denominator = checked_uint256(reserve_product + adjusted)
      return domain_error("SWAP_ARITHMETIC") if denominator.zero?
      numerator = checked_uint256(adjusted * reserve_out)
      amount_out = checked_uint256(numerator / denominator)
      return domain_error("SWAP_INSUFFICIENT_LIQUIDITY") if amount_out.zero? || amount_out > reserve_out

      CalculatedQuote.new(
        amount_out: amount_out,
        fee_numerator: fee_numerator,
        fee_denominator: fee_denominator
      )
    end

    def checked_uint256(value)
      return domain_error("SWAP_ARITHMETIC") if value > UINT256_MAX

      value
    end

    def build_quote_result(normalized, state, calculated)
      fee = {
        "numerator" => calculated.fee_numerator.to_s,
        "denominator" => calculated.fee_denominator.to_s
      }.freeze
      snapshot = {
        "kind" => "evm-block",
        "blockNumber" => state.initial.number.to_s,
        "blockHash" => state.initial.hash,
        "blockTimestamp" => state.initial.timestamp.to_s
      }.freeze
      {
        "quoteKind" => "exact-input",
        "chainId" => normalized.chain_id,
        "poolDefinitionId" => normalized.pool_definition_id,
        "dexDeploymentId" => normalized.dex.fetch(:dex_deployment_id),
        "adapterKind" => normalized.pool.fetch(:adapter).fetch(:kind),
        "inputTokenDeploymentId" => normalized.input_token_deployment_id,
        "outputTokenDeploymentId" => normalized.output_token_deployment_id,
        "amountIn" => normalized.amount_in.to_s,
        "amountOut" => calculated.amount_out.to_s,
        "fee" => fee,
        "snapshot" => snapshot,
        "tokenCatalogDigest" => TokenCatalog::TOKEN_CATALOG_CONTENT_DIGEST,
        "dexCatalogDigest" => DexCatalog::DEX_CATALOG_CONTENT_DIGEST
      }.freeze
    end

    def domain_error(code)
      raise SwapQuoteError, code
    end
  end
end
