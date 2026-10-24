# frozen_string_literal: true

require_relative "base"

module ERPC
  ROBINHOOD_TRANSPORT_FACTS = SealedEvmContract.facts_from_contract(RPC_NETWORK_CONTRACT, "client-robinhood-rpc")
  ROBINHOOD_RPC_METHODS = ROBINHOOD_TRANSPORT_FACTS.method_names
  private_constant :ROBINHOOD_TRANSPORT_FACTS

  class RobinhoodRpc < BaseRpc
    alias_method :endpoint, :endpoint
    alias_method :eth_chain_id, :eth_chain_id
    alias_method :eth_get_balance, :eth_get_balance
    alias_method :eth_call, :eth_call
  end

  class RobinhoodClient
    attr_reader :rpc

    def initialize(transport)
      @rpc = RobinhoodRpc.new(transport)
      freeze
    end
  end

  module Robinhood
    module_function

    def create_client(transport)
      RobinhoodClient.new(transport)
    end
  end
end
