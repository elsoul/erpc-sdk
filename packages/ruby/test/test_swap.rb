# frozen_string_literal: true

require_relative "test_helper"
require "fileutils"

class SwapTest < Minitest::Test
  ROOT = File.expand_path("../../..", __dir__)
  FIXTURE = JSON.parse(
    File.read(File.join(ROOT, "registry", "fixtures", "swap-quote-cases.json"))
  ).freeze
  SHARED_CASES = %w[validCases invalidCases rpcCases arithmeticCases].flat_map do |group|
    FIXTURE.fetch(group).reject { |entry| entry["applicability"] == "language-local" }
  end.freeze

  ETHEREUM_CHAIN_ID = ERPC::DexChainIDs::ETHEREUM_MAINNET
  SOLANA_CHAIN_ID = ERPC::DexChainIDs::SOLANA_MAINNET
  AVALANCHE_CHAIN_ID = ERPC::DexChainIDs::AVALANCHE_C_MAINNET

  def test_performs_the_exact_rpc_sequence_and_computes_an_ethereum_quote
    entry = FIXTURE.fetch("validCases").find { |value| value.fetch("caseId") == "ethereum-weth-usdc-forward" }
    outcome, trace = run_fixture_case(entry)

    assert_equal expected_fixture_outcome(entry), outcome
    assert_equal entry.fetch("rpcTrace"), trace
    assert_equal "2393866186", outcome.fetch("value").fetch("amountOut")
    assert_equal({
      "blockHash" => entry.fetch("snapshot").fetch("blockHash"),
      "requireCanonical" => true
    }, trace.fetch(2).fetch("params").fetch(1))
  end

  def test_routes_avalanche_quote_to_the_avalanche_transport
    entry = FIXTURE.fetch("validCases").find { |value| value.fetch("caseId") == "avalanche-wavax-usdc-forward" }
    trace = []
    adapter = fixture_adapter(entry, trace)
    client = ERPC::Client.new(
      ERPC::ClientConfig.new(api_key: "capture-secret", endpoint: "https://example.test"),
      http_adapter: adapter
    )
    set_fixture_clock(client, entry.fetch("nowSeconds"))

    result = client.swap.quote_exact_input(entry.fetch("request"))
    assert_equal "7329527", result.fetch("amountOut")
    assert_equal 11, trace.length
    assert_equal AVALANCHE_CHAIN_ID, result.fetch("chainId")
  ensure
    client&.close
  end

  def test_routes_ethereum_quote_reads_to_the_exact_direct_rpc_target
    entry = FIXTURE.fetch("validCases").find { |value| value.fetch("caseId") == "ethereum-weth-usdc-forward" }
    trace = []
    adapter = fixture_adapter(entry, trace)
    direct_url = "https://customer.example/customer/path?token=a%2Fb&region=eu"
    client = ERPC::Client.new(
      ERPC::ClientConfig.new(
        ethereum_rpc: ERPC::RpcEndpointConfig.new(http_url: direct_url)
      ),
      http_adapter: adapter
    )
    set_fixture_clock(client, entry.fetch("nowSeconds"))

    result = client.swap.quote_exact_input(entry.fetch("request"))
    assert_equal "2393866186", result.fetch("amountOut")
    assert_equal 11, trace.length
    assert_equal [direct_url], adapter.requests.map { |request| request.fetch(:url) }.uniq
  ensure
    client&.close
  end

  def test_routes_avalanche_quote_reads_to_the_exact_direct_c_rpc_target
    entry = FIXTURE.fetch("validCases").find { |value| value.fetch("caseId") == "avalanche-wavax-usdc-forward" }
    trace = []
    adapter = fixture_adapter(entry, trace)
    direct_url = "https://customer.example/customer/path?token=a%2Fb&region=eu"
    client = ERPC::Client.new(
      ERPC::ClientConfig.new(
        avalanche_c_rpc: ERPC::RpcEndpointConfig.new(http_url: direct_url)
      ),
      http_adapter: adapter
    )
    set_fixture_clock(client, entry.fetch("nowSeconds"))

    result = client.swap.quote_exact_input(entry.fetch("request"))
    assert_equal "7329527", result.fetch("amountOut")
    assert_equal 11, trace.length
    assert_equal [direct_url], adapter.requests.map { |request| request.fetch(:url) }.uniq
  ensure
    client&.close
  end

  def test_wrong_chain_still_fails_before_a_direct_rpc_call
    entry = FIXTURE.fetch("validCases").find { |value| value.fetch("caseId") == "ethereum-weth-usdc-forward" }
    adapter = FakeHttpAdapter.new { raise "wrong-chain validation should not use RPC" }
    client = ERPC::Client.new(
      ERPC::ClientConfig.new(
        ethereum_rpc: ERPC::RpcEndpointConfig.new(http_url: "https://customer.example/rpc")
      ),
      http_adapter: adapter
    )
    request = entry.fetch("request").merge("chainId" => AVALANCHE_CHAIN_ID)

    assert_swap_code(request, "SWAP_CHAIN_MISMATCH", client)
    assert_empty adapter.requests
  ensure
    client&.close
  end

  def test_rejects_invalid_catalog_requests_before_rpc
    called = 0
    adapter = FakeHttpAdapter.new do
      called += 1
      raise "RPC should not be called"
    end
    client = ERPC::Client.new(
      ERPC::ClientConfig.new(api_key: "capture-secret", endpoint: "https://example.test"),
      http_adapter: adapter
    )
    base = {
      "chainId" => ETHEREUM_CHAIN_ID,
      "poolDefinitionId" => "pool-0001",
      "inputTokenDeploymentId" => "deployment-0002",
      "outputTokenDeploymentId" => "deployment-0008",
      "amountIn" => "1"
    }

    assert_swap_code(base.merge("chainId" => "eip155:999"), "SWAP_UNSUPPORTED_CHAIN", client)
    assert_swap_code(base.merge("inputTokenDeploymentId" => "deployment-0001"), "SWAP_UNSUPPORTED_TOKEN_STANDARD", client)
    assert_swap_code({
      "chainId" => SOLANA_CHAIN_ID,
      "poolDefinitionId" => "pool-0003",
      "inputTokenDeploymentId" => "deployment-0006",
      "outputTokenDeploymentId" => "deployment-0013",
      "amountIn" => "1"
    }, "SWAP_UNSUPPORTED_ADAPTER", client)
    assert_swap_code(base.merge("amountIn" => "01"), "SWAP_INVALID_ARGUMENT", client)
    assert_equal 0, called
  ensure
    client&.close
  end

  def test_rejects_a_token_outside_the_reviewed_quote_capability_before_rpc
    called = 0
    adapter = FakeHttpAdapter.new do
      called += 1
      raise "RPC should not be called"
    end
    client = ERPC::Client.new(
      ERPC::ClientConfig.new(api_key: "capture-secret", endpoint: "https://example.test"),
      http_adapter: adapter
    )
    original_input = ERPC::TokenCatalog.get_token_deployment("deployment-0002")
    unsupported_input = original_input.merge(
      address: "0x1111111111111111111111111111111111111111"
    ).freeze
    lookup = lambda do |deployment_id|
      deployment_id == "deployment-0002" ? unsupported_input : ERPC::TokenCatalog::DEPLOYMENTS_BY_ID.fetch(deployment_id, nil)
    end

    ERPC::TokenCatalog.stub(:get_token_deployment, lookup) do
      error = assert_raises(ERPC::SwapQuoteError) do
        client.swap.quote_exact_input(
          "chainId" => ETHEREUM_CHAIN_ID,
          "poolDefinitionId" => "pool-0001",
          "inputTokenDeploymentId" => "deployment-0002",
          "outputTokenDeploymentId" => "deployment-0008",
          "amountIn" => "1"
        )
      end
      assert_equal "SWAP_UNSUPPORTED_TOKEN", error.code
      assert_equal "Swap token is unsupported for the selected pool", error.message
    end
    assert_equal 0, called
  ensure
    client&.close
  end

  def test_snapshots_request_scalars_before_the_first_rpc_call
    entry = FIXTURE.fetch("validCases").first
    request = entry.fetch("request").dup
    trace = []
    adapter = FakeHttpAdapter.new do |http_request|
      request["poolDefinitionId"] = "pool-0002"
      request["amountIn"] = "1"
      body = JSON.parse(http_request.fetch(:body))
      index = trace.length
      trace << { "method" => body.fetch("method"), "params" => body.fetch("params", []) }
      response = entry.fetch("rpcResponses").fetch(index)
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate("jsonrpc" => "2.0", "id" => body.fetch("id"), "result" => response)
      )
    end
    client = ERPC::Client.new(
      ERPC::ClientConfig.new(api_key: "capture-secret", endpoint: "https://example.test"),
      http_adapter: adapter
    )
    set_fixture_clock(client, entry.fetch("nowSeconds"))

    result = client.swap.quote_exact_input(request)
    assert_equal "pool-0001", result.fetch("poolDefinitionId")
    assert_equal "1000000000000000000", result.fetch("amountIn")
  ensure
    client&.close
  end

  def test_preserves_upstream_transport_errors
    source = RuntimeError.new("upstream detail")
    adapter = FakeHttpAdapter.new { raise source }
    client = ERPC::Client.new(
      ERPC::ClientConfig.new(api_key: "capture-secret", endpoint: "https://example.test"),
      http_adapter: adapter
    )
    request = {
      "chainId" => ETHEREUM_CHAIN_ID,
      "poolDefinitionId" => "pool-0001",
      "inputTokenDeploymentId" => "deployment-0002",
      "outputTokenDeploymentId" => "deployment-0008",
      "amountIn" => "1"
    }

    error = assert_raises(RuntimeError) { client.swap.quote_exact_input(request) }
    assert_same source, error
  ensure
    client&.close
  end

  def test_freezes_quote_result_without_exposing_rpc_or_clock_fields
    entry = FIXTURE.fetch("validCases").first
    outcome, = run_fixture_case(entry)
    result = outcome.fetch("value")

    assert result.frozen?
    assert result.fetch("fee").frozen?
    assert result.fetch("snapshot").frozen?
    assert_raises(FrozenError) { result.fetch("fee")["numerator"] = "0" }
    refute result.key?("rpc")
    refute result.key?("now")
  end

  def test_replays_all_shared_fixture_cases
    SHARED_CASES.each do |entry|
      outcome, trace = run_fixture_case(entry)
      assert_equal expected_fixture_outcome(entry), outcome, entry.fetch("caseId")
      assert_equal entry.fetch("rpcTrace"), trace, entry.fetch("caseId")
    end
  end

  def test_captures_native_dex_parity_only_when_output_is_configured
    output_path = ENV["ERPC_SDK_DEX_PARITY_OUTPUT"]
    return if output_path.nil? || output_path.empty?

    behavior = capture_lookup_behavior
    behavior["alias"] = capture_alias_behavior
    behavior["quote"] = SHARED_CASES.map do |entry|
      outcome, trace = run_fixture_case(entry)
      { "caseId" => entry.fetch("caseId"), "outcome" => outcome, "rpcTrace" => trace }
    end
    snapshot = {
      "snapshotVersion" => 1,
      "snapshotKind" => "native-runtime",
      "language" => "ruby",
      "runtime" => "ruby-native-#{RUBY_VERSION}",
      "metadata" => {
        "version" => ERPC::TokenCatalog::TOKEN_CATALOG_VERSION,
        "asOfDate" => ERPC::TokenCatalog::TOKEN_CATALOG_AS_OF_DATE,
        "contentDigest" => ERPC::TokenCatalog::TOKEN_CATALOG_CONTENT_DIGEST,
        "chainIds" => token_chain_ids_for_snapshot
      },
      "dexMetadata" => {
        "version" => ERPC::DexCatalog::DEX_CATALOG_VERSION,
        "asOfDate" => ERPC::DexCatalog::DEX_CATALOG_AS_OF_DATE,
        "contentDigest" => ERPC::DexCatalog::DEX_CATALOG_CONTENT_DIGEST
      },
      "dexDeployments" => ERPC::DexCatalog::DEX_DEPLOYMENTS.map { |value| record_dex(value) },
      "poolDefinitions" => ERPC::DexCatalog::POOL_DEFINITIONS.map { |value| record_pool(value) },
      "nativeWrapDefinitions" => ERPC::DexCatalog::NATIVE_WRAP_DEFINITIONS.map { |value| record_wrap(value) },
      "aliases" => ERPC::DexCatalog::DEX_ALIASES.map { |value| record_alias(value) },
      "behavior" => behavior
    }
    FileUtils.mkdir_p(File.dirname(output_path))
    File.write(output_path, JSON.pretty_generate(snapshot) + "\n")
    assert_operator File.size(output_path), :>, 0
  end

  private

  def set_fixture_clock(client, seconds)
    client.swap.instance_variable_set(:@clock, -> { seconds })
  end

  def expected_fixture_outcome(entry)
    expected = entry.fetch("outcome")
    return expected unless expected.fetch("kind") == "success" && expected.fetch("value").is_a?(Hash)

    expected.merge(
      "value" => expected.fetch("value").merge(
        "tokenCatalogDigest" => ERPC::TokenCatalog::TOKEN_CATALOG_CONTENT_DIGEST,
        "dexCatalogDigest" => ERPC::DexCatalog::DEX_CATALOG_CONTENT_DIGEST
      )
    )
  end

  def fixture_adapter(entry, trace)
    response_index = 0
    FakeHttpAdapter.new do |request|
      body = JSON.parse(request.fetch(:body))
      trace << { "method" => body.fetch("method"), "params" => body.fetch("params", []) }
      raise "upstream transport detail" if entry["mutation"] == "throwSourceError"

      result = entry.fetch("rpcResponses").fetch(response_index)
      response_index += 1
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate("jsonrpc" => "2.0", "id" => body.fetch("id"), "result" => result)
      )
    end
  end

  def run_fixture_case(entry)
    trace = []
    adapter = fixture_adapter(entry, trace)
    client = ERPC::Client.new(
      ERPC::ClientConfig.new(api_key: "capture-secret", endpoint: "https://example.test"),
      http_adapter: adapter
    )
    set_fixture_clock(client, entry.fetch("nowSeconds"))

    outcome = begin
      { "kind" => "success", "value" => client.swap.quote_exact_input(entry.fetch("request")) }
    rescue ERPC::SwapQuoteError => error
      { "kind" => "sdk-error", "code" => error.code }
    rescue StandardError
      { "kind" => "transport-error", "sourcePreserved" => true }
    end
    [outcome, trace]
  ensure
    client&.close
  end

  def assert_swap_code(request, expected, client)
    error = assert_raises(ERPC::SwapQuoteError) { client.swap.quote_exact_input(request) }
    assert_equal expected, error.code
  end

  def record_dex(value)
    {
      "dexDeploymentId" => value.fetch(:dex_deployment_id),
      "protocolId" => value.fetch(:protocol_id),
      "name" => value.fetch(:name),
      "chainId" => value.fetch(:chain_id),
      "programAddress" => value.fetch(:program_address),
      "adapterKind" => value.fetch(:adapter_kind),
      "status" => value.fetch(:status),
      "replacedByDexDeploymentId" => value.fetch(:replaced_by_dex_deployment_id)
    }
  end

  def record_pool(value)
    {
      "poolDefinitionId" => value.fetch(:pool_definition_id),
      "dexDeploymentId" => value.fetch(:dex_deployment_id),
      "chainId" => value.fetch(:chain_id),
      "address" => value.fetch(:address),
      "token0DeploymentId" => value.fetch(:token0_deployment_id),
      "token1DeploymentId" => value.fetch(:token1_deployment_id),
      "adapter" => {
        "kind" => value.fetch(:adapter).fetch(:kind),
        "feeNumerator" => value.fetch(:adapter).fetch(:fee_numerator),
        "feeDenominator" => value.fetch(:adapter).fetch(:fee_denominator)
      },
      "status" => value.fetch(:status),
      "replacedByPoolDefinitionId" => value.fetch(:replaced_by_pool_definition_id)
    }
  end

  def record_wrap(value)
    {
      "nativeWrapDefinitionId" => value.fetch(:native_wrap_definition_id),
      "chainId" => value.fetch(:chain_id),
      "nativeTokenDeploymentId" => value.fetch(:native_token_deployment_id),
      "wrappedTokenDeploymentId" => value.fetch(:wrapped_token_deployment_id),
      "status" => value.fetch(:status)
    }
  end

  def record_alias(value)
    {
      "namespace" => value.fetch(:namespace),
      "name" => value.fetch(:name),
      "dexDeploymentId" => value.fetch(:dex_deployment_id),
      "poolDefinitionId" => value.fetch(:pool_definition_id)
    }
  end

  def dex_chain_ids_for_snapshot
    {
      "ethereum" => ERPC::DexCatalog::DEX_CHAIN_IDS.fetch(:ethereum),
      "solana" => ERPC::DexCatalog::DEX_CHAIN_IDS.fetch(:solana),
      "avalancheC" => ERPC::DexCatalog::DEX_CHAIN_IDS.fetch(:avalanche_c)
    }
  end

  def capture_lookup_behavior
    behavior = {
      "getDexDeployment" => [],
      "getPoolDefinition" => [],
      "findPoolDefinitionByAddress" => [],
      "findPoolDefinitionsByPair" => [],
      "listPoolDefinitions" => [],
      "getNativeWrapDefinition" => []
    }
    ERPC::DexCatalog::DEX_DEPLOYMENTS.each do |deployment|
      input = deployment.fetch(:dex_deployment_id)
      value = ERPC::DexCatalog.get_dex_deployment(input)
      behavior.fetch("getDexDeployment") << { "input" => input, "result" => value&.fetch(:dex_deployment_id) }
    end
    unknown_dex = ERPC::DexCatalog.get_dex_deployment("dex-unknown")
    behavior.fetch("getDexDeployment") << { "input" => "dex-unknown", "result" => unknown_dex&.fetch(:dex_deployment_id) }

    ERPC::DexCatalog::POOL_DEFINITIONS.each do |pool|
      input = pool.fetch(:pool_definition_id)
      value = ERPC::DexCatalog.get_pool_definition(input)
      behavior.fetch("getPoolDefinition") << { "input" => input, "result" => value&.fetch(:pool_definition_id) }
    end
    unknown_pool = ERPC::DexCatalog.get_pool_definition("pool-unknown")
    behavior.fetch("getPoolDefinition") << { "input" => "pool-unknown", "result" => unknown_pool&.fetch(:pool_definition_id) }

    ERPC::DexCatalog::POOL_DEFINITIONS.each do |pool|
      chain_id = pool.fetch(:chain_id)
      address = pool.fetch(:address)
      value = ERPC::DexCatalog.find_pool_definition_by_address(chain_id, address)
      behavior.fetch("findPoolDefinitionByAddress") << {
        "chainId" => chain_id,
        "address" => address,
        "result" => value&.fetch(:pool_definition_id)
      }
      next unless chain_id.start_with?("eip155:")

      uppercase = "0x#{address[2..].upcase}"
      value = ERPC::DexCatalog.find_pool_definition_by_address(chain_id, uppercase)
      behavior.fetch("findPoolDefinitionByAddress") << {
        "chainId" => chain_id,
        "address" => uppercase,
        "result" => value&.fetch(:pool_definition_id)
      }
    end
    invalid_addresses = [
      [ETHEREUM_CHAIN_ID, "0x#{'0' * 40}"],
      [ETHEREUM_CHAIN_ID, "not-an-address"],
      ["unknown:chain", "0x#{'0' * 39}1"]
    ]
    invalid_addresses.each do |chain_id, address|
      value = ERPC::DexCatalog.find_pool_definition_by_address(chain_id, address)
      behavior.fetch("findPoolDefinitionByAddress") << {
        "chainId" => chain_id,
        "address" => address,
        "result" => value&.fetch(:pool_definition_id)
      }
    end

    ERPC::DexCatalog::POOL_DEFINITIONS.each do |pool|
      token0 = pool.fetch(:token0_deployment_id)
      token1 = pool.fetch(:token1_deployment_id)
      [
        [token0, token1],
        [token1, token0]
      ].each do |left, right|
        value = ERPC::DexCatalog.find_pool_definitions_by_pair(pool.fetch(:chain_id), left, right)
        behavior.fetch("findPoolDefinitionsByPair") << {
          "chainId" => pool.fetch(:chain_id),
          "token0DeploymentId" => left,
          "token1DeploymentId" => right,
          "result" => value.map { |item| item.fetch(:pool_definition_id) }
        }
      end
    end
    invalid_pairs = [
      [ETHEREUM_CHAIN_ID, "deployment-0001", "deployment-0003"],
      ["unknown:chain", "deployment-0002", "deployment-0008"]
    ]
    invalid_pairs.each do |chain_id, token0, token1|
      values = ERPC::DexCatalog.find_pool_definitions_by_pair(chain_id, token0, token1)
      behavior.fetch("findPoolDefinitionsByPair") << {
        "chainId" => chain_id,
        "token0DeploymentId" => token0,
        "token1DeploymentId" => token1,
        "result" => values.map { |value| value.fetch(:pool_definition_id) }
      }
    end

    filters = [{}]
    filters.concat(dex_chain_ids_for_snapshot.values.map { |chain_id| { "chainId" => chain_id } })
    filters.concat(ERPC::DexCatalog::POOL_DEFINITIONS.flat_map do |pool|
      [
        { "tokenDeploymentId" => pool.fetch(:token0_deployment_id) },
        { "tokenDeploymentId" => pool.fetch(:token1_deployment_id) }
      ]
    end)
    adapters = ERPC::DexCatalog::POOL_DEFINITIONS.map { |pool| pool.fetch(:adapter).fetch(:kind) }.uniq
    filters.concat(adapters.map { |kind| { "adapterKind" => kind } })
    filters.concat(ERPC::DexCatalog::POOL_DEFINITIONS.map do |pool|
      {
        "chainId" => pool.fetch(:chain_id),
        "tokenDeploymentId" => pool.fetch(:token0_deployment_id),
        "adapterKind" => pool.fetch(:adapter).fetch(:kind)
      }
    end)
    filters.concat([
      { "chainId" => "unknown:chain" },
      { "tokenDeploymentId" => "deployment-unknown" },
      { "adapterKind" => "unknown-adapter" }
    ])
    filters.each do |filter|
      values = ERPC::DexCatalog.list_pool_definitions(filter)
      behavior.fetch("listPoolDefinitions") << {
        "filter" => filter,
        "result" => values.map { |value| value.fetch(:pool_definition_id) }
      }
    end

    ERPC::TokenCatalog::TOKEN_DEPLOYMENTS.each do |deployment|
      next unless deployment.fetch(:standard) == "native"

      input = deployment.fetch(:deployment_id)
      value = ERPC::DexCatalog.get_native_wrap_definition(input)
      behavior.fetch("getNativeWrapDefinition") << {
        "input" => input,
        "result" => value&.fetch(:native_wrap_definition_id)
      }
    end
    ["deployment-unknown", "native-wrap-0001"].each do |input|
      value = ERPC::DexCatalog.get_native_wrap_definition(input)
      behavior.fetch("getNativeWrapDefinition") << {
        "input" => input,
        "result" => value&.fetch(:native_wrap_definition_id)
      }
    end
    behavior
  end

  def token_chain_ids_for_snapshot
    {
      "ethereum" => ERPC::TokenCatalog::TOKEN_CHAIN_IDS.fetch(:ethereum),
      "solana" => ERPC::TokenCatalog::TOKEN_CHAIN_IDS.fetch(:solana),
      "avalancheC" => ERPC::TokenCatalog::TOKEN_CHAIN_IDS.fetch(:avalanche_c)
    }
  end

  def capture_alias_behavior
    ERPC::DexCatalog::DEX_ALIASES.map do |alias_value|
      namespace = alias_value.fetch(:namespace)
      name = alias_value.fetch(:name)
      dex_id = alias_value.fetch(:dex_deployment_id)
      group = dex_id.nil? ? ERPC::Pools : ERPC::Dexes
      group_name = namespace == "avalancheC" ? :AvalancheC : namespace.to_sym.capitalize
      group_hash = group.const_get(group_name)
      result = group_hash[name.to_sym]
      {
        "namespace" => namespace,
        "name" => name,
        "kind" => dex_id.nil? ? "pool" : "dex",
        "result" => result
      }
    end
  end
end
