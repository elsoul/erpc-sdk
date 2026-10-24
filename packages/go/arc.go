package erpc

import "context"

type ArcClient struct{ RPC *ArcRPCClient }
type ArcRPCClient struct {
	transport *c1HTTPTransport
	facts     c1EVMFacts
}

func newArcClient(transport *c1HTTPTransport, facts c1EVMFacts) *ArcClient {
	return &ArcClient{RPC: &ArcRPCClient{transport: transport, facts: facts}}
}
func (client *ArcRPCClient) Endpoint() string { return c1EVMEndpoint(client.transport) }
func (client *ArcRPCClient) request(ctx context.Context, name string, params ...any) (string, error) {
	return c1EVMRequest(client.transport, client.facts, ctx, name, params...)
}
func (client *ArcRPCClient) EthChainID(ctx context.Context) (string, error) {
	return client.request(ctx, "EthChainID")
}
func (client *ArcRPCClient) EthGetBalance(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthGetBalance", params...)
}
func (client *ArcRPCClient) EthCall(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthCall", params...)
}
