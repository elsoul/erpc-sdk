package erpc

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRESTBearerAndSSE(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		switch r.URL.Path {
		case "/v3/erpc/token-balance":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"max_tokens":100,"next_refill_at":null,"plan":"pro","remaining_tokens":75}`))
		case "/v2/updates/price/stream":
			if r.URL.Query()["ids[]"][0] != "feed" {
				t.Error("missing repeated id")
			}
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("id: one\nevent: update\ndata: {\"binary\":{\"data\":[\"value\"],\"encoding\":\"base64\"}}\n\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client, err := NewClient(Config{APIKey: "token", Endpoint: server.URL, AccountEndpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	balance, err := client.Account.GetTokenBalance(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if balance.RemainingTokens != 75 {
		t.Fatalf("balance = %#v", balance)
	}
	stream, err := client.Price.StreamPriceUpdates(context.Background(), PriceStreamOptions{PriceUpdateOptions: PriceUpdateOptions{IDs: []string{"feed"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	event, err := stream.Next()
	if err != nil {
		t.Fatal(err)
	}
	if event.ID != "one" || event.Event != "update" || len(event.Data.Binary.Data) != 1 {
		t.Fatalf("event = %#v", event)
	}
}

func TestDirectRPCHeadersStayScopedAwayFromLegacyREST(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/direct":
			if got := r.Header.Get("X-Direct"); got != "solana" {
				t.Errorf("direct header = %q", got)
			}
			if got := r.Header.Get("X-Global"); got != "" {
				t.Errorf("global header leaked to direct RPC = %q", got)
			}
			if got := r.URL.Query().Get("api-key"); got != "" {
				t.Errorf("direct api key = %q", got)
			}
			var request wireRequest
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Fatal(err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0", "id": request.ID, "result": uint64(7),
			})
		case "/v3/erpc/token-balance":
			if got := r.Header.Get("X-Global"); got != "shared" {
				t.Errorf("REST global header = %q", got)
			}
			if got := r.Header.Get("X-Direct"); got != "" {
				t.Errorf("direct header leaked to REST = %q", got)
			}
			if got := r.Header.Get("Authorization"); got != "Bearer shared-key" {
				t.Errorf("REST authorization = %q", got)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"max_tokens": 10, "next_refill_at": nil, "plan": "pro", "remaining_tokens": 9,
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client, err := NewClient(Config{
		APIKey:          "shared-key",
		Endpoint:        server.URL,
		AccountEndpoint: server.URL,
		Headers:         http.Header{"X-Global": {"shared"}},
		SolanaRPC: &RPCEndpointConfig{
			HTTPURL: server.URL + "/direct?token=direct",
			Headers: http.Header{"X-Direct": {"solana"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if slot, err := client.Solana.RPC.GetSlot(context.Background()); err != nil || slot != 7 {
		t.Fatalf("direct slot = %d, %v", slot, err)
	}
	balance, err := client.Account.GetTokenBalance(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if balance.RemainingTokens != 9 {
		t.Fatalf("REST balance = %#v", balance)
	}
}

func TestCloudRejectsPlainHTTPOutsideLocalhost(t *testing.T) {
	_, err := NewCloudClient(CloudConfig{AccessToken: "token", Endpoint: "http://example.com"})
	if err == nil {
		t.Fatal("expected configuration error")
	}
}

func TestKeylessUnconfiguredRESTAndNativeNamespacesFailWithoutIO(t *testing.T) {
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		t.Fatalf("unexpected request to %s", r.URL)
	}))
	defer server.Close()
	client, err := NewClient(Config{
		SolanaRPC:  &RPCEndpointConfig{HTTPURL: server.URL + "/solana"},
		HTTPClient: server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	checks := []struct {
		name      string
		namespace string
		call      func() error
	}{
		{
			name: "ethereum rpc", namespace: "ethereum.rpc",
			call: func() error {
				_, err := client.Ethereum.RPC.ChainID(context.Background())
				return err
			},
		},
		{
			name: "avalanche native", namespace: "avalanche.xChain",
			call: func() error {
				var result json.RawMessage
				return client.Avalanche.XChain.Request(context.Background(), "getHeight", nil, &result)
			},
		},
		{
			name: "price", namespace: "price",
			call: func() error {
				_, err := client.Price.GetPriceFeeds(context.Background(), "", "")
				return err
			},
		},
		{
			name: "price stream", namespace: "price",
			call: func() error {
				stream, err := client.Price.StreamPriceUpdates(context.Background(), PriceStreamOptions{})
				if stream != nil {
					_ = stream.Close()
				}
				return err
			},
		},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			err := check.call()
			var sdkErr *Error
			if !errors.As(err, &sdkErr) || sdkErr.Kind != ErrorNotConfigured {
				t.Fatalf("error = %#v", err)
			}
			if sdkErr.Namespace != check.namespace {
				t.Fatalf("namespace = %q, want %q", sdkErr.Namespace, check.namespace)
			}
		})
	}
	if requests != 0 {
		t.Fatalf("unexpected request count = %d", requests)
	}
}
