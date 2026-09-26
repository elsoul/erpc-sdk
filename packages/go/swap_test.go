package erpc

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

const (
	goSwapEthereumFactory = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f"
	goSwapEthereumPool    = "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc"
	goSwapEthereumUSDC    = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
	goSwapEthereumWETH    = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
	goSwapEthereumHash    = "0x29ed72152f595cf0e190cccab56d5536dbc4eab289b82d343a498e9d256ca2fb"
	goSwapEthereumBlock   = "0x18c7f20"
)

type goQuoteFixture struct {
	ValidCases      []goQuoteFixtureCase `json:"validCases"`
	InvalidCases    []goQuoteFixtureCase `json:"invalidCases"`
	RPCCases        []goQuoteFixtureCase `json:"rpcCases"`
	ArithmeticCases []goQuoteFixtureCase `json:"arithmeticCases"`
}

type goQuoteFixtureCase struct {
	CaseID        string           `json:"caseId"`
	Request       map[string]any   `json:"request"`
	NowSeconds    int64            `json:"nowSeconds"`
	RPCResponses  []any            `json:"rpcResponses"`
	RPCTrace      []map[string]any `json:"rpcTrace"`
	Outcome       map[string]any   `json:"outcome"`
	Applicability string           `json:"applicability"`
	Mutation      string           `json:"mutation"`
}

type goCapturedRPCRequest struct {
	Method   string
	Params   []any
	Endpoint string
}

func TestSwapExactInputQuoteReadsConsistentSnapshot(t *testing.T) {
	fixture := loadGoQuoteFixture(t)
	caseValue := fixture.ValidCases[0]
	requests := make([]goCapturedRPCRequest, 0, len(caseValue.RPCResponses))
	server := newGoFixtureRPCServer(t, caseValue.RPCResponses, &requests)
	defer server.Close()

	client, err := NewClient(Config{APIKey: "quote-secret", Endpoint: server.URL, AvalancheEndpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	client.Swap.clock = func() int64 { return caseValue.NowSeconds }
	quote, err := client.Swap.QuoteExactInput(context.Background(), goRequestFromFixture(t, caseValue.Request))
	if err != nil {
		t.Fatal(err)
	}
	if quote.AmountOut != "2393866186" || quote.AmountIn != "1000000000000000000" {
		t.Fatalf("quote = %#v", quote)
	}
	if quote.Snapshot.BlockNumber != "25984800" || quote.Snapshot.BlockHash != goSwapEthereumHash || quote.Snapshot.BlockTimestamp != "1789498679" {
		t.Fatalf("snapshot = %#v", quote.Snapshot)
	}
	if len(requests) != 11 {
		t.Fatalf("RPC request count = %d, want 11", len(requests))
	}
	wantMethods := []string{
		"eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getCode",
		"eth_call", "eth_call", "eth_call", "eth_call", "eth_call",
		"eth_getBlockByNumber", "eth_getBlockByNumber",
	}
	for index, method := range wantMethods {
		if requests[index].Method != method {
			t.Fatalf("RPC request %d method = %q, want %q", index, requests[index].Method, method)
		}
	}
	if !reflect.DeepEqual(requests[1].Params, []any{"latest", false}) {
		t.Fatalf("initial header params = %#v", requests[1].Params)
	}
	selector, ok := requests[2].Params[1].(map[string]any)
	if !ok || selector["blockHash"] != goSwapEthereumHash || selector["requireCanonical"] != true {
		t.Fatalf("state selector = %#v", requests[2].Params[1])
	}
	if !reflect.DeepEqual(requests[10].Params, []any{goSwapEthereumBlock, false}) {
		t.Fatalf("snapshot reread params = %#v", requests[10].Params)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSwapQuotesUseSelectedDirectEthereumAndAvalancheRPC(t *testing.T) {
	fixture := loadGoQuoteFixture(t)
	cases := []struct {
		name       string
		fixture    goQuoteFixtureCase
		configure  func(*Config, *RPCEndpointConfig)
		wrongChain string
	}{
		{
			name:    "ethereum",
			fixture: fixture.ValidCases[0],
			configure: func(config *Config, endpoint *RPCEndpointConfig) {
				config.EthereumRPC = endpoint
			},
			wrongChain: TokenChainAvalancheCMainnet,
		},
		{
			name:    "avalanche c-chain",
			fixture: fixture.ValidCases[2],
			configure: func(config *Config, endpoint *RPCEndpointConfig) {
				config.AvalancheCRPC = endpoint
			},
			wrongChain: TokenChainEthereumMainnet,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			requests := make([]goCapturedRPCRequest, 0, len(testCase.fixture.RPCResponses))
			server := newGoFixtureRPCServer(t, testCase.fixture.RPCResponses, &requests)
			defer server.Close()
			directPath := "/customer/path?token=a%2Fb&region=eu"
			endpoint := &RPCEndpointConfig{HTTPURL: server.URL + directPath}
			config := Config{}
			testCase.configure(&config, endpoint)
			client, err := NewClient(config)
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			client.Swap.clock = func() int64 { return testCase.fixture.NowSeconds }

			request := goRequestFromFixture(t, testCase.fixture.Request)
			if _, err := client.Swap.QuoteExactInput(context.Background(), request); err != nil {
				t.Fatal(err)
			}
			if len(requests) != 11 {
				t.Fatalf("RPC request count = %d, want 11", len(requests))
			}
			for index, captured := range requests {
				if captured.Endpoint != directPath {
					t.Fatalf("request %d endpoint = %q, want %q", index, captured.Endpoint, directPath)
				}
			}
			request.ChainID = testCase.wrongChain
			_, err = client.Swap.QuoteExactInput(context.Background(), request)
			var quoteErr *SwapQuoteError
			if !errors.As(err, &quoteErr) || quoteErr.Code != SwapQuoteChainMismatch {
				t.Fatalf("wrong-chain error = %#v", err)
			}
			if len(requests) != 11 {
				t.Fatalf("wrong-chain request count = %d, want 11", len(requests))
			}
		})
	}
}

func TestSwapQuoteValidationAndSolanaAdapterAreZeroRPC(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		t.Fatalf("unexpected RPC request %s", r.URL.Path)
	}))
	defer server.Close()
	client, err := NewClient(Config{APIKey: "quote-secret", Endpoint: server.URL, AvalancheEndpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	cases := []struct {
		name    string
		request ExactInputQuoteRequest
		code    SwapQuoteErrorCode
	}{
		{
			name: "unsupported chain", request: ExactInputQuoteRequest{
				ChainID: "eip155:999", PoolDefinitionID: "pool-0001", InputTokenDeploymentID: TokenEthereumWETH,
				OutputTokenDeploymentID: TokenEthereumUSDC, AmountIn: "1",
			}, code: SwapQuoteUnsupportedChain,
		},
		{
			name: "native input", request: ExactInputQuoteRequest{
				ChainID: TokenChainEthereumMainnet, PoolDefinitionID: "pool-0001", InputTokenDeploymentID: TokenEthereumETH,
				OutputTokenDeploymentID: TokenEthereumUSDC, AmountIn: "1",
			}, code: SwapQuoteUnsupportedStandard,
		},
		{
			name: "classic SPL adapter", request: ExactInputQuoteRequest{
				ChainID: TokenChainSolanaMainnet, PoolDefinitionID: "pool-0003", InputTokenDeploymentID: TokenSolanaWSOL,
				OutputTokenDeploymentID: TokenSolanaEURC, AmountIn: "1",
			}, code: SwapQuoteUnsupportedAdapter,
		},
		{
			name: "leading zero", request: ExactInputQuoteRequest{
				ChainID: TokenChainEthereumMainnet, PoolDefinitionID: "pool-0001", InputTokenDeploymentID: TokenEthereumWETH,
				OutputTokenDeploymentID: TokenEthereumUSDC, AmountIn: "01",
			}, code: SwapQuoteInvalidArgument,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := client.Swap.QuoteExactInput(context.Background(), testCase.request)
			var domain *SwapQuoteError
			if !errors.As(err, &domain) || domain.Code != testCase.code {
				t.Fatalf("error = %v, want %s", err, testCase.code)
			}
		})
	}
	if calls != 0 {
		t.Fatalf("pre-RPC validation made %d requests", calls)
	}
}

func TestSwapQuoteDetectsStaleBeforeMalformedABI(t *testing.T) {
	fixture := loadGoQuoteFixture(t)
	var stale goQuoteFixtureCase
	for _, candidate := range fixture.RPCCases {
		if candidate.CaseID == "stale-wins-malformed-abi" {
			stale = candidate
			break
		}
	}
	if stale.CaseID == "" {
		t.Fatal("missing stale precedence fixture")
	}
	requests := make([]goCapturedRPCRequest, 0, 11)
	server := newGoFixtureRPCServer(t, stale.RPCResponses, &requests)
	defer server.Close()
	client, err := NewClient(Config{APIKey: "quote-secret", Endpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	client.Swap.clock = func() int64 { return stale.NowSeconds }
	_, err = client.Swap.QuoteExactInput(context.Background(), goRequestFromFixture(t, stale.Request))
	var domain *SwapQuoteError
	if !errors.As(err, &domain) || domain.Code != SwapQuoteStateStale {
		t.Fatalf("error = %v, want stale state", err)
	}
	if len(requests) != 11 {
		t.Fatalf("RPC request count = %d, want 11", len(requests))
	}
	_ = client.Close()
}

func TestSwapQuoteSnapshotsRequestAndFreshnessBeforeRPC(t *testing.T) {
	fixture := loadGoQuoteFixture(t)
	caseValue := fixture.ValidCases[0]
	responses := caseValue.RPCResponses
	requests := make([]goCapturedRPCRequest, 0, len(responses))
	index := 0
	var request ExactInputQuoteRequest
	var freshness SwapFreshness
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var wire struct {
			JSONRPC string `json:"jsonrpc"`
			ID      uint64 `json:"id"`
			Method  string `json:"method"`
			Params  []any  `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&wire); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		requests = append(requests, goCapturedRPCRequest{Method: wire.Method, Params: wire.Params})
		if index == 0 {
			// These mutations happen in the first RPC handler while the quote is
			// suspended. The returned quote must use the values snapshotted
			// before the first await.
			request.PoolDefinitionID = "pool-0002"
			request.AmountIn = "1"
			freshness.MaxBlockAgeSeconds = uint64Pointer(0)
			freshness.MaxBlockLag = uint64Pointer(0)
		}
		if index >= len(responses) {
			t.Errorf("request %d (%s) has no fixture response", index, wire.Method)
			return
		}
		result := responses[index]
		index++
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": wire.ID, "result": result,
		})
	}))
	defer server.Close()

	request = goRequestFromFixture(t, caseValue.Request)
	freshness = SwapFreshness{
		MaxBlockAgeSeconds:  uint64Pointer(120),
		MaxBlockLag:         uint64Pointer(3),
		MaxClockSkewSeconds: uint64Pointer(5),
	}
	request.Freshness = &freshness
	client, err := NewClient(Config{APIKey: "quote-secret", Endpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	client.Swap.clock = func() int64 { return caseValue.NowSeconds }
	quote, err := client.Swap.QuoteExactInput(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if quote.PoolDefinitionID != "pool-0001" || quote.AmountIn != "1000000000000000000" || quote.AmountOut != "2393866186" {
		t.Fatalf("quote changed after request mutation: %#v", quote)
	}
	if len(requests) != len(responses) {
		t.Fatalf("RPC request count = %d, want %d", len(requests), len(responses))
	}
	_ = client.Close()
}

func TestSwapQuotePreservesContextCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("cancelled request reached HTTP server")
	}))
	defer server.Close()
	client, err := NewClient(Config{APIKey: "quote-secret", Endpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = client.Swap.QuoteExactInput(ctx, ExactInputQuoteRequest{
		ChainID: TokenChainEthereumMainnet, PoolDefinitionID: "pool-0001", InputTokenDeploymentID: TokenEthereumWETH,
		OutputTokenDeploymentID: TokenEthereumUSDC, AmountIn: "1",
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func newGoFixtureRPCServer(t *testing.T, responses []any, captured *[]goCapturedRPCRequest) *httptest.Server {
	t.Helper()
	index := 0
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			JSONRPC string `json:"jsonrpc"`
			ID      uint64 `json:"id"`
			Method  string `json:"method"`
			Params  []any  `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		*captured = append(*captured, goCapturedRPCRequest{
			Method: request.Method, Params: request.Params, Endpoint: r.URL.RequestURI(),
		})
		if index >= len(responses) {
			t.Errorf("request %d (%s) has no fixture response", index, request.Method)
			return
		}
		result := responses[index]
		index++
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0",
			"id":      request.ID,
			"result":  result,
		})
	}))
}

func loadGoQuoteFixture(t *testing.T) goQuoteFixture {
	return readGoQuoteFixture(t, false)
}

func loadGoQuoteFixtureForCapture(t *testing.T) goQuoteFixture {
	return readGoQuoteFixture(t, true)
}

func readGoQuoteFixture(t *testing.T, required bool) goQuoteFixture {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	path := filepath.Join(filepath.Dir(source), "..", "..", "registry", "fixtures", "swap-quote-cases.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) && !required {
			t.Skip("workspace quote fixtures are unavailable in this standalone module")
		}
		t.Fatalf("read quote fixture: %v", err)
	}
	var fixture goQuoteFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("decode quote fixture: %v", err)
	}
	return fixture
}

func goRequestFromFixture(t *testing.T, raw map[string]any) ExactInputQuoteRequest {
	t.Helper()
	request := ExactInputQuoteRequest{
		ChainID:                 rawStringValue(t, raw, "chainId"),
		PoolDefinitionID:        rawStringValue(t, raw, "poolDefinitionId"),
		InputTokenDeploymentID:  rawStringValue(t, raw, "inputTokenDeploymentId"),
		OutputTokenDeploymentID: rawStringValue(t, raw, "outputTokenDeploymentId"),
		AmountIn:                rawStringValue(t, raw, "amountIn"),
	}
	if rawFreshness, ok := raw["freshness"].(map[string]any); ok {
		freshness := &SwapFreshness{}
		if value, exists := rawFreshness["maxBlockAgeSeconds"]; exists {
			freshness.MaxBlockAgeSeconds = rawUintPointer(t, value)
		}
		if value, exists := rawFreshness["maxBlockLag"]; exists {
			freshness.MaxBlockLag = rawUintPointer(t, value)
		}
		if value, exists := rawFreshness["maxClockSkewSeconds"]; exists {
			freshness.MaxClockSkewSeconds = rawUintPointer(t, value)
		}
		request.Freshness = freshness
	}
	return request
}

func rawStringValue(t *testing.T, value map[string]any, key string) string {
	t.Helper()
	stringValue, ok := value[key].(string)
	if !ok {
		t.Fatalf("fixture field %s is not a string: %#v", key, value[key])
	}
	return stringValue
}

func rawUintPointer(t *testing.T, value any) *uint64 {
	t.Helper()
	floatValue, ok := value.(float64)
	if !ok || floatValue < 0 || floatValue != float64(uint64(floatValue)) {
		t.Fatalf("fixture freshness value is not an integer: %#v", value)
	}
	uintValue := uint64(floatValue)
	return &uintValue
}

func uint64Pointer(value uint64) *uint64 {
	return &value
}

func quoteOutcomeMap(result ExactInputQuoteResult, err error) map[string]any {
	if err != nil {
		var domain *SwapQuoteError
		if errors.As(err, &domain) {
			return map[string]any{"kind": "sdk-error", "code": string(domain.Code)}
		}
		return map[string]any{"kind": "transport-error", "sourcePreserved": true}
	}
	encoded, marshalErr := json.Marshal(result)
	if marshalErr != nil {
		panic(marshalErr)
	}
	var value map[string]any
	if err := json.Unmarshal(encoded, &value); err != nil {
		panic(err)
	}
	return map[string]any{"kind": "success", "value": value}
}

func expectedQuoteOutcome(outcome map[string]any) map[string]any {
	expected := make(map[string]any, len(outcome))
	for key, value := range outcome {
		expected[key] = value
	}
	if expected["kind"] != "success" {
		return expected
	}
	value, ok := expected["value"].(map[string]any)
	if !ok {
		return expected
	}
	normalized := make(map[string]any, len(value)+2)
	for key, item := range value {
		normalized[key] = item
	}
	normalized["tokenCatalogDigest"] = TOKEN_CATALOG_CONTENT_DIGEST
	normalized["dexCatalogDigest"] = DexCatalogContentDigest
	expected["value"] = normalized
	return expected
}

func normalizeCapturedParams(params []any) []any {
	if params == nil {
		return []any{}
	}
	return params
}

func capturedTrace(requests []goCapturedRPCRequest) []map[string]any {
	trace := make([]map[string]any, 0, len(requests))
	for _, request := range requests {
		trace = append(trace, map[string]any{
			"method": request.Method,
			"params": normalizeCapturedParams(request.Params),
		})
	}
	return trace
}

func mustSameJSON(t *testing.T, got, want any) {
	t.Helper()
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	var gotValue, wantValue any
	if err := json.Unmarshal(gotJSON, &gotValue); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(wantJSON, &wantValue); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Fatalf("JSON values differ:\n got %s\nwant %s", gotJSON, wantJSON)
	}
}

func goFixturePath(name string) string {
	_, source, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(source), "..", "..", "registry", "fixtures", name)
}

func TestDexParityCapture(t *testing.T) {
	outputPath := os.Getenv("ERPC_SDK_DEX_PARITY_OUTPUT")
	if outputPath == "" {
		return
	}
	fixture := loadGoQuoteFixtureForCapture(t)
	behavior := map[string]any{
		"getDexDeployment":            captureGoDexLookups(),
		"getPoolDefinition":           captureGoPoolLookups(),
		"findPoolDefinitionByAddress": captureGoAddressLookups(),
		"findPoolDefinitionsByPair":   captureGoPairLookups(),
		"listPoolDefinitions":         captureGoListLookups(),
		"getNativeWrapDefinition":     captureGoWrapLookups(),
		"alias":                       captureGoAliases(),
		"quote":                       captureGoQuoteBehavior(t, fixture),
	}
	snapshot := map[string]any{
		"snapshotVersion": 1,
		"snapshotKind":    "native-runtime",
		"language":        "go",
		"runtime":         "go-" + runtime.Version(),
		"metadata": map[string]any{
			"version":       TOKEN_CATALOG_VERSION,
			"asOfDate":      TOKEN_CATALOG_AS_OF_DATE,
			"contentDigest": TOKEN_CATALOG_CONTENT_DIGEST,
			"chainIds":      DexChainIDs(),
		},
		"dexMetadata": map[string]any{
			"version":       DexCatalogVersion,
			"asOfDate":      DexCatalogAsOfDate,
			"contentDigest": DexCatalogContentDigest,
		},
		"dexDeployments":        captureGoDexRecords(DexDeployments()),
		"poolDefinitions":       captureGoPoolRecords(PoolDefinitions()),
		"nativeWrapDefinitions": captureGoWrapRecords(NativeWrapDefinitions()),
		"aliases":               captureGoAliasRecords(DexAliases()),
		"behavior":              behavior,
	}
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		t.Fatalf("create parity output directory: %v", err)
	}
	if err := os.WriteFile(outputPath, append(data, '\n'), 0o644); err != nil {
		t.Fatalf("write parity output: %v", err)
	}
}

func captureGoDexRecords(records []DexDeployment) []map[string]any {
	result := make([]map[string]any, 0, len(records))
	for _, record := range records {
		result = append(result, map[string]any{
			"dexDeploymentId":           record.DexDeploymentID,
			"protocolId":                record.ProtocolID,
			"name":                      record.Name,
			"chainId":                   record.ChainID,
			"programAddress":            record.ProgramAddress,
			"adapterKind":               record.AdapterKind,
			"status":                    record.Status,
			"replacedByDexDeploymentId": record.ReplacedByDexDeploymentID,
		})
	}
	return result
}

func captureGoPoolRecords(records []PoolDefinition) []map[string]any {
	result := make([]map[string]any, 0, len(records))
	for _, record := range records {
		result = append(result, map[string]any{
			"poolDefinitionId":   record.PoolDefinitionID,
			"dexDeploymentId":    record.DexDeploymentID,
			"chainId":            record.ChainID,
			"address":            record.Address,
			"token0DeploymentId": record.Token0DeploymentID,
			"token1DeploymentId": record.Token1DeploymentID,
			"adapter": map[string]any{
				"kind":           record.Adapter.Kind,
				"feeNumerator":   record.Adapter.FeeNumerator,
				"feeDenominator": record.Adapter.FeeDenominator,
			},
			"status":                     record.Status,
			"replacedByPoolDefinitionId": record.ReplacedByPoolDefinitionID,
		})
	}
	return result
}

func captureGoWrapRecords(records []NativeWrapDefinition) []map[string]any {
	result := make([]map[string]any, 0, len(records))
	for _, record := range records {
		result = append(result, map[string]any{
			"nativeWrapDefinitionId":   record.NativeWrapDefinitionID,
			"chainId":                  record.ChainID,
			"nativeTokenDeploymentId":  record.NativeTokenDeploymentID,
			"wrappedTokenDeploymentId": record.WrappedTokenDeploymentID,
			"status":                   record.Status,
		})
	}
	return result
}

func captureGoAliasRecords(records []DexAlias) []map[string]any {
	result := make([]map[string]any, 0, len(records))
	for _, record := range records {
		result = append(result, map[string]any{
			"namespace":        record.Namespace,
			"name":             record.Name,
			"dexDeploymentId":  record.DexDeploymentID,
			"poolDefinitionId": record.PoolDefinitionID,
		})
	}
	return result
}

func captureGoDexLookups() []map[string]any {
	result := make([]map[string]any, 0, len(DexDeployments())+1)
	for _, deployment := range DexDeployments() {
		got, ok := GetDexDeployment(deployment.DexDeploymentID)
		if !ok {
			result = append(result, map[string]any{"input": deployment.DexDeploymentID, "result": nil})
			continue
		}
		result = append(result, map[string]any{"input": deployment.DexDeploymentID, "result": got.DexDeploymentID})
	}
	_, unknown := GetDexDeployment("dex-unknown")
	if unknown {
		result = append(result, map[string]any{"input": "dex-unknown", "result": "dex-unknown"})
	} else {
		result = append(result, map[string]any{"input": "dex-unknown", "result": nil})
	}
	return result
}

func captureGoPoolLookups() []map[string]any {
	result := make([]map[string]any, 0, len(PoolDefinitions())+1)
	for _, pool := range PoolDefinitions() {
		got, ok := GetPoolDefinition(pool.PoolDefinitionID)
		if !ok {
			result = append(result, map[string]any{"input": pool.PoolDefinitionID, "result": nil})
			continue
		}
		result = append(result, map[string]any{"input": pool.PoolDefinitionID, "result": got.PoolDefinitionID})
	}
	_, unknown := GetPoolDefinition("pool-unknown")
	if unknown {
		result = append(result, map[string]any{"input": "pool-unknown", "result": "pool-unknown"})
	} else {
		result = append(result, map[string]any{"input": "pool-unknown", "result": nil})
	}
	return result
}

func captureGoAddressLookups() []map[string]any {
	result := make([]map[string]any, 0)
	for _, pool := range PoolDefinitions() {
		got, ok := FindPoolDefinitionByAddress(pool.ChainID, pool.Address)
		result = append(result, map[string]any{
			"chainId": pool.ChainID, "address": pool.Address, "result": goPoolID(got, ok),
		})
		if strings.HasPrefix(pool.ChainID, "eip155:") {
			mixed := "0x" + strings.ToUpper(pool.Address[2:])
			got, ok = FindPoolDefinitionByAddress(pool.ChainID, mixed)
			result = append(result, map[string]any{
				"chainId": pool.ChainID, "address": mixed, "result": goPoolID(got, ok),
			})
		}
	}
	for _, value := range []struct {
		chainID string
		address string
	}{
		{TokenChainEthereumMainnet, "0x" + strings.Repeat("0", 40)},
		{TokenChainEthereumMainnet, "not-an-address"},
		{"unknown:chain", "0x0000000000000000000000000000000000000001"},
	} {
		got, ok := FindPoolDefinitionByAddress(value.chainID, value.address)
		result = append(result, map[string]any{
			"chainId": value.chainID, "address": value.address, "result": goPoolID(got, ok),
		})
	}
	return result
}

func goPoolID(value PoolDefinition, ok bool) any {
	if !ok {
		return nil
	}
	return value.PoolDefinitionID
}

func captureGoPairLookups() []map[string]any {
	result := make([]map[string]any, 0)
	for _, pool := range PoolDefinitions() {
		for _, pair := range [][2]string{
			{pool.Token0DeploymentID, pool.Token1DeploymentID},
			{pool.Token1DeploymentID, pool.Token0DeploymentID},
		} {
			matches := FindPoolDefinitionsByPair(pool.ChainID, pair[0], pair[1])
			ids := make([]string, 0, len(matches))
			for _, match := range matches {
				ids = append(ids, match.PoolDefinitionID)
			}
			result = append(result, map[string]any{
				"chainId":            pool.ChainID,
				"token0DeploymentId": pair[0],
				"token1DeploymentId": pair[1],
				"result":             ids,
			})
		}
	}
	for _, value := range []struct {
		chainID string
		token0  string
		token1  string
	}{
		{TokenChainEthereumMainnet, "deployment-0001", "deployment-0003"},
		{"unknown:chain", "deployment-0002", "deployment-0008"},
	} {
		matches := FindPoolDefinitionsByPair(value.chainID, value.token0, value.token1)
		ids := make([]string, 0, len(matches))
		for _, match := range matches {
			ids = append(ids, match.PoolDefinitionID)
		}
		result = append(result, map[string]any{
			"chainId": value.chainID, "token0DeploymentId": value.token0,
			"token1DeploymentId": value.token1, "result": ids,
		})
	}
	return result
}

func captureGoListLookups() []map[string]any {
	filters := make([]PoolDefinitionFilter, 0)
	filters = append(filters, PoolDefinitionFilter{})
	ids := DexChainIDs()
	for _, chainID := range []string{ids["ethereum"], ids["solana"], ids["avalancheC"]} {
		filters = append(filters, PoolDefinitionFilter{ChainID: chainID})
	}
	for _, pool := range PoolDefinitions() {
		filters = append(filters,
			PoolDefinitionFilter{TokenDeploymentID: pool.Token0DeploymentID},
			PoolDefinitionFilter{TokenDeploymentID: pool.Token1DeploymentID},
		)
	}
	seenAdapters := make(map[string]bool)
	for _, pool := range PoolDefinitions() {
		if !seenAdapters[pool.Adapter.Kind] {
			filters = append(filters, PoolDefinitionFilter{AdapterKind: pool.Adapter.Kind})
			seenAdapters[pool.Adapter.Kind] = true
		}
	}
	for _, pool := range PoolDefinitions() {
		filters = append(filters, PoolDefinitionFilter{
			ChainID: pool.ChainID, TokenDeploymentID: pool.Token0DeploymentID, AdapterKind: pool.Adapter.Kind,
		})
	}
	filters = append(filters,
		PoolDefinitionFilter{ChainID: "unknown:chain"},
		PoolDefinitionFilter{TokenDeploymentID: "deployment-unknown"},
		PoolDefinitionFilter{AdapterKind: "unknown-adapter"},
	)
	result := make([]map[string]any, 0, len(filters))
	for _, filter := range filters {
		matches := ListPoolDefinitions(filter)
		poolIDs := make([]string, 0, len(matches))
		for _, pool := range matches {
			poolIDs = append(poolIDs, pool.PoolDefinitionID)
		}
		filterMap := map[string]any{}
		if filter.ChainID != "" {
			filterMap["chainId"] = filter.ChainID
		}
		if filter.TokenDeploymentID != "" {
			filterMap["tokenDeploymentId"] = filter.TokenDeploymentID
		}
		if filter.AdapterKind != "" {
			filterMap["adapterKind"] = filter.AdapterKind
		}
		result = append(result, map[string]any{"filter": filterMap, "result": poolIDs})
	}
	return result
}

func captureGoWrapLookups() []map[string]any {
	result := make([]map[string]any, 0)
	for _, deployment := range TokenDeployments() {
		if deployment.Standard != TokenStandardNative {
			continue
		}
		wrap, ok := GetNativeWrapDefinition(deployment.DeploymentID)
		var id any
		if ok {
			id = wrap.NativeWrapDefinitionID
		}
		result = append(result, map[string]any{"input": deployment.DeploymentID, "result": id})
	}
	for _, input := range []string{"deployment-unknown", "native-wrap-0001"} {
		wrap, ok := GetNativeWrapDefinition(input)
		var id any
		if ok {
			id = wrap.NativeWrapDefinitionID
		}
		result = append(result, map[string]any{"input": input, "result": id})
	}
	return result
}

func captureGoAliases() []map[string]any {
	aliases := actualNativeDexAliases()
	result := make([]map[string]any, 0, len(DexAliases()))
	for _, alias := range DexAliases() {
		value, ok := aliases[alias.Namespace+"\x00"+alias.Name]
		id, kind := any(nil), "pool"
		if ok {
			id, kind = value.id, value.kind
		}
		result = append(result, map[string]any{
			"namespace": alias.Namespace, "name": alias.Name, "kind": kind, "result": id,
		})
	}
	return result
}

type nativeDexAlias struct {
	id   any
	kind string
}

func actualNativeDexAliases() map[string]nativeDexAlias {
	result := make(map[string]nativeDexAlias, len(DexAliases()))
	for _, alias := range DexAliases() {
		key := alias.Namespace + "\x00" + alias.Name
		switch {
		case alias.DexDeploymentID != nil:
			result[key] = nativeDexAlias{id: *alias.DexDeploymentID, kind: "dex"}
		case alias.PoolDefinitionID != nil:
			result[key] = nativeDexAlias{id: *alias.PoolDefinitionID, kind: "pool"}
		}
	}
	return result
}

func captureGoQuoteBehavior(t *testing.T, fixture goQuoteFixture) []map[string]any {
	t.Helper()
	all := make([]goQuoteFixtureCase, 0, len(fixture.ValidCases)+len(fixture.InvalidCases)+len(fixture.RPCCases)+len(fixture.ArithmeticCases))
	all = append(all, fixture.ValidCases...)
	all = append(all, fixture.InvalidCases...)
	all = append(all, fixture.RPCCases...)
	all = append(all, fixture.ArithmeticCases...)
	result := make([]map[string]any, 0)
	for _, fixtureCase := range all {
		if fixtureCase.Applicability == "language-local" {
			continue
		}
		requests := make([]goCapturedRPCRequest, 0, len(fixtureCase.RPCResponses))
		server := newGoFixtureRPCServer(t, fixtureCase.RPCResponses, &requests)
		client, err := NewClient(Config{APIKey: "capture-secret", Endpoint: server.URL, AvalancheEndpoint: server.URL})
		if err != nil {
			server.Close()
			t.Fatalf("capture client: %v", err)
		}
		client.Swap.clock = func() int64 { return fixtureCase.NowSeconds }
		quote, quoteErr := client.Swap.QuoteExactInput(context.Background(), goRequestFromFixture(t, fixtureCase.Request))
		_ = client.Close()
		server.Close()
		outcome := quoteOutcomeMap(quote, quoteErr)
		trace := capturedTrace(requests)
		mustSameJSON(t, outcome, expectedQuoteOutcome(fixtureCase.Outcome))
		mustSameJSON(t, trace, fixtureCase.RPCTrace)
		if len(requests) != len(fixtureCase.RPCResponses) {
			t.Fatalf("fixture %s made %d RPC requests, want %d", fixtureCase.CaseID, len(requests), len(fixtureCase.RPCResponses))
		}
		result = append(result, map[string]any{
			"caseId":   fixtureCase.CaseID,
			"outcome":  outcome,
			"rpcTrace": trace,
		})
	}
	return result
}
