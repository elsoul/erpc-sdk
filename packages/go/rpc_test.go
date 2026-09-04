package erpc

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestTypedRequestAndCredentialBoundary(t *testing.T) {
	const key = "secret key/value"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("api-key"); got != key {
			t.Errorf("api key = %q", got)
		}
		if got := r.Header.Get("X-Test"); got != "present" {
			t.Errorf("header = %q", got)
		}
		var request wireRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if request.Method != "getSlot" {
			t.Errorf("method = %q", request.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": 42})
	}))
	defer server.Close()
	client, err := NewClient(Config{APIKey: key, Endpoint: server.URL, Headers: http.Header{"X-Test": {"present"}}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(client.Solana.RPC.Endpoint(), "api-key") || strings.Contains(client.Solana.RPC.Endpoint(), key) {
		t.Fatal("public endpoint contains credentials")
	}
	slot, err := client.Solana.RPC.GetSlot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if slot != 42 {
		t.Fatalf("slot = %d", slot)
	}
}

func TestAvalancheUsesCChainEndpoint(t *testing.T) {
	const key = "avalanche-key"
	defaults, err := resolveConfig(Config{APIKey: key})
	if err != nil {
		t.Fatal(err)
	}
	if got := defaults.avalancheEndpoint.String(); got != DefaultAvalancheEndpoint {
		t.Fatalf("default Avalanche endpoint = %q", got)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ava" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if got := r.URL.Query().Get("api-key"); got != key {
			t.Errorf("api key = %q", got)
		}
		var request wireRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if request.Method != "eth_chainId" {
			t.Errorf("method = %q", request.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": request.ID, "result": "0xa86a",
		})
	}))
	defer server.Close()
	client, err := NewClient(Config{APIKey: key, AvalancheEndpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if got, want := client.Avalanche.Subscriptions.Endpoint(), "ws"+strings.TrimPrefix(server.URL, "http")+"/ava-ws"; got != want {
		t.Fatalf("Avalanche WebSocket endpoint = %q, want %q", got, want)
	}
	chainID, err := client.Avalanche.RPC.ChainID(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if chainID != "0xa86a" {
		t.Fatalf("chain id = %q", chainID)
	}
	if strings.Contains(client.Avalanche.RPC.Endpoint(), key) {
		t.Fatal("public endpoint contains credentials")
	}
}

func TestBatchOrderAndPolicy(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var batch []wireRequest
		if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
			t.Fatal(err)
		}
		responses := []map[string]any{
			{"jsonrpc": "2.0", "id": batch[1].ID, "result": "second"},
			{"jsonrpc": "2.0", "id": batch[0].ID, "result": "first"},
		}
		_ = json.NewEncoder(w).Encode(responses)
	}))
	defer server.Close()
	client, err := NewClient(Config{APIKey: "test", Endpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	results, err := client.Solana.RPC.Batch(context.Background(), []BatchCall{{Method: "getSlot", Params: []any{}}, {Method: "getHealth", Params: []any{}}})
	if err != nil {
		t.Fatal(err)
	}
	first, err := decodeRaw[string](results[0])
	if err != nil {
		t.Fatal(err)
	}
	second, err := decodeRaw[string](results[1])
	if err != nil {
		t.Fatal(err)
	}
	if first != "first" || second != "second" {
		t.Fatalf("results = %q, %q", first, second)
	}
	_, err = client.Solana.RPC.Batch(context.Background(), []BatchCall{{Method: "getProgramAccounts"}, {Method: "getSlot"}})
	var sdkErr *Error
	if !errors.As(err, &sdkErr) || sdkErr.Kind != ErrorBatchPolicy {
		t.Fatalf("error = %#v", err)
	}
	if requests.Load() != 1 {
		t.Fatalf("requests = %d", requests.Load())
	}
}

func TestBatchRejectsUnexpectedResponseIDWithoutExposingIt(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var batch []wireRequest
		if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
			t.Fatal(err)
		}
		responses := []map[string]any{
			{"jsonrpc": "2.0", "id": batch[0].ID, "result": "first"},
			{"jsonrpc": "2.0", "id": batch[1].ID, "result": "second"},
			{"jsonrpc": "2.0", "id": 999999, "result": "unexpected"},
		}
		_ = json.NewEncoder(w).Encode(responses)
	}))
	defer server.Close()
	client, err := NewClient(Config{APIKey: "test", Endpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Ethereum.RPC.Batch(context.Background(), []BatchCall{{Method: "eth_chainId"}, {Method: "eth_blockNumber"}})
	var sdkErr *Error
	if !errors.As(err, &sdkErr) || sdkErr.Kind != ErrorInvalidResponse {
		t.Fatalf("error = %#v", err)
	}
	if !strings.Contains(err.Error(), "unexpected batch response id") || strings.Contains(err.Error(), "999999") {
		t.Fatalf("unsafe error = %q", err)
	}
}

func TestStateChangingRequestIsNotRetriedAndRPCErrorIsRedacted(t *testing.T) {
	const key = "credential-to-hide"
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var request wireRequest
		_ = json.NewDecoder(r.Body).Decode(&request)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": request.ID,
			"error": map[string]any{"code": -32000, "message": "rejected " + key, "data": "https://example.invalid/?api-key=" + key},
		})
	}))
	defer server.Close()
	client, err := NewClient(Config{APIKey: key, Endpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Solana.RPC.SendTransaction(context.Background(), "transaction")
	if err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(err.Error(), key) {
		t.Fatal("error string contains credential")
	}
	var sdkErr *Error
	if !errors.As(err, &sdkErr) || strings.Contains(string(sdkErr.Data), key) {
		t.Fatal("error data contains credential")
	}
	if requests.Load() != 1 {
		t.Fatalf("requests = %d", requests.Load())
	}
}

func TestMethodCatalogCounts(t *testing.T) {
	counts := []int{len(SolanaRPCMethods), len(SolanaDASMethods), len(SolanaHistoryMethods), len(SolanaLeaderMethods), len(SolanaAnalyticsMethods), len(SolanaEnhancedSubscriptionMethods), len(EthereumRPCMethods), len(EthereumSubscriptionMethods)}
	want := []int{55, 14, 2, 2, 5, 4, 53, 2}
	for i := range want {
		if counts[i] != want[i] {
			t.Fatalf("catalog %d count = %d", i, counts[i])
		}
	}
}
