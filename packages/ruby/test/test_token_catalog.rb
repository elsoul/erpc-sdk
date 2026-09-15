# frozen_string_literal: true

require_relative "test_helper"

class TokenCatalogTest < Minitest::Test
  ETHEREUM = ERPC::TokenChainIDs::ETHEREUM_MAINNET
  SOLANA = ERPC::TokenChainIDs::SOLANA_MAINNET
  AVALANCHE_C = ERPC::TokenChainIDs::AVALANCHE_C_MAINNET

  DEPLOYMENT_KEYS = %i[
    deployment_id asset_id name representation_kind stable_currency
    underlying_asset_id economic_reference_asset_id chain_id symbol decimals
    standard address status replaced_by_deployment_id
  ].freeze

  ASSET_KEYS = %i[
    asset_id name representation_kind stable_currency underlying_asset_id
    economic_reference_asset_id
  ].freeze

  def test_exports_generated_metadata_chain_constants_and_alias_ids
    assert_equal "1.0.0", ERPC::TokenCatalog::TOKEN_CATALOG_VERSION
    assert_equal "2026-09-15", ERPC::TokenCatalog::AS_OF_DATE
    assert_match(/\A[0-9a-f]{64}\z/, ERPC::TokenCatalog::CONTENT_DIGEST)
    assert_equal ETHEREUM, ERPC::TokenCatalog::TOKEN_CHAIN_IDS.fetch(:ethereum)
    assert_equal SOLANA, ERPC::TokenCatalog::TOKEN_CHAIN_IDS.fetch(:solana)
    assert_equal AVALANCHE_C, ERPC::TokenCatalog::TOKEN_CHAIN_IDS.fetch(:avalanche_c)

    assert ERPC::TokenCatalog::TOKEN_CHAIN_IDS.frozen?
    assert ERPC::Tokens::Ethereum.frozen?
    assert ERPC::Tokens::Solana.frozen?
    assert ERPC::Tokens::AvalancheC.frozen?
    assert_equal ERPC::TokenCatalog::TOKEN_DEPLOYMENTS.map { |deployment| deployment.fetch(:deployment_id) }.sort,
                 ERPC::TokenCatalog::TOKEN_ALIASES.map { |alias_record| alias_record.fetch(:deployment_id) }.sort

    {
      ethereum: ERPC::Tokens::Ethereum,
      solana: ERPC::Tokens::Solana,
      avalanche_c: ERPC::Tokens::AvalancheC
    }.each_value do |aliases|
      aliases.each_value do |deployment_id|
        assert_instance_of String, deployment_id
        assert ERPC::TokenCatalog.get_token_deployment(deployment_id)
      end
    end
  end

  def test_cross_links_complete_flattened_asset_and_deployment_records
    assert_equal 39, ERPC::TokenCatalog::TOKEN_ASSETS.length
    assert_equal 60, ERPC::TokenCatalog::TOKEN_DEPLOYMENTS.length
    assert_equal 60, ERPC::TokenCatalog::TOKEN_ALIASES.length

    ERPC::TokenCatalog::TOKEN_ASSETS.each do |asset|
      assert_equal ASSET_KEYS.sort, asset.keys.sort
      assert_same asset, ERPC::TokenCatalog.get_token_asset(asset.fetch(:asset_id))
      assert_deeply_frozen(asset)
    end

    ERPC::TokenCatalog::TOKEN_DEPLOYMENTS.each do |deployment|
      assert_equal DEPLOYMENT_KEYS.sort, deployment.keys.sort
      assert_same deployment, ERPC::TokenCatalog.get_token_deployment(deployment.fetch(:deployment_id))
      asset = ERPC::TokenCatalog.get_token_asset(deployment.fetch(:asset_id))
      refute_nil asset
      assert_equal asset.fetch(:name), deployment.fetch(:name)
      assert_equal asset.fetch(:representation_kind), deployment.fetch(:representation_kind)
      assert_matching_nullable_field asset, deployment, :stable_currency
      assert_matching_nullable_field asset, deployment, :underlying_asset_id
      assert_matching_nullable_field asset, deployment, :economic_reference_asset_id
      assert_deeply_frozen(deployment)
    end
  end

  def test_chain_usdc_native_wrapped_bridged_and_symbol_edge_cases
    [ETHEREUM, SOLANA, AVALANCHE_C].each do |chain_id|
      usdc = ERPC::TokenCatalog.find_token_deployments_by_symbol(chain_id, "USDC")
      refute_empty usdc
      assert usdc.all? { |deployment| deployment.fetch(:chain_id) == chain_id && deployment.fetch(:symbol) == "USDC" }

      native = ERPC::TokenCatalog.get_native_token_deployment(chain_id)
      refute_nil native
      assert_equal chain_id, native.fetch(:chain_id)
      assert_equal "native", native.fetch(:standard)
      assert_nil native.fetch(:address)
      assert_nil ERPC::TokenCatalog.find_token_deployment_by_address(chain_id, "")
      assert_nil ERPC::TokenCatalog.find_token_deployment_by_address(chain_id, nil)
    end

    wrapped = ERPC::TokenCatalog.list_token_deployments.select { |deployment| deployment.fetch(:representation_kind) == "wrapped" }
    bridged = ERPC::TokenCatalog.list_token_deployments.select { |deployment| deployment.fetch(:representation_kind) == "bridged" }
    refute_empty wrapped
    refute_empty bridged

    eu_re = ERPC::TokenCatalog.find_token_deployments_by_symbol(ETHEREUM, "EURe")
    assert_operator eu_re.length, :>=, 2
    assert_equal eu_re.map { |deployment| deployment.fetch(:deployment_id) }.sort,
                 eu_re.map { |deployment| deployment.fetch(:deployment_id) }
    assert_empty ERPC::TokenCatalog.find_token_deployments_by_symbol(ETHEREUM, "eure")

    wsol = ERPC::TokenCatalog.find_token_deployments_by_symbol(SOLANA, "WSOL")
    assert_equal %w[spl-token spl-token-2022].sort, wsol.map { |deployment| deployment.fetch(:standard) }.sort

    eurcv_eth = ERPC::TokenCatalog.find_token_deployments_by_symbol(ETHEREUM, "EURCV").find { |deployment| deployment.fetch(:decimals) == 18 }
    eurcv_solana = ERPC::TokenCatalog.find_token_deployments_by_symbol(SOLANA, "EURCV").find { |deployment| deployment.fetch(:decimals) == 2 }
    refute_nil eurcv_eth
    refute_nil eurcv_solana
    assert_equal eurcv_eth.fetch(:asset_id), eurcv_solana.fetch(:asset_id)
  end

  def test_lists_filters_every_lifecycle_status_and_returns_frozen_arrays
    all = ERPC::TokenCatalog.list_token_deployments
    assert_equal ERPC::TokenCatalog::TOKEN_DEPLOYMENTS.length, all.length
    assert all.frozen?
    assert_equal %w[active legacy retired winding-down].sort,
                 all.map { |deployment| deployment.fetch(:status) }.uniq.sort

    %w[USD EUR JPY].each do |currency|
      filtered = ERPC::TokenCatalog.list_token_deployments(stable_currency: currency)
      refute_empty filtered
      assert filtered.frozen?
      assert filtered.all? { |deployment| deployment.fetch(:stable_currency) == currency }
    end

    solana_eur = ERPC::TokenCatalog.list_token_deployments(chain_id: SOLANA, stable_currency: "EUR")
    refute_empty solana_eur
    assert solana_eur.all? { |deployment| deployment.fetch(:chain_id) == SOLANA && deployment.fetch(:stable_currency) == "EUR" }
    assert_equal solana_eur, ERPC::TokenCatalog.list_token_deployments(SOLANA, "EUR")

    assert_empty ERPC::TokenCatalog.list_token_deployments(chain_id: "eip155:999")
    assert_empty ERPC::TokenCatalog.list_token_deployments(stable_currency: "GBP")
    assert_empty ERPC::TokenCatalog.list_token_deployments(chain_id: 1)
    assert_empty ERPC::TokenCatalog.list_token_deployments(stable_currency: :USD)
  end

  def test_address_lookup_is_strict_case_insensitive_for_evm_and_exact_for_solana
    evm = ERPC::TokenCatalog::TOKEN_DEPLOYMENTS.find do |deployment|
      deployment.fetch(:chain_id) == ETHEREUM && deployment[:address].is_a?(String)
    end
    solana = ERPC::TokenCatalog::TOKEN_DEPLOYMENTS.find do |deployment|
      deployment.fetch(:chain_id) == SOLANA && deployment[:address].is_a?(String)
    end
    refute_nil evm
    refute_nil solana

    mixed_case = "0x#{evm.fetch(:address).byteslice(2, 40).upcase}"
    assert_same evm, ERPC::TokenCatalog.find_token_deployment_by_address(ETHEREUM, mixed_case)
    assert_nil ERPC::TokenCatalog.find_token_deployment_by_address(ETHEREUM, "0X#{evm.fetch(:address).byteslice(2, 40)}")
    assert_nil ERPC::TokenCatalog.find_token_deployment_by_address(ETHEREUM, "0x1234")
    assert_nil ERPC::TokenCatalog.find_token_deployment_by_address(ETHEREUM, "0x#{"0" * 40}")
    assert_nil ERPC::TokenCatalog.find_token_deployment_by_address(ETHEREUM, "0x#{"g" * 40}")
    assert_nil ERPC::TokenCatalog.find_token_deployment_by_address(ETHEREUM, "0x#{"０" * 40}")

    assert_same solana, ERPC::TokenCatalog.find_token_deployment_by_address(SOLANA, solana.fetch(:address))
    mutated = solana.fetch(:address).dup
    mutated[-1] = mutated.end_with?("1") ? "2" : "1"
    assert_nil ERPC::TokenCatalog.find_token_deployment_by_address(SOLANA, mutated)
    assert_nil ERPC::TokenCatalog.find_token_deployment_by_address(SOLANA, evm.fetch(:address))
  end

  def test_unknown_ids_wrong_types_and_opaque_values_do_not_match
    assert_nil ERPC::TokenCatalog.get_token_asset(nil)
    assert_nil ERPC::TokenCatalog.get_token_asset(1)
    assert_nil ERPC::TokenCatalog.get_token_asset("")
    assert_nil ERPC::TokenCatalog.get_token_deployment(nil)
    assert_nil ERPC::TokenCatalog.get_token_deployment(Object.new)
    assert_nil ERPC::TokenCatalog.get_token_deployment("")

    first = ERPC::TokenCatalog::TOKEN_DEPLOYMENTS.first
    refute_nil first
    assert_nil ERPC::TokenCatalog.get_token_deployment("#{first.fetch(:deployment_id)}:extra")
    assert_empty ERPC::TokenCatalog.find_token_deployments_by_symbol("eip155:999", first.fetch(:symbol))
    assert_empty ERPC::TokenCatalog.find_token_deployments_by_symbol(ETHEREUM, "")
    assert_empty ERPC::TokenCatalog.find_token_deployments_by_symbol(ETHEREUM, :USDC)
    assert_nil ERPC::TokenCatalog.find_token_deployment_by_address("eip155:999", "0x1234")
    assert_nil ERPC::TokenCatalog.find_token_deployment_by_address(ETHEREUM, false)
    assert_nil ERPC::TokenCatalog.get_native_token_deployment("eip155:999")
  end

  def test_all_reachable_catalog_values_are_frozen_and_mutations_cannot_change_future_reads
    assert_deeply_frozen(ERPC::TokenCatalog::TOKEN_CHAIN_IDS)
    assert_deeply_frozen(ERPC::TokenCatalog::TOKEN_ASSETS)
    assert_deeply_frozen(ERPC::TokenCatalog::TOKEN_DEPLOYMENTS)
    assert_deeply_frozen(ERPC::TokenCatalog::TOKEN_ALIASES)
    assert_deeply_frozen(ERPC::Tokens::Ethereum)
    assert_deeply_frozen(ERPC::Tokens::Solana)
    assert_deeply_frozen(ERPC::Tokens::AvalancheC)

    asset = ERPC::TokenCatalog::TOKEN_ASSETS.first
    deployment = ERPC::TokenCatalog::TOKEN_DEPLOYMENTS.first
    refute_nil asset
    refute_nil deployment
    assert_raises(FrozenError) { asset[:name] = "MUTATED" }
    assert_raises(FrozenError) { deployment[:symbol] = "MUTATED" }
    assert_raises(FrozenError) { ERPC::TokenCatalog.list_token_deployments << deployment }
    assert_equal asset, ERPC::TokenCatalog.get_token_asset(asset.fetch(:asset_id))
    assert_equal deployment, ERPC::TokenCatalog.get_token_deployment(deployment.fetch(:deployment_id))

    assert_raises(FrozenError) { ERPC::Tokens::Ethereum[:USDC] = "MUTATED" }
    assert_equal ERPC::TokenCatalog::TOKEN_DEPLOYMENTS.find { |entry| entry.fetch(:deployment_id) == ERPC::Tokens::Ethereum.fetch(:USDC) },
                 ERPC::TokenCatalog.get_token_deployment(ERPC::Tokens::Ethereum.fetch(:USDC))
  end

  private

  def assert_matching_nullable_field(asset, deployment, key)
    expected = asset.fetch(key)
    if expected.nil?
      assert_nil deployment.fetch(key)
    else
      assert_equal expected, deployment.fetch(key)
    end
  end

  def assert_deeply_frozen(value)
    assert value.frozen?, "expected #{value.inspect} to be frozen"
    case value
    when Hash
      value.each { |key, child| assert_deeply_frozen(key); assert_deeply_frozen(child) }
    when Array
      value.each { |child| assert_deeply_frozen(child) }
    end
  end
end
