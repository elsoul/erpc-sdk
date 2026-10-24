package erpc

import "context"

type HyperliquidClient struct{ RPC *HyperliquidRPCClient }
type HyperliquidRPCClient struct {
	transport *c1HTTPTransport
	facts     c1EVMFacts
}

func newHyperliquidClient(transport *c1HTTPTransport, facts c1EVMFacts) *HyperliquidClient {
	return &HyperliquidClient{RPC: &HyperliquidRPCClient{transport: transport, facts: facts}}
}
func (client *HyperliquidRPCClient) Endpoint() string { return c1EVMEndpoint(client.transport) }
func (client *HyperliquidRPCClient) request(ctx context.Context, name string, params ...any) (string, error) {
	return c1EVMRequest(client.transport, client.facts, ctx, name, params...)
}
func (client *HyperliquidRPCClient) EthChainID(ctx context.Context) (string, error) {
	return client.request(ctx, "EthChainID")
}
func (client *HyperliquidRPCClient) EthGetBalance(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthGetBalance", params...)
}
func (client *HyperliquidRPCClient) EthCall(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthCall", params...)
}
