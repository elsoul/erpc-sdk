# frozen_string_literal: true

require_relative "base"

module ERPC
  SONEIUM_TRANSPORT_FACTS = SealedEvmContract.facts_from_contract(RPC_NETWORK_CONTRACT, "client-soneium-rpc")
  SONEIUM_RPC_METHODS = SONEIUM_TRANSPORT_FACTS.method_names
  private_constant :SONEIUM_TRANSPORT_FACTS

  class SoneiumRpc < BaseRpc
    alias_method :endpoint, :endpoint
    alias_method :eth_chain_id, :eth_chain_id
    alias_method :eth_get_balance, :eth_get_balance
    alias_method :eth_call, :eth_call
  end

  class SoneiumClient
    attr_reader :rpc

    def initialize(transport)
      @rpc = SoneiumRpc.new(transport)
      freeze
    end
  end

  module Soneium
    module_function

    def create_client(transport)
      SoneiumClient.new(transport)
    end
  end
end
