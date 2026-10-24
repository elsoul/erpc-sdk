package erpc

import "context"

type SoneiumClient struct{ RPC *SoneiumRPCClient }
type SoneiumRPCClient struct {
	transport *c1HTTPTransport
	facts     c1EVMFacts
}

func newSoneiumClient(transport *c1HTTPTransport, facts c1EVMFacts) *SoneiumClient {
	return &SoneiumClient{RPC: &SoneiumRPCClient{transport: transport, facts: facts}}
}
func (client *SoneiumRPCClient) Endpoint() string { return c1EVMEndpoint(client.transport) }
func (client *SoneiumRPCClient) request(ctx context.Context, name string, params ...any) (string, error) {
	return c1EVMRequest(client.transport, client.facts, ctx, name, params...)
}
func (client *SoneiumRPCClient) EthChainID(ctx context.Context) (string, error) {
	return client.request(ctx, "EthChainID")
}
func (client *SoneiumRPCClient) EthGetBalance(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthGetBalance", params...)
}
func (client *SoneiumRPCClient) EthCall(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthCall", params...)
}
