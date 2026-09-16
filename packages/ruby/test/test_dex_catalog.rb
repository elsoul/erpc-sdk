# frozen_string_literal: true

require_relative "test_helper"

class DexCatalogTest < Minitest::Test
  def test_catalog_contains_seed_deployments_and_pools
    refute_empty ERPC::DexCatalog::DEX_DEPLOYMENTS
    refute_empty ERPC::DexCatalog::POOL_DEFINITIONS
    refute_empty ERPC::DexCatalog::NATIVE_WRAP_DEFINITIONS
    refute_empty ERPC::DexCatalog::DEX_ALIASES
    assert_equal "dex-deployment-0001", ERPC::Dexes::Ethereum.fetch(:UNISWAP_V2)
    assert_equal "pool-0003", ERPC::Pools::Solana.fetch(:ORCA_WHIRLPOOLS_WSOL_EURC)
  end

  def test_every_catalog_alias_points_to_its_compiled_constant
    ERPC::DexCatalog::DEX_ALIASES.each do |alias_record|
      namespace = alias_record.fetch(:namespace)
      group = alias_record.fetch(:dex_deployment_id).nil? ? ERPC::Pools : ERPC::Dexes
      group_name = namespace == "avalancheC" ? :AvalancheC : namespace.to_sym.capitalize
      compiled = group.const_get(group_name)
      alias_name = alias_record.fetch(:name).to_sym

      assert compiled.frozen?
      assert compiled.key?(alias_name)
      expected = alias_record.fetch(:dex_deployment_id) || alias_record.fetch(:pool_definition_id)
      assert_equal expected, compiled.fetch(alias_name)
    end
  end

  def test_lookups_are_offline_and_pair_order_is_unordered
    pool = ERPC::DexCatalog.get_pool_definition("pool-0001")
    assert_equal "pool-0001", pool.fetch(:pool_definition_id)
    assert_nil ERPC::DexCatalog.get_pool_definition("POOL-0001")
    assert_equal "pool-0001", ERPC::DexCatalog.find_pool_definition_by_address(
      ERPC::DexChainIDs::ETHEREUM_MAINNET,
      "0x#{pool.fetch(:address)[2..].upcase}"
    ).fetch(:pool_definition_id)

    forward = ERPC::DexCatalog.find_pool_definitions_by_pair(
      ERPC::DexChainIDs::SOLANA_MAINNET,
      "deployment-0006",
      "deployment-0013"
    )
    reverse = ERPC::DexCatalog.find_pool_definitions_by_pair(
      ERPC::DexChainIDs::SOLANA_MAINNET,
      "deployment-0013",
      "deployment-0006"
    )
    solana_pair_ids = ERPC::DexCatalog::POOL_DEFINITIONS.select do |pool|
      pool.fetch(:chain_id) == ERPC::DexChainIDs::SOLANA_MAINNET &&
        [pool.fetch(:token0_deployment_id), pool.fetch(:token1_deployment_id)].sort ==
          %w[deployment-0006 deployment-0013]
    end.map { |pool| pool.fetch(:pool_definition_id) }
    forward_ids = forward.map { |value| value.fetch(:pool_definition_id) }
    assert_equal solana_pair_ids, forward_ids
    assert_includes forward_ids, "pool-0003"
    assert_includes forward_ids, "pool-0004"
    assert_equal forward_ids, reverse.map { |value| value.fetch(:pool_definition_id) }
    assert_equal [], ERPC::DexCatalog.find_pool_definitions_by_pair(
      ERPC::DexChainIDs::ETHEREUM_MAINNET,
      "deployment-0001",
      "deployment-0003"
    )
  end

  def test_filters_and_native_wrap_lookup_keep_lifecycle_records_visible
    filtered = ERPC::DexCatalog::POOL_DEFINITIONS.select do |pool|
      pool.fetch(:chain_id) == ERPC::DexChainIDs::ETHEREUM_MAINNET &&
        [pool.fetch(:token0_deployment_id), pool.fetch(:token1_deployment_id)].include?("deployment-0002") &&
        pool.fetch(:adapter).fetch(:kind) == "evm-constant-product-v2"
    end.map { |pool| pool.fetch(:pool_definition_id) }
    ethereum_pools = ERPC::DexCatalog.list_pool_definitions(
      chainId: ERPC::DexChainIDs::ETHEREUM_MAINNET,
      tokenDeploymentId: "deployment-0002",
      adapterKind: "evm-constant-product-v2"
    ).map { |value| value.fetch(:pool_definition_id) }
    assert_equal filtered, ethereum_pools
    assert_includes ethereum_pools, "pool-0001"
    solana_pool_ids = ERPC::DexCatalog::POOL_DEFINITIONS.select do |pool|
      pool.fetch(:chain_id) == ERPC::DexChainIDs::SOLANA_MAINNET
    end.map { |pool| pool.fetch(:pool_definition_id) }
    listed_solana_pool_ids = ERPC::DexCatalog.list_pool_definitions(
      { "chainId" => ERPC::DexChainIDs::SOLANA_MAINNET }
    ).map { |value| value.fetch(:pool_definition_id) }
    assert_equal solana_pool_ids, listed_solana_pool_ids
    assert_includes listed_solana_pool_ids, "pool-0003"
    assert_includes listed_solana_pool_ids, "pool-0004"
    assert_empty ERPC::DexCatalog.list_pool_definitions({ "unknown" => "value" })

    wrap = ERPC::DexCatalog.get_native_wrap_definition("deployment-0005")
    assert_equal "native-wrap-0003", wrap.fetch(:native_wrap_definition_id)
    assert_nil ERPC::DexCatalog.get_native_wrap_definition("native-wrap-0001")
  end

  def test_returned_catalog_records_and_aliases_are_immutable
    pool = ERPC::DexCatalog.get_pool_definition("pool-0001")
    assert pool.frozen?
    assert pool.fetch(:adapter).frozen?
    assert_raises(FrozenError) { pool.fetch(:adapter)[:kind] = "changed" }
    assert_equal "evm-constant-product-v2",
                 ERPC::DexCatalog.get_pool_definition("pool-0001").fetch(:adapter).fetch(:kind)
    assert ERPC::Dexes::Ethereum.frozen?
    assert ERPC::Pools::Solana.frozen?
  end
end
