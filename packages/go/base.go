package erpc

import "context"

type c1EVMFacts struct {
	methods map[string]string
}

func c1EVMEndpoint(transport *c1HTTPTransport) string {
	if transport == nil {
		return ""
	}
	return transport.publicEndpoint
}

func c1EVMRequest(transport *c1HTTPTransport, facts c1EVMFacts, ctx context.Context, publicName string, params ...any) (string, error) {
	method, err := facts.wire(publicName)
	if err != nil {
		return "", err
	}
	return transport.requestEVM(ctx, method, params)
}

func (facts c1EVMFacts) wire(publicName string) (string, error) {
	method, ok := facts.methods[publicName]
	if !ok || method == "" {
		return "", sdkError(ErrorConfig, "sealed EVM method is absent from the accepted contract")
	}
	return method, nil
}

// BaseClient groups Base's sealed read namespace.
type BaseClient struct {
	RPC *BaseRPCClient
}

// BaseRPCClient exposes only eth_chainId, eth_getBalance and eth_call.
type BaseRPCClient struct {
	transport *c1HTTPTransport
	facts     c1EVMFacts
}

func newBaseClient(transport *c1HTTPTransport, facts c1EVMFacts) *BaseClient {
	return &BaseClient{RPC: &BaseRPCClient{transport: transport, facts: facts}}
}

// Endpoint returns the origin-only diagnostic for the configured endpoint.
func (client *BaseRPCClient) Endpoint() string {
	if client == nil {
		return ""
	}
	return c1EVMEndpoint(client.transport)
}

func (client *BaseRPCClient) request(ctx context.Context, publicName string, params ...any) (string, error) {
	method, err := client.facts.wire(publicName)
	if err != nil {
		return "", err
	}
	return client.transport.requestEVM(ctx, method, params)
}

// EthChainID reads eth_chainId.
func (client *BaseRPCClient) EthChainID(ctx context.Context) (string, error) {
	return client.request(ctx, "EthChainID")
}

// EthGetBalance reads eth_getBalance with positional parameters.
func (client *BaseRPCClient) EthGetBalance(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthGetBalance", params...)
}

// EthCall reads eth_call with positional parameters.
func (client *BaseRPCClient) EthCall(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthCall", params...)
}
