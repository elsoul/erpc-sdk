# frozen_string_literal: true

require_relative "base"

module ERPC
  POLYGON_TRANSPORT_FACTS = SealedEvmContract.facts_from_contract(RPC_NETWORK_CONTRACT, "client-polygon-rpc")
  POLYGON_RPC_METHODS = POLYGON_TRANSPORT_FACTS.method_names
  private_constant :POLYGON_TRANSPORT_FACTS

  class PolygonRpc < BaseRpc
    alias_method :endpoint, :endpoint
    alias_method :eth_chain_id, :eth_chain_id
    alias_method :eth_get_balance, :eth_get_balance
    alias_method :eth_call, :eth_call
  end

  class PolygonClient
    attr_reader :rpc

    def initialize(transport)
      @rpc = PolygonRpc.new(transport)
      freeze
    end
  end

  module Polygon
    module_function

    def create_client(transport)
      PolygonClient.new(transport)
    end
  end
end
