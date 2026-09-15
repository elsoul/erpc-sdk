# frozen_string_literal: true

require_relative "generated/token_catalog"

module ERPC
  # Canonical CAIP-2 chain identifiers used by the bundled token catalog.
  module TokenChainIDs
    ETHEREUM_MAINNET = TokenCatalogData::TOKEN_CHAIN_IDS.fetch(:ethereum)
    SOLANA_MAINNET = TokenCatalogData::TOKEN_CHAIN_IDS.fetch(:solana)
    AVALANCHE_C_MAINNET = TokenCatalogData::TOKEN_CHAIN_IDS.fetch(:avalanche_c)
  end

  # Offline access to the generated token and deployment catalog.
  #
  # All records are static, frozen Ruby values generated from the canonical
  # registry. These methods never create a client, read a file, parse JSON, or
  # access the network.
  module TokenCatalog
    TOKEN_CATALOG_VERSION = TokenCatalogData::TOKEN_CATALOG_VERSION
    TOKEN_CATALOG_AS_OF_DATE = TokenCatalogData::TOKEN_CATALOG_AS_OF_DATE
    TOKEN_CATALOG_CONTENT_DIGEST = TokenCatalogData::TOKEN_CATALOG_CONTENT_DIGEST
    AS_OF_DATE = TOKEN_CATALOG_AS_OF_DATE
    CONTENT_DIGEST = TOKEN_CATALOG_CONTENT_DIGEST

    TOKEN_CHAIN_IDS = TokenCatalogData::TOKEN_CHAIN_IDS
    TOKEN_ASSETS = TokenCatalogData::TOKEN_ASSETS
    TOKEN_DEPLOYMENTS = TokenCatalogData::TOKEN_DEPLOYMENTS
    TOKEN_ALIASES = TokenCatalogData::TOKEN_ALIASES

    EMPTY_DEPLOYMENTS = [].freeze

    ASSETS_BY_ID = TOKEN_ASSETS.each_with_object({}) do |asset, index|
      index[asset.fetch(:asset_id)] = asset
    end.freeze

    DEPLOYMENTS_BY_ID = TOKEN_DEPLOYMENTS.each_with_object({}) do |deployment, index|
      index[deployment.fetch(:deployment_id)] = deployment
    end.freeze

    DEPLOYMENTS_BY_SYMBOL = begin
      grouped = Hash.new { |hash, key| hash[key] = [] }
      TOKEN_DEPLOYMENTS.each do |deployment|
        key = [deployment.fetch(:chain_id), deployment.fetch(:symbol)].freeze
        grouped[key] << deployment
      end
      grouped.each_with_object({}) do |(key, deployments), index|
        index[key] = deployments.sort_by { |deployment| deployment.fetch(:deployment_id) }.freeze
      end.freeze
    end

    DEPLOYMENTS_BY_ADDRESS = begin
      indexed = {}
      TOKEN_DEPLOYMENTS.each do |deployment|
        address = deployment[:address]
        next unless address.is_a?(String) && !address.empty?

        evm_chain = [TokenChainIDs::ETHEREUM_MAINNET, TokenChainIDs::AVALANCHE_C_MAINNET].include?(deployment.fetch(:chain_id))
        normalized = evm_chain ? address.downcase : address
        key = [deployment.fetch(:chain_id), normalized].freeze
        indexed[key] ||= deployment
      end
      indexed.freeze
    end

    class << self
      # Return the asset with the exact opaque asset ID.
      def get_token_asset(asset_id)
        return nil unless asset_id.is_a?(String) && !asset_id.empty?

        ASSETS_BY_ID[asset_id]
      end

      # Return the deployment with the exact opaque deployment ID.
      def get_token_deployment(deployment_id)
        return nil unless deployment_id.is_a?(String) && !deployment_id.empty?

        DEPLOYMENTS_BY_ID[deployment_id]
      end

      # List all deployments, optionally restricted by chain and stable
      # currency. Every lifecycle status remains visible.
      #
      # The canonical Ruby form uses keywords:
      #   list_token_deployments(chain_id: ..., stable_currency: ...)
      # Positional values are also accepted for callers that prefer the
      # compact form: list_token_deployments(chain_id, stable_currency).
      def list_token_deployments(chain_id = nil, stable_currency = nil, **filters)
        unless filters.empty?
          return EMPTY_DEPLOYMENTS unless filters.keys.all? { |key| %i[chain_id stable_currency].include?(key) }
          return EMPTY_DEPLOYMENTS if filters.key?(:chain_id) && !chain_id.nil?
          return EMPTY_DEPLOYMENTS if filters.key?(:stable_currency) && !stable_currency.nil?

          chain_id = filters[:chain_id] if filters.key?(:chain_id)
          stable_currency = filters[:stable_currency] if filters.key?(:stable_currency)
        end

        return EMPTY_DEPLOYMENTS if !chain_id.nil? && !known_chain_id?(chain_id)
        return EMPTY_DEPLOYMENTS if !stable_currency.nil? && !stable_currency?(stable_currency)

        filtered = TOKEN_DEPLOYMENTS.select do |deployment|
          (chain_id.nil? || deployment.fetch(:chain_id) == chain_id) &&
            (stable_currency.nil? || deployment[:stable_currency] == stable_currency)
        end
        filtered.empty? ? EMPTY_DEPLOYMENTS : filtered.freeze
      end

      # Find every exact-case symbol match on a known chain, ordered by
      # deployment ID.
      def find_token_deployments_by_symbol(chain_id, symbol)
        return EMPTY_DEPLOYMENTS unless known_chain_id?(chain_id)
        return EMPTY_DEPLOYMENTS unless symbol.is_a?(String) && !symbol.empty?

        DEPLOYMENTS_BY_SYMBOL.fetch([chain_id, symbol], EMPTY_DEPLOYMENTS)
      end

      # Find a non-native deployment by address. EVM addresses are strict
      # ASCII hexadecimal and matched case-insensitively; Solana addresses are
      # matched exactly.
      def find_token_deployment_by_address(chain_id, address)
        return nil unless known_chain_id?(chain_id)
        return nil unless address.is_a?(String) && !address.empty?

        if evm_chain_id?(chain_id)
          return nil unless valid_evm_address?(address)

          normalized = address.downcase
          return nil if zero_evm_address?(normalized)
        else
          normalized = address
        end

        DEPLOYMENTS_BY_ADDRESS[[chain_id, normalized]]
      end

      # Return the native deployment for a known chain. Native deployments use
      # a nil address and are intentionally not address-lookup candidates.
      def get_native_token_deployment(chain_id)
        return nil unless known_chain_id?(chain_id)

        TOKEN_DEPLOYMENTS.find do |deployment|
          deployment.fetch(:chain_id) == chain_id &&
            deployment.fetch(:standard) == "native" && deployment[:address].nil?
        end
      end

      private

      def known_chain_id?(chain_id)
        chain_id.is_a?(String) &&
          [TokenChainIDs::ETHEREUM_MAINNET, TokenChainIDs::SOLANA_MAINNET, TokenChainIDs::AVALANCHE_C_MAINNET].include?(chain_id)
      end

      def evm_chain_id?(chain_id)
        chain_id == TokenChainIDs::ETHEREUM_MAINNET || chain_id == TokenChainIDs::AVALANCHE_C_MAINNET
      end

      def stable_currency?(value)
        value.is_a?(String) && %w[USD EUR JPY].include?(value)
      end

      def valid_evm_address?(address)
        address.match?(/\A0x[0-9A-Fa-f]{40}\z/)
      end

      def zero_evm_address?(address)
        address == "0x#{"0" * 40}"
      end
    end
  end
end
