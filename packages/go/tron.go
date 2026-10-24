package erpc

import "context"

type TronClient struct{ RPC *TronRPCClient }
type TronRPCClient struct {
	transport *c1HTTPTransport
	facts     c1EVMFacts
}

func newTronClient(transport *c1HTTPTransport, facts c1EVMFacts) *TronClient {
	return &TronClient{RPC: &TronRPCClient{transport: transport, facts: facts}}
}
func (client *TronRPCClient) Endpoint() string { return c1EVMEndpoint(client.transport) }
func (client *TronRPCClient) request(ctx context.Context, name string, params ...any) (string, error) {
	return c1EVMRequest(client.transport, client.facts, ctx, name, params...)
}
func (client *TronRPCClient) EthChainID(ctx context.Context) (string, error) {
	return client.request(ctx, "EthChainID")
}
func (client *TronRPCClient) EthGetBalance(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthGetBalance", params...)
}
func (client *TronRPCClient) EthCall(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthCall", params...)
}
