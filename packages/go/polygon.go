package erpc

import "context"

type PolygonClient struct{ RPC *PolygonRPCClient }
type PolygonRPCClient struct {
	transport *c1HTTPTransport
	facts     c1EVMFacts
}

func newPolygonClient(transport *c1HTTPTransport, facts c1EVMFacts) *PolygonClient {
	return &PolygonClient{RPC: &PolygonRPCClient{transport: transport, facts: facts}}
}
func (client *PolygonRPCClient) Endpoint() string { return c1EVMEndpoint(client.transport) }
func (client *PolygonRPCClient) request(ctx context.Context, name string, params ...any) (string, error) {
	return c1EVMRequest(client.transport, client.facts, ctx, name, params...)
}
func (client *PolygonRPCClient) EthChainID(ctx context.Context) (string, error) {
	return client.request(ctx, "EthChainID")
}
func (client *PolygonRPCClient) EthGetBalance(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthGetBalance", params...)
}
func (client *PolygonRPCClient) EthCall(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthCall", params...)
}
