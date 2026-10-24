package erpc

import "context"

type BscClient struct{ RPC *BscRPCClient }
type BscRPCClient struct {
	transport *c1HTTPTransport
	facts     c1EVMFacts
}

func newBscClient(transport *c1HTTPTransport, facts c1EVMFacts) *BscClient {
	return &BscClient{RPC: &BscRPCClient{transport: transport, facts: facts}}
}
func (client *BscRPCClient) Endpoint() string { return c1EVMEndpoint(client.transport) }
func (client *BscRPCClient) request(ctx context.Context, name string, params ...any) (string, error) {
	return c1EVMRequest(client.transport, client.facts, ctx, name, params...)
}
func (client *BscRPCClient) EthChainID(ctx context.Context) (string, error) {
	return client.request(ctx, "EthChainID")
}
func (client *BscRPCClient) EthGetBalance(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthGetBalance", params...)
}
func (client *BscRPCClient) EthCall(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthCall", params...)
}
