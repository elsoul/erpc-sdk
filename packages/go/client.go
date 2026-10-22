// Package erpc provides a context-aware Go client for ERPC JSON-RPC, REST,
// server-sent events, and WebSocket subscriptions.
package erpc

import (
	"context"
	"encoding/json"
	"net/url"
)

// Client groups all API namespaces backed by one API key and optional direct
// chain RPC endpoints.
type Client struct {
	Solana    *SolanaClient
	Ethereum  *EthereumClient
	Avalanche *AvalancheClient
	Swap      *SwapClient
	Price     *PriceClient
	Account   *AccountClient
	Usage     *UsageClient
}

// NewClient validates config and creates an inert client. It performs no
// network I/O until a method is called.
func NewClient(config Config) (*Client, error) {
	resolved, err := resolveConfig(config)
	if err != nil {
		return nil, err
	}
	solanaHTTP := rpcHTTPTransport(resolved, resolved.solanaRPC, resolved.endpoint, "solana.rpc")
	ethereumHTTP := rpcHTTPTransport(resolved, resolved.ethereumRPC, endpointPath(resolved.endpoint, "/eth"), "ethereum.rpc")
	avalancheHTTP := rpcHTTPTransport(resolved, resolved.avalancheCRPC, endpointPath(resolved.avalancheEndpoint, "/ava"), "avalanche.rpc")
	avalancheNativeHTTP := legacyOrUnavailableHTTPTransport(resolved, endpointPath(resolved.avalancheEndpoint, "/ava"), "avalanche.avax")
	avalancheIndex := &AvalancheIndexClient{
		CChainBlocks: newAvalancheRPCNamespace(
			legacyOrUnavailableHTTPTransport(resolved, endpointPath(resolved.avalancheEndpoint, "/ava/ext/index/C/block"), "avalanche.index.cChainBlocks"),
			"index",
			AvalancheIndexMethods,
		),
		PChainBlocks: newAvalancheRPCNamespace(
			legacyOrUnavailableHTTPTransport(resolved, endpointPath(resolved.avalancheEndpoint, "/ava/ext/index/P/block"), "avalanche.index.pChainBlocks"),
			"index",
			AvalancheIndexMethods,
		),
		XChainBlocks: newAvalancheRPCNamespace(
			legacyOrUnavailableHTTPTransport(resolved, endpointPath(resolved.avalancheEndpoint, "/ava/ext/index/X/block"), "avalanche.index.xChainBlocks"),
			"index",
			AvalancheIndexMethods,
		),
		XChainTransactions: newAvalancheRPCNamespace(
			legacyOrUnavailableHTTPTransport(resolved, endpointPath(resolved.avalancheEndpoint, "/ava/ext/index/X/tx"), "avalanche.index.xChainTransactions"),
			"index",
			AvalancheIndexMethods,
		),
	}
	solanaWS := rpcWebSocketTransport(resolved, resolved.solanaRPC, websocketURL(resolved.endpoint, resolved.apiKey, ""), "solana.subscriptions")
	ethereumWS := rpcWebSocketTransport(resolved, resolved.ethereumRPC, websocketURL(resolved.endpoint, resolved.apiKey, "/eth"), "ethereum.subscriptions")
	avalancheWS := rpcWebSocketTransport(resolved, resolved.avalancheCRPC, websocketURL(resolved.avalancheEndpoint, resolved.apiKey, "/ava-ws"), "avalanche.subscriptions")
	sharedREST := legacyOrUnavailableRESTTransport(resolved, resolved.endpoint, "price")
	accountREST := legacyOrUnavailableRESTTransport(resolved, resolved.accountEndpoint, "account")
	userREST := legacyOrUnavailableRESTTransport(resolved, resolved.userEndpoint, "usage")
	solana := newSolanaClient(solanaHTTP, solanaWS)
	if resolved.solanaRPC == nil && resolved.apiKey == "" {
		solana.DAS = &RPCNamespace{transport: newUnavailableHTTPRPCTransport(resolved, "solana.das"), policy: batchAny}
		solana.History = &RPCNamespace{transport: newUnavailableHTTPRPCTransport(resolved, "solana.history"), policy: batchAny}
		solana.Leaders = &RPCNamespace{transport: newUnavailableHTTPRPCTransport(resolved, "solana.leaders"), policy: batchUnsupported}
		solana.Analytics = &RPCNamespace{transport: newUnavailableHTTPRPCTransport(resolved, "solana.analytics"), policy: batchAny}
	}
	avalanche := newAvalancheClient(avalancheHTTP, avalancheWS, avalancheIndex, avalancheNativeHTTP)
	if resolved.avalancheCRPC == nil && resolved.apiKey == "" {
		avalanche.AVAX = newUnavailableAvalancheNamespace(resolved, "avalanche.avax", "avax", AvalancheAVAXMethods)
		avalanche.XChain = newUnavailableAvalancheNamespace(resolved, "avalanche.xChain", "avm", AvalancheXChainMethods)
		avalanche.PChain = newUnavailableAvalancheNamespace(resolved, "avalanche.pChain", "platform", AvalanchePChainMethods)
		avalanche.ProposerVM = newUnavailableAvalancheNamespace(resolved, "avalanche.proposerVM", "proposervm", AvalancheProposerVMMethods)
		avalanche.Info = newUnavailableAvalancheNamespace(resolved, "avalanche.info", "info", AvalancheInfoMethods)
	}
	return &Client{
		Solana:    solana,
		Ethereum:  newEthereumClient(ethereumHTTP, ethereumWS),
		Avalanche: avalanche,
		Swap:      newSwapClient(ethereumHTTP, avalancheHTTP),
		Price:     &PriceClient{transport: sharedREST},
		Account:   &AccountClient{transport: accountREST},
		Usage:     &UsageClient{transport: userREST},
	}, nil
}

func rpcHTTPTransport(
	config resolvedConfig,
	override *resolvedRPCEndpointConfig,
	legacyEndpoint *url.URL,
	namespace string,
) *httpRPCTransport {
	if override != nil {
		return newDirectHTTPRPCTransport(config, override)
	}
	return legacyOrUnavailableHTTPTransport(config, legacyEndpoint, namespace)
}

func legacyOrUnavailableHTTPTransport(config resolvedConfig, endpoint *url.URL, namespace string) *httpRPCTransport {
	if config.apiKey == "" {
		return newUnavailableHTTPRPCTransport(config, namespace)
	}
	return newHTTPRPCTransport(config, endpoint)
}

func rpcWebSocketTransport(
	config resolvedConfig,
	override *resolvedRPCEndpointConfig,
	legacyEndpoint *url.URL,
	namespace string,
) *webSocketTransport {
	if override != nil {
		return newDirectWebSocketTransport(override, config.timeout, namespace)
	}
	if config.apiKey == "" {
		return newUnavailableWebSocketTransport(config.timeout, namespace)
	}
	return newWebSocketTransport(legacyEndpoint, config.timeout)
}

func legacyOrUnavailableRESTTransport(config resolvedConfig, endpoint *url.URL, namespace string) *restTransport {
	if config.apiKey == "" {
		return newUnavailableRESTTransport(namespace, config)
	}
	return newRESTTransport(config.apiKey, endpoint, config)
}

// Close closes subscription connections. HTTP requests require no close.
func (c *Client) Close() error {
	first := c.Solana.Subscriptions.close()
	if err := c.Ethereum.Subscriptions.close(); first == nil {
		first = err
	}
	if err := c.Avalanche.Subscriptions.close(); first == nil {
		first = err
	}
	return first
}

// SolanaClient groups standard and extended Solana APIs.
type SolanaClient struct {
	RPC           *SolanaRPCClient
	DAS           *RPCNamespace
	History       *RPCNamespace
	Leaders       *RPCNamespace
	Analytics     *RPCNamespace
	Subscriptions *SolanaSubscriptions
}

func newSolanaClient(transport *httpRPCTransport, ws *webSocketTransport) *SolanaClient {
	return &SolanaClient{
		RPC:           &SolanaRPCClient{RPCNamespace: &RPCNamespace{transport: transport, policy: batchSolanaStandard}},
		DAS:           &RPCNamespace{transport: transport, policy: batchAny},
		History:       &RPCNamespace{transport: transport, policy: batchAny},
		Leaders:       &RPCNamespace{transport: transport, policy: batchUnsupported},
		Analytics:     &RPCNamespace{transport: transport, policy: batchAny},
		Subscriptions: &SolanaSubscriptions{transport: ws},
	}
}

// SolanaRPCClient provides standard Solana JSON-RPC and typed common methods.
type SolanaRPCClient struct{ *RPCNamespace }

func (c *SolanaRPCClient) GetSlot(ctx context.Context, params ...any) (uint64, error) {
	return NewRequest[uint64](c.RPCNamespace, "getSlot", positional(params)).Send(ctx)
}

func (c *SolanaRPCClient) GetBalance(ctx context.Context, address string, options ...any) (SolanaContextResult[uint64], error) {
	return NewRequest[SolanaContextResult[uint64]](c.RPCNamespace, "getBalance", append([]any{address}, options...)).Send(ctx)
}

func (c *SolanaRPCClient) GetAccountInfo(ctx context.Context, address string, options ...any) (SolanaContextResult[json.RawMessage], error) {
	return NewRequest[SolanaContextResult[json.RawMessage]](c.RPCNamespace, "getAccountInfo", append([]any{address}, options...)).Send(ctx)
}

func (c *SolanaRPCClient) GetLatestBlockhash(ctx context.Context, options ...any) (json.RawMessage, error) {
	return NewRequest[json.RawMessage](c.RPCNamespace, "getLatestBlockhash", positional(options)).Send(ctx)
}

func (c *SolanaRPCClient) GetTransaction(ctx context.Context, signature string, options ...any) (json.RawMessage, error) {
	return NewRequest[json.RawMessage](c.RPCNamespace, "getTransaction", append([]any{signature}, options...)).Send(ctx)
}

// SendTransaction is attempted exactly once. The SDK never retries a
// state-changing request automatically.
func (c *SolanaRPCClient) SendTransaction(ctx context.Context, transaction string, options ...any) (string, error) {
	return NewRequest[string](c.RPCNamespace, "sendTransaction", append([]any{transaction}, options...)).Send(ctx)
}

func (c *SolanaRPCClient) SimulateTransaction(ctx context.Context, transaction string, options ...any) (json.RawMessage, error) {
	return NewRequest[json.RawMessage](c.RPCNamespace, "simulateTransaction", append([]any{transaction}, options...)).Send(ctx)
}

// SolanaContext is standard response context metadata.
type SolanaContext struct {
	APIVersion string `json:"apiVersion,omitempty"`
	Slot       uint64 `json:"slot"`
}

// SolanaContextResult wraps a value with standard response context metadata.
type SolanaContextResult[T any] struct {
	Context SolanaContext `json:"context"`
	Value   T             `json:"value"`
}

// EthereumClient groups standard RPC and subscriptions.
type EthereumClient struct {
	RPC           *EthereumRPCClient
	Subscriptions *EthereumSubscriptions
}

func newEthereumClient(transport *httpRPCTransport, ws *webSocketTransport) *EthereumClient {
	return &EthereumClient{
		RPC:           &EthereumRPCClient{RPCNamespace: &RPCNamespace{transport: transport, policy: batchAny}},
		Subscriptions: &EthereumSubscriptions{transport: ws},
	}
}

// EthereumRPCClient provides Ethereum JSON-RPC and typed common methods.
type EthereumRPCClient struct{ *RPCNamespace }

func (c *EthereumRPCClient) ChainID(ctx context.Context) (string, error) {
	return NewRequest[string](c.RPCNamespace, "eth_chainId", []any{}).Send(ctx)
}

func (c *EthereumRPCClient) BlockNumber(ctx context.Context) (string, error) {
	return NewRequest[string](c.RPCNamespace, "eth_blockNumber", []any{}).Send(ctx)
}

func (c *EthereumRPCClient) GetBalance(ctx context.Context, address, block string) (string, error) {
	return NewRequest[string](c.RPCNamespace, "eth_getBalance", []any{address, block}).Send(ctx)
}

func (c *EthereumRPCClient) GetBlockByNumber(ctx context.Context, block string, fullTransactions bool) (json.RawMessage, error) {
	return NewRequest[json.RawMessage](c.RPCNamespace, "eth_getBlockByNumber", []any{block, fullTransactions}).Send(ctx)
}

func (c *EthereumRPCClient) Call(ctx context.Context, transaction any, block string) (string, error) {
	return NewRequest[string](c.RPCNamespace, "eth_call", []any{transaction, block}).Send(ctx)
}

// SendRawTransaction is attempted exactly once. The SDK never retries it.
func (c *EthereumRPCClient) SendRawTransaction(ctx context.Context, transaction string) (string, error) {
	return NewRequest[string](c.RPCNamespace, "eth_sendRawTransaction", []any{transaction}).Send(ctx)
}

func positional(values []any) []any {
	if values == nil {
		return []any{}
	}
	return values
}
