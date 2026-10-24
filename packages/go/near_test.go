package erpc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func nearTestFacts() c1EVMFacts {
	return c1EVMFacts{methods: map[string]string{"Status": "status", "Block": "block", "ViewAccount": "query"}}
}

func TestNearTypedSelectorsAndLosslessAdditionalData(t *testing.T) {
	var methods []string
	var params []json.RawMessage
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var body struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		decoder := json.NewDecoder(request.Body)
		decoder.UseNumber()
		if err := decoder.Decode(&body); err != nil {
			t.Fatal(err)
		}
		methods = append(methods, body.Method)
		params = append(params, append(json.RawMessage(nil), body.Params...))
		var result string
		switch body.Method {
		case "status":
			result = `{"chain_id":"mainnet","genesis_hash":"genesis","latest_protocol_version":18446744073709551615,"protocol_version":7,"sync_info":{"latest_block_hash":"head","latest_block_height":9007199254740993,"latest_block_time":"2026-01-01T00:00:00Z","latest_state_root":"root","syncing":false,"unknown":18446744073709551616},"version":{"version":"1","build":"build","rustc_version":null}}`
		case "block":
			result = `{"author":"validator","header":{"hash":"hash","height":9,"prev_hash":"prev","timestamp":1,"timestamp_nanosec":"1000","gas_price":"10","total_supply":"20"},"chunks":[],"extra":true}`
		case "query":
			result = `{"amount":"1","locked":"0","code_hash":"code","storage_usage":2,"storage_paid_at":0,"block_height":3,"block_hash":"bh","state":"state","bootstrap_nonce":4,"global_contract_account_id":null,"global_contract_hash":null}`
		default:
			result = `null`
		}
		_, _ = fmt.Fprintf(response, `{"jsonrpc":"2.0","id":%s,"result":%s}`, body.ID, result)
	}))
	defer server.Close()
	resolved, err := resolveConfig(Config{APIKey: "key"})
	if err != nil {
		t.Fatal(err)
	}
	direct, err := resolveSealedRPCEndpoint(&RPCEndpointConfig{HTTPURL: server.URL + "/near?token=x"}, "NearRPC")
	if err != nil {
		t.Fatal(err)
	}
	transport := newC1EVMTransport(resolved, nil, direct, c1MethodFacts{methods: nearTestFacts().methods}, "near.rpc")
	client := newNearClient(transport, nearTestFacts())
	status, err := client.RPC.Status(context.Background())
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if status.LatestProtocolVersion != ^uint64(0) || status.SyncInfo.LatestBlockHeight != 9007199254740993 || status.SyncInfo.Additional["unknown"].(json.Number).String() != "18446744073709551616" {
		t.Fatalf("status = %#v", status)
	}
	height := uint64(9007199254740993)
	block, err := client.RPC.Block(context.Background(), NearBlockReference{BlockID: &NearBlockID{Height: &height}})
	if err != nil {
		t.Fatalf("block: %v", err)
	}
	if block.Header.Hash != "hash" || len(block.Chunks) != 0 {
		t.Fatalf("block = %#v", block)
	}
	account, err := client.RPC.ViewAccount(context.Background(), "alice.near", NearBlockReference{Finality: nearFinalityPointer(NearFinal)})
	if err != nil {
		t.Fatalf("view account: %v", err)
	}
	if account.Amount != "1" || account.StoragePaidAt == nil || *account.StoragePaidAt != 0 {
		t.Fatalf("account = %#v", account)
	}
	if !sameStringSlice(methods, []string{"status", "block", "query"}) {
		t.Fatalf("methods = %#v", methods)
	}
	if len(params) != 3 {
		t.Fatalf("params count = %d", len(params))
	}
	if !bytes.Equal(params[0], []byte("[]")) {
		t.Fatalf("status params = %s, want []", params[0])
	}
	var blockSelector map[string]json.RawMessage
	if err := json.Unmarshal(params[1], &blockSelector); err != nil {
		t.Fatalf("block params are not an object: %v", err)
	}
	if !strings.Contains(string(params[1]), `"block_id":9007199254740993`) {
		t.Fatalf("block selector = %s", params[1])
	}
	var accountSelector map[string]json.RawMessage
	if err := json.Unmarshal(params[2], &accountSelector); err != nil {
		t.Fatalf("query params are not an object: %v", err)
	}
	if !strings.Contains(string(params[2]), `"request_type":"view_account"`) {
		t.Fatalf("query selector = %s", params[2])
	}
}

func TestNearReferenceRejectsAmbiguousSelectors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) { t.Error("unexpected request") }))
	defer server.Close()
	resolved, _ := resolveConfig(Config{APIKey: "key"})
	direct, _ := resolveSealedRPCEndpoint(&RPCEndpointConfig{HTTPURL: server.URL}, "NearRPC")
	client := newNearClient(newC1EVMTransport(resolved, nil, direct, c1MethodFacts{methods: nearTestFacts().methods}, "near.rpc"), nearTestFacts())
	if _, err := client.RPC.Block(context.Background(), NearBlockReference{}); err == nil {
		t.Fatal("empty reference accepted")
	} else if sdkErr, ok := err.(*Error); !ok || sdkErr.Kind != ErrorConfig {
		t.Fatalf("empty reference error = %#v, want config", err)
	}
	if _, err := client.RPC.Block(context.Background(), NearBlockReference{Finality: nearFinalityPointer(NearFinal), BlockID: &NearBlockID{Hash: stringPointer("hash")}}); err == nil {
		t.Fatal("ambiguous reference accepted")
	}
}

func nearFinalityPointer(value NearFinality) *NearFinality { return &value }
func stringPointer(value string) *string                   { return &value }
func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	result, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
