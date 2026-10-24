# frozen_string_literal: true

require_relative "base"

module ERPC
  BSC_TRANSPORT_FACTS = SealedEvmContract.facts_from_contract(RPC_NETWORK_CONTRACT, "client-bsc-rpc")
  BSC_RPC_METHODS = BSC_TRANSPORT_FACTS.method_names
  private_constant :BSC_TRANSPORT_FACTS

  class BscRpc < BaseRpc
    alias_method :endpoint, :endpoint
    alias_method :eth_chain_id, :eth_chain_id
    alias_method :eth_get_balance, :eth_get_balance
    alias_method :eth_call, :eth_call
  end

  class BscClient
    attr_reader :rpc

    def initialize(transport)
      @rpc = BscRpc.new(transport)
      freeze
    end
  end

  module Bsc
    module_function

    def create_client(transport)
      BscClient.new(transport)
    end
  end
end
