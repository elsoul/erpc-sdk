package erpc

import "context"

type KaiaClient struct{ RPC *KaiaRPCClient }
type KaiaRPCClient struct {
	transport *c1HTTPTransport
	facts     c1EVMFacts
}

func newKaiaClient(transport *c1HTTPTransport, facts c1EVMFacts) *KaiaClient {
	return &KaiaClient{RPC: &KaiaRPCClient{transport: transport, facts: facts}}
}
func (client *KaiaRPCClient) Endpoint() string { return c1EVMEndpoint(client.transport) }
func (client *KaiaRPCClient) request(ctx context.Context, name string, params ...any) (string, error) {
	return c1EVMRequest(client.transport, client.facts, ctx, name, params...)
}
func (client *KaiaRPCClient) EthChainID(ctx context.Context) (string, error) {
	return client.request(ctx, "EthChainID")
}
func (client *KaiaRPCClient) EthGetBalance(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthGetBalance", params...)
}
func (client *KaiaRPCClient) EthCall(ctx context.Context, params ...any) (string, error) {
	return client.request(ctx, "EthCall", params...)
}
