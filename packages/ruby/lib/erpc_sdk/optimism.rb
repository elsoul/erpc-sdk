# frozen_string_literal: true

require_relative "base"

module ERPC
  OPTIMISM_TRANSPORT_FACTS = SealedEvmContract.facts_from_contract(RPC_NETWORK_CONTRACT, "client-optimism-rpc")
  OPTIMISM_RPC_METHODS = OPTIMISM_TRANSPORT_FACTS.method_names
  private_constant :OPTIMISM_TRANSPORT_FACTS

  class OptimismRpc < BaseRpc
    alias_method :endpoint, :endpoint
    alias_method :eth_chain_id, :eth_chain_id
    alias_method :eth_get_balance, :eth_get_balance
    alias_method :eth_call, :eth_call
  end

  class OptimismClient
    attr_reader :rpc

    def initialize(transport)
      @rpc = OptimismRpc.new(transport)
      freeze
    end
  end

  module Optimism
    module_function

    def create_client(transport)
      OptimismClient.new(transport)
    end
  end
end
