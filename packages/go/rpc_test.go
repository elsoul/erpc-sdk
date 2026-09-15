package erpc

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

type capturedRPCRequest struct {
	method string
	params json.RawMessage
}

func assertCapturedRPCRequest(t *testing.T, requests []capturedRPCRequest, index int, method string, params any) {
	t.Helper()
	if index >= len(requests) {
		t.Fatalf("request %d is missing; got %d requests", index, len(requests))
	}
	if requests[index].method != method {
		t.Fatalf("request %d method = %q, want %q", index, requests[index].method, method)
	}
	want, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(requests[index].params, want) {
		t.Fatalf("request %d params = %s, want %s", index, requests[index].params, want)
	}
}

func assertJSONEqual(t *testing.T, got json.RawMessage, want any) {
	t.Helper()
	var gotValue, wantValue any
	if err := json.Unmarshal(got, &gotValue); err != nil {
		t.Fatalf("decode returned JSON: %v", err)
	}
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(wantJSON, &wantValue); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Fatalf("returned JSON = %s, want %s", got, wantJSON)
	}
}

func solanaV1TransactionFixture(priorityFee any) map[string]any {
	return map[string]any{
		"slot":      1035,
		"blockTime": nil,
		"meta": map[string]any{
			"err": nil,
			"fee": 5000,
			"unrelatedMetaField": map[string]any{
				"keep": []any{true, 7},
			},
		},
		"transaction": map[string]any{
			"signatures": []any{"signature-v1"},
			"message": map[string]any{
				"accountKeys": []any{"payer", "program"},
				"header": map[string]any{
					"numReadonlySignedAccounts":   0,
					"numReadonlyUnsignedAccounts": 1,
					"numRequiredSignatures":       1,
				},
				"instructions": []any{map[string]any{
					"accounts":       []any{1},
					"data":           "AQI=",
					"programIdIndex": 1,
				}},
				"recentBlockhash": "blockhash-v1",
				"transactionConfig": map[string]any{
					"computeUnitLimit":            30000,
					"loadedAccountsDataSizeLimit": 200000,
					"heapSize":                    nil,
					"priorityFee":                 priorityFee,
					"unrelatedConfigField":        "preserved",
				},
				"unrelatedMessageField": map[string]any{"keep": true},
			},
			"unrelatedTransactionField": "preserved",
		},
		"version":            1,
		"unrelatedRootField": map[string]any{"keep": true},
	}
}

func solanaLegacyTransactionFixture() map[string]any {
	return map[string]any{
		"slot":      1035,
		"blockTime": nil,
		"meta":      map[string]any{"err": nil, "fee": 5000},
		"transaction": map[string]any{
			"signatures": []any{"signature-legacy"},
			"message": map[string]any{
				"accountKeys":     []any{"legacy-payer"},
				"instructions":    []any{},
				"recentBlockhash": "blockhash-legacy",
			},
		},
		"version":            "legacy",
		"unrelatedRootField": "preserved",
	}
}

func solanaV0TransactionFixture() map[string]any {
	return map[string]any{
		"slot":      1035,
		"blockTime": nil,
		"meta":      map[string]any{"err": nil, "fee": 5000},
		"transaction": map[string]any{
			"signatures": []any{"signature-v0"},
			"message": map[string]any{
				"accountKeys":         []any{"v0-payer"},
				"addressTableLookups": []any{},
				"instructions":        []any{},
				"recentBlockhash":     "blockhash-v0",
			},
		},
		"version":            0,
		"unrelatedRootField": map[string]any{"keep": true},
	}
}

func solanaBlockEntry(fixture map[string]any) map[string]any {
	entry := make(map[string]any, len(fixture))
	for key, value := range fixture {
		entry[key] = value
	}
	delete(entry, "slot")
	delete(entry, "blockTime")
	return entry
}

func solanaV1BlockFixture() map[string]any {
	return map[string]any{
		"blockhash":         "blockhash-v1",
		"previousBlockhash": "blockhash-parent",
		"parentSlot":        1034,
		"blockHeight":       2000,
		"blockTime":         nil,
		"rewards":           []any{},
		"transactions": []any{
			solanaBlockEntry(solanaV1TransactionFixture(5000)),
			solanaBlockEntry(solanaLegacyTransactionFixture()),
			solanaBlockEntry(solanaV0TransactionFixture()),
		},
		"unrelatedBlockField": map[string]any{"keep": true},
	}
}

func assertSolanaTransactionConfig(t *testing.T, raw json.RawMessage, priorityFee any) {
	t.Helper()
	var value struct {
		Transaction struct {
			Message struct {
				TransactionConfig map[string]any `json:"transactionConfig"`
			} `json:"message"`
		} `json:"transaction"`
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	config := value.Transaction.Message.TransactionConfig
	for _, key := range []string{"computeUnitLimit", "loadedAccountsDataSizeLimit", "heapSize", "priorityFee"} {
		if _, ok := config[key]; !ok {
			t.Fatalf("transactionConfig is missing %q", key)
		}
	}
	if got := config["computeUnitLimit"]; got != float64(30000) {
		t.Fatalf("computeUnitLimit = %#v", got)
	}
	if got := config["loadedAccountsDataSizeLimit"]; got != float64(200000) {
		t.Fatalf("loadedAccountsDataSizeLimit = %#v", got)
	}
	if got := config["heapSize"]; got != nil {
		t.Fatalf("heapSize = %#v, want null", got)
	}
	gotPriorityFee := config["priorityFee"]
	if priorityFee == nil {
		if gotPriorityFee != nil {
			t.Fatalf("priorityFee = %#v, want null", gotPriorityFee)
		}
	} else if gotPriorityFee != float64(priorityFee.(int)) {
		t.Fatalf("priorityFee = %#v, want %v", gotPriorityFee, priorityFee)
	}
}

func assertSolanaTransactionConfigAbsent(t *testing.T, raw json.RawMessage) {
	t.Helper()
	var value struct {
		Transaction struct {
			Message map[string]any `json:"message"`
		} `json:"transaction"`
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	if _, ok := value.Transaction.Message["transactionConfig"]; ok {
		t.Fatal("legacy or v0 transaction unexpectedly contains transactionConfig")
	}
}

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

func TestAvalancheNativeAndIndexNamespacesPreserveWireRoutes(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var request wireRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		switch request.Method {
		case "platform.getHeight":
			if r.URL.Path != "/ava" {
				t.Errorf("P-Chain path = %q", r.URL.Path)
			}
		case "index.getContainerByID":
			if r.URL.Path != "/ava/ext/index/X/tx" {
				t.Errorf("Index path = %q", r.URL.Path)
			}
		default:
			t.Errorf("method = %q", request.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": request.ID, "result": request.Method,
		})
	}))
	defer server.Close()
	client, err := NewClient(Config{APIKey: "key", AvalancheEndpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var result string
	if err := client.Avalanche.PChain.Request(context.Background(), "getHeight", nil, &result); err != nil {
		t.Fatal(err)
	}
	if result != "platform.getHeight" {
		t.Fatalf("result = %q", result)
	}
	if err := client.Avalanche.Index.XChainTransactions.Request(
		context.Background(),
		"getContainerByID",
		map[string]any{"id": "tx-id"},
		&result,
	); err != nil {
		t.Fatal(err)
	}
	_, err = client.Avalanche.XChain.Batch(
		context.Background(),
		[]BatchCall{{Method: "getHeight"}},
	)
	var sdkErr *Error
	if !errors.As(err, &sdkErr) || sdkErr.Kind != ErrorBatchPolicy {
		t.Fatalf("error = %#v", err)
	}
	if requests.Load() != 2 {
		t.Fatalf("requests = %d", requests.Load())
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

func TestSolanaV1OptionsAndResponses(t *testing.T) {
	transactionOptions := map[string]any{
		"commitment":                     "finalized",
		"encoding":                       "jsonParsed",
		"maxSupportedTransactionVersion": 1,
	}
	blockOptions := map[string]any{
		"commitment":                     "confirmed",
		"encoding":                       "jsonParsed",
		"maxSupportedTransactionVersion": 1,
		"rewards":                        true,
		"transactionDetails":             "full",
	}
	zeroTransactionOptions := map[string]any{"maxSupportedTransactionVersion": 0}
	zeroBlockOptions := map[string]any{"maxSupportedTransactionVersion": 0}
	v1Transaction := solanaV1TransactionFixture(nil)
	v0Transaction := solanaV0TransactionFixture()
	legacyTransaction := solanaLegacyTransactionFixture()
	block := solanaV1BlockFixture()
	transactionFixtures := map[string]any{
		"signature-v1":     v1Transaction,
		"signature-v0":     v0Transaction,
		"signature-legacy": legacyTransaction,
	}
	var requests []capturedRPCRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     uint64          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		requests = append(requests, capturedRPCRequest{
			method: request.Method,
			params: append(json.RawMessage(nil), request.Params...),
		})
		var params []json.RawMessage
		if err := json.Unmarshal(request.Params, &params); err != nil {
			t.Fatal(err)
		}
		var result any
		switch request.Method {
		case "getTransaction":
			var signature string
			if err := json.Unmarshal(params[0], &signature); err != nil {
				t.Fatal(err)
			}
			result = transactionFixtures[signature]
		case "getBlock":
			var slot uint64
			if err := json.Unmarshal(params[0], &slot); err != nil {
				t.Fatal(err)
			}
			if slot == 1035 {
				result = block
			}
		default:
			t.Errorf("method = %q", request.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": request.ID, "result": result,
		})
	}))
	defer server.Close()
	client, err := NewClient(Config{APIKey: "key", Endpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	gotTransaction, err := client.Solana.RPC.GetTransaction(
		context.Background(), "signature-v1", transactionOptions,
	)
	if err != nil {
		t.Fatal(err)
	}
	assertJSONEqual(t, gotTransaction, v1Transaction)
	assertSolanaTransactionConfig(t, gotTransaction, nil)

	var gotBlock json.RawMessage
	if err := client.Solana.RPC.Request(
		context.Background(), "getBlock", []any{uint64(1035), blockOptions}, &gotBlock,
	); err != nil {
		t.Fatal(err)
	}
	assertJSONEqual(t, gotBlock, block)

	gotV0, err := client.Solana.RPC.GetTransaction(
		context.Background(), "signature-v0", zeroTransactionOptions,
	)
	if err != nil {
		t.Fatal(err)
	}
	assertJSONEqual(t, gotV0, v0Transaction)
	assertSolanaTransactionConfigAbsent(t, gotV0)

	gotLegacy, err := client.Solana.RPC.GetTransaction(context.Background(), "signature-legacy")
	if err != nil {
		t.Fatal(err)
	}
	assertJSONEqual(t, gotLegacy, legacyTransaction)
	assertSolanaTransactionConfigAbsent(t, gotLegacy)

	var ignored json.RawMessage
	if err := client.Solana.RPC.Raw(
		context.Background(), "getBlock", []any{uint64(1034), zeroBlockOptions}, &ignored,
	); err != nil {
		t.Fatal(err)
	}
	if err := client.Solana.RPC.Request(
		context.Background(), "getBlock", []any{uint64(1033)}, &ignored,
	); err != nil {
		t.Fatal(err)
	}

	if len(requests) != 6 {
		t.Fatalf("requests = %d, want 6", len(requests))
	}
	assertCapturedRPCRequest(t, requests, 0, "getTransaction", []any{"signature-v1", transactionOptions})
	assertCapturedRPCRequest(t, requests, 1, "getBlock", []any{uint64(1035), blockOptions})
	assertCapturedRPCRequest(t, requests, 2, "getTransaction", []any{"signature-v0", zeroTransactionOptions})
	assertCapturedRPCRequest(t, requests, 3, "getTransaction", []any{"signature-legacy"})
	assertCapturedRPCRequest(t, requests, 4, "getBlock", []any{uint64(1034), zeroBlockOptions})
	assertCapturedRPCRequest(t, requests, 5, "getBlock", []any{uint64(1033)})

	var blockValue struct {
		Transactions []struct {
			Meta struct {
				Fee json.RawMessage `json:"fee"`
			} `json:"meta"`
			Transaction struct {
				Message map[string]any `json:"message"`
			} `json:"transaction"`
		} `json:"transactions"`
	}
	if err := json.Unmarshal(gotBlock, &blockValue); err != nil {
		t.Fatal(err)
	}
	if len(blockValue.Transactions) != 3 {
		t.Fatalf("block transactions = %d, want 3", len(blockValue.Transactions))
	}
	if got := string(blockValue.Transactions[0].Meta.Fee); got != "5000" {
		t.Fatalf("v1 block fee = %s, want numeric 5000", got)
	}
	if _, ok := blockValue.Transactions[0].Transaction.Message["transactionConfig"]; !ok {
		t.Fatal("v1 block transaction is missing transactionConfig")
	}
	for _, transaction := range blockValue.Transactions[1:] {
		if _, ok := transaction.Transaction.Message["transactionConfig"]; ok {
			t.Fatal("legacy or v0 block transaction unexpectedly contains transactionConfig")
		}
	}
}

func TestSolanaTransactionSubmissionForwardsLargeBase64Once(t *testing.T) {
	// Synthetic opaque fixture: not a valid signed transaction and does not
	// prove chain acceptance.
	transaction := strings.Repeat("A", 5462) + "=="
	decoded, err := base64.StdEncoding.DecodeString(transaction)
	if err != nil {
		t.Fatal(err)
	}
	if len(decoded) != 4096 {
		t.Fatalf("decoded transaction size = %d, want 4096", len(decoded))
	}
	options := map[string]any{"encoding": "base64"}
	var requests []capturedRPCRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     uint64          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		requests = append(requests, capturedRPCRequest{
			method: request.Method,
			params: append(json.RawMessage(nil), request.Params...),
		})
		var result any = map[string]any{"err": nil, "logs": []any{}}
		if request.Method == "sendTransaction" {
			result = "synthetic-signature"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": request.ID, "result": result,
		})
	}))
	defer server.Close()
	client, err := NewClient(Config{APIKey: "key", Endpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	if _, err := client.Solana.RPC.SendTransaction(context.Background(), transaction, options); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Solana.RPC.SimulateTransaction(context.Background(), transaction, options); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 2 {
		t.Fatalf("requests = %d, want one request for each method", len(requests))
	}
	assertCapturedRPCRequest(t, requests, 0, "sendTransaction", []any{transaction, options})
	assertCapturedRPCRequest(t, requests, 1, "simulateTransaction", []any{transaction, options})
}

func TestSolanaV1RPCErrorSurfacesOnceWithoutFallback(t *testing.T) {
	errorData := map[string]any{
		"maxSupportedTransactionVersion": 0,
		"transactionVersion":             1,
		"detail":                         "decoder capability is too old",
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var request struct {
			ID     uint64          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0",
			"id":      request.ID,
			"error": map[string]any{
				"code": -32015, "message": "Transaction version is not supported", "data": errorData,
			},
		})
	}))
	defer server.Close()
	client, err := NewClient(Config{APIKey: "key", Endpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	_, err = client.Solana.RPC.GetTransaction(
		context.Background(), "signature-v1", map[string]any{"maxSupportedTransactionVersion": 0},
	)
	if err == nil {
		t.Fatal("expected -32015 RPC error")
	}
	var sdkErr *Error
	if !errors.As(err, &sdkErr) || sdkErr.Kind != ErrorRPC || sdkErr.Code != -32015 {
		t.Fatalf("error = %#v", err)
	}
	assertJSONEqual(t, sdkErr.Data, errorData)
	if requests.Load() != 1 {
		t.Fatalf("requests = %d, want one request without fallback", requests.Load())
	}
}

func TestMethodCatalogCounts(t *testing.T) {
	counts := []int{
		len(SolanaRPCMethods), len(SolanaDASMethods), len(SolanaHistoryMethods),
		len(SolanaLeaderMethods), len(SolanaAnalyticsMethods), len(SolanaEnhancedSubscriptionMethods),
		len(EthereumRPCMethods), len(EthereumSubscriptionMethods), len(AvalancheAVAXMethods),
		len(AvalancheXChainMethods), len(AvalanchePChainMethods), len(AvalancheProposerVMMethods),
		len(AvalancheInfoMethods), len(AvalancheIndexMethods),
	}
	want := []int{55, 14, 2, 2, 5, 4, 53, 2, 4, 11, 26, 2, 1, 6}
	for i := range want {
		if counts[i] != want[i] {
			t.Fatalf("catalog %d count = %d", i, counts[i])
		}
	}
}
