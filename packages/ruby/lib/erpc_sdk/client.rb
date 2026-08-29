# frozen_string_literal: true

module ERPC
  SolanaClient = Struct.new(:rpc, :das, :history, :leaders, :analytics, :subscriptions, keyword_init: true)
  EthereumClient = Struct.new(:rpc, :subscriptions, keyword_init: true)

  class Client
    attr_reader :solana, :ethereum, :price, :account, :usage

    def initialize(config, http_adapter: nil, websocket_factory: nil)
      adapter = http_adapter || NetHttpAdapter.new
      solana_transport = HttpJsonRpcTransport.new(
        api_key: config.api_key,
        endpoint: config.endpoint,
        headers: config.headers,
        timeout: config.timeout,
        adapter: adapter
      )
      ethereum_transport = HttpJsonRpcTransport.new(
        api_key: config.api_key,
        endpoint: URLs.with_path(config.endpoint, "/eth"),
        headers: config.headers,
        timeout: config.timeout,
        adapter: adapter
      )
      solana_ws = WebSocketJsonRpcTransport.new(
        URLs.websocket(config.endpoint, config.api_key),
        config.api_key,
        config.timeout,
        connection_factory: websocket_factory
      )
      ethereum_ws = WebSocketJsonRpcTransport.new(
        URLs.websocket(config.endpoint, config.api_key, "/eth"),
        config.api_key,
        config.timeout,
        connection_factory: websocket_factory
      )

      @solana = SolanaClient.new(
        rpc: RpcNamespace.new(
          solana_transport,
          SOLANA_RPC_METHODS,
          parameter_mode: :positional,
          batch_policy: :solana_standard
        ),
        das: RpcNamespace.new(solana_transport, SOLANA_DAS_METHODS, parameter_mode: :named),
        history: RpcNamespace.new(solana_transport, SOLANA_HISTORY_METHODS, parameter_mode: :positional),
        leaders: RpcNamespace.new(
          solana_transport,
          SOLANA_LEADER_METHODS,
          parameter_mode: :positional,
          batch_policy: :unsupported
        ),
        analytics: RpcNamespace.new(
          solana_transport,
          SOLANA_ANALYTICS_METHODS,
          parameter_mode: :positional
        ),
        subscriptions: SolanaSubscriptions.new(solana_ws)
      )
      @ethereum = EthereumClient.new(
        rpc: RpcNamespace.new(ethereum_transport, ETHEREUM_RPC_METHODS, parameter_mode: :positional),
        subscriptions: EthereumSubscriptions.new(ethereum_ws)
      )
      @price = PriceClient.new(
        RestTransport.new(
          credential: config.api_key,
          endpoint: config.endpoint,
          headers: config.headers,
          timeout: config.timeout,
          adapter: adapter
        )
      )
      @account = AccountClient.new(
        RestTransport.new(
          credential: config.api_key,
          endpoint: config.account_endpoint,
          headers: config.headers,
          timeout: config.timeout,
          adapter: adapter
        )
      )
      @usage = UsageClient.new(
        RestTransport.new(
          credential: config.api_key,
          endpoint: config.user_endpoint,
          headers: config.headers,
          timeout: config.timeout,
          adapter: adapter
        )
      )
      @closed = false
    end

    def close
      return if @closed

      @closed = true
      solana.subscriptions.close
      ethereum.subscriptions.close
      nil
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
