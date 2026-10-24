package erpc

import "context"

type OptimismClient struct{ RPC *OptimismRPCClient }
type OptimismRPCClient struct {
	transport *c1HTTPTransport
	facts     c1EVMFacts
}

func newOptimismClient(transport *c1HTTPTransport, facts c1EVMFacts) *OptimismClient {
	return &OptimismClient{RPC: &OptimismRPCClient{transport: transport, facts: facts}}
}
func (client *OptimismRPCClient) Endpoint() string { return c1EVMEndpoint(client.transport) }
func (client *OptimismRPCClient) request(ctx context.Context, name string, params ...any) (string, error) {
	return c1EVMRequest(client.transport, client.facts, ctx, name, params...)
}
func (client *OptimismRPCClient) EthChainID(ctx context.Context) (string, error) {
	return client.request(ctx, "EthChainID")
}
func (client *OptimismRPCClient) EthGetBalance(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthGetBalance", params...)
}
func (client *OptimismRPCClient) EthCall(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthCall", params...)
}
