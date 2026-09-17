package erpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"sort"
	"strings"
	"testing"
)

type goSwapExecutionFixture struct {
	SchemaVersion    int                          `json:"schemaVersion"`
	FixtureKind      string                       `json:"fixtureKind"`
	CapabilityAsOf   string                       `json:"capabilityAsOfDate"`
	CapabilityDigest string                       `json:"capabilityDigest"`
	Cases            []goSwapExecutionFixtureCase `json:"cases"`
}

type goSwapExecutionFixtureCase struct {
	CaseID       string           `json:"caseId"`
	Method       string           `json:"method"`
	QuoteCaseID  string           `json:"quoteCaseId"`
	Request      map[string]any   `json:"request"`
	NowSeconds   int64            `json:"nowSeconds"`
	RPCResponses []any            `json:"rpcResponses"`
	RPCTrace     []map[string]any `json:"rpcTrace"`
	Outcome      map[string]any   `json:"outcome"`
	Mutation     string           `json:"mutation"`
}

func TestSwapExecutionFixtures(t *testing.T) {
	fixture := loadGoSwapExecutionFixture(t, false)
	for _, fixtureCase := range fixture.Cases {
		t.Run(fixtureCase.CaseID, func(t *testing.T) {
			request := goExecutionRequestFromFixture(t, fixtureCase.Request)
			requests := make([]goCapturedRPCRequest, 0, len(fixtureCase.RPCTrace))
			server := newGoSwapExecutionFixtureRPCServer(t, fixtureCase, &requests)
			defer server.Close()
			client, err := NewClient(Config{APIKey: "swap-execution-capture", Endpoint: server.URL, AvalancheEndpoint: server.URL})
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			client.Swap.clock = func() int64 { return fixtureCase.NowSeconds }

			callContext := context.Background()
			if fixtureCase.Mutation == "cancelBeforeFirstRpc" {
				var cancel context.CancelFunc
				callContext, cancel = context.WithCancel(context.Background())
				cancel()
			}
			var value any
			var callErr error
			if fixtureCase.Method == "prepare" {
				value, callErr = client.Swap.PrepareExactInputSwap(callContext, request)
			} else {
				value, callErr = client.Swap.SimulateExactInputSwap(callContext, request)
			}
			actualOutcome := goSwapExecutionOutcome(value, callErr)
			mustSameJSON(t, actualOutcome, fixtureCase.Outcome)
			mustSameJSON(t, capturedTrace(requests), fixtureCase.RPCTrace)
			if len(requests) != len(fixtureCase.RPCTrace) {
				t.Fatalf("RPC request count = %d, want %d", len(requests), len(fixtureCase.RPCTrace))
			}
		})
	}
}

func TestSwapExecutionWritesNativeParityCapture(t *testing.T) {
	outputPath := os.Getenv("ERPC_SDK_SWAP_EXECUTION_PARITY_OUTPUT")
	if outputPath == "" {
		return
	}
	fixture := loadGoSwapExecutionFixture(t, true)
	behavior := map[string][]map[string]any{"prepare": {}, "simulate": {}}
	for _, fixtureCase := range fixture.Cases {
		request := goExecutionRequestFromFixture(t, fixtureCase.Request)
		requests := make([]goCapturedRPCRequest, 0, len(fixtureCase.RPCTrace))
		server := newGoSwapExecutionFixtureRPCServer(t, fixtureCase, &requests)
		client, err := NewClient(Config{APIKey: "swap-execution-capture", Endpoint: server.URL, AvalancheEndpoint: server.URL})
		if err != nil {
			server.Close()
			t.Fatalf("capture client: %v", err)
		}
		client.Swap.clock = func() int64 { return fixtureCase.NowSeconds }
		callContext := context.Background()
		if fixtureCase.Mutation == "cancelBeforeFirstRpc" {
			var cancel context.CancelFunc
			callContext, cancel = context.WithCancel(context.Background())
			cancel()
		}
		var value any
		var callErr error
		if fixtureCase.Method == "prepare" {
			value, callErr = client.Swap.PrepareExactInputSwap(callContext, request)
		} else {
			value, callErr = client.Swap.SimulateExactInputSwap(callContext, request)
		}
		behavior[fixtureCase.Method] = append(behavior[fixtureCase.Method], map[string]any{
			"caseId":   fixtureCase.CaseID,
			"outcome":  goSwapExecutionOutcome(value, callErr),
			"rpcTrace": capturedTrace(requests),
		})
		_ = client.Close()
		server.Close()
	}
	for _, cases := range behavior {
		sort.Slice(cases, func(left, right int) bool {
			return cases[left]["caseId"].(string) < cases[right]["caseId"].(string)
		})
	}
	snapshot := map[string]any{
		"snapshotVersion":    1,
		"snapshotKind":       "swap-execution-native-runtime",
		"language":           "go",
		"runtime":            "go-" + runtime.Version(),
		"capabilityAsOfDate": swapExecutionCapabilitiesAsOfDate,
		"capabilityDigest":   swapExecutionCapabilitiesContentDigest,
		"behavior":           behavior,
	}
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, '\n')
	if err := os.WriteFile(outputPath, data, 0o644); err != nil {
		t.Fatalf("write parity capture: %v", err)
	}
}

func loadGoSwapExecutionFixture(t *testing.T, required bool) goSwapExecutionFixture {
	t.Helper()
	path := goFixturePath("swap-execution-cases.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) && !required {
			t.Skip("workspace swap execution fixtures are unavailable in this standalone module")
		}
		t.Fatalf("read swap execution fixture: %v", err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	var fixture goSwapExecutionFixture
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatalf("decode swap execution fixture: %v", err)
	}
	if fixture.SchemaVersion != 1 || fixture.FixtureKind != "swap-execution-fixtures" {
		t.Fatalf("unexpected fixture metadata: %#v", fixture)
	}
	return fixture
}

func goExecutionRequestFromFixture(t *testing.T, raw map[string]any) PrepareExactInputSwapRequest {
	t.Helper()
	request := PrepareExactInputSwapRequest{
		ChainID:                 goExecutionStringValue(t, raw, "chainId"),
		PoolDefinitionID:        goExecutionStringValue(t, raw, "poolDefinitionId"),
		InputTokenDeploymentID:  goExecutionStringValue(t, raw, "inputTokenDeploymentId"),
		OutputTokenDeploymentID: goExecutionStringValue(t, raw, "outputTokenDeploymentId"),
		AmountIn:                goExecutionStringValue(t, raw, "amountIn"),
		Sender:                  goExecutionStringValue(t, raw, "sender"),
		Recipient:               goExecutionStringValue(t, raw, "recipient"),
		SlippageBps:             raw["slippageBps"],
		Deadline:                goExecutionStringValue(t, raw, "deadline"),
	}
	if rawFreshness, ok := raw["freshness"].(map[string]any); ok {
		freshness := &SwapFreshness{}
		if value, exists := rawFreshness["maxBlockAgeSeconds"]; exists {
			freshness.MaxBlockAgeSeconds = goExecutionUintPointer(t, value)
		}
		if value, exists := rawFreshness["maxBlockLag"]; exists {
			freshness.MaxBlockLag = goExecutionUintPointer(t, value)
		}
		if value, exists := rawFreshness["maxClockSkewSeconds"]; exists {
			freshness.MaxClockSkewSeconds = goExecutionUintPointer(t, value)
		}
		request.Freshness = freshness
	}
	return request
}

func goExecutionStringValue(t *testing.T, raw map[string]any, key string) string {
	t.Helper()
	value, ok := raw[key].(string)
	if !ok {
		t.Fatalf("fixture field %s is not a string: %#v", key, raw[key])
	}
	return value
}

func goExecutionUintPointer(t *testing.T, value any) *uint64 {
	t.Helper()
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil || parsed < 0 {
			t.Fatalf("fixture freshness value is not an integer: %#v", value)
		}
		converted := uint64(parsed)
		return &converted
	case float64:
		if typed < 0 || typed != float64(uint64(typed)) {
			t.Fatalf("fixture freshness value is not an integer: %#v", value)
		}
		converted := uint64(typed)
		return &converted
	default:
		t.Fatalf("fixture freshness value is not an integer: %#v", value)
		return nil
	}
}

func newGoSwapExecutionFixtureRPCServer(t *testing.T, fixtureCase goSwapExecutionFixtureCase, captured *[]goCapturedRPCRequest) *httptest.Server {
	t.Helper()
	responseIndex := 0
	return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var wire struct {
			JSONRPC string `json:"jsonrpc"`
			ID      uint64 `json:"id"`
			Method  string `json:"method"`
			Params  []any  `json:"params"`
		}
		decoder := json.NewDecoder(request.Body)
		decoder.UseNumber()
		if err := decoder.Decode(&wire); err != nil {
			t.Errorf("decode RPC request: %v", err)
			return
		}
		*captured = append(*captured, goCapturedRPCRequest{Method: wire.Method, Params: wire.Params, Endpoint: request.URL.RequestURI()})
		traceIndex := len(*captured) - 1
		if fixtureCase.Mutation == "preflightProviderError" {
			goWriteRPCError(writer, wire.ID, -32001, "provider preflight failure")
			return
		}
		if fixtureCase.Mutation == "routerRevert" && goIsFinalSimulationCall(wire.Method, wire.Params) {
			goWriteRPCError(writer, wire.ID, -32000, "execution reverted")
			return
		}
		if fixtureCase.Mutation == "routerProviderError" && goIsFinalSimulationCall(wire.Method, wire.Params) {
			goWriteRPCError(writer, wire.ID, -32000, "provider unavailable")
			return
		}
		if fixtureCase.Mutation == "routerRevertCode3" && goIsFinalSimulationCall(wire.Method, wire.Params) {
			goWriteRPCError(writer, wire.ID, 3, "execution reverted: ERC20: transfer amount exceeds balance")
			return
		}
		if fixtureCase.Mutation == "routerNonRevertCode3" && goIsFinalSimulationCall(wire.Method, wire.Params) {
			goWriteRPCError(writer, wire.ID, 3, "invalid router request")
			return
		}
		if responseIndex >= len(fixtureCase.RPCResponses) {
			t.Errorf("fixture has no response for RPC request %s at %d", wire.Method, traceIndex)
			return
		}
		result := goMutateSwapExecutionResponse(fixtureCase.Mutation, traceIndex, fixtureCase.RPCResponses[responseIndex])
		responseIndex++
		_ = json.NewEncoder(writer).Encode(map[string]any{"jsonrpc": "2.0", "id": wire.ID, "result": result})
	}))
}

func goWriteRPCError(writer http.ResponseWriter, id uint64, code int, message string) {
	_ = json.NewEncoder(writer).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   map[string]any{"code": code, "message": message},
	})
}

func goIsFinalSimulationCall(method string, params []any) bool {
	if method != "eth_call" || len(params) == 0 {
		return false
	}
	transaction, ok := params[0].(map[string]any)
	if !ok {
		return false
	}
	data, ok := transaction["data"].(string)
	return ok && strings.HasPrefix(data, swapExecutionFunctionSelector)
}

func goMutateSwapExecutionResponse(mutation string, index int, result any) any {
	switch {
	case mutation == "emptyRouterCode" && index == 11:
		return "0x"
	case mutation == "wrongFactory" && index == 12:
		return goExecutionAddressWord("0x1111111111111111111111111111111111111111")
	case mutation == "wrongWrapped" && index == 13:
		return goExecutionAddressWord("0x2222222222222222222222222222222222222222")
	case mutation == "malformedRouterQuote" && index == 14:
		return "0x20"
	case mutation == "wrongRouterQuote" && index == 14:
		value, ok := result.(string)
		if !ok || len(value) < 3 {
			return result
		}
		return value[:len(value)-1] + "b"
	case (mutation == "quoteStale" && index == 9) || (mutation == "staleAfterRouter" && index == 15):
		return map[string]any{
			"number":    "0x18c7f20",
			"hash":      "0x" + strings.Repeat("aa", 32),
			"timestamp": "0x6aa99537",
		}
	default:
		return result
	}
}

func goExecutionAddressWord(address string) string {
	return "0x" + strings.Repeat("0", 24) + strings.TrimPrefix(address, "0x")
}

func goSwapExecutionOutcome(value any, err error) map[string]any {
	if err != nil {
		var executionErr *SwapExecutionError
		if errors.As(err, &executionErr) {
			return map[string]any{"kind": "sdk-error", "code": string(executionErr.Code)}
		}
		var quoteErr *SwapQuoteError
		if errors.As(err, &quoteErr) {
			return map[string]any{"kind": "sdk-error", "code": string(quoteErr.Code)}
		}
		return map[string]any{"kind": "transport-error", "sourcePreserved": true}
	}
	encoded, marshalErr := json.Marshal(value)
	if marshalErr != nil {
		panic(fmt.Sprintf("marshal execution result: %v", marshalErr))
	}
	var result map[string]any
	if err := json.Unmarshal(encoded, &result); err != nil {
		panic(err)
	}
	return map[string]any{"kind": "success", "value": result}
}
