package erpc

import "context"

// ArbitrumClient groups Arbitrum's sealed read namespace.
type ArbitrumClient struct {
	RPC *ArbitrumRPCClient
}

// ArbitrumRPCClient exposes only eth_chainId, eth_getBalance and eth_call.
type ArbitrumRPCClient struct {
	transport *c1HTTPTransport
	facts     c1EVMFacts
}

func newArbitrumClient(transport *c1HTTPTransport, facts c1EVMFacts) *ArbitrumClient {
	return &ArbitrumClient{RPC: &ArbitrumRPCClient{transport: transport, facts: facts}}
}

// Endpoint returns the origin-only diagnostic for the configured endpoint.
func (client *ArbitrumRPCClient) Endpoint() string {
	if client == nil || client.transport == nil {
		return ""
	}
	return client.transport.publicEndpoint
}

func (client *ArbitrumRPCClient) request(ctx context.Context, publicName string, params ...any) (string, error) {
	method, err := client.facts.wire(publicName)
	if err != nil {
		return "", err
	}
	return client.transport.requestEVM(ctx, method, params)
}

// EthChainID reads eth_chainId.
func (client *ArbitrumRPCClient) EthChainID(ctx context.Context) (string, error) {
	return client.request(ctx, "EthChainID")
}

// EthGetBalance reads eth_getBalance with positional parameters.
func (client *ArbitrumRPCClient) EthGetBalance(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthGetBalance", params...)
}

// EthCall reads eth_call with positional parameters.
func (client *ArbitrumRPCClient) EthCall(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthCall", params...)
}
