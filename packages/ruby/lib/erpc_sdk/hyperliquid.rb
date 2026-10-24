# frozen_string_literal: true

require_relative "base"

module ERPC
  HYPERLIQUID_TRANSPORT_FACTS = SealedEvmContract.facts_from_contract(RPC_NETWORK_CONTRACT, "client-hyperliquid-rpc")
  HYPERLIQUID_RPC_METHODS = HYPERLIQUID_TRANSPORT_FACTS.method_names
  private_constant :HYPERLIQUID_TRANSPORT_FACTS

  class HyperliquidRpc < BaseRpc
    alias_method :endpoint, :endpoint
    alias_method :eth_chain_id, :eth_chain_id
    alias_method :eth_get_balance, :eth_get_balance
    alias_method :eth_call, :eth_call
  end

  class HyperliquidClient
    attr_reader :rpc

    def initialize(transport)
      @rpc = HyperliquidRpc.new(transport)
      freeze
    end
  end

  module Hyperliquid
    module_function

    def create_client(transport)
      HyperliquidClient.new(transport)
    end
  end
end
