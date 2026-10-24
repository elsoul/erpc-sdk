# frozen_string_literal: true

require_relative "bitcoin_transport"

module ERPC
  if defined?(RPC_NETWORK_CONTRACT)
    BITCOIN_TRANSPORT_FACTS = BitcoinTransportContract.facts_from_contract(RPC_NETWORK_CONTRACT)
    BITCOIN_RPC_METHODS = BITCOIN_TRANSPORT_FACTS.method_names
    private_constant :BITCOIN_TRANSPORT_FACTS
  end

  class BitcoinPendingRequest
    def initialize(&block)
      @block = block
    end

    def send
      @block.call
    end
  end

  class BitcoinRpc
    attr_reader :endpoint

    def initialize(transport)
      @transport = transport
      @endpoint = transport.endpoint
    end

    def inspect
      "#<#{self.class} endpoint=#{endpoint.inspect}>"
    end

    def estimate_smart_fee(conf_target = nil, estimate_mode = nil)
      if estimate_mode && conf_target.nil?
        raise ConfigError, "estimate_mode requires conf_target", cause: nil
      end
      params = conf_target.nil? ? [] : [conf_target]
      params << estimate_mode unless estimate_mode.nil?
      pending("estimate_smart_fee", params)
    end

    def get_best_block_hash
      pending("get_best_block_hash", [], projector: BitcoinCodec.method(:as_string))
    end

    def get_block(block_hash, verbosity = nil)
      params = [block_hash]
      params << verbosity unless verbosity.nil?
      pending("get_block", params)
    end

    def get_blockchain_info
      pending("get_blockchain_info", [])
    end

    def get_block_count
      pending("get_block_count", [], projector: BitcoinCodec.method(:as_block_count))
    end

    def get_block_hash(height)
      pending("get_block_hash", [height], projector: BitcoinCodec.method(:as_string))
    end

    def get_block_header(block_hash, verbose = nil)
      params = [block_hash]
      params << verbose unless verbose.nil?
      pending("get_block_header", params)
    end

    def get_mempool_info
      pending("get_mempool_info", [])
    end

    def get_network_info
      pending("get_network_info", [])
    end

    def get_raw_mempool(verbose = nil)
      pending("get_raw_mempool", verbose.nil? ? [] : [verbose])
    end

    def get_raw_transaction(transaction_id, verbose = nil, block_hash = nil)
      params = [transaction_id]
      params << verbose unless verbose.nil?
      params << block_hash unless block_hash.nil?
      pending("get_raw_transaction", params)
    end

    def get_tx_out(transaction_id, output_index, include_mempool = nil)
      params = [transaction_id, output_index]
      params << include_mempool unless include_mempool.nil?
      pending("get_tx_out", params, projector: BitcoinCodec.method(:as_nullable_object))
    end

    private

    def pending(public_name, params, projector: nil)
      method = @transport.wire_method(public_name)
      BitcoinPendingRequest.new do
        @transport.request(method, params, projector: projector)
      end
    end
  end

  class BitcoinClient
    attr_reader :rpc

    def initialize(transport)
      @rpc = BitcoinRpc.new(transport)
      freeze
    end
  end

  BitcoinRpcClient = BitcoinRpc

  module Bitcoin
    module_function

    def create_client(transport)
      BitcoinClient.new(transport)
    end
  end

  private_constant :BitcoinPendingRequest
end
