# frozen_string_literal: true

require_relative "base"

module ERPC
  if defined?(RPC_NETWORK_CONTRACT)
    ARBITRUM_TRANSPORT_FACTS = SealedEvmContract.facts_from_contract(RPC_NETWORK_CONTRACT, "client-arbitrum-rpc")
    ARBITRUM_RPC_METHODS = ARBITRUM_TRANSPORT_FACTS.method_names
    private_constant :ARBITRUM_TRANSPORT_FACTS
  end

  class ArbitrumRpc
    attr_reader :endpoint

    def initialize(transport)
      @transport = transport
      @endpoint = transport.endpoint
    end

    def eth_chain_id
      pending(@transport.wire_method("eth_chain_id"), [])
    end

    def eth_get_balance(address, block = nil)
      params = [address]
      params << block unless block.nil?
      pending(@transport.wire_method("eth_get_balance"), params)
    end

    def eth_call(transaction, block = nil, state_override = nil)
      params = [transaction]
      params << block unless block.nil?
      params << state_override unless state_override.nil?
      pending(@transport.wire_method("eth_call"), params)
    end

    private

    def pending(method, params)
      SealedEvmPendingRequest.new { @transport.request(method, params) }
    end
  end

  class ArbitrumClient
    attr_reader :rpc

    def initialize(transport)
      @rpc = ArbitrumRpc.new(transport)
      freeze
    end
  end

  ArbitrumRpcClient = ArbitrumRpc

  module Arbitrum
    module_function

    def create_client(transport)
      ArbitrumClient.new(transport)
    end
  end
end
