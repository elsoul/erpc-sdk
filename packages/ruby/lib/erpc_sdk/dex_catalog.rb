# frozen_string_literal: true

require_relative "generated/dex_catalog"
require_relative "token_catalog"

module ERPC
  # Canonical CAIP-2 chain identifiers used by the bundled DEX catalog.
  module DexChainIDs
    ETHEREUM_MAINNET = DexCatalogData::DEX_CHAIN_IDS.fetch(:ethereum)
    SOLANA_MAINNET = DexCatalogData::DEX_CHAIN_IDS.fetch(:solana)
    AVALANCHE_C_MAINNET = DexCatalogData::DEX_CHAIN_IDS.fetch(:avalanche_c)
  end

  # Offline access to the generated DEX, pool, and native-wrap catalog.
  #
  # The generated records are deeply frozen scalar/hash values. Lookups return
  # those immutable records directly, so a caller cannot alter a later lookup
  # or quote by mutating a previous result.
  module DexCatalog
    DEX_CATALOG_VERSION = DexCatalogData::DEX_CATALOG_VERSION
    DEX_CATALOG_AS_OF_DATE = DexCatalogData::DEX_CATALOG_AS_OF_DATE
    DEX_CATALOG_CONTENT_DIGEST = DexCatalogData::DEX_CATALOG_CONTENT_DIGEST
    AS_OF_DATE = DEX_CATALOG_AS_OF_DATE
    CONTENT_DIGEST = DEX_CATALOG_CONTENT_DIGEST

    DEX_CHAIN_IDS = DexCatalogData::DEX_CHAIN_IDS
    DEX_DEPLOYMENTS = DexCatalogData::DEX_DEPLOYMENTS
    POOL_DEFINITIONS = DexCatalogData::POOL_DEFINITIONS
    NATIVE_WRAP_DEFINITIONS = DexCatalogData::NATIVE_WRAP_DEFINITIONS
    DEX_ALIASES = DexCatalogData::DEX_ALIASES

    # Generated namespace modules contain the opaque IDs used by callers.
    DEXES = Dexes
    POOLS = Pools

    EMPTY_POOLS = [].freeze

    DEXES_BY_ID = DEX_DEPLOYMENTS.each_with_object({}) do |deployment, index|
      index[deployment.fetch(:dex_deployment_id)] = deployment
    end.freeze

    POOLS_BY_ID = POOL_DEFINITIONS.each_with_object({}) do |pool, index|
      index[pool.fetch(:pool_definition_id)] = pool
    end.freeze

    WRAPS_BY_NATIVE_ID = NATIVE_WRAP_DEFINITIONS.each_with_object({}) do |definition, index|
      index[definition.fetch(:native_token_deployment_id)] = definition
    end.freeze

    KNOWN_CHAIN_IDS = [
      DexChainIDs::ETHEREUM_MAINNET,
      DexChainIDs::SOLANA_MAINNET,
      DexChainIDs::AVALANCHE_C_MAINNET
    ].freeze

    EVM_CHAIN_IDS = [
      DexChainIDs::ETHEREUM_MAINNET,
      DexChainIDs::AVALANCHE_C_MAINNET
    ].freeze

    class << self
      # Return the generated DEX namespace module for ergonomic alias access.
      def dexes
        Dexes
      end

      # Return the generated pool namespace module for ergonomic alias access.
      def pools
        Pools
      end

      # Return a DEX deployment by its exact opaque ID.
      def get_dex_deployment(dex_deployment_id)
        return nil unless dex_deployment_id.is_a?(String) && !dex_deployment_id.empty?

        DEXES_BY_ID[dex_deployment_id]
      end

      # Return a pool definition by its exact opaque ID.
      def get_pool_definition(pool_definition_id)
        return nil unless pool_definition_id.is_a?(String) && !pool_definition_id.empty?

        POOLS_BY_ID[pool_definition_id]
      end

      # Find a pool by chain-qualified address.
      # EVM addresses are strict hexadecimal and matched case-insensitively;
      # Solana addresses are matched exactly as their canonical base58 text.
      def find_pool_definition_by_address(chain_id, address)
        return nil unless known_chain_id?(chain_id)
        return nil unless address.is_a?(String) && !address.empty?

        normalized = address
        if evm_chain_id?(chain_id)
          return nil unless valid_evm_address?(address)

          normalized = address.downcase
          return nil if zero_evm_address?(normalized)
        end

        POOL_DEFINITIONS.find do |pool|
          pool.fetch(:chain_id) == chain_id && pool.fetch(:address) == normalized
        end
      end

      # Find all pools for an unordered token pair in stable pool-ID order.
      def find_pool_definitions_by_pair(chain_id, token_a_deployment_id, token_b_deployment_id)
        return EMPTY_POOLS unless known_chain_id?(chain_id)
        return EMPTY_POOLS unless token_a_deployment_id.is_a?(String) && token_b_deployment_id.is_a?(String)
        return EMPTY_POOLS if token_a_deployment_id.empty? || token_b_deployment_id.empty?
        return EMPTY_POOLS if token_a_deployment_id == token_b_deployment_id

        wanted = [token_a_deployment_id, token_b_deployment_id].sort
        matches = POOL_DEFINITIONS.select do |pool|
          actual = [pool.fetch(:token0_deployment_id), pool.fetch(:token1_deployment_id)].sort
          pool.fetch(:chain_id) == chain_id && actual == wanted
        end.sort_by { |pool| pool.fetch(:pool_definition_id) }
        matches.empty? ? EMPTY_POOLS : matches.freeze
      end

      # List pools using the optional chainId/tokenDeploymentId/adapterKind
      # filters. Ruby callers may use either the contract's camelCase keys or
      # idiomatic snake_case keyword keys.
      def list_pool_definitions(options = nil, **keyword_options)
        if options.nil?
          options = keyword_options
        elsif !keyword_options.empty?
          return EMPTY_POOLS
        end
        return EMPTY_POOLS unless options.is_a?(Hash)

        normalized = normalize_filter_keys(options)
        return EMPTY_POOLS unless normalized

        chain_id = normalized[:chain_id]
        token_deployment_id = normalized[:token_deployment_id]
        adapter_kind = normalized[:adapter_kind]
        return EMPTY_POOLS if chain_id && !known_chain_id?(chain_id)
        return EMPTY_POOLS if token_deployment_id &&
          (!token_deployment_id.is_a?(String) || token_deployment_id.empty?)
        return EMPTY_POOLS if adapter_kind &&
          (!adapter_kind.is_a?(String) || adapter_kind.empty?)

        matches = POOL_DEFINITIONS.select do |pool|
          (chain_id.nil? || pool.fetch(:chain_id) == chain_id) &&
            (token_deployment_id.nil? ||
              pool.fetch(:token0_deployment_id) == token_deployment_id ||
              pool.fetch(:token1_deployment_id) == token_deployment_id) &&
            (adapter_kind.nil? || pool.fetch(:adapter).fetch(:kind) == adapter_kind)
        end.sort_by { |pool| pool.fetch(:pool_definition_id) }
        matches.empty? ? EMPTY_POOLS : matches.freeze
      end

      # Return the chain-bound native-to-wrapped relationship for an opaque
      # native token deployment ID. A wrap definition ID is not accepted.
      def get_native_wrap_definition(native_token_deployment_id)
        return nil unless native_token_deployment_id.is_a?(String) && !native_token_deployment_id.empty?

        WRAPS_BY_NATIVE_ID[native_token_deployment_id]
      end

      private

      def normalize_filter_keys(options)
        aliases = {
          "chainId" => :chain_id,
          :chainId => :chain_id,
          "chain_id" => :chain_id,
          :chain_id => :chain_id,
          "tokenDeploymentId" => :token_deployment_id,
          :tokenDeploymentId => :token_deployment_id,
          "token_deployment_id" => :token_deployment_id,
          :token_deployment_id => :token_deployment_id,
          "adapterKind" => :adapter_kind,
          :adapterKind => :adapter_kind,
          "adapter_kind" => :adapter_kind,
          :adapter_kind => :adapter_kind
        }
        result = {}
        options.each do |key, value|
          target = aliases[key]
          return nil unless target
          return nil if result.key?(target)

          result[target] = value
        end
        result
      end

      def known_chain_id?(chain_id)
        chain_id.is_a?(String) && KNOWN_CHAIN_IDS.include?(chain_id)
      end

      def evm_chain_id?(chain_id)
        EVM_CHAIN_IDS.include?(chain_id)
      end

      def valid_evm_address?(address)
        address.match?(/\A0x[0-9A-Fa-f]{40}\z/)
      end

      def zero_evm_address?(address)
        address == "0x#{'0' * 40}"
      end
    end
  end
end
