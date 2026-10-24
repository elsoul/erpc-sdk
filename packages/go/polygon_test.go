package erpc

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

type sealedEVMTestClient interface {
	Endpoint() string
	EthChainID(context.Context) (string, error)
	EthGetBalance(context.Context, ...any) (string, error)
	EthCall(context.Context, ...any) (string, error)
}

func testLaterEVM(t *testing.T, name string, build func(*c1HTTPTransport, c1EVMFacts) sealedEVMTestClient) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer direct-secret" {
			t.Errorf("%s authorization = %q", name, request.Header.Get("Authorization"))
		}
		var body c1WireRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("%s request decode: %v", name, err)
		}
		_, _ = fmt.Fprintf(response, `{"jsonrpc":"2.0","id":%d,"result":"0x123"}`, body.ID)
	}))
	defer server.Close()
	resolved, err := resolveConfig(Config{APIKey: "legacy", HTTPClient: &http.Client{}})
	if err != nil {
		t.Fatal(err)
	}
	direct, err := resolveSealedRPCEndpoint(&RPCEndpointConfig{HTTPURL: server.URL + "/tenant%2Fone?token=a%2Fb", Headers: http.Header{"Authorization": {"Bearer direct-secret"}}}, name+"RPC")
	if err != nil {
		t.Fatal(err)
	}
	facts := c1EVMFacts{methods: evmTestFacts().methods}
	transport := newC1EVMTransport(resolved, nil, direct, c1MethodFacts{methods: facts.methods}, name+".rpc")
	client := build(transport, facts)
	if got, err := client.EthChainID(context.Background()); err != nil || got != "0x123" {
		t.Fatalf("%s chain ID = %q, %v", name, got, err)
	}
	if got, err := client.EthGetBalance(context.Background(), "0xabc", "latest"); err != nil || got != "0x123" {
		t.Fatalf("%s balance = %q, %v", name, got, err)
	}
	if got, err := client.EthCall(context.Background(), map[string]any{"to": "0xabc"}, "latest"); err != nil || got != "0x123" {
		t.Fatalf("%s call = %q, %v", name, got, err)
	}
	if !strings.HasPrefix(client.Endpoint(), "http://127.0.0.1:") || !strings.HasSuffix(client.Endpoint(), "/") {
		t.Fatalf("%s endpoint = %q", name, client.Endpoint())
	}
}

func TestPolygonSealedReads(t *testing.T) {
	testLaterEVM(t, "polygon", func(transport *c1HTTPTransport, facts c1EVMFacts) sealedEVMTestClient {
		return newPolygonClient(transport, facts).RPC
	})
	if got := reflect.TypeOf((*PolygonRPCClient)(nil)).NumMethod(); got != 4 {
		t.Fatalf("Polygon methods = %d", got)
	}
}

func TestNewClientWiresLaterHostedDefaultsFromGeneratedFacts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var body c1WireRequest
		decoder := json.NewDecoder(request.Body)
		decoder.UseNumber()
		if err := decoder.Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Method == "eth_chainId" {
			_, _ = fmt.Fprintf(response, `{"jsonrpc":"2.0","id":%d,"result":"0x89"}`, body.ID)
			return
		}
		_, _ = fmt.Fprintf(response, `{"jsonrpc":"2.0","id":%d,"result":{"chain_id":"mainnet","genesis_hash":"genesis","latest_protocol_version":1,"protocol_version":1,"sync_info":{"latest_block_hash":"head","latest_block_height":1,"latest_block_time":"now","latest_state_root":"root","syncing":false},"version":{"version":"1","build":"b"}}}`, body.ID)
	}))
	defer server.Close()
	client, err := NewClient(Config{APIKey: "key", PolygonEndpoint: server.URL, NearEndpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := client.Polygon.RPC.EthChainID(context.Background()); err != nil || got != "0x89" {
		t.Fatalf("Polygon = %q, %v", got, err)
	}
	if status, err := client.Near.RPC.Status(context.Background()); err != nil || status.ChainID != "mainnet" {
		t.Fatalf("NEAR = %#v, %v", status, err)
	}
}
