# frozen_string_literal: true

require_relative "test_helper"

class DexCatalogTest < Minitest::Test
  def test_catalog_contains_the_four_deployments_and_four_pools
    assert_equal 4, ERPC::DexCatalog::DEX_DEPLOYMENTS.length
    assert_equal 4, ERPC::DexCatalog::POOL_DEFINITIONS.length
    assert_equal 3, ERPC::DexCatalog::NATIVE_WRAP_DEFINITIONS.length
    assert_equal 8, ERPC::DexCatalog::DEX_ALIASES.length
    assert_equal "dex-deployment-0001", ERPC::Dexes::Ethereum.fetch(:UNISWAP_V2)
    assert_equal "pool-0003", ERPC::Pools::Solana.fetch(:ORCA_WHIRLPOOLS_WSOL_EURC)
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
    assert_equal %w[pool-0003 pool-0004], forward.map { |value| value.fetch(:pool_definition_id) }
    assert_equal forward.map { |value| value.fetch(:pool_definition_id) }, reverse.map { |value| value.fetch(:pool_definition_id) }
    assert_equal [], ERPC::DexCatalog.find_pool_definitions_by_pair(
      ERPC::DexChainIDs::ETHEREUM_MAINNET,
      "deployment-0001",
      "deployment-0003"
    )
  end

  def test_filters_and_native_wrap_lookup_keep_lifecycle_records_visible
    assert_equal %w[pool-0001], ERPC::DexCatalog.list_pool_definitions(
      chainId: ERPC::DexChainIDs::ETHEREUM_MAINNET,
      tokenDeploymentId: "deployment-0002",
      adapterKind: "evm-constant-product-v2"
    ).map { |value| value.fetch(:pool_definition_id) }
    assert_equal %w[pool-0003 pool-0004], ERPC::DexCatalog.list_pool_definitions(
      { "chainId" => ERPC::DexChainIDs::SOLANA_MAINNET }
    ).map { |value| value.fetch(:pool_definition_id) }
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
