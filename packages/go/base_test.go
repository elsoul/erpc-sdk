package erpc

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBaseDirectFacadePreservesExactTargetAndScopedHeaders(t *testing.T) {
	var captured string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		captured = request.URL.String()
		if request.Header.Get("Authorization") != "Bearer base-secret" {
			t.Errorf("authorization leaked or changed: %q", request.Header.Get("Authorization"))
		}
		if request.Header.Get("X-Global") != "" {
			t.Errorf("global header leaked: %q", request.Header.Get("X-Global"))
		}
		var body c1WireRequest
		_ = json.NewDecoder(request.Body).Decode(&body)
		_, _ = fmt.Fprintf(response, `{"jsonrpc":"2.0","id":%d,"result":"0x2105"}`, body.ID)
	}))
	defer server.Close()

	resolved, err := resolveConfig(Config{
		APIKey:  "legacy-secret",
		Headers: http.Header{"Authorization": {"Bearer global-secret"}, "X-Global": {"global"}},
		Timeout: time.Second,
	})
	if err != nil {
		t.Fatalf("resolveConfig() error = %v", err)
	}
	direct, err := resolveRPCEndpoint(&RPCEndpointConfig{
		HTTPURL: server.URL + "/customer/base?token=a%2Fb&region=eu",
		Headers: http.Header{"Authorization": {"Bearer base-secret"}},
	}, "BaseRPC")
	if err != nil {
		t.Fatalf("resolveRPCEndpoint() error = %v", err)
	}
	facts := evmTestFacts()
	transport := newC1EVMTransport(resolved, nil, direct, c1MethodFacts{methods: facts.methods}, "base.rpc")
	client := newBaseClient(transport, facts)
	if got, err := client.RPC.EthChainID(context.Background()); err != nil || got != "0x2105" {
		t.Fatalf("EthChainID() = %q, %v", got, err)
	}
	if captured != "/customer/base?token=a%2Fb&region=eu" {
		t.Fatalf("captured target = %q", captured)
	}
}

func TestBaseHostedTargetUsesQueryAPIKeyWithoutSuffix(t *testing.T) {
	var captured string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		captured = request.URL.String()
		var body c1WireRequest
		_ = json.NewDecoder(request.Body).Decode(&body)
		_, _ = fmt.Fprintf(response, `{"jsonrpc":"2.0","id":%d,"result":"0x2105"}`, body.ID)
	}))
	defer server.Close()
	resolved, err := resolveConfig(Config{APIKey: "base-key", Endpoint: server.URL})
	if err != nil {
		t.Fatalf("resolveConfig() error = %v", err)
	}
	facts := evmTestFacts()
	transport := newC1EVMTransport(resolved, resolved.endpoint, nil, c1MethodFacts{methods: facts.methods}, "base.rpc")
	if _, err := newBaseClient(transport, facts).RPC.EthChainID(context.Background()); err != nil {
		t.Fatalf("EthChainID() error = %v", err)
	}
	if captured != "/?api-key=base-key" {
		t.Fatalf("hosted target = %q, want /?api-key=base-key", captured)
	}
}

func TestNewClientWiresC1HostedDefaultsAndKeylessDirectOverrides(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		paths = append(paths, request.URL.String())
		var body c1WireRequest
		_ = json.NewDecoder(request.Body).Decode(&body)
		result := "0x2105"
		if body.Method == "getbestblockhash" {
			result = "hash"
		}
		_, _ = fmt.Fprintf(response, `{"jsonrpc":"2.0","id":%d,"result":%q}`, body.ID, result)
	}))
	defer server.Close()

	hosted, err := NewClient(Config{
		APIKey:           "shared-key",
		Endpoint:         server.URL,
		BaseEndpoint:     server.URL + "/customer/base/?secret=base-secret",
		ArbitrumEndpoint: server.URL + "/customer/arbitrum",
	})
	if err != nil {
		t.Fatalf("hosted NewClient() error = %v", err)
	}
	if _, err := hosted.Base.RPC.EthChainID(context.Background()); err != nil {
		t.Fatalf("hosted Base EthChainID() error = %v", err)
	}
	if got := hosted.Base.RPC.Endpoint(); got != "http://127.0.0.1/" && !strings.HasSuffix(got, "/") {
		t.Fatalf("hosted Base endpoint = %q", got)
	}
	if len(paths) != 1 || paths[0] != "/customer/base?api-key=shared-key" {
		t.Fatalf("hosted path = %#v", paths)
	}
	hosted.Close()

	paths = nil
	direct, err := NewClient(Config{
		BitcoinRPC:  &RPCEndpointConfig{HTTPURL: server.URL + "/bitcoin-direct", Headers: http.Header{"Authorization": {"Bearer btc"}}},
		BaseRPC:     &RPCEndpointConfig{HTTPURL: server.URL + "/base-direct", Headers: http.Header{"Authorization": {"Bearer base"}}},
		ArbitrumRPC: &RPCEndpointConfig{HTTPURL: server.URL + "/arb-direct", Headers: http.Header{"Authorization": {"Bearer arb"}}},
		Headers:     http.Header{"X-Global": {"must-not-forward"}},
	})
	if err != nil {
		t.Fatalf("keyless direct NewClient() error = %v", err)
	}
	if _, err := direct.Bitcoin.RPC.GetBestBlockHash(context.Background()); err != nil {
		t.Fatalf("direct Bitcoin error = %v", err)
	}
	if _, err := direct.Base.RPC.EthChainID(context.Background()); err != nil {
		t.Fatalf("direct Base error = %v", err)
	}
	if _, err := direct.Arbitrum.RPC.EthChainID(context.Background()); err != nil {
		t.Fatalf("direct Arbitrum error = %v", err)
	}
	if len(paths) != 3 {
		t.Fatalf("direct request count = %d", len(paths))
	}
	direct.Close()
}

func TestNewClientRejectsWebSocketOnSealedOverrides(t *testing.T) {
	for name, field := range map[string]**RPCEndpointConfig{
		"BitcoinRPC":  new(*RPCEndpointConfig),
		"BaseRPC":     new(*RPCEndpointConfig),
		"ArbitrumRPC": new(*RPCEndpointConfig),
	} {
		*field = &RPCEndpointConfig{HTTPURL: "https://rpc.example/path", WebSocketURL: "wss://rpc.example/socket"}
		config := Config{APIKey: "key"}
		switch name {
		case "BitcoinRPC":
			config.BitcoinRPC = *field
		case "BaseRPC":
			config.BaseRPC = *field
		case "ArbitrumRPC":
			config.ArbitrumRPC = *field
		}
		if _, err := NewClient(config); err == nil {
			t.Fatalf("%s unexpectedly accepted WebSocket URL", name)
		}
	}
}

func TestC1ConfigDiagnosticsUseOriginOnlyForNewFields(t *testing.T) {
	config := Config{
		APIKey:           "global-secret",
		BaseEndpoint:     "https://base.example/customer/path?token=base-secret",
		ArbitrumEndpoint: "https://arbitrum.example/customer/path?token=arb-secret",
		BitcoinRPC: &RPCEndpointConfig{
			HTTPURL: "https://bitcoin.example/customer/path?token=btc-secret",
			Headers: http.Header{"Authorization": {"Bearer bitcoin-secret"}},
		},
	}
	rendered := config.String()
	for _, secret := range []string{"global-secret", "base-secret", "arb-secret", "btc-secret", "bitcoin-secret", "customer/path"} {
		if strings.Contains(rendered, secret) {
			t.Fatalf("configuration diagnostic leaked %q: %s", secret, rendered)
		}
	}
	for _, origin := range []string{"https://base.example/", "https://arbitrum.example/", "https://bitcoin.example/"} {
		if !strings.Contains(rendered, origin) {
			t.Fatalf("configuration diagnostic omitted %q: %s", origin, rendered)
		}
	}
}

func TestNewClientLeavesMissingC1SiblingsUnconfiguredWithoutIO(t *testing.T) {
	var requests int
	client, err := NewClient(Config{
		BitcoinRPC: &RPCEndpointConfig{HTTPURL: "https://bitcoin.example/rpc"},
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			requests++
			return nil, fmt.Errorf("unexpected request")
		})},
	})
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	if got := client.Base.RPC.Endpoint(); got != "" {
		t.Fatalf("unconfigured Base endpoint = %q", got)
	}
	if _, err := client.Base.RPC.EthChainID(context.Background()); err == nil {
		t.Fatal("unconfigured Base request unexpectedly succeeded")
	} else {
		var sdkErr *Error
		if !asError(err, &sdkErr) || sdkErr.Kind != ErrorNotConfigured || sdkErr.Namespace != "base.rpc" {
			t.Fatalf("unconfigured Base error = %#v", err)
		}
	}
	if requests != 0 {
		t.Fatalf("unconfigured Base performed %d requests", requests)
	}
	client.Close()
}

func TestBaseDirectErrorsRedactPathQueryAndHeaderCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var body c1WireRequest
		_ = json.NewDecoder(request.Body).Decode(&body)
		_, _ = fmt.Fprintf(response, `{"jsonrpc":"2.0","id":%d,"error":{"code":-32000,"message":"gate%%2Ffake-path-key gate/fake-path-key node-secret","data":{"url":"%s","authorization":"Bearer node-secret","precise":1e1000}}}`, body.ID, request.URL.String())
	}))
	defer server.Close()
	resolved, err := resolveConfig(Config{APIKey: "legacy-key"})
	if err != nil {
		t.Fatalf("resolveConfig() error = %v", err)
	}
	direct, err := resolveRPCEndpoint(&RPCEndpointConfig{
		HTTPURL: server.URL + "/customer/gate%2Ffake-path-key?token=node-secret",
		Headers: http.Header{"Authorization": {"Bearer node-secret"}},
	}, "BaseRPC")
	if err != nil {
		t.Fatalf("resolveRPCEndpoint() error = %v", err)
	}
	facts := evmTestFacts()
	transport := newC1EVMTransport(resolved, nil, direct, c1MethodFacts{methods: facts.methods}, "base.rpc")
	_, err = newBaseClient(transport, facts).RPC.EthChainID(context.Background())
	if err == nil {
		t.Fatal("direct RPC error unexpectedly succeeded")
	}
	var sdkErr *Error
	if !asError(err, &sdkErr) || sdkErr.Kind != ErrorRPC {
		t.Fatalf("direct RPC error = %#v", err)
	}
	if strings.Contains(sdkErr.Error(), "node-secret") || strings.Contains(string(sdkErr.Data), "node-secret") || strings.Contains(sdkErr.Error(), "fake-path-key") {
		t.Fatalf("direct credential leaked: error=%q data=%s", sdkErr.Error(), sdkErr.Data)
	}
}
