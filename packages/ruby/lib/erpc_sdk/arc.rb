# frozen_string_literal: true

require_relative "base"

module ERPC
  ARC_TRANSPORT_FACTS = SealedEvmContract.facts_from_contract(RPC_NETWORK_CONTRACT, "client-arc-rpc")
  ARC_RPC_METHODS = ARC_TRANSPORT_FACTS.method_names
  private_constant :ARC_TRANSPORT_FACTS

  class ArcRpc < BaseRpc
    alias_method :endpoint, :endpoint
    alias_method :eth_chain_id, :eth_chain_id
    alias_method :eth_get_balance, :eth_get_balance
    alias_method :eth_call, :eth_call
  end

  class ArcClient
    attr_reader :rpc

    def initialize(transport)
      @rpc = ArcRpc.new(transport)
      freeze
    end
  end

  module Arc
    module_function

    def create_client(transport)
      ArcClient.new(transport)
    end
  end
end
