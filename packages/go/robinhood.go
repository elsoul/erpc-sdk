package erpc

import "context"

type RobinhoodClient struct{ RPC *RobinhoodRPCClient }
type RobinhoodRPCClient struct {
	transport *c1HTTPTransport
	facts     c1EVMFacts
}

func newRobinhoodClient(transport *c1HTTPTransport, facts c1EVMFacts) *RobinhoodClient {
	return &RobinhoodClient{RPC: &RobinhoodRPCClient{transport: transport, facts: facts}}
}
func (client *RobinhoodRPCClient) Endpoint() string { return c1EVMEndpoint(client.transport) }
func (client *RobinhoodRPCClient) request(ctx context.Context, name string, params ...any) (string, error) {
	return c1EVMRequest(client.transport, client.facts, ctx, name, params...)
}
func (client *RobinhoodRPCClient) EthChainID(ctx context.Context) (string, error) {
	return client.request(ctx, "EthChainID")
}
func (client *RobinhoodRPCClient) EthGetBalance(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthGetBalance", params...)
}
func (client *RobinhoodRPCClient) EthCall(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthCall", params...)
}
