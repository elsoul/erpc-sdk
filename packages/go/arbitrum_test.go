package erpc

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestArbitrumDirectFacadeUsesOnlyThreeReads(t *testing.T) {
	var methods []string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var body c1WireRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("request decode: %v", err)
		}
		methods = append(methods, body.Method)
		_, _ = fmt.Fprintf(response, `{"jsonrpc":"2.0","id":%d,"result":"0xa4b1"}`, body.ID)
	}))
	defer server.Close()

	resolved, err := resolveConfig(Config{APIKey: "legacy-key"})
	if err != nil {
		t.Fatalf("resolveConfig() error = %v", err)
	}
	direct, err := resolveRPCEndpoint(&RPCEndpointConfig{HTTPURL: server.URL + "/arbitrum?region=us"}, "ArbitrumRPC")
	if err != nil {
		t.Fatalf("resolveRPCEndpoint() error = %v", err)
	}
	facts := evmTestFacts()
	transport := newC1EVMTransport(resolved, nil, direct, c1MethodFacts{methods: facts.methods}, "arbitrum.rpc")
	client := newArbitrumClient(transport, facts)
	if got, err := client.RPC.EthChainID(context.Background()); err != nil || got != "0xa4b1" {
		t.Fatalf("EthChainID() = %q, %v", got, err)
	}
	if got, err := client.RPC.EthGetBalance(context.Background(), "0xabc", "latest"); err != nil || got != "0xa4b1" {
		t.Fatalf("EthGetBalance() = %q, %v", got, err)
	}
	if got, err := client.RPC.EthCall(context.Background(), map[string]any{"to": "0xabc"}, "latest"); err != nil || got != "0xa4b1" {
		t.Fatalf("EthCall() = %q, %v", got, err)
	}
	if want := []string{"eth_chainId", "eth_getBalance", "eth_call"}; !sameStringSlice(methods, want) {
		t.Fatalf("methods = %#v, want %#v", methods, want)
	}
}

func sameStringSlice(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}
