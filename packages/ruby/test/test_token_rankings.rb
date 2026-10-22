# frozen_string_literal: true

require_relative "test_helper"
require "fileutils"
require "rubygems"

class TokenRankingsTest < Minitest::Test
  CHAIN_IDS = [
    ERPC::TokenChainIDs::ETHEREUM_MAINNET,
    ERPC::TokenChainIDs::SOLANA_MAINNET,
    ERPC::TokenChainIDs::AVALANCHE_C_MAINNET
  ].freeze
  BEHAVIOR_INPUTS = (CHAIN_IDS + ["", "unknown:chain", "constructor", "toString", "__proto__"]).freeze

  RANKING_KEYS = %i[
    rank chain_id deployment_ids metric value_numerator value_denominator
    quote_currency quote_deployment_id observed_at source_id source_asset_id
  ].freeze
  METADATA_KEYS = %i[
    schema_version metric as_of content_digest status coverage source_ids
  ].freeze
  COVERAGE_KEYS = %i[
    chain_id total_deployments ranked_deployments unranked_deployments observed_at
  ].freeze
  NATIVE_QUOTE_DEPLOYMENTS = {
    ERPC::TokenChainIDs::ETHEREUM_MAINNET => "deployment-0001",
    ERPC::TokenChainIDs::AVALANCHE_C_MAINNET => "deployment-0003",
    ERPC::TokenChainIDs::SOLANA_MAINNET => "deployment-0005"
  }.freeze

  def test_generated_snapshot_schema_and_nested_values_are_immutable
    metadata = ERPC::TokenRankings::TOKEN_RANKINGS_METADATA
    assert_equal METADATA_KEYS.sort, metadata.keys.sort
    assert_equal 1, metadata.fetch(:schema_version)
    assert [nil, "onchain-total-supply-value-native", "global-circulating-market-cap-usd"].include?(metadata.fetch(:metric))
    if metadata.fetch(:as_of)
      assert_match(/\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\z/, metadata.fetch(:as_of))
    else
      assert_nil metadata.fetch(:as_of)
    end
    assert_match(/\A[0-9a-f]{64}\z/, metadata.fetch(:content_digest))
    assert_equal metadata.fetch(:content_digest), ERPC::TokenRankings::TOKEN_RANKINGS_CONTENT_DIGEST
    assert_includes %w[unconfigured complete partial], metadata.fetch(:status)
    assert_deeply_frozen(metadata)

    records = ERPC::TokenRankings::TOKEN_RANKINGS
    assert records.frozen?
    assert ERPC::TokenRankings::TOKEN_RANKINGS_BY_CHAIN.frozen?
    assert_deeply_frozen(ERPC::TokenRankings::TOKEN_RANKINGS_BY_CHAIN)
    assert_equal metadata.fetch(:coverage), ERPC::TokenRankings::TOKEN_RANKINGS_COVERAGE
    assert_equal metadata.fetch(:source_ids), ERPC::TokenRankings::TOKEN_RANKINGS_SOURCE_IDS

    metadata.fetch(:coverage).each do |coverage|
      assert_equal COVERAGE_KEYS.sort, coverage.keys.sort
      assert_operator coverage.fetch(:total_deployments), :>=, 0
      assert_operator coverage.fetch(:ranked_deployments), :>=, 0
      assert_operator coverage.fetch(:unranked_deployments), :>=, 0
      assert_operator coverage.fetch(:ranked_deployments) + coverage.fetch(:unranked_deployments), :<=, coverage.fetch(:total_deployments)
    end

    records.each do |ranking|
      assert_equal RANKING_KEYS.sort, ranking.keys.sort
      assert_operator ranking.fetch(:rank), :>, 0
      assert_includes CHAIN_IDS, ranking.fetch(:chain_id)
      refute_empty ranking.fetch(:deployment_ids)
      assert_match(/\A(?:0|[1-9][0-9]*)\z/, ranking.fetch(:value_numerator))
      assert_match(/\A[1-9][0-9]*\z/, ranking.fetch(:value_denominator))
      assert_equal 1, ranking.fetch(:value_numerator).to_i.gcd(ranking.fetch(:value_denominator).to_i)
      assert_includes %w[native USD], ranking.fetch(:quote_currency)
      assert_match(/\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\z/, ranking.fetch(:observed_at))
      refute_empty ranking.fetch(:source_id)
      if ranking.fetch(:metric) == "onchain-total-supply-value-native"
        assert_equal 1, ranking.fetch(:deployment_ids).length
        assert_equal "native", ranking.fetch(:quote_currency)
        assert_equal NATIVE_QUOTE_DEPLOYMENTS.fetch(ranking.fetch(:chain_id)), ranking.fetch(:quote_deployment_id)
        assert_nil ranking.fetch(:source_asset_id)
      elsif ranking.fetch(:metric) == "global-circulating-market-cap-usd"
        assert_equal "USD", ranking.fetch(:quote_currency)
        assert_nil ranking.fetch(:quote_deployment_id)
        refute_nil ranking.fetch(:source_asset_id)
      else
        flunk "unknown ranking metric #{ranking.fetch(:metric).inspect}"
      end
    end
  end

  def test_list_token_rankings_is_an_exact_offline_immutable_lookup
    CHAIN_IDS.each do |chain_id|
      expected = ERPC::TokenRankings::TOKEN_RANKINGS.select { |ranking| ranking.fetch(:chain_id) == chain_id }
      actual = ERPC::TokenRankings.list_token_rankings(chain_id)
      assert_equal expected, actual
      assert actual.frozen?
      assert_same expected.first, actual.first if expected.first
    end

    empty = ERPC::TokenRankings.list_token_rankings("")
    unknown = ERPC::TokenRankings.list_token_rankings("unknown:chain")
    assert_equal [], empty
    assert_equal empty, unknown
    assert_same empty, unknown
    assert empty.frozen?
    BEHAVIOR_INPUTS.last(3).each do |special|
      assert_equal [], ERPC::TokenRankings.list_token_rankings(special)
      assert ERPC::TokenRankings.list_token_rankings(special).frozen?
    end
    [nil, 1, [], {}].each { |value| assert_equal [], ERPC::TokenRankings.list_token_rankings(value) }
  end

  def test_unconfigured_snapshot_is_empty_without_pinning_future_counts
    metadata = ERPC::TokenRankings::TOKEN_RANKINGS_METADATA
    return unless metadata.fetch(:status) == "unconfigured"

    assert_nil metadata.fetch(:metric)
    assert_nil metadata.fetch(:as_of)
    assert_empty ERPC::TokenRankings::TOKEN_RANKINGS
    assert_empty ERPC::TokenRankings::TOKEN_RANKINGS_BY_CHAIN
  end

  def test_captures_native_ranking_parity_from_the_fresh_installed_gem_when_requested
    output_path = ENV["ERPC_SDK_RANKING_PARITY_OUTPUT"]
    return if output_path.nil? || output_path.empty?

    spec = Gem.loaded_specs["erpc-sdk"]
    flunk "ERPC_SDK_RANKING_PARITY_OUTPUT requires an installed gem" unless spec
    gem_path = File.realpath(spec.full_gem_path)
    gem_home = ENV["GEM_HOME"]
    flunk "ERPC_SDK_RANKING_PARITY_OUTPUT requires GEM_HOME" unless gem_home && !gem_home.empty?
    gem_home_path = File.realpath(gem_home)
    flunk "erpc-sdk was not loaded from the fresh gem home: #{gem_path}" unless gem_path.start_with?("#{gem_home_path}#{File::SEPARATOR}")

    behavior = BEHAVIOR_INPUTS.each_with_object({}) do |chain_id, result|
      result[chain_id] = ERPC::TokenRankings.list_token_rankings(chain_id).map { |ranking| row_json(ranking) }
    end
    snapshot = {
      "snapshotVersion" => 1,
      "snapshotKind" => "native-runtime",
      "language" => "ruby",
      "runtime" => "ruby-installed-gem-#{spec.full_name}-#{RUBY_ENGINE}-#{RUBY_VERSION}",
      "metadata" => metadata_json(ERPC::TokenRankings::TOKEN_RANKINGS_METADATA),
      "records" => ERPC::TokenRankings::TOKEN_RANKINGS.map { |ranking| row_json(ranking) },
      "behavior" => behavior
    }

    FileUtils.mkdir_p(File.dirname(output_path))
    File.write(output_path, JSON.pretty_generate(snapshot) + "\n")
    assert_operator File.size(output_path), :>, 0
  end

  private

  def row_json(ranking)
    {
      "rank" => ranking.fetch(:rank),
      "chainId" => ranking.fetch(:chain_id),
      "deploymentIds" => ranking.fetch(:deployment_ids),
      "metric" => ranking.fetch(:metric),
      "valueNumerator" => ranking.fetch(:value_numerator),
      "valueDenominator" => ranking.fetch(:value_denominator),
      "quoteCurrency" => ranking.fetch(:quote_currency),
      "quoteDeploymentId" => ranking.fetch(:quote_deployment_id),
      "observedAt" => ranking.fetch(:observed_at),
      "sourceId" => ranking.fetch(:source_id),
      "sourceAssetId" => ranking.fetch(:source_asset_id)
    }
  end

  def metadata_json(metadata)
    {
      "schemaVersion" => metadata.fetch(:schema_version),
      "metric" => metadata.fetch(:metric),
      "asOf" => metadata.fetch(:as_of),
      "contentDigest" => metadata.fetch(:content_digest),
      "status" => metadata.fetch(:status),
      "coverage" => metadata.fetch(:coverage).map do |coverage|
        {
          "chainId" => coverage.fetch(:chain_id),
          "totalDeployments" => coverage.fetch(:total_deployments),
          "rankedDeployments" => coverage.fetch(:ranked_deployments),
          "unrankedDeployments" => coverage.fetch(:unranked_deployments),
          "observedAt" => coverage.fetch(:observed_at)
        }
      end,
      "sourceIds" => metadata.fetch(:source_ids)
    }
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
