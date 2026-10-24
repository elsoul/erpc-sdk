package erpc

import "context"

type c1BitcoinFacts struct {
	methods map[string]string
}

func (facts c1BitcoinFacts) wire(publicName string) (string, error) {
	method, ok := facts.methods[publicName]
	if !ok || method == "" {
		return "", sdkError(ErrorConfig, "Bitcoin method is absent from the accepted contract")
	}
	return method, nil
}

// BitcoinClient exposes the sealed Bitcoin JSON-RPC read namespace.
type BitcoinClient struct {
	RPC *BitcoinRPCClient
}

// BitcoinRPCClient exposes only the twelve approved Bitcoin read helpers.
// The transport and generic RPC namespace remain private by design.
type BitcoinRPCClient struct {
	transport *c1HTTPTransport
	facts     c1BitcoinFacts
}

func newBitcoinClient(transport *c1HTTPTransport, facts c1BitcoinFacts) *BitcoinClient {
	return &BitcoinClient{RPC: &BitcoinRPCClient{transport: transport, facts: facts}}
}

// Endpoint returns the origin-only diagnostic for the configured endpoint.
func (client *BitcoinRPCClient) Endpoint() string {
	if client == nil || client.transport == nil {
		return ""
	}
	return client.transport.publicEndpoint
}

func (client *BitcoinRPCClient) request(ctx context.Context, publicName string, params ...any) (any, error) {
	method, err := client.facts.wire(publicName)
	if err != nil {
		return nil, err
	}
	return client.transport.requestBitcoin(ctx, method, params)
}

// EstimateSmartFee reads estimatesmartfee with positional parameters.
func (client *BitcoinRPCClient) EstimateSmartFee(ctx context.Context, params ...any) (any, error) {
	return client.request(ctx, "EstimateSmartFee", params...)
}

// GetBestBlockHash reads getbestblockhash.
func (client *BitcoinRPCClient) GetBestBlockHash(ctx context.Context) (string, error) {
	value, err := client.request(ctx, "GetBestBlockHash")
	if err != nil {
		return "", err
	}
	return asBitcoinString(value)
}

// GetBlock reads getblock with positional parameters.
func (client *BitcoinRPCClient) GetBlock(ctx context.Context, params ...any) (any, error) {
	return client.request(ctx, "GetBlock", params...)
}

// GetBlockchainInfo reads getblockchaininfo.
func (client *BitcoinRPCClient) GetBlockchainInfo(ctx context.Context) (any, error) {
	return client.request(ctx, "GetBlockchainInfo")
}

// GetBlockCount reads an unsigned integer token into uint64.
func (client *BitcoinRPCClient) GetBlockCount(ctx context.Context) (uint64, error) {
	value, err := client.request(ctx, "GetBlockCount")
	if err != nil {
		return 0, err
	}
	return asBitcoinBlockCount(value)
}

// GetBlockHash reads getblockhash with positional parameters.
func (client *BitcoinRPCClient) GetBlockHash(ctx context.Context, params ...any) (string, error) {
	value, err := client.request(ctx, "GetBlockHash", params...)
	if err != nil {
		return "", err
	}
	return asBitcoinString(value)
}

// GetBlockHeader reads getblockheader with positional parameters.
func (client *BitcoinRPCClient) GetBlockHeader(ctx context.Context, params ...any) (any, error) {
	return client.request(ctx, "GetBlockHeader", params...)
}

// GetMempoolInfo reads getmempoolinfo.
func (client *BitcoinRPCClient) GetMempoolInfo(ctx context.Context) (any, error) {
	return client.request(ctx, "GetMempoolInfo")
}

// GetNetworkInfo reads getnetworkinfo.
func (client *BitcoinRPCClient) GetNetworkInfo(ctx context.Context) (any, error) {
	return client.request(ctx, "GetNetworkInfo")
}

// GetRawMempool reads getrawmempool with positional parameters.
func (client *BitcoinRPCClient) GetRawMempool(ctx context.Context, params ...any) (any, error) {
	return client.request(ctx, "GetRawMempool", params...)
}

// GetRawTransaction reads getrawtransaction with positional parameters.
func (client *BitcoinRPCClient) GetRawTransaction(ctx context.Context, params ...any) (any, error) {
	return client.request(ctx, "GetRawTransaction", params...)
}

// GetTxOut reads gettxout.  A nil result is a valid Bitcoin response.
func (client *BitcoinRPCClient) GetTxOut(ctx context.Context, params ...any) (any, error) {
	value, err := client.request(ctx, "GetTxOut", params...)
	if err != nil {
		return nil, err
	}
	return asBitcoinNullableObject(value)
}
