package erpc

import (
	"context"
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

func TestCloudRejectsPlainHTTPOutsideLocalhost(t *testing.T) {
	_, err := NewCloudClient(CloudConfig{AccessToken: "token", Endpoint: "http://example.com"})
	if err == nil {
		t.Fatal("expected configuration error")
	}
}
