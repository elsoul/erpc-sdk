package erpc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestWebSocketSubscriptionLifecycle(t *testing.T) {
	const key = "ws-key"
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/eth" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("api-key") != key {
			t.Errorf("api key = %q", r.URL.Query().Get("api-key"))
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		for {
			var request wireRequest
			if err := conn.ReadJSON(&request); err != nil {
				return
			}
			switch request.Method {
			case "eth_subscribe":
				_ = conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": "sub-1"})
				_ = conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "method": "eth_subscription", "params": map[string]any{"subscription": "sub-1", "result": map[string]any{"number": "0x2a"}}})
			case "eth_unsubscribe":
				_ = conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": true})
			}
		}
	}))
	defer server.Close()
	client, err := NewClient(Config{APIKey: key, Endpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if endpoint := client.Ethereum.Subscriptions.Endpoint(); endpoint == "" || strings.Contains(endpoint, key) {
		t.Fatalf("public endpoint = %q", endpoint)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	subscription, err := client.Ethereum.Subscriptions.Subscribe(ctx, "newHeads")
	if err != nil {
		t.Fatal(err)
	}
	var header struct {
		Number string `json:"number"`
	}
	if err := subscription.Next(ctx, &header); err != nil {
		t.Fatal(err)
	}
	if header.Number != "0x2a" {
		t.Fatalf("header = %#v", header)
	}
	if ok, err := subscription.Unsubscribe(ctx); err != nil || !ok {
		t.Fatalf("unsubscribe = %v, %v", ok, err)
	}
	if ok, err := subscription.Unsubscribe(ctx); err != nil || !ok {
		t.Fatalf("second unsubscribe = %v, %v", ok, err)
	}
	var id string
	if err := json.Unmarshal(subscription.ID, &id); err != nil || id != "sub-1" {
		t.Fatalf("subscription id = %q, %v", id, err)
	}
}
