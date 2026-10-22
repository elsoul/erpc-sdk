package erpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
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

func TestDirectWebSocketUsesExplicitTargetWithoutAPIKey(t *testing.T) {
	const apiKey = "shared-secret"
	var requests atomic.Int32
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/customer/socket" {
			http.NotFound(w, r)
			return
		}
		if got := r.URL.Query().Get("token"); got != "ws/x" {
			t.Errorf("websocket token = %q", got)
		}
		if got := r.URL.Query().Get("api-key"); got != "" {
			t.Errorf("websocket api key = %q", got)
		}
		requests.Add(1)
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
				_ = conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": "direct-sub"})
				_ = conn.WriteJSON(map[string]any{
					"jsonrpc": "2.0", "method": "eth_subscription",
					"params": map[string]any{"subscription": "direct-sub", "result": map[string]any{"number": "0x2a"}},
				})
			case "eth_unsubscribe":
				_ = conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": true})
			}
		}
	}))
	defer server.Close()
	directWebSocketURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/customer/socket?token=ws%2Fx"
	client, err := NewClient(Config{
		APIKey: apiKey,
		EthereumRPC: &RPCEndpointConfig{
			HTTPURL:      server.URL + "/customer/rpc?token=http%2Fsecret",
			WebSocketURL: directWebSocketURL,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if got, want := client.Ethereum.Subscriptions.Endpoint(), "ws"+strings.TrimPrefix(server.URL, "http")+"/customer/socket"; got != want {
		t.Fatalf("public websocket endpoint = %q, want %q", got, want)
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
	if requests.Load() != 1 {
		t.Fatalf("websocket connections = %d", requests.Load())
	}
}

func TestDirectSubscriptionWithoutWebSocketURLFailsLocally(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		t.Fatalf("unexpected websocket request to %s", r.URL)
	}))
	defer server.Close()
	client, err := NewClient(Config{
		APIKey: "shared-secret",
		EthereumRPC: &RPCEndpointConfig{
			HTTPURL: server.URL + "/rpc",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_, err = client.Ethereum.Subscriptions.Subscribe(context.Background(), "newHeads")
	var sdkErr *Error
	if !errors.As(err, &sdkErr) || sdkErr.Kind != ErrorNotConfigured || sdkErr.Namespace != "ethereum.subscriptions" {
		t.Fatalf("error = %#v", err)
	}
	if requests.Load() != 0 {
		t.Fatalf("unexpected requests = %d", requests.Load())
	}
}

func TestDirectSubscriptionErrorsRedactIndependentEndpointSecrets(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		var request wireRequest
		if err := conn.ReadJSON(&request); err != nil {
			t.Error(err)
			return
		}
		_ = conn.WriteJSON(map[string]any{
			"jsonrpc": "2.0", "id": request.ID,
			"error": map[string]any{
				"code":    -32000,
				"message": "ws%2fx ws/x header-secret",
				"data":    map[string]any{"ws/x": "ws%2fx", "header-secret": "header-secret"},
			},
		})
	}))
	defer server.Close()
	directWebSocketURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/socket?token=ws%2Fx"
	client, err := NewClient(Config{EthereumRPC: &RPCEndpointConfig{
		HTTPURL:      server.URL + "/rpc?token=http%2Fsecret",
		WebSocketURL: directWebSocketURL,
		Headers:      http.Header{"Authorization": {"Bearer header-secret"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var result json.RawMessage
	err = client.Ethereum.Subscriptions.Raw(context.Background(), "eth_subscribe", []any{"newHeads"}, &result)
	if err == nil {
		t.Fatal("expected WebSocket RPC error")
	}
	var sdkErr *Error
	if !errors.As(err, &sdkErr) || sdkErr.Kind != ErrorRPC {
		t.Fatalf("error = %#v", err)
	}
	rendered := fmt.Sprintf("%v %#v", err, sdkErr.Data)
	for _, secret := range []string{"ws%2fx", "ws%2Fx", "ws/x", "header-secret"} {
		if strings.Contains(rendered, secret) {
			t.Fatalf("WebSocket error contains %q: %s", secret, rendered)
		}
	}
}
