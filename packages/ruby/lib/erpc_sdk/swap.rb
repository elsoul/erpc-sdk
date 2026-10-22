# frozen_string_literal: true

require "json"

require_relative "dex_catalog"
require_relative "generated/swap_execution_capabilities"

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

  # Stable machine-readable codes for unsigned swap preparation and RPC
  # simulation. The prefixed aliases keep the shared identifiers convenient
  # for callers that use the wire spelling as a Ruby constant.
  module SwapExecutionErrorCode
    INVALID_ARGUMENT = "SWAP_EXECUTION_INVALID_ARGUMENT"
    UNSUPPORTED_EXECUTION = "SWAP_UNSUPPORTED_EXECUTION"
    PROGRAM_MISMATCH = "SWAP_PROGRAM_MISMATCH"
    INSUFFICIENT_ALLOWANCE = "SWAP_INSUFFICIENT_ALLOWANCE"
    SIMULATION_REVERTED = "SWAP_SIMULATION_REVERTED"
    INVALID_SIMULATION = "SWAP_INVALID_SIMULATION"

    SWAP_EXECUTION_INVALID_ARGUMENT = INVALID_ARGUMENT
    SWAP_UNSUPPORTED_EXECUTION = UNSUPPORTED_EXECUTION
    SWAP_PROGRAM_MISMATCH = PROGRAM_MISMATCH
    SWAP_INSUFFICIENT_ALLOWANCE = INSUFFICIENT_ALLOWANCE
    SWAP_SIMULATION_REVERTED = SIMULATION_REVERTED
    SWAP_INVALID_SIMULATION = INVALID_SIMULATION

    ALL = [
      INVALID_ARGUMENT,
      UNSUPPORTED_EXECUTION,
      PROGRAM_MISMATCH,
      INSUFFICIENT_ALLOWANCE,
      SIMULATION_REVERTED,
      INVALID_SIMULATION
    ].freeze
  end

  # Stable local failures raised by unsigned preparation and simulation.
  # Quote, transport, timeout, cancellation, and non-revert JSON-RPC errors
  # retain their existing native behavior.
  class SwapExecutionError < Error
    MESSAGES = {
      SwapExecutionErrorCode::INVALID_ARGUMENT => "Swap execution request is invalid",
      SwapExecutionErrorCode::UNSUPPORTED_EXECUTION => "Swap execution is unsupported for the selected records",
      SwapExecutionErrorCode::PROGRAM_MISMATCH => "Swap program does not match the selected records",
      SwapExecutionErrorCode::INSUFFICIENT_ALLOWANCE => "Swap allowance is insufficient",
      SwapExecutionErrorCode::SIMULATION_REVERTED => "Swap simulation reverted",
      SwapExecutionErrorCode::INVALID_SIMULATION => "Swap simulation result is invalid"
    }.freeze

    attr_reader :code

    def initialize(code)
      @code = code.to_s.freeze
      super(MESSAGES.fetch(@code, "Swap execution failed"))
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
    ROUTER_FACTORY_SELECTOR = "0xc45a0155"
    ROUTER_GET_AMOUNTS_OUT_SELECTOR = "0xd06ca61f"
    ERC20_ALLOWANCE_SELECTOR = "0xdd62ed3e"

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

    EXECUTION_REQUEST_KEY_ALIASES = REQUEST_KEY_ALIASES.merge(
      "sender" => :sender,
      :sender => :sender,
      "recipient" => :recipient,
      :recipient => :recipient,
      "slippageBps" => :slippage_bps,
      :slippageBps => :slippage_bps,
      "slippage_bps" => :slippage_bps,
      :slippage_bps => :slippage_bps,
      "deadline" => :deadline,
      :deadline => :deadline
    ).freeze

    EXECUTION_UNSUPPORTED_QUOTE_CODES = %w[
      SWAP_UNKNOWN_POOL
      SWAP_UNSUPPORTED_ADAPTER
      SWAP_UNSUPPORTED_TOKEN
      SWAP_UNSUPPORTED_TOKEN_STANDARD
    ].freeze

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
    ExecutionRequestSnapshot = Struct.new(
      :quote_request,
      :sender,
      :recipient,
      :slippage_bps,
      :deadline,
      keyword_init: true
    )
    NormalizedExecutionRequest = Struct.new(
      :normalized,
      :sender,
      :recipient,
      :slippage_bps,
      :deadline,
      :deadline_value,
      keyword_init: true
    )
    PreparedExecutionContext = Struct.new(
      :normalized,
      :capability,
      :transport,
      :state,
      :quote,
      :preparation,
      keyword_init: true
    )

    # The execution capability rows are generated from the canonical
    # registry. Runtime code only parses this immutable string; it never reads
    # the registry or a file at runtime.
    EXECUTION_CAPABILITIES = JSON.parse(SWAP_EXECUTION_CAPABILITIES_JSON).map do |row|
      row.freeze
    end.freeze

    private_constant :REQUEST_KEY_ALIASES
    private_constant :FRESHNESS_KEY_ALIASES
    private_constant :EXECUTION_REQUEST_KEY_ALIASES
    private_constant :EXECUTION_UNSUPPORTED_QUOTE_CODES
    private_constant :REQUIRED_REQUEST_KEYS
    private_constant :SUPPORTED_QUOTE_CAPABILITIES
    private_constant :EXECUTION_CAPABILITIES
    private_constant :NormalizedFreshness
    private_constant :NormalizedRequest
    private_constant :BlockHeader
    private_constant :EvmState
    private_constant :CalculatedQuote
    private_constant :ExecutionRequestSnapshot
    private_constant :NormalizedExecutionRequest
    private_constant :PreparedExecutionContext

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

    # Prepare an unsigned ERC-20-to-ERC-20 router transaction from a fresh
    # local quote and router preflight. No allowance, signature, or send is
    # produced by this method.
    def prepare_exact_input_swap(request, options = nil, **keyword_options)
      options = keyword_options unless keyword_options.empty?
      execution = normalize_execution_request(request)
      context = prepare_execution_context(execution, options)
      context.preparation
    end

    # Simulate the prepared router call against the quote block. The caller's
    # allowance is read first; an insufficient allowance never reaches the
    # router simulation.
    def simulate_exact_input_swap(request, options = nil, **keyword_options)
      options = keyword_options unless keyword_options.empty?
      execution = normalize_execution_request(request)
      context = prepare_execution_context(execution, options)
      simulate_execution_context(context, options)
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

    def snapshot_execution_request(request)
      return execution_domain_error(SwapExecutionErrorCode::INVALID_ARGUMENT) unless request.is_a?(Hash)

      values = {}
      request.each do |key, value|
        canonical = EXECUTION_REQUEST_KEY_ALIASES[key]
        return execution_domain_error(SwapExecutionErrorCode::INVALID_ARGUMENT) unless canonical
        return execution_domain_error(SwapExecutionErrorCode::INVALID_ARGUMENT) if values.key?(canonical)

        values[canonical] = snapshot_request_value(value)
      end

      quote_request = {}
      %i[chain_id pool_definition_id input_token_deployment_id output_token_deployment_id amount_in].each do |key|
        quote_request[key] = values[key] if values.key?(key)
      end
      quote_request[:freshness] = values[:freshness] if values.key?(:freshness)

      ExecutionRequestSnapshot.new(
        quote_request: quote_request.freeze,
        sender: values[:sender],
        recipient: values[:recipient],
        slippage_bps: values[:slippage_bps],
        deadline: values[:deadline]
      ).freeze
    end

    def snapshot_request_value(value)
      case value
      when String
        value.dup.freeze
      when Hash
        value.each_with_object({}) do |(key, child), copy|
          copy[snapshot_request_value(key)] = snapshot_request_value(child)
        end.freeze
      when Array
        value.map { |child| snapshot_request_value(child) }.freeze
      else
        value
      end
    end

    def normalize_execution_request(request)
      snapshot = snapshot_execution_request(request)
      sender = normalize_execution_address(snapshot.sender)
      recipient = normalize_execution_address(snapshot.recipient)
      slippage_bps = normalize_execution_slippage(snapshot.slippage_bps)
      deadline_value = parse_execution_deadline(snapshot.deadline)

      # Reject an already elapsed deadline before any RPC call. It is checked
      # again against the quote block and at completion below.
      initial_clock = execution_current_time
      return execution_domain_error(SwapExecutionErrorCode::INVALID_ARGUMENT) if deadline_value <= initial_clock

      normalized = begin
        normalize_request(snapshot.quote_request)
      rescue SwapQuoteError => error
        if EXECUTION_UNSUPPORTED_QUOTE_CODES.include?(error.code)
          execution_domain_error(SwapExecutionErrorCode::UNSUPPORTED_EXECUTION)
        end
        raise
      end

      NormalizedExecutionRequest.new(
        normalized: normalized,
        sender: sender,
        recipient: recipient,
        slippage_bps: slippage_bps,
        deadline: snapshot.deadline,
        deadline_value: deadline_value
      ).freeze
    end

    def normalize_execution_address(value)
      return execution_domain_error(SwapExecutionErrorCode::INVALID_ARGUMENT) unless evm_address?(value)

      normalized = value.downcase
      return execution_domain_error(SwapExecutionErrorCode::INVALID_ARGUMENT) if normalized == "0x#{'0' * 40}"

      normalized.freeze
    end

    def normalize_execution_slippage(value)
      return execution_domain_error(SwapExecutionErrorCode::INVALID_ARGUMENT) unless value.is_a?(Integer)
      return execution_domain_error(SwapExecutionErrorCode::INVALID_ARGUMENT) unless value.between?(0, 9_999)

      value
    end

    def parse_execution_deadline(value)
      return execution_domain_error(SwapExecutionErrorCode::INVALID_ARGUMENT) unless value.is_a?(String) &&
        value.length.between?(1, UINT256_DECIMAL_MAX_LENGTH) &&
        value.match?(/\A[0-9]+\z/) &&
        (value.length == 1 || value[0] != "0")

      parsed = Integer(value, 10)
      return execution_domain_error(SwapExecutionErrorCode::INVALID_ARGUMENT) if parsed.zero? || parsed > UINT256_MAX

      parsed
    rescue ArgumentError
      execution_domain_error(SwapExecutionErrorCode::INVALID_ARGUMENT)
    end

    def execution_current_time
      value = @clock.call
      return execution_domain_error(SwapExecutionErrorCode::INVALID_ARGUMENT) unless value.is_a?(Integer) && value >= 0

      value
    end

    def execution_capability_for(normalized)
      capability = EXECUTION_CAPABILITIES.find do |row|
        row.fetch("poolDefinitionId") == normalized.pool.fetch(:pool_definition_id)
      end
      return execution_domain_error(SwapExecutionErrorCode::UNSUPPORTED_EXECUTION) unless capability
      return execution_domain_error(SwapExecutionErrorCode::UNSUPPORTED_EXECUTION) unless capability.fetch("status") == "active"

      token0 = TokenCatalog.get_token_deployment(capability.fetch("token0DeploymentId"))
      token1 = TokenCatalog.get_token_deployment(capability.fetch("token1DeploymentId"))
      wrapped = TokenCatalog.get_token_deployment(capability.fetch("wrappedNativeTokenDeploymentId"))
      native_wrap = DexCatalog::NATIVE_WRAP_DEFINITIONS.find do |definition|
        definition.fetch(:chain_id) == capability.fetch("chainId") &&
          definition.fetch(:wrapped_token_deployment_id) == capability.fetch("wrappedNativeTokenDeploymentId")
      end

      matches_capability_token = lambda do |token, deployment_key, address_key, standard_key|
        token &&
          token.fetch(:deployment_id) == capability.fetch(deployment_key) &&
          token.fetch(:chain_id) == capability.fetch("chainId") &&
          canonical_evm_address_equal?(token[:address], capability.fetch(address_key)) &&
          token.fetch(:standard) == capability.fetch(standard_key) &&
          token.fetch(:status) == "active"
      end

      input_matches = matches_capability_token.call(
        normalized.input,
        "token0DeploymentId",
        "token0Address",
        "token0Standard"
      ) || matches_capability_token.call(
        normalized.input,
        "token1DeploymentId",
        "token1Address",
        "token1Standard"
      )
      output_matches = matches_capability_token.call(
        normalized.output,
        "token0DeploymentId",
        "token0Address",
        "token0Standard"
      ) || matches_capability_token.call(
        normalized.output,
        "token1DeploymentId",
        "token1Address",
        "token1Standard"
      )

      pool = normalized.pool
      dex = normalized.dex
      pool_adapter = pool.fetch(:adapter)
      capability_matches =
        capability.fetch("chainId") == pool.fetch(:chain_id) &&
        capability.fetch("dexDeploymentId") == pool.fetch(:dex_deployment_id) &&
        capability.fetch("adapterKind") == SUPPORTED_QUOTE_ADAPTER &&
        capability.fetch("functionKind") == "exact-input-erc20-to-erc20" &&
        capability.fetch("functionSignature") == SWAP_EXECUTION_FUNCTION_SIGNATURE &&
        capability.fetch("functionSelector") == SWAP_EXECUTION_FUNCTION_SELECTOR &&
        dex.fetch(:status) == "active" &&
        canonical_evm_address_equal?(dex[:program_address], capability.fetch("factoryAddress")) &&
        dex.fetch(:adapter_kind) == capability.fetch("adapterKind") &&
        pool.fetch(:status) == "active" &&
        pool_adapter.fetch(:kind) == capability.fetch("adapterKind") &&
        pool_adapter.fetch(:fee_numerator) == "3" &&
        pool_adapter.fetch(:fee_denominator) == "1000" &&
        pool.fetch(:token0_deployment_id) == capability.fetch("token0DeploymentId") &&
        pool.fetch(:token1_deployment_id) == capability.fetch("token1DeploymentId") &&
        input_matches && output_matches &&
        token0 && token1 && wrapped &&
        wrapped.fetch(:chain_id) == capability.fetch("chainId") &&
        canonical_evm_address_equal?(wrapped[:address], capability.fetch("wrappedNativeTokenAddress")) &&
        wrapped.fetch(:standard) == "erc20" &&
        wrapped.fetch(:status) == "active" &&
        native_wrap &&
        native_wrap.fetch(:status) == "active" &&
        native_wrap.fetch(:wrapped_token_deployment_id) == capability.fetch("wrappedNativeTokenDeploymentId")

      return execution_domain_error(SwapExecutionErrorCode::UNSUPPORTED_EXECUTION) unless capability_matches

      capability
    end

    def canonical_evm_address_equal?(left, right)
      left.is_a?(String) && right.is_a?(String) && evm_address?(left) && evm_address?(right) && left.casecmp?(right)
    end

    def prepare_execution_context(execution, options)
      check_execution_options(options)
      normalized = execution.normalized
      capability = execution_capability_for(normalized)
      transport = execution_transport_for(normalized)

      state = read_evm_state(transport, normalized)
      assert_freshness(state.initial, state.latest_after_reads, normalized.freshness)
      quote = build_quote_result(normalized, state, calculate_quote(normalized, state))
      assert_execution_deadline(execution, state.initial.timestamp, execution_current_time)

      input_address = execution_token_address(normalized.input)
      output_address = execution_token_address(normalized.output)
      selector = rpc_selector(state.initial.hash)
      router_address = capability.fetch("routerAddress")

      router_code_raw = rpc_request(
        transport,
        "eth_getCode",
        [router_address, selector]
      )
      router_code = parse_execution_hex_bytes(router_code_raw)
      return execution_domain_error(SwapExecutionErrorCode::INVALID_SIMULATION) if router_code.length <= 2

      router_factory_raw = rpc_request(
        transport,
        "eth_call",
        [abi_call(router_address, ROUTER_FACTORY_SELECTOR), selector]
      )
      router_factory = parse_execution_address_word(router_factory_raw)
      return execution_domain_error(SwapExecutionErrorCode::PROGRAM_MISMATCH) unless router_factory == capability.fetch("factoryAddress")

      wrapped_native_raw = rpc_request(
        transport,
        "eth_call",
        [abi_call(router_address, capability.fetch("wrappedNativeFunctionSelector")), selector]
      )
      wrapped_native = parse_execution_address_word(wrapped_native_raw)
      return execution_domain_error(SwapExecutionErrorCode::PROGRAM_MISMATCH) unless wrapped_native == capability.fetch("wrappedNativeTokenAddress")

      amounts_out_raw = rpc_request(
        transport,
        "eth_call",
        [
          abi_call(
            router_address,
            execution_get_amounts_out_data(normalized.amount_in, input_address, output_address)
          ),
          selector
        ]
      )
      amounts_out = parse_execution_uint_array_of_two(amounts_out_raw)
      quote_amount_out = parse_decimal_quantity(quote.fetch("amountOut"), "SWAP_ARITHMETIC")
      return execution_domain_error(SwapExecutionErrorCode::INVALID_SIMULATION) unless
        amounts_out[0] == normalized.amount_in && amounts_out[1] == quote_amount_out

      latest_after_router_reads = parse_block_header(
        rpc_request(transport, "eth_getBlockByNumber", ["latest", false])
      )
      assert_freshness(
        state.initial,
        latest_after_router_reads,
        normalized.freshness
      )

      preparation = build_execution_preparation(execution, capability, quote)
      assert_execution_deadline(execution, state.initial.timestamp, execution_current_time)
      PreparedExecutionContext.new(
        normalized: execution,
        capability: capability,
        transport: transport,
        state: state,
        quote: quote,
        preparation: preparation
      ).freeze
    end

    def execution_transport_for(normalized)
      case normalized.chain_id
      when DexChainIDs::ETHEREUM_MAINNET
        @ethereum_transport
      when DexChainIDs::AVALANCHE_C_MAINNET
        @avalanche_transport
      else
        execution_domain_error(SwapExecutionErrorCode::UNSUPPORTED_EXECUTION)
      end
    end

    def execution_token_address(token)
      address = token[:address]
      return execution_domain_error(SwapExecutionErrorCode::INVALID_SIMULATION) unless evm_address?(address)

      address.downcase.freeze
    end

    def encode_execution_address_argument(address)
      return execution_domain_error(SwapExecutionErrorCode::INVALID_SIMULATION) unless evm_address?(address)

      "0" * 24 + address[2..].downcase
    end

    def encode_execution_uint256_word(value)
      return execution_domain_error(SwapExecutionErrorCode::INVALID_SIMULATION) unless value.is_a?(Integer) && value.between?(0, UINT256_MAX)

      format("%064x", value)
    end

    def execution_get_amounts_out_data(amount_in, input_address, output_address)
      ROUTER_GET_AMOUNTS_OUT_SELECTOR +
        encode_execution_uint256_word(amount_in) +
        encode_execution_uint256_word(0x40) +
        encode_execution_uint256_word(2) +
        encode_execution_address_argument(input_address) +
        encode_execution_address_argument(output_address)
    end

    def execution_swap_data(amount_in, minimum_amount_out, input_address, output_address, recipient, deadline)
      SWAP_EXECUTION_FUNCTION_SELECTOR +
        encode_execution_uint256_word(amount_in) +
        encode_execution_uint256_word(minimum_amount_out) +
        encode_execution_uint256_word(0xa0) +
        encode_execution_address_argument(recipient) +
        encode_execution_uint256_word(deadline) +
        encode_execution_uint256_word(2) +
        encode_execution_address_argument(input_address) +
        encode_execution_address_argument(output_address)
    end

    def build_execution_preparation(execution, capability, quote)
      normalized = execution.normalized
      input_address = execution_token_address(normalized.input)
      output_address = execution_token_address(normalized.output)
      quote_amount_out = parse_decimal_quantity(quote.fetch("amountOut"), "SWAP_ARITHMETIC")
      minimum_amount_out = checked_uint256(
        quote_amount_out * (10_000 - execution.slippage_bps)
      ) / 10_000
      return execution_domain_error(SwapExecutionErrorCode::INVALID_ARGUMENT) if minimum_amount_out.zero?

      preparation = {
        "preparationKind" => "evm-router-v2-exact-input",
        "executionCapabilityId" => capability.fetch("swapExecutionCapabilityId"),
        "executionCapabilityDigest" => SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST,
        "quote" => quote,
        "minimumAmountOut" => minimum_amount_out.to_s,
        "slippageBps" => execution.slippage_bps,
        "deadline" => execution.deadline,
        "recipient" => execution.recipient,
        "path" => [
          {
            "tokenDeploymentId" => normalized.input.fetch(:deployment_id),
            "address" => input_address,
            "standard" => "erc20",
            "representationKind" => normalized.input.fetch(:representation_kind)
          },
          {
            "tokenDeploymentId" => normalized.output.fetch(:deployment_id),
            "address" => output_address,
            "standard" => "erc20",
            "representationKind" => normalized.output.fetch(:representation_kind)
          }
        ],
        "transaction" => {
          "kind" => "evm-unsigned-transaction",
          "chainId" => quote.fetch("chainId"),
          "from" => execution.sender,
          "to" => capability.fetch("routerAddress"),
          "data" => execution_swap_data(
            normalized.amount_in,
            minimum_amount_out,
            input_address,
            output_address,
            execution.recipient,
            execution.deadline_value
          ),
          "value" => "0"
        },
        "allowance" => {
          "tokenDeploymentId" => normalized.input.fetch(:deployment_id),
          "tokenAddress" => input_address,
          "owner" => execution.sender,
          "spender" => capability.fetch("routerAddress"),
          "requiredAmount" => quote.fetch("amountIn")
        }
      }
      deep_freeze(preparation)
    end

    def assert_execution_deadline(execution, quote_timestamp, completion_clock)
      return true if execution.deadline_value > quote_timestamp && execution.deadline_value > completion_clock

      execution_domain_error(SwapExecutionErrorCode::INVALID_ARGUMENT)
    end

    def simulate_execution_context(context, options)
      check_execution_options(options)
      execution = context.normalized
      capability = context.capability
      transport = context.transport
      state = context.state
      preparation = context.preparation
      selector = rpc_selector(state.initial.hash)
      allowance_data = ERC20_ALLOWANCE_SELECTOR +
        encode_execution_address_argument(execution.sender) +
        encode_execution_address_argument(capability.fetch("routerAddress"))
      allowance_raw = rpc_request(
        transport,
        "eth_call",
        [abi_call(preparation.fetch("allowance").fetch("tokenAddress"), allowance_data), selector]
      )
      current_allowance = parse_execution_uint_word(
        allowance_raw,
        code: SwapExecutionErrorCode::INSUFFICIENT_ALLOWANCE
      )
      return execution_domain_error(SwapExecutionErrorCode::INSUFFICIENT_ALLOWANCE) if current_allowance < execution.normalized.amount_in

      simulation_raw = begin
        rpc_request(
          transport,
          "eth_call",
          [
            {
              "from" => preparation.fetch("transaction").fetch("from"),
              "to" => preparation.fetch("transaction").fetch("to"),
              "data" => preparation.fetch("transaction").fetch("data"),
              "value" => "0x0"
            },
            selector
          ]
        )
      rescue JsonRpcError => error
        return execution_domain_error(SwapExecutionErrorCode::SIMULATION_REVERTED) if recognized_execution_revert?(error)

        raise
      end

      latest_after_simulation = parse_block_header(
        rpc_request(transport, "eth_getBlockByNumber", ["latest", false])
      )
      assert_freshness(
        state.initial,
        latest_after_simulation,
        execution.normalized.freshness
      )

      amounts = parse_execution_uint_array_of_two(simulation_raw)
      quote_amount_out = parse_decimal_quantity(preparation.fetch("quote").fetch("amountOut"), "SWAP_ARITHMETIC")
      minimum_amount_out = parse_decimal_quantity(preparation.fetch("minimumAmountOut"), "SWAP_ARITHMETIC")
      return execution_domain_error(SwapExecutionErrorCode::INVALID_SIMULATION) unless
        amounts[0] == execution.normalized.amount_in &&
        amounts[1] == quote_amount_out &&
        amounts[1] >= minimum_amount_out

      assert_execution_deadline(execution, state.initial.timestamp, execution_current_time)
      deep_freeze(
        "simulationKind" => "evm-call",
        "preparation" => preparation,
        "snapshot" => preparation.fetch("quote").fetch("snapshot"),
        "currentAllowance" => current_allowance.to_s,
        "amounts" => amounts.map(&:to_s),
        "amountOut" => amounts[1].to_s
      )
    end

    def parse_execution_hex_bytes(value, expected_bytes: nil, code: SwapExecutionErrorCode::INVALID_SIMULATION)
      return execution_domain_error(code) unless value.is_a?(String) && value.start_with?("0x")

      hex = value[2..]
      return execution_domain_error(code) unless hex && hex.match?(/\A[0-9a-fA-F]*\z/) && hex.length.even?
      return execution_domain_error(code) if expected_bytes && hex.length != expected_bytes * 2

      "0x#{hex.downcase}"
    end

    def parse_execution_address_word(value, code: SwapExecutionErrorCode::INVALID_SIMULATION)
      parsed = parse_execution_hex_bytes(value, expected_bytes: 32, code: code)
      word = parsed[2..]
      return execution_domain_error(code) unless word[0, 24] == "0" * 24

      "0x#{word[24, 40]}"
    end

    def parse_execution_uint_word(value, code: SwapExecutionErrorCode::INVALID_SIMULATION)
      parsed = parse_execution_hex_bytes(value, expected_bytes: 32, code: code)
      Integer(parsed[2..], 16)
    rescue ArgumentError
      execution_domain_error(code)
    end

    def parse_execution_uint_array_of_two(value)
      parsed = parse_execution_hex_bytes(value)
      payload = parsed[2..]
      return execution_domain_error(SwapExecutionErrorCode::INVALID_SIMULATION) unless payload.length == 256

      offset = Integer(payload[0, 64], 16)
      length = Integer(payload[64, 64], 16)
      return execution_domain_error(SwapExecutionErrorCode::INVALID_SIMULATION) unless offset == 0x20 && length == 2

      [
        Integer(payload[128, 64], 16),
        Integer(payload[192, 64], 16)
      ].freeze
    rescue ArgumentError, TypeError
      execution_domain_error(SwapExecutionErrorCode::INVALID_SIMULATION)
    end

    def recognized_execution_revert?(error)
      return false unless error.is_a?(JsonRpcError)
      return false unless [-32_000, -32_015, -32_603, 3].include?(error.code)

      message = error.message.to_s.downcase
      message.include?("execution reverted") ||
        message.include?("transaction reverted") ||
        message.include?("vm execution error") ||
        message.match?(/\Arevert(?:ed)?(?:\b|:)/)
    end

    def check_execution_options(options)
      return if options.nil?

      cancelled = if options.is_a?(Hash)
                    options[:cancelled] || options["cancelled"] || options[:aborted] || options["aborted"]
                  elsif options.respond_to?(:cancelled?)
                    options.cancelled?
                  elsif options.respond_to?(:aborted?)
                    options.aborted?
                  end
      return unless cancelled

      reason = if options.is_a?(Hash)
                 options[:reason] || options["reason"]
               end
      raise reason if reason.is_a?(Exception)

      raise TransportError, "Swap operation was cancelled", cause: nil
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

    def execution_domain_error(code)
      raise SwapExecutionError, code
    end
  end
end
