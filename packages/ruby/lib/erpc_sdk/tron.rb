# frozen_string_literal: true

require_relative "base"

module ERPC
  TRON_TRANSPORT_FACTS = SealedEvmContract.facts_from_contract(RPC_NETWORK_CONTRACT, "client-tron-rpc")
  TRON_RPC_METHODS = TRON_TRANSPORT_FACTS.method_names
  private_constant :TRON_TRANSPORT_FACTS

  class TronRpc < BaseRpc
    alias_method :endpoint, :endpoint
    alias_method :eth_chain_id, :eth_chain_id
    alias_method :eth_get_balance, :eth_get_balance
    alias_method :eth_call, :eth_call
  end

  class TronClient
    attr_reader :rpc

    def initialize(transport)
      @rpc = TronRpc.new(transport)
      freeze
    end
  end

  module Tron
    module_function

    def create_client(transport)
      TronClient.new(transport)
    end
  end
end
