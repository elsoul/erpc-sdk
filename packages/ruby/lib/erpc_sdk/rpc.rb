# frozen_string_literal: true

module ERPC
  SOLANA_RPC_METHODS = [
    "getAccountInfo",
    "getBalance",
    "getBlock",
    "getBlockCommitment",
    "getBlockHeight",
    "getBlockProduction",
    "getBlockTime",
    "getBlocks",
    "getBlocksWithLimit",
    "getClusterNodes",
    "getEpochInfo",
    "getEpochSchedule",
    "getFeeForMessage",
    "getFirstAvailableBlock",
    "getGenesisHash",
    "getHealth",
    "getHighestSnapshotSlot",
    "getIdentity",
    "getInflationGovernor",
    "getInflationRate",
    "getInflationReward",
    "getLargestAccounts",
    "getLatestBlockhash",
    "getLeaderSchedule",
    "getMaxRetransmitSlot",
    "getMaxShredInsertSlot",
    "getMinimumBalanceForRentExemption",
    "getMultipleAccounts",
    "getParsedTransaction",
    "getPriorityFeeEstimate",
    "getProgramAccounts",
    "getProgramAccountsV2",
    "getRecentPerformanceSamples",
    "getRecentPrioritizationFees",
    "getSignatureStatuses",
    "getSignaturesForAddress",
    "getSlot",
    "getSlotLeader",
    "getSlotLeaders",
    "getStakeMinimumDelegation",
    "getSupply",
    "getTokenAccountBalance",
    "getTokenAccountsByDelegate",
    "getTokenAccountsByOwner",
    "getTokenLargestAccounts",
    "getTokenSupply",
    "getTransaction",
    "getTransactionCount",
    "getVersion",
    "getVoteAccounts",
    "isBlockhashValid",
    "minimumLedgerSlot",
    "requestAirdrop",
    "sendTransaction",
    "simulateTransaction"
  ].freeze

  SOLANA_DAS_METHODS = [
    "getAsset",
    "getAssetBatch",
    "getAssetProof",
    "getAssetProofBatch",
    "getAssetsByAuthority",
    "getAssetsByCreator",
    "getAssetsByGroup",
    "getAssetsByOwner",
    "getNftEditions",
    "getSignaturesForAsset",
    "getTokenAccounts",
    "getTokensByDelegate",
    "getTokensByOwner",
    "searchAssets"
  ].freeze

  SOLANA_HISTORY_METHODS = [
    "getTransactionsForAddress",
    "getTransfersByAddress"
  ].freeze

  SOLANA_LEADER_METHODS = [
    "getLeaderSlots",
    "getValidatorsInformation"
  ].freeze

  SOLANA_ANALYTICS_METHODS = [
    "jetEpochSummary",
    "jetProgramStats",
    "jetSlotStats",
    "jetTopPrograms",
    "jetTpsTimeseries"
  ].freeze

  SOLANA_ENHANCED_SUBSCRIPTION_METHODS = [
    "accountSubscribe",
    "accountUnsubscribe",
    "transactionSubscribe",
    "transactionUnsubscribe"
  ].freeze

  ETHEREUM_RPC_METHODS = [
    "eth_accounts",
    "eth_baseFee",
    "eth_blobBaseFee",
    "eth_blockNumber",
    "eth_call",
    "eth_callMany",
    "eth_capabilities",
    "eth_chainId",
    "eth_createAccessList",
    "eth_estimateGas",
    "eth_feeHistory",
    "eth_gasPrice",
    "eth_getAccount",
    "eth_getBalance",
    "eth_getBlockByHash",
    "eth_getBlockByNumber",
    "eth_getBlockReceipts",
    "eth_getBlockTransactionCountByHash",
    "eth_getBlockTransactionCountByNumber",
    "eth_getCode",
    "eth_getFilterChanges",
    "eth_getFilterLogs",
    "eth_getLogs",
    "eth_getProof",
    "eth_getRawTransactionByHash",
    "eth_getStorageAt",
    "eth_getTransactionByBlockHashAndIndex",
    "eth_getTransactionByBlockNumberAndIndex",
    "eth_getTransactionByHash",
    "eth_getTransactionBySenderAndNonce",
    "eth_getTransactionCount",
    "eth_getTransactionReceipt",
    "eth_getUncleCountByBlockHash",
    "eth_getUncleCountByBlockNumber",
    "eth_maxPriorityFeePerGas",
    "eth_newBlockFilter",
    "eth_newFilter",
    "eth_newPendingTransactionFilter",
    "eth_sendRawTransaction",
    "eth_signTransaction",
    "eth_simulateV1",
    "eth_submitWork",
    "eth_syncing",
    "eth_uninstallFilter",
    "net_listening",
    "net_peerCount",
    "net_version",
    "txpool_content",
    "txpool_contentFrom",
    "txpool_inspect",
    "txpool_status",
    "web3_clientVersion",
    "web3_sha3"
  ].freeze

  ETHEREUM_SUBSCRIPTION_METHODS = [
    "eth_subscribe",
    "eth_unsubscribe"
  ].freeze

  HEAVY_SOLANA_METHODS = %w[
    getPriorityFeeEstimate
    getProgramAccounts
    getProgramAccountsV2
    getTokenLargestAccounts
  ].freeze
  private_constant :HEAVY_SOLANA_METHODS

  class PendingRpcRequest
    def initialize(transport, method, params, decoder)
      @transport = transport
      @method = method
      @params = params
      @decoder = decoder
    end

    def send
      @decoder.call(@transport.request(@method, @params))
    end
  end

  class PendingRpcBatchRequest
    def initialize(transport, calls)
      @transport = transport
      @calls = calls.map(&:dup).freeze
    end

    def send
      @transport.batch(@calls)
    end
  end

  class RpcNamespace
    attr_reader :endpoint

    def initialize(transport, methods, parameter_mode:, batch_policy: :any)
      @transport = transport
      @endpoint = transport.endpoint
      @methods = methods.to_h { |method| [method, true] }.freeze
      @aliases = methods.to_h { |method| [snake_case(method), method] }.freeze
      @parameter_mode = parameter_mode
      @batch_policy = batch_policy
    end

    def request(method, params = nil, decoder: nil)
      unless @methods.key?(method)
        raise ConfigError, "#{method.inspect} is not in this namespace; use raw for forward-compatible methods"
      end

      PendingRpcRequest.new(@transport, method, params, decoder || ->(value) { value })
    end

    def raw(method, params = nil, decoder: nil)
      raise ConfigError, "method must not be empty" if method.to_s.empty?

      PendingRpcRequest.new(@transport, method, params, decoder || ->(value) { value })
    end

    def batch(calls)
      if @batch_policy == :unsupported && !calls.empty?
        raise BatchPolicyError, "Leader RPC methods do not support batching"
      end
      if @batch_policy == :solana_standard
        methods = calls.map { |call| call[:method] || call["method"] }
        has_heavy = methods.any? { |method| HEAVY_SOLANA_METHODS.include?(method) }
        has_standard = methods.any? { |method| !HEAVY_SOLANA_METHODS.include?(method) }
        if has_heavy && has_standard
          raise BatchPolicyError, "Solana indexed and standard RPC methods cannot share a batch"
        end
      end

      PendingRpcBatchRequest.new(@transport, calls)
    end

    def method_missing(name, *arguments, &block)
      return super if block

      string_name = name.to_s
      method = @methods.key?(string_name) ? string_name : @aliases[string_name]
      return super unless method

      params = if @parameter_mode == :positional
                 arguments
               elsif arguments.empty?
                 nil
               elsif arguments.length == 1 && arguments.first.is_a?(Hash)
                 arguments.first
               else
                 raise ConfigError, "named RPC methods require one Hash argument"
               end
      request(method, params)
    end

    def respond_to_missing?(name, include_private = false)
      string_name = name.to_s
      @methods.key?(string_name) || @aliases.key?(string_name) || super
    end

    private

    def snake_case(value)
      value.gsub(/(?<=[a-z0-9])(?=[A-Z])/, "_").downcase
    end
  end
end
