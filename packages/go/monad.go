package erpc

import "context"

type MonadClient struct{ RPC *MonadRPCClient }
type MonadRPCClient struct {
	transport *c1HTTPTransport
	facts     c1EVMFacts
}

func newMonadClient(transport *c1HTTPTransport, facts c1EVMFacts) *MonadClient {
	return &MonadClient{RPC: &MonadRPCClient{transport: transport, facts: facts}}
}
func (client *MonadRPCClient) Endpoint() string { return c1EVMEndpoint(client.transport) }
func (client *MonadRPCClient) request(ctx context.Context, name string, params ...any) (string, error) {
	return c1EVMRequest(client.transport, client.facts, ctx, name, params...)
}
func (client *MonadRPCClient) EthChainID(ctx context.Context) (string, error) {
	return client.request(ctx, "EthChainID")
}
func (client *MonadRPCClient) EthGetBalance(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthGetBalance", params...)
}
func (client *MonadRPCClient) EthCall(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthCall", params...)
}
