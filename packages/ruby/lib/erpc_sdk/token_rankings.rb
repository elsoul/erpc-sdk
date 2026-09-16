# frozen_string_literal: true

require_relative "generated/token_rankings"

module ERPC
  # Offline access to the generated token ranking snapshot.
  #
  # Ranking records are immutable values generated from the canonical registry.
  # Lookups use exact chain IDs and never access a client, clock, file, or
  # network. The current canonical snapshot is intentionally unconfigured, so
  # its known-chain results are empty until a reviewed snapshot is published.
  module TokenRankings
    TOKEN_RANKINGS_METADATA = TokenRankingsData::TOKEN_RANKINGS_METADATA
    TOKEN_RANKINGS = TokenRankingsData::TOKEN_RANKINGS
    TOKEN_RANKINGS_CONTENT_DIGEST = TokenRankingsData::TOKEN_RANKINGS_CONTENT_DIGEST

    TOKEN_RANKINGS_SCHEMA_VERSION = TOKEN_RANKINGS_METADATA.fetch(:schema_version)
    TOKEN_RANKINGS_METRIC = TOKEN_RANKINGS_METADATA.fetch(:metric)
    TOKEN_RANKINGS_AS_OF = TOKEN_RANKINGS_METADATA.fetch(:as_of)
    TOKEN_RANKINGS_STATUS = TOKEN_RANKINGS_METADATA.fetch(:status)
    TOKEN_RANKINGS_COVERAGE = TOKEN_RANKINGS_METADATA.fetch(:coverage)
    TOKEN_RANKINGS_SOURCE_IDS = TOKEN_RANKINGS_METADATA.fetch(:source_ids)

    EMPTY_RANKINGS = [].freeze

    TOKEN_RANKINGS_BY_CHAIN = begin
      grouped = {}
      TOKEN_RANKINGS.each do |ranking|
        chain_id = ranking.fetch(:chain_id)
        grouped[chain_id] ||= []
        grouped[chain_id] << ranking
      end
      grouped.each_with_object({}) do |(chain_id, rows), index|
        index[chain_id] = rows.freeze
      end.freeze
    end

    class << self
      # Return rankings for one exact chain ID.
      #
      # Empty, unknown, and special string inputs return the same immutable
      # empty array. No aliases or live data are inferred.
      def list_token_rankings(chain_id)
        return EMPTY_RANKINGS unless chain_id.is_a?(String) && !chain_id.empty?

        TOKEN_RANKINGS_BY_CHAIN.fetch(chain_id, EMPTY_RANKINGS)
      end
    end
  end
end
