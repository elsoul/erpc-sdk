package erpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"
)

func bitcoinTestFacts() c1BitcoinFacts {
	return c1BitcoinFacts{methods: map[string]string{
		"EstimateSmartFee":  "estimatesmartfee",
		"GetBestBlockHash":  "getbestblockhash",
		"GetBlock":          "getblock",
		"GetBlockchainInfo": "getblockchaininfo",
		"GetBlockCount":     "getblockcount",
		"GetBlockHash":      "getblockhash",
		"GetBlockHeader":    "getblockheader",
		"GetMempoolInfo":    "getmempoolinfo",
		"GetNetworkInfo":    "getnetworkinfo",
		"GetRawMempool":     "getrawmempool",
		"GetRawTransaction": "getrawtransaction",
		"GetTxOut":          "gettxout",
	}}
}

func evmTestFacts() c1EVMFacts {
	return c1EVMFacts{methods: map[string]string{
		"EthChainID":    "eth_chainId",
		"EthGetBalance": "eth_getBalance",
		"EthCall":       "eth_call",
	}}
}

func TestBitcoinHostedTransportAndFacadeUseOneScopedPost(t *testing.T) {
	var requestCount int
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestCount++
		if request.URL.Path != "/bitcoin" || request.URL.RawQuery != "" {
			t.Errorf("target = %s, want /bitcoin without query", request.URL.String())
		}
		if got := request.Header.Get("Authorization"); got != "Bearer hosted-secret" {
			t.Errorf("authorization = %q", got)
		}
		if got := request.Header.Get("X-Global"); got != "global" {
			t.Errorf("global header = %q", got)
		}
		var body c1WireRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("request decode: %v", err)
		}
		if body.Method != "getbestblockhash" || len(body.Params) != 0 {
			t.Errorf("request body = %#v", body)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(response, `{"jsonrpc":"2.0","id":%d,"error":null,"result":"hash"}`, body.ID)
	}))
	defer server.Close()

	resolved, err := resolveConfig(Config{
		APIKey:     "hosted-secret",
		Endpoint:   server.URL,
		Headers:    http.Header{"Authorization": {"Basic global-secret"}, "X-Global": {"global"}},
		HTTPClient: &http.Client{},
	})
	if err != nil {
		t.Fatalf("resolveConfig() error = %v", err)
	}
	hosted := endpointPath(resolved.endpoint, "bitcoin")
	facts := bitcoinTestFacts()
	transport := newC1BitcoinTransport(resolved, hosted, nil, c1MethodFacts{methods: facts.methods})
	client := newBitcoinClient(transport, facts)
	got, err := client.RPC.GetBestBlockHash(context.Background())
	if err != nil || got != "hash" {
		t.Fatalf("GetBestBlockHash() = %q, %v", got, err)
	}
	if requestCount != 1 {
		t.Fatalf("request count = %d, want one", requestCount)
	}
	if client.RPC.Endpoint() != "http://127.0.0.1/" && !strings.HasSuffix(client.RPC.Endpoint(), "/") {
		t.Fatalf("endpoint diagnostic = %q", client.RPC.Endpoint())
	}
	if got := reflect.TypeOf(client.RPC).NumMethod(); got != 13 {
		t.Fatalf("BitcoinRPCClient exported method count = %d, want 13 named reads plus Endpoint", got)
	}
}

func TestBitcoinDirectTransportPreservesTargetAndIsolatesHeaders(t *testing.T) {
	var requestCount int
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestCount++
		if request.URL.String() != "/customer/rpc?token=a%2Fb&region=eu" {
			t.Errorf("request target = %q", request.URL.String())
		}
		if got := request.Header.Get("Authorization"); got != "Bearer direct-secret" {
			t.Errorf("authorization = %q", got)
		}
		if got := request.Header.Get("X-Global"); got != "" {
			t.Errorf("ambient global header leaked: %q", got)
		}
		var body c1WireRequest
		_ = json.NewDecoder(request.Body).Decode(&body)
		_, _ = fmt.Fprintf(response, `{"jsonrpc":"2.0","id":%d,"result":null}`, body.ID)
	}))
	defer server.Close()

	resolved, err := resolveConfig(Config{
		APIKey:     "legacy-secret",
		Headers:    http.Header{"Authorization": {"Bearer global-secret"}, "X-Global": {"must-not-forward"}},
		HTTPClient: &http.Client{Jar: testCookieJar{value: "ambient"}},
	})
	if err != nil {
		t.Fatalf("resolveConfig() error = %v", err)
	}
	directURL := server.URL + "/customer/rpc?token=a%2Fb&region=eu"
	direct, err := resolveRPCEndpoint(&RPCEndpointConfig{
		HTTPURL: directURL,
		Headers: http.Header{"Authorization": {"Bearer direct-secret"}},
	}, "BitcoinRPC")
	if err != nil {
		t.Fatalf("resolveRPCEndpoint() error = %v", err)
	}
	facts := bitcoinTestFacts()
	transport := newC1BitcoinTransport(resolved, nil, direct, c1MethodFacts{methods: facts.methods})
	client := newBitcoinClient(transport, facts)
	if _, err := client.RPC.GetTxOut(context.Background(), "tx", 0); err != nil {
		t.Fatalf("GetTxOut() error = %v", err)
	}
	if requestCount != 1 {
		t.Fatalf("request count = %d, want one", requestCount)
	}
	if got := client.RPC.Endpoint(); got != "http://127.0.0.1/" && !strings.HasSuffix(got, "/") {
		t.Fatalf("direct endpoint diagnostic = %q", got)
	}
}

func TestBitcoinTransportPreservesContextDeadlineDuringBodyRead(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusOK)
		if flusher, ok := response.(http.Flusher); ok {
			flusher.Flush()
		}
		<-request.Context().Done()
	}))
	defer server.Close()

	resolved, err := resolveConfig(Config{APIKey: "secret", Endpoint: server.URL, Timeout: time.Second})
	if err != nil {
		t.Fatalf("resolveConfig() error = %v", err)
	}
	transport := newC1BitcoinTransport(resolved, endpointPath(resolved.endpoint, "bitcoin"), nil, c1MethodFacts{methods: bitcoinTestFacts().methods})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err = transport.requestBitcoin(ctx, "getnetworkinfo", nil)
	if err == nil || err != context.DeadlineExceeded {
		t.Fatalf("request error = %v, want context deadline", err)
	}
}

func TestBitcoinTransportRejectsOversizedAndMalformedUTF8Bodies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/oversized" {
			_, _ = io.WriteString(response, "123456789")
			return
		}
		_, _ = response.Write([]byte{0xc3, 0x28})
	}))
	defer server.Close()
	resolved, err := resolveConfig(Config{APIKey: "secret", Endpoint: server.URL})
	if err != nil {
		t.Fatalf("resolveConfig() error = %v", err)
	}
	facts := c1MethodFacts{methods: bitcoinTestFacts().methods}
	overLimit := newC1BitcoinTransport(resolved, endpointPath(resolved.endpoint, "oversized"), nil, facts)
	overLimit.maxBodyBytes = 8
	if _, err := overLimit.requestBitcoin(context.Background(), "getnetworkinfo", nil); err == nil {
		t.Fatal("oversized Bitcoin response unexpectedly succeeded")
	}
	invalidUTF8 := newC1BitcoinTransport(resolved, endpointPath(resolved.endpoint, "invalid"), nil, facts)
	if _, err := invalidUTF8.requestBitcoin(context.Background(), "getnetworkinfo", nil); err == nil {
		t.Fatal("malformed UTF-8 response unexpectedly succeeded")
	}
}

func TestC1JSONTransportChecksCancellationBeforeIOAndClassifiesReadFailures(t *testing.T) {
	calls := []struct {
		name string
		call func(*Client, context.Context) error
	}{
		{name: "bitcoin", call: func(client *Client, ctx context.Context) error {
			_, err := client.Bitcoin.RPC.GetBlockCount(ctx)
			return err
		}},
		{name: "polygon", call: func(client *Client, ctx context.Context) error {
			_, err := client.Polygon.RPC.EthChainID(ctx)
			return err
		}},
		{name: "near", call: func(client *Client, ctx context.Context) error {
			_, err := client.Near.RPC.Status(ctx)
			return err
		}},
	}
	for _, testCase := range calls {
		t.Run(testCase.name+" pre-cancel", func(t *testing.T) {
			var requestCount int
			httpClient := &http.Client{Transport: bitcoinRoundTripFunc(func(*http.Request) (*http.Response, error) {
				requestCount++
				return nil, errors.New("unexpected request")
			})}
			client, err := NewClient(Config{
				BitcoinRPC: &RPCEndpointConfig{HTTPURL: "https://bitcoin.example.invalid"},
				PolygonRPC: &RPCEndpointConfig{HTTPURL: "https://polygon.example.invalid"},
				NearRPC:    &RPCEndpointConfig{HTTPURL: "https://near.example.invalid"},
				HTTPClient: httpClient,
			})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if err := testCase.call(client, ctx); !errors.Is(err, context.Canceled) {
				t.Fatalf("pre-cancel error = %v, want context canceled", err)
			}
			if requestCount != 0 {
				t.Fatalf("pre-cancel round trips = %d, want zero", requestCount)
			}
		})

		t.Run(testCase.name+" read error", func(t *testing.T) {
			httpClient := &http.Client{Transport: bitcoinRoundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body:       bitcoinFailingBody{},
				}, nil
			})}
			client, err := NewClient(Config{
				BitcoinRPC: &RPCEndpointConfig{HTTPURL: "https://bitcoin.example.invalid"},
				PolygonRPC: &RPCEndpointConfig{HTTPURL: "https://polygon.example.invalid"},
				NearRPC:    &RPCEndpointConfig{HTTPURL: "https://near.example.invalid"},
				HTTPClient: httpClient,
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := testCase.call(client, context.Background()); err == nil {
				t.Fatal("native body read unexpectedly succeeded")
			} else {
				var sdkErr *Error
				if !errors.As(err, &sdkErr) || sdkErr.Kind != ErrorTransport {
					t.Fatalf("native body read error = %#v, want transport", err)
				}
			}
		})
	}
}

type bitcoinRoundTripFunc func(*http.Request) (*http.Response, error)

func (function bitcoinRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

type bitcoinFailingBody struct{}

func (bitcoinFailingBody) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func (bitcoinFailingBody) Close() error             { return nil }

func TestBitcoinDirectTransportDoesNotFollowRedirectsOrMutateHTTPClient(t *testing.T) {
	var secondRequests int
	second := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		secondRequests++
		_, _ = fmt.Fprint(response, `{"jsonrpc":"2.0","id":1,"result":"unexpected"}`)
	}))
	defer second.Close()
	first := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Location", second.URL+"/redirected")
		response.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer first.Close()
	redirects := 0
	client := &http.Client{CheckRedirect: func(request *http.Request, previous []*http.Request) error {
		redirects++
		return nil
	}}
	resolved, err := resolveConfig(Config{APIKey: "legacy", HTTPClient: client})
	if err != nil {
		t.Fatalf("resolveConfig() error = %v", err)
	}
	direct, err := resolveRPCEndpoint(&RPCEndpointConfig{HTTPURL: first.URL + "/rpc"}, "BitcoinRPC")
	if err != nil {
		t.Fatalf("resolveRPCEndpoint() error = %v", err)
	}
	facts := bitcoinTestFacts()
	transport := newC1BitcoinTransport(resolved, nil, direct, c1MethodFacts{methods: facts.methods})
	if _, err := newBitcoinClient(transport, facts).RPC.GetNetworkInfo(context.Background()); err == nil {
		t.Fatal("redirect response unexpectedly succeeded")
	}
	if redirects != 0 || secondRequests != 0 {
		t.Fatalf("redirects followed: client=%d second=%d", redirects, secondRequests)
	}
	if client.CheckRedirect == nil {
		t.Fatal("supplied redirect policy was mutated")
	}
}

func TestSealedEVMFacadesExposeOnlyNamedReads(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var body c1WireRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("request decode: %v", err)
		}
		_, _ = fmt.Fprintf(response, `{"jsonrpc":"2.0","id":%d,"result":"0x2105"}`, body.ID)
	}))
	defer server.Close()
	resolved, err := resolveConfig(Config{APIKey: "key", Endpoint: server.URL})
	if err != nil {
		t.Fatalf("resolveConfig() error = %v", err)
	}
	facts := evmTestFacts()
	transport := newC1EVMTransport(resolved, resolved.endpoint, nil, c1MethodFacts{methods: facts.methods}, "base.rpc")
	base := newBaseClient(transport, facts)
	if got, err := base.RPC.EthChainID(context.Background()); err != nil || got != "0x2105" {
		t.Fatalf("EthChainID() = %q, %v", got, err)
	}
	if _, err := base.RPC.EthGetBalance(context.Background(), "0xabc", "latest"); err != nil {
		t.Fatalf("EthGetBalance() error = %v", err)
	}
	if _, err := base.RPC.EthCall(context.Background(), map[string]any{"to": "0xabc"}, "latest"); err != nil {
		t.Fatalf("EthCall() error = %v", err)
	}
	if got := reflect.TypeOf(base.RPC).NumMethod(); got != 4 {
		t.Fatalf("BaseRPCClient exported method count = %d, want 4", got)
	}
	if got := base.RPC.Endpoint(); !strings.HasSuffix(got, "/") {
		t.Fatalf("Base endpoint diagnostic = %q", got)
	}
}

type testCookieJar struct{ value string }

func (jar testCookieJar) Cookies(*url.URL) []*http.Cookie { return nil }

func (jar testCookieJar) SetCookies(*url.URL, []*http.Cookie) {}
