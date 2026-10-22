# frozen_string_literal: true

require_relative "test_helper"
require "fileutils"

class TokenCatalogTest < Minitest::Test
  ETHEREUM = ERPC::TokenChainIDs::ETHEREUM_MAINNET
  SOLANA = ERPC::TokenChainIDs::SOLANA_MAINNET
  AVALANCHE_C = ERPC::TokenChainIDs::AVALANCHE_C_MAINNET
  BASE = ERPC::TokenChainIDs::BASE_MAINNET

  CHAIN_IDS = [ETHEREUM, SOLANA, AVALANCHE_C, BASE].freeze

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
    assert_match(/\A\d+\.\d+\.\d+\z/, ERPC::TokenCatalog::TOKEN_CATALOG_VERSION)
    assert_match(/\A\d{4}-\d{2}-\d{2}\z/, ERPC::TokenCatalog::AS_OF_DATE)
    assert_match(/\A[0-9a-f]{64}\z/, ERPC::TokenCatalog::CONTENT_DIGEST)
    assert_equal ETHEREUM, ERPC::TokenCatalog::TOKEN_CHAIN_IDS.fetch(:ethereum)
    assert_equal SOLANA, ERPC::TokenCatalog::TOKEN_CHAIN_IDS.fetch(:solana)
    assert_equal AVALANCHE_C, ERPC::TokenCatalog::TOKEN_CHAIN_IDS.fetch(:avalanche_c)
    assert_equal BASE, ERPC::TokenCatalog::TOKEN_CHAIN_IDS.fetch(:base)

    assert ERPC::TokenCatalog::TOKEN_CHAIN_IDS.frozen?
    assert ERPC::Tokens::Ethereum.frozen?
    assert ERPC::Tokens::Solana.frozen?
    assert ERPC::Tokens::AvalancheC.frozen?
    assert ERPC::Tokens::Base.frozen?
    assert_equal ERPC::TokenCatalog::TOKEN_DEPLOYMENTS.map { |deployment| deployment.fetch(:deployment_id) }.sort,
                 ERPC::TokenCatalog::TOKEN_ALIASES.map { |alias_record| alias_record.fetch(:deployment_id) }.sort

    {
      ethereum: ERPC::Tokens::Ethereum,
      solana: ERPC::Tokens::Solana,
      avalanche_c: ERPC::Tokens::AvalancheC,
      base: ERPC::Tokens::Base
    }.each_value do |aliases|
      aliases.each_value do |deployment_id|
        assert_instance_of String, deployment_id
        assert ERPC::TokenCatalog.get_token_deployment(deployment_id)
      end
    end

    ERPC::TokenCatalog::TOKEN_ALIASES.each do |alias_record|
      group_name = alias_record.fetch(:namespace) == "avalancheC" ? :AvalancheC : alias_record.fetch(:namespace).to_sym.capitalize
      compiled = ERPC::Tokens.const_get(group_name)
      assert_equal alias_record.fetch(:deployment_id), compiled.fetch(alias_record.fetch(:name).to_sym)
    end
  end

  def test_cross_links_complete_flattened_asset_and_deployment_records
    refute_empty ERPC::TokenCatalog::TOKEN_ASSETS
    refute_empty ERPC::TokenCatalog::TOKEN_DEPLOYMENTS
    assert_equal 49, ERPC::TokenCatalog::TOKEN_ASSETS.length
    assert_equal 73, ERPC::TokenCatalog::TOKEN_DEPLOYMENTS.length
    assert_equal 73, ERPC::TokenCatalog::TOKEN_ALIASES.length
    assert_equal ERPC::TokenCatalog::TOKEN_DEPLOYMENTS.length,
                 ERPC::TokenCatalog::TOKEN_ALIASES.length

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
    CHAIN_IDS.each do |chain_id|
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

  def test_base_records_keep_ids_decimals_aliases_and_evm_lookup_normalization
    base_eth = ERPC::TokenCatalog.get_token_deployment(ERPC::Tokens::Base.fetch(:ETH))
    base_usdc = ERPC::TokenCatalog.get_token_deployment(ERPC::Tokens::Base.fetch(:USDC))
    base_eurc = ERPC::TokenCatalog.get_token_deployment(ERPC::Tokens::Base.fetch(:EURC))

    refute_nil base_eth
    refute_nil base_usdc
    refute_nil base_eurc

    assert_equal %w[deployment-0061 deployment-0062 deployment-0063],
                 ERPC::TokenCatalog.list_token_deployments(BASE).map { |deployment| deployment.fetch(:deployment_id) }

    assert_equal "deployment-0061", base_eth.fetch(:deployment_id)
    assert_equal "asset-0001", base_eth.fetch(:asset_id)
    assert_equal "ETH", base_eth.fetch(:symbol)
    assert_equal 18, base_eth.fetch(:decimals)
    assert_equal "native", base_eth.fetch(:standard)
    assert_nil base_eth.fetch(:address)
    assert_same base_eth, ERPC::TokenCatalog.get_native_token_deployment(BASE)

    assert_equal "deployment-0062", base_usdc.fetch(:deployment_id)
    assert_equal "asset-0007", base_usdc.fetch(:asset_id)
    assert_equal "USDC", base_usdc.fetch(:symbol)
    assert_equal 6, base_usdc.fetch(:decimals)
    assert_equal "erc20", base_usdc.fetch(:standard)
    assert_equal "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", base_usdc.fetch(:address)

    assert_equal "deployment-0063", base_eurc.fetch(:deployment_id)
    assert_equal "asset-0008", base_eurc.fetch(:asset_id)
    assert_equal "EURC", base_eurc.fetch(:symbol)
    assert_equal 6, base_eurc.fetch(:decimals)
    assert_equal "erc20", base_eurc.fetch(:standard)
    assert_equal "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", base_eurc.fetch(:address)

    assert_equal %w[ETH EURC USDC], ERPC::Tokens::Base.keys.map(&:to_s).sort
    ERPC::Tokens::Base.each do |name, deployment_id|
      alias_record = ERPC::TokenCatalog::TOKEN_ALIASES.find do |candidate|
        candidate.fetch(:namespace) == "base" && candidate.fetch(:name) == name.to_s
      end
      refute_nil alias_record
      assert_equal deployment_id, alias_record.fetch(:deployment_id)
    end

    [base_usdc, base_eurc].each do |deployment|
      address = deployment.fetch(:address)
      mixed_case = "0x#{address.byteslice(2, 40).chars.each_with_index.map { |character, index| index.even? ? character.upcase : character.downcase }.join}"
      assert_same deployment, ERPC::TokenCatalog.find_token_deployment_by_address(BASE, mixed_case)
    end

    assert_nil ERPC::TokenCatalog.find_token_deployment_by_address(BASE, nil)
    assert_nil ERPC::TokenCatalog.find_token_deployment_by_address(BASE, "")
    assert_nil ERPC::TokenCatalog.find_token_deployment_by_address(BASE, "0x#{"0" * 40}")
    assert_nil ERPC::TokenCatalog.find_token_deployment_by_address(BASE, base_eth.fetch(:address))
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
    assert_deeply_frozen(ERPC::Tokens::Base)

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

  def test_captures_native_token_parity_when_requested
    output_path = ENV["ERPC_SDK_TOKEN_CATALOG_PARITY_OUTPUT"]
    return if output_path.nil? || output_path.empty?

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
      "assets" => ERPC::TokenCatalog::TOKEN_ASSETS.map { |asset| runtime_asset(asset) },
      "deployments" => ERPC::TokenCatalog::TOKEN_DEPLOYMENTS.map { |deployment| runtime_deployment(deployment) },
      "aliases" => ERPC::TokenCatalog::TOKEN_ALIASES.map { |alias_record| runtime_alias(alias_record) },
      "behavior" => token_catalog_capture_behavior
    }

    FileUtils.mkdir_p(File.dirname(output_path))
    File.write(output_path, JSON.pretty_generate(snapshot) + "\n")
    assert_operator File.size(output_path), :>, 0
  end

  private

  def token_chain_ids_for_snapshot
    {
      "ethereum" => ETHEREUM,
      "solana" => SOLANA,
      "avalancheC" => AVALANCHE_C,
      "base" => BASE
    }
  end

  def runtime_asset(asset)
    {
      "assetId" => asset.fetch(:asset_id),
      "name" => asset.fetch(:name),
      "representationKind" => asset.fetch(:representation_kind),
      "stableCurrency" => asset.fetch(:stable_currency),
      "underlyingAssetId" => asset.fetch(:underlying_asset_id),
      "economicReferenceAssetId" => asset.fetch(:economic_reference_asset_id)
    }
  end

  def runtime_deployment(deployment)
    {
      "deploymentId" => deployment.fetch(:deployment_id),
      "assetId" => deployment.fetch(:asset_id),
      "name" => deployment.fetch(:name),
      "representationKind" => deployment.fetch(:representation_kind),
      "stableCurrency" => deployment.fetch(:stable_currency),
      "underlyingAssetId" => deployment.fetch(:underlying_asset_id),
      "economicReferenceAssetId" => deployment.fetch(:economic_reference_asset_id),
      "chainId" => deployment.fetch(:chain_id),
      "symbol" => deployment.fetch(:symbol),
      "decimals" => deployment.fetch(:decimals),
      "standard" => deployment.fetch(:standard),
      "address" => deployment.fetch(:address),
      "status" => deployment.fetch(:status),
      "replacedByDeploymentId" => deployment.fetch(:replaced_by_deployment_id)
    }
  end

  def runtime_alias(alias_record)
    {
      "namespace" => alias_record.fetch(:namespace),
      "name" => alias_record.fetch(:name),
      "deploymentId" => alias_record.fetch(:deployment_id)
    }
  end

  def deployment_ids(deployments)
    deployments.map { |deployment| deployment.fetch(:deployment_id) }.sort
  end

  def evm_chain_for_snapshot?(chain_id)
    [ETHEREUM, AVALANCHE_C, BASE].include?(chain_id)
  end

  def uppercase_evm_address(address)
    "0x#{address.byteslice(2, 40).upcase}"
  end

  def token_catalog_capture_behavior
    lookup_assets = ERPC::TokenCatalog::TOKEN_ASSETS.map do |asset|
      input = asset.fetch(:asset_id)
      {
        "input" => input,
        "result" => ERPC::TokenCatalog.get_token_asset(input)&.fetch(:asset_id)
      }
    end
    lookup_assets << { "input" => "__unknown_asset__", "result" => nil }

    lookup_deployments = ERPC::TokenCatalog::TOKEN_DEPLOYMENTS.map do |deployment|
      input = deployment.fetch(:deployment_id)
      {
        "input" => input,
        "result" => ERPC::TokenCatalog.get_token_deployment(input)&.fetch(:deployment_id)
      }
    end
    lookup_deployments << { "input" => "__unknown_deployment__", "result" => nil }

    native_deployments = CHAIN_IDS.map do |chain_id|
      {
        "chainId" => chain_id,
        "result" => ERPC::TokenCatalog.get_native_token_deployment(chain_id)&.fetch(:deployment_id)
      }
    end
    native_deployments << { "chainId" => "unknown:chain", "result" => nil }

    symbol_keys = ERPC::TokenCatalog::TOKEN_DEPLOYMENTS.map do |deployment|
      [deployment.fetch(:chain_id), deployment.fetch(:symbol)]
    end.uniq.sort
    symbols = symbol_keys.map do |chain_id, symbol|
      {
        "chainId" => chain_id,
        "symbol" => symbol,
        "result" => deployment_ids(ERPC::TokenCatalog.find_token_deployments_by_symbol(chain_id, symbol))
      }
    end
    symbols.concat(
      [
        { "chainId" => ETHEREUM, "symbol" => "__unknown_symbol__", "result" => [] },
        { "chainId" => "unknown:chain", "symbol" => "USDC", "result" => [] }
      ]
    )

    addresses = []
    ERPC::TokenCatalog::TOKEN_DEPLOYMENTS.each do |deployment|
      address = deployment.fetch(:address)
      next unless address.is_a?(String) && !address.empty?

      chain_id = deployment.fetch(:chain_id)
      addresses << {
        "chainId" => chain_id,
        "address" => address,
        "result" => ERPC::TokenCatalog.find_token_deployment_by_address(chain_id, address)&.fetch(:deployment_id)
      }
      if evm_chain_for_snapshot?(chain_id)
        mixed_case = uppercase_evm_address(address)
        addresses << {
          "chainId" => chain_id,
          "address" => mixed_case,
          "result" => ERPC::TokenCatalog.find_token_deployment_by_address(chain_id, mixed_case)&.fetch(:deployment_id)
        }
      end
    end
    addresses.concat(
      [
        {
          "chainId" => ETHEREUM,
          "address" => "0x#{"0" * 40}",
          "result" => nil
        },
        { "chainId" => ETHEREUM, "address" => "not-an-address", "result" => nil },
        { "chainId" => SOLANA, "address" => "not-a-solana-address", "result" => nil },
        {
          "chainId" => "unknown:chain",
          "address" => "0x#{"0" * 39}1",
          "result" => nil
        }
      ]
    )

    aliases = ERPC::TokenCatalog::TOKEN_ALIASES.map do |alias_record|
      matching = ERPC::TokenCatalog::TOKEN_ALIASES.find do |candidate|
        candidate.fetch(:namespace) == alias_record.fetch(:namespace) &&
          candidate.fetch(:name) == alias_record.fetch(:name)
      end
      {
        "namespace" => alias_record.fetch(:namespace),
        "name" => alias_record.fetch(:name),
        "result" => matching&.fetch(:deployment_id)
      }
    end
    aliases.concat(
      [
        { "namespace" => "ethereum", "name" => "__UNKNOWN_ALIAS__", "result" => nil },
        { "namespace" => "unknown", "name" => "USDC", "result" => nil }
      ]
    )

    list_inputs = [[nil, nil]] + CHAIN_IDS.map { |chain_id| [chain_id, nil] }
    list_inputs.concat(%w[USD EUR JPY].map { |currency| [nil, currency] })
    list_inputs.concat(
      [
        [ETHEREUM, "USD"],
        [SOLANA, "EUR"],
        ["unknown:chain", nil],
        [nil, "unknown"]
      ]
    )
    lists = list_inputs.map do |chain_id, stable_currency|
      {
        "chainId" => chain_id,
        "stableCurrency" => stable_currency,
        "result" => deployment_ids(ERPC::TokenCatalog.list_token_deployments(chain_id, stable_currency))
      }
    end

    {
      "lookupAsset" => lookup_assets,
      "lookupDeployment" => lookup_deployments,
      "nativeDeployment" => native_deployments,
      "symbol" => symbols,
      "address" => addresses,
      "alias" => aliases,
      "list" => lists
    }
  end

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
