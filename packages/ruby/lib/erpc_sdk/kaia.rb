# frozen_string_literal: true

require_relative "base"

module ERPC
  KAIA_TRANSPORT_FACTS = SealedEvmContract.facts_from_contract(RPC_NETWORK_CONTRACT, "client-kaia-rpc")
  KAIA_RPC_METHODS = KAIA_TRANSPORT_FACTS.method_names
  private_constant :KAIA_TRANSPORT_FACTS

  class KaiaRpc < BaseRpc
    alias_method :endpoint, :endpoint
    alias_method :eth_chain_id, :eth_chain_id
    alias_method :eth_get_balance, :eth_get_balance
    alias_method :eth_call, :eth_call
  end

  class KaiaClient
    attr_reader :rpc

    def initialize(transport)
      @rpc = KaiaRpc.new(transport)
      freeze
    end
  end

  module Kaia
    module_function

    def create_client(transport)
      KaiaClient.new(transport)
    end
  end
end
