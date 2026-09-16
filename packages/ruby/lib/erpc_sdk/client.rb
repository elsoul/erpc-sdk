# frozen_string_literal: true

module ERPC
  SolanaClient = Struct.new(:rpc, :das, :history, :leaders, :analytics, :subscriptions, keyword_init: true)
  EthereumClient = Struct.new(:rpc, :subscriptions, keyword_init: true)
  AvalancheIndexClient = Struct.new(
    :c_chain_blocks,
    :p_chain_blocks,
    :x_chain_blocks,
    :x_chain_transactions,
    keyword_init: true
  )
  AvalancheClient = Struct.new(
    :rpc,
    :avax,
    :x_chain,
    :p_chain,
    :proposer_vm,
    :info,
    :index,
    :subscriptions,
    keyword_init: true
  )

  class Client
    attr_reader :solana, :ethereum, :avalanche, :price, :account, :usage, :swap

    def initialize(config, http_adapter: nil, websocket_factory: nil)
      adapter = http_adapter || NetHttpAdapter.new
      unavailable_http = lambda do |namespace|
        HttpJsonRpcTransport.new(
          endpoint: URLs.unavailable_endpoint(namespace),
          headers: {},
          timeout: config.timeout,
          adapter: adapter,
          unavailable_namespace: namespace
        )
      end
      legacy_http = lambda do |endpoint, namespace|
        if config.api_key.nil?
          unavailable_http.call(namespace)
        else
          HttpJsonRpcTransport.new(
            api_key: config.api_key,
            endpoint: endpoint,
            headers: config.headers,
            timeout: config.timeout,
            adapter: adapter
          )
        end
      end
      direct_http = lambda do |override|
        HttpJsonRpcTransport.new(
          endpoint: override.http_url,
          headers: override.headers,
          timeout: config.timeout,
          adapter: adapter,
          direct: true,
          redactions: Redaction.direct_variants(
            http_url: override.http_url,
            websocket_url: override.websocket_url,
            headers: override.headers
          )
        )
      end
      selected_http = lambda do |override, endpoint, namespace|
        override.nil? ? legacy_http.call(endpoint, namespace) : direct_http.call(override)
      end

      unavailable_websocket = lambda do |namespace|
        WebSocketJsonRpcTransport.new(
          URLs.unavailable_endpoint(namespace),
          nil,
          config.timeout,
          connection_factory: websocket_factory,
          unavailable_namespace: namespace
        )
      end
      legacy_websocket = lambda do |endpoint, namespace|
        if config.api_key.nil?
          unavailable_websocket.call(namespace)
        else
          WebSocketJsonRpcTransport.new(
            endpoint,
            config.api_key,
            config.timeout,
            connection_factory: websocket_factory
          )
        end
      end
      direct_websocket = lambda do |override, namespace|
        if override.websocket_url.nil?
          unavailable_websocket.call(namespace)
        else
          WebSocketJsonRpcTransport.new(
            override.websocket_url,
            nil,
            config.timeout,
            connection_factory: websocket_factory,
            direct: true,
            redactions: Redaction.direct_variants(
              http_url: override.http_url,
              websocket_url: override.websocket_url,
              headers: override.headers
            )
          )
        end
      end
      selected_websocket = lambda do |override, endpoint, namespace|
        override.nil? ? legacy_websocket.call(endpoint, namespace) : direct_websocket.call(override, namespace)
      end

      solana_transport = selected_http.call(config.solana_rpc, config.endpoint, "solana.rpc")
      solana_aux_transport = if config.solana_rpc || config.api_key
                              solana_transport
                            else
                              unavailable_http.call("solana.das")
                            end
      solana_history_transport = if config.solana_rpc || config.api_key
                                  solana_transport
                                else
                                  unavailable_http.call("solana.history")
                                end
      solana_leaders_transport = if config.solana_rpc || config.api_key
                                  solana_transport
                                else
                                  unavailable_http.call("solana.leaders")
                                end
      solana_analytics_transport = if config.solana_rpc || config.api_key
                                    solana_transport
                                  else
                                    unavailable_http.call("solana.analytics")
                                  end
      ethereum_transport = selected_http.call(
        config.ethereum_rpc,
        URLs.with_path(config.endpoint, "/eth"),
        "ethereum.rpc"
      )
      avalanche_transport = selected_http.call(
        config.avalanche_c_rpc,
        URLs.with_path(config.avalanche_endpoint, "/ava"),
        "avalanche.rpc"
      )
      avalanche_avax_transport = legacy_http.call(
        URLs.with_path(config.avalanche_endpoint, "/ava"),
        "avalanche.avax"
      )
      avalanche_x_chain_transport = if config.api_key
                                     avalanche_avax_transport
                                   else
                                     unavailable_http.call("avalanche.x_chain")
                                   end
      avalanche_p_chain_transport = if config.api_key
                                     avalanche_avax_transport
                                   else
                                     unavailable_http.call("avalanche.p_chain")
                                   end
      avalanche_proposer_vm_transport = if config.api_key
                                        avalanche_avax_transport
                                      else
                                        unavailable_http.call("avalanche.proposer_vm")
                                      end
      avalanche_info_transport = if config.api_key
                                  avalanche_avax_transport
                                else
                                  unavailable_http.call("avalanche.info")
                                end
      avalanche_index_transport = lambda do |path, namespace|
        legacy_http.call(URLs.with_path(config.avalanche_endpoint, path), namespace)
      end
      solana_ws = selected_websocket.call(
        config.solana_rpc,
        config.api_key.nil? ? URLs.unavailable_endpoint("solana.subscriptions") : URLs.websocket(config.endpoint, config.api_key, ""),
        "solana.subscriptions"
      )
      ethereum_ws = selected_websocket.call(
        config.ethereum_rpc,
        config.api_key.nil? ? URLs.unavailable_endpoint("ethereum.subscriptions") : URLs.websocket(config.endpoint, config.api_key, "/eth"),
        "ethereum.subscriptions"
      )
      avalanche_ws = selected_websocket.call(
        config.avalanche_c_rpc,
        config.api_key.nil? ? URLs.unavailable_endpoint("avalanche.subscriptions") : URLs.websocket(config.avalanche_endpoint, config.api_key, "/ava-ws"),
        "avalanche.subscriptions"
      )

      @solana = SolanaClient.new(
        rpc: RpcNamespace.new(
          solana_transport,
          SOLANA_RPC_METHODS,
          parameter_mode: :positional,
          batch_policy: :solana_standard
        ),
        das: RpcNamespace.new(solana_aux_transport, SOLANA_DAS_METHODS, parameter_mode: :named),
        history: RpcNamespace.new(solana_history_transport, SOLANA_HISTORY_METHODS, parameter_mode: :positional),
        leaders: RpcNamespace.new(
          solana_leaders_transport,
          SOLANA_LEADER_METHODS,
          parameter_mode: :positional,
          batch_policy: :unsupported
        ),
        analytics: RpcNamespace.new(
          solana_analytics_transport,
          SOLANA_ANALYTICS_METHODS,
          parameter_mode: :positional
        ),
        subscriptions: SolanaSubscriptions.new(solana_ws)
      )
      @ethereum = EthereumClient.new(
        rpc: RpcNamespace.new(ethereum_transport, ETHEREUM_RPC_METHODS, parameter_mode: :positional),
        subscriptions: EthereumSubscriptions.new(ethereum_ws)
      )
      @avalanche = AvalancheClient.new(
        rpc: RpcNamespace.new(avalanche_transport, ETHEREUM_RPC_METHODS, parameter_mode: :positional),
        avax: avalanche_namespace(avalanche_avax_transport, AVALANCHE_AVAX_METHODS, "avax"),
        x_chain: avalanche_namespace(avalanche_x_chain_transport, AVALANCHE_X_CHAIN_METHODS, "avm"),
        p_chain: avalanche_namespace(avalanche_p_chain_transport, AVALANCHE_P_CHAIN_METHODS, "platform"),
        proposer_vm: avalanche_namespace(
          avalanche_proposer_vm_transport,
          AVALANCHE_PROPOSER_VM_METHODS,
          "proposervm"
        ),
        info: avalanche_namespace(avalanche_info_transport, AVALANCHE_INFO_METHODS, "info"),
        index: AvalancheIndexClient.new(
          c_chain_blocks: avalanche_namespace(
            avalanche_index_transport.call("/ava/ext/index/C/block", "avalanche.index.c_chain_blocks"),
            AVALANCHE_INDEX_METHODS,
            "index"
          ),
          p_chain_blocks: avalanche_namespace(
            avalanche_index_transport.call("/ava/ext/index/P/block", "avalanche.index.p_chain_blocks"),
            AVALANCHE_INDEX_METHODS,
            "index"
          ),
          x_chain_blocks: avalanche_namespace(
            avalanche_index_transport.call("/ava/ext/index/X/block", "avalanche.index.x_chain_blocks"),
            AVALANCHE_INDEX_METHODS,
            "index"
          ),
          x_chain_transactions: avalanche_namespace(
            avalanche_index_transport.call("/ava/ext/index/X/tx", "avalanche.index.x_chain_transactions"),
            AVALANCHE_INDEX_METHODS,
            "index"
          )
        ),
        subscriptions: EthereumSubscriptions.new(avalanche_ws)
      )
      @swap = SwapClient.new(
        ethereum_transport: ethereum_transport,
        avalanche_transport: avalanche_transport
      )
      @price = PriceClient.new(
        if config.api_key.nil?
          RestTransport.new(
            endpoint: URLs.unavailable_endpoint("price"),
            timeout: config.timeout,
            adapter: adapter,
            unavailable_namespace: "price"
          )
        else
          RestTransport.new(
            credential: config.api_key,
            endpoint: config.endpoint,
            headers: config.headers,
            timeout: config.timeout,
            adapter: adapter
          )
        end
      )
      @account = AccountClient.new(
        if config.api_key.nil?
          RestTransport.new(
            endpoint: URLs.unavailable_endpoint("account"),
            timeout: config.timeout,
            adapter: adapter,
            unavailable_namespace: "account"
          )
        else
          RestTransport.new(
            credential: config.api_key,
            endpoint: config.account_endpoint,
            headers: config.headers,
            timeout: config.timeout,
            adapter: adapter
          )
        end
      )
      @usage = UsageClient.new(
        if config.api_key.nil?
          RestTransport.new(
            endpoint: URLs.unavailable_endpoint("usage"),
            timeout: config.timeout,
            adapter: adapter,
            unavailable_namespace: "usage"
          )
        else
          RestTransport.new(
            credential: config.api_key,
            endpoint: config.user_endpoint,
            headers: config.headers,
            timeout: config.timeout,
            adapter: adapter
          )
        end
      )
      @closed = false
    end

    def close
      return if @closed

      @closed = true
      solana.subscriptions.close
      ethereum.subscriptions.close
      avalanche.subscriptions.close
      nil
    end

    private

    def avalanche_namespace(transport, methods, prefix)
      RpcNamespace.new(
        transport,
        methods,
        parameter_mode: :named,
        batch_policy: :unsupported,
        method_prefix: prefix
      )
    end
  end

  class CloudClient
    attr_reader :catalog, :credit, :resources, :usage

    def initialize(config, http_adapter: nil)
      transport = RestTransport.new(
        credential: config.access_token,
        endpoint: config.endpoint,
        headers: config.headers,
        timeout: config.timeout,
        adapter: http_adapter || NetHttpAdapter.new
      )
      @catalog = CloudCatalogClient.new(transport)
      @credit = CloudCreditClient.new(transport)
      @resources = CloudResourcesClient.new(transport)
      @usage = UsageClient.new(transport)
    end

    def close
      nil
    end
  end

  module_function

  def create_client(config, **options)
    Client.new(config, **options)
  end

  def create_cloud_client(config, **options)
    CloudClient.new(config, **options)
  end
end
