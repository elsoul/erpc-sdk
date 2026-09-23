package erpc

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type goLocalFixture struct {
	SchemaVersion        int                  `json:"schemaVersion"`
	FixtureKind          string               `json:"fixtureKind"`
	CapabilityAsOfDate   string               `json:"capabilityAsOfDate"`
	CapabilityDigest     string               `json:"capabilityDigest"`
	HostedFixtureSHA256  string               `json:"hostedFixtureSha256"`
	HostedSemanticSHA256 string               `json:"hostedFixtureSemanticSha256"`
	LocalFixtureDigest   string               `json:"localFixtureDigest"`
	ReferenceCommit      string               `json:"referenceCommit"`
	OfficialSDKVersion   string               `json:"officialSdkVersion"`
	Quotes               []goLocalQuoteRecord `json:"quotes"`
	SourceSwapMocks      []goLocalMock        `json:"sourceSwapMocks"`
	RPCMocks             []goLocalMock        `json:"rpcMocks"`
	Cases                []goLocalFixtureCase `json:"cases"`
}

type goLocalQuoteRecord struct {
	QuoteID        string            `json:"quoteId"`
	CapabilityID   string            `json:"capabilityId"`
	RawQuoteJSON   string            `json:"rawQuoteJson"`
	RawQuoteSHA256 string            `json:"rawQuoteSha256"`
	Normalized     MayanSwiftV2Quote `json:"normalizedQuote"`
}

type goLocalMock struct {
	MockID   string             `json:"mockId"`
	Request  goLocalHTTPMessage `json:"request"`
	Response goLocalHTTPMessage `json:"response"`
}

type goLocalHTTPMessage struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Body    *string           `json:"body"`
	Status  int               `json:"status"`
}

type goLocalFixtureCase struct {
	CaseID            string           `json:"caseId"`
	Method            string           `json:"method"`
	Source            string           `json:"source"`
	CapabilityID      string           `json:"capabilityId"`
	QuoteID           string           `json:"quoteId"`
	Context           map[string]any   `json:"context"`
	SourceSwapMockIDs []string         `json:"sourceSwapMockIds"`
	RPCMockIDs        []string         `json:"rpcMockIds"`
	SourceSwapPlanRef *string          `json:"sourceSwapPlanRef"`
	Expected          map[string]any   `json:"expected"`
	HTTPTrace         []map[string]any `json:"httpTrace"`
	RPCTrace          []map[string]any `json:"rpcTrace"`
	Mutation          map[string]any   `json:"mutation"`
	Config            map[string]any   `json:"config"`
}

type goLocalCapturedRequest struct {
	Method  string
	URL     string
	Headers map[string]string
	Body    *string
}

func goLocalFixturePath() string {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		return filepath.Join("..", "..", "registry", "fixtures", "mayan-swift-v2-local-build-cases.json")
	}
	return filepath.Join(filepath.Dir(source), "..", "..", "registry", "fixtures", "mayan-swift-v2-local-build-cases.json")
}

func loadGoLocalFixture(t *testing.T) goLocalFixture {
	t.Helper()
	data, err := os.ReadFile(goLocalFixturePath())
	if err != nil {
		t.Fatalf("read local bridge fixture: %v", err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	var fixture goLocalFixture
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatalf("decode local bridge fixture: %v", err)
	}
	if fixture.SchemaVersion != 1 || fixture.FixtureKind != "mayan-swift-v2-local-build-fixtures" {
		t.Fatalf("unexpected local bridge fixture metadata: %#v", fixture)
	}
	return fixture
}

func goLocalString(t *testing.T, value any, field string) string {
	t.Helper()
	text, ok := value.(string)
	if !ok {
		t.Fatalf("local fixture field %s is not a string: %#v", field, value)
	}
	return text
}

func goLocalCloneMap(t *testing.T, value any) any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("clone local fixture value: %v", err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(encoded)))
	decoder.UseNumber()
	var result any
	if err := decoder.Decode(&result); err != nil {
		t.Fatalf("decode cloned local fixture value: %v", err)
	}
	return result
}

func goLocalPathParts(path string) []string {
	parts := make([]string, 0)
	for _, component := range strings.Split(path, ".") {
		for len(component) > 0 {
			opening := strings.IndexByte(component, '[')
			if opening < 0 {
				parts = append(parts, component)
				break
			}
			if opening > 0 {
				parts = append(parts, component[:opening])
			}
			closing := strings.IndexByte(component[opening+1:], ']')
			if closing < 0 {
				return nil
			}
			closing += opening + 1
			parts = append(parts, component[opening+1:closing])
			component = component[closing+1:]
		}
	}
	return parts
}

func goLocalSetPath(root any, path string, value any) bool {
	parts := goLocalPathParts(path)
	if len(parts) == 0 {
		return false
	}
	var cursor any = root
	for _, part := range parts[:len(parts)-1] {
		switch typed := cursor.(type) {
		case map[string]any:
			cursor = typed[part]
		case []any:
			index, err := strconv.Atoi(part)
			if err != nil || index < 0 || index >= len(typed) {
				return false
			}
			cursor = typed[index]
		default:
			return false
		}
	}
	leaf := parts[len(parts)-1]
	switch typed := cursor.(type) {
	case map[string]any:
		typed[leaf] = value
		return true
	case []any:
		index, err := strconv.Atoi(leaf)
		if err != nil || index < 0 || index >= len(typed) {
			return false
		}
		typed[index] = value
		return true
	default:
		return false
	}
}

func goLocalMap(t *testing.T, value any) map[string]any {
	t.Helper()
	result, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("local fixture value is not an object: %#v", value)
	}
	return result
}

func goLocalQuoteWithMutation(t *testing.T, base MayanSwiftV2Quote, mutation map[string]any) MayanSwiftV2Quote {
	t.Helper()
	if mutation == nil {
		return cloneBridgeQuote(base)
	}
	kind := goLocalString(t, mutation["kind"], "mutation.kind")
	if kind != "quote-normalized-set" && kind != "quote-raw-set" {
		return cloneBridgeQuote(base)
	}
	path := goLocalString(t, mutation["path"], "mutation.path")
	value := goLocalCloneMap(t, base)
	if kind == "quote-normalized-set" {
		if !goLocalSetPath(value, path, mutation["value"]) {
			t.Fatalf("set local quote path %s", path)
		}
	} else {
		quoteMap := goLocalMap(t, value)
		rawText := goLocalString(t, quoteMap["rawSignedQuoteJson"], "rawSignedQuoteJson")
		var raw any
		decoder := json.NewDecoder(strings.NewReader(rawText))
		decoder.UseNumber()
		if err := decoder.Decode(&raw); err != nil || !goLocalSetPath(raw, path, mutation["value"]) {
			t.Fatalf("set local raw quote path %s", path)
		}
		rawBytes, err := json.Marshal(raw)
		if err != nil {
			t.Fatalf("marshal local raw quote: %v", err)
		}
		quoteMap["rawSignedQuoteJson"] = string(rawBytes)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal mutated local quote: %v", err)
	}
	var quote MayanSwiftV2Quote
	if err := json.Unmarshal(encoded, &quote); err != nil {
		t.Fatalf("decode mutated local quote: %v", err)
	}
	return quote
}

func goLocalMutateMock(t *testing.T, mock goLocalMock, mutation map[string]any) goLocalMock {
	t.Helper()
	if mutation == nil || goLocalString(t, mutation["kind"], "mutation.kind") != "source-swap-response-set" {
		return mock
	}
	if mock.Response.Body == nil {
		return mock
	}
	var body any
	decoder := json.NewDecoder(strings.NewReader(*mock.Response.Body))
	decoder.UseNumber()
	if err := decoder.Decode(&body); err != nil || !goLocalSetPath(body, goLocalString(t, mutation["path"], "mutation.path"), mutation["value"]) {
		t.Fatalf("set local source response path")
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal local source response: %v", err)
	}
	mock.Response.Body = stringPtr(string(encoded))
	return mock
}

func goLocalMutateRPCMock(t *testing.T, mock goLocalMock, mutation map[string]any) goLocalMock {
	t.Helper()
	if mutation == nil || mock.Response.Body == nil || mock.Request.Body == nil {
		return mock
	}
	kind, _ := mutation["kind"].(string)
	if kind != "rpc-response-set" && kind != "rpc-envelope-set" {
		return mock
	}
	var request map[string]any
	var response any
	if err := json.Unmarshal([]byte(*mock.Request.Body), &request); err != nil {
		t.Fatalf("decode local RPC request")
	}
	if err := json.Unmarshal([]byte(*mock.Response.Body), &response); err != nil {
		t.Fatalf("decode local RPC mock")
	}
	method := goLocalString(t, request["method"], "rpc method")
	if kind == "rpc-envelope-set" {
		responseObject, ok := response.(map[string]any)
		if !ok {
			t.Fatalf("local RPC envelope is not an object")
		}
		path := goLocalString(t, mutation["path"], "mutation.path")
		switch path {
		case "jsonrpc", "version":
			responseObject["jsonrpc"] = mutation["value"]
		case "id":
			responseObject["id"] = mutation["value"]
		case "depth":
			depth := 0
			switch value := mutation["value"].(type) {
			case json.Number:
				depth, _ = strconv.Atoi(value.String())
			case string:
				depth, _ = strconv.Atoi(value)
			case float64:
				depth = int(value)
			}
			if depth < 0 {
				depth = 0
			}
			var nested any = true
			for index := 0; index < depth; index++ {
				nested = map[string]any{"nested": nested}
			}
			responseObject["__depthProbe"] = nested
		case "size":
			// Size is a framing mutation. Preserve the parsed result and append
			// JSON whitespace after the envelope to exercise streaming limits.
			encoded, err := json.Marshal(responseObject)
			if err != nil {
				t.Fatalf("marshal local RPC envelope: %v", err)
			}
			target := 0
			switch value := mutation["value"].(type) {
			case json.Number:
				target, _ = strconv.Atoi(value.String())
			case string:
				target, _ = strconv.Atoi(value)
			case float64:
				target = int(value)
			}
			if target > len(encoded) {
				encoded = append(encoded, []byte(strings.Repeat(" ", target-len(encoded)))...)
			}
			mock.Response.Body = stringPtr(string(encoded))
			return mock
		default:
			t.Fatalf("unknown local RPC envelope path %s", path)
		}
		encoded, err := json.Marshal(responseObject)
		if err != nil {
			t.Fatalf("marshal local RPC envelope: %v", err)
		}
		mock.Response.Body = stringPtr(string(encoded))
		return mock
	}
	path := goLocalString(t, mutation["path"], "mutation.path")
	prefix := method + "."
	if !strings.HasPrefix(path, prefix) {
		return mock
	}
	path = strings.TrimPrefix(path, prefix)
	if path != "result" {
		path = "result." + path
	}
	if !goLocalSetPath(response, path, mutation["value"]) {
		t.Fatalf("set local RPC response path %s", path)
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal local RPC response: %v", err)
	}
	mock.Response.Body = stringPtr(string(encoded))
	return mock
}

func goLocalMutateBoundary(t *testing.T, mock goLocalMock, mutation map[string]any) goLocalMock {
	t.Helper()
	if mutation == nil || goLocalString(t, mutation["kind"], "mutation.kind") != "boundary" || mock.Response.Body == nil || mock.Request.Body == nil {
		return mock
	}
	var request map[string]any
	var response map[string]any
	if err := json.Unmarshal([]byte(*mock.Request.Body), &request); err != nil {
		t.Fatalf("decode local boundary RPC request")
	}
	if err := json.Unmarshal([]byte(*mock.Response.Body), &response); err != nil {
		t.Fatalf("decode local boundary RPC mock")
	}
	if request["method"] != "getMultipleAccounts" {
		return mock
	}
	result, ok := response["result"].(map[string]any)
	if !ok {
		return mock
	}
	values, ok := result["value"].([]any)
	if !ok {
		return mock
	}
	empty := make([]byte, 56)
	empty[0] = 1
	for index := 4; index < 12; index++ {
		empty[index] = 0xff
	}
	encodedEmpty := base64.StdEncoding.EncodeToString(empty)
	for _, item := range values {
		account, ok := item.(map[string]any)
		if !ok {
			continue
		}
		data, ok := account["data"].([]any)
		if ok && len(data) > 0 {
			data[0] = encodedEmpty
		}
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal local boundary response: %v", err)
	}
	mock.Response.Body = stringPtr(string(encoded))
	return mock
}

func stringPtr(value string) *string { return &value }

func goLocalConfig(t *testing.T, raw map[string]any, transport http.RoundTripper, timeout time.Duration) MayanSwiftV2BridgeConfig {
	t.Helper()
	config := MayanSwiftV2BridgeConfig{HTTPClient: &http.Client{Transport: transport}, Timeout: timeout}
	zeroValidity := uint64(0)
	config.MinimumQuoteValiditySeconds = &zeroValidity
	localValue, ok := raw["localBuild"].(map[string]any)
	if !ok {
		config.LocalBuild = &MayanSwiftV2LocalBuildConfig{}
		return config
	}
	localConfig := &MayanSwiftV2LocalBuildConfig{}
	if value, ok := localValue["sourceSwapEndpoint"].(string); ok {
		localConfig.SourceSwapEndpoint = value
	}
	if value, present := localValue["ethereumRpc"]; present && value != nil {
		endpoint := goLocalMap(t, value)
		localConfig.EthereumRPC = &RPCEndpointConfig{HTTPURL: goLocalString(t, endpoint["httpUrl"], "ethereumRpc.httpUrl")}
	}
	if value, present := localValue["solanaRpc"]; present && value != nil {
		endpoint := goLocalMap(t, value)
		localConfig.SolanaRPC = &RPCEndpointConfig{HTTPURL: goLocalString(t, endpoint["httpUrl"], "solanaRpc.httpUrl")}
	}
	config.LocalBuild = localConfig
	return config
}

func goLocalTraceRequest(request *http.Request, body *string) goLocalCapturedRequest {
	headers := make(map[string]string)
	for name, values := range request.Header {
		if len(values) == 0 {
			continue
		}
		lower := strings.ToLower(name)
		if lower == "host" || lower == "content-length" || lower == "user-agent" || lower == "accept-encoding" {
			continue
		}
		headers[lower] = values[0]
	}
	return goLocalCapturedRequest{Method: request.Method, URL: request.URL.String(), Headers: headers, Body: body}
}

func goLocalTrace(captured []goLocalCapturedRequest) []map[string]any {
	result := make([]map[string]any, 0, len(captured))
	for _, request := range captured {
		row := map[string]any{"method": request.Method, "url": request.URL, "headers": request.Headers, "body": nil}
		if request.Body != nil {
			row["body"] = *request.Body
		}
		result = append(result, row)
	}
	return result
}

func goLocalRPCParts(body string) (method string, params any, ok bool) {
	var value map[string]any
	if err := json.Unmarshal([]byte(body), &value); err != nil {
		return "", nil, false
	}
	method, ok = value["method"].(string)
	if !ok {
		return "", nil, false
	}
	return method, value["params"], true
}

func goLocalResponse(mock goLocalMock) *http.Response {
	status := mock.Response.Status
	if status == 0 {
		status = http.StatusOK
	}
	body := ""
	if mock.Response.Body != nil {
		body = *mock.Response.Body
	}
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
}

func goLocalRunCase(t *testing.T, fixture goLocalFixture, entry goLocalFixtureCase, quotes map[string]MayanSwiftV2Quote, plans map[string]MayanSwiftV2SourceSwapPlan) (map[string]any, []map[string]any, []map[string]any) {
	t.Helper()
	quote, ok := quotes[entry.QuoteID]
	if !ok {
		t.Fatalf("missing local fixture quote %s", entry.QuoteID)
	}
	if entry.Mutation != nil {
		quote = goLocalQuoteWithMutation(t, quote, entry.Mutation)
	}
	contextValue := MayanSwiftV2LocalContext{Quote: quote, SwapperAddress: goLocalString(t, entry.Context["swapperAddress"], "swapperAddress"), DestinationAddress: goLocalString(t, entry.Context["destinationAddress"], "destinationAddress"), OrderNonce: goLocalString(t, entry.Context["orderNonce"], "orderNonce")}

	sourceMocks := make(map[string]goLocalMock)
	for _, mock := range fixture.SourceSwapMocks {
		for _, mockID := range entry.SourceSwapMockIDs {
			if mock.MockID == mockID {
				sourceMocks[mock.MockID] = goLocalMutateMock(t, mock, entry.Mutation)
			}
		}
	}
	rpcMocks := make(map[string]goLocalMock)
	for _, mock := range fixture.RPCMocks {
		for _, mockID := range entry.RPCMockIDs {
			if mock.MockID != mockID {
				continue
			}
			mock = goLocalMutateRPCMock(t, mock, entry.Mutation)
			mock = goLocalMutateBoundary(t, mock, entry.Mutation)
			rpcMocks[mock.MockID] = mock
		}
	}

	capturedHTTP := make([]goLocalCapturedRequest, 0)
	capturedRPC := make([]goLocalCapturedRequest, 0)
	transportEvent := ""
	if entry.Mutation != nil && entry.Mutation["kind"] == "transport" {
		transportEvent, _ = entry.Mutation["event"].(string)
	}
	var cancel context.CancelFunc
	baseContext := context.Background()
	if transportEvent == "source-swap-abort" || transportEvent == "rpc-abort" {
		baseContext, cancel = context.WithCancel(baseContext)
		defer cancel()
	}
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if transportEvent == "credential-forwarding" || transportEvent == "hosted-build-attempt" {
			return nil, localError(BridgeLocalPlanInvalid)
		}
		var bodyBytes []byte
		if request.Body != nil {
			var err error
			bodyBytes, err = io.ReadAll(request.Body)
			if err != nil {
				return nil, err
			}
		}
		var body *string
		if len(bodyBytes) > 0 {
			value := string(bodyBytes)
			body = &value
		}
		trace := goLocalTraceRequest(request, body)
		if request.Method == http.MethodGet {
			capturedHTTP = append(capturedHTTP, trace)
		} else {
			capturedRPC = append(capturedRPC, trace)
		}
		if transportEvent == "source-swap-timeout" || transportEvent == "rpc-timeout" {
			<-request.Context().Done()
			return nil, request.Context().Err()
		}
		if transportEvent == "rpc-transport-error" {
			return nil, errors.New("rpc transport")
		}
		if transportEvent == "source-swap-abort" || transportEvent == "rpc-abort" {
			if cancel != nil {
				cancel()
			}
			<-request.Context().Done()
			return nil, request.Context().Err()
		}
		if request.Method == http.MethodGet {
			for _, mock := range sourceMocks {
				if mock.Request.URL == request.URL.String() {
					return goLocalResponse(mock), nil
				}
			}
			return nil, errors.New("unexpected source swap request")
		}
		method, params, ok := goLocalRPCParts(string(bodyBytes))
		if !ok {
			return nil, errors.New("invalid RPC request")
		}
		for _, mock := range rpcMocks {
			if mock.Request.URL != request.URL.String() || mock.Request.Body == nil {
				continue
			}
			expectedMethod, expectedParams, expectedOK := goLocalRPCParts(*mock.Request.Body)
			if expectedOK {
				actualJSON, _ := json.Marshal(params)
				expectedJSON, _ := json.Marshal(expectedParams)
				if expectedMethod == method && string(actualJSON) == string(expectedJSON) {
					return goLocalResponse(mock), nil
				}
			}
		}
		return nil, errors.New("unexpected RPC request")
	})
	configRaw := entry.Config
	if entry.Mutation != nil && entry.Mutation["kind"] == "config-set" {
		cloned := goLocalCloneMap(t, entry.Config)
		if !goLocalSetPath(cloned, goLocalString(t, entry.Mutation["path"], "config path"), entry.Mutation["value"]) {
			t.Fatalf("set config path")
		}
		configRaw = goLocalMap(t, cloned)
	}
	config := goLocalConfig(t, configRaw, transport, 30*time.Second)
	if transportEvent == "source-swap-timeout" || transportEvent == "rpc-timeout" {
		config.Timeout = 5 * time.Millisecond
	}
	client, err := NewMayanSwiftV2BridgeClient(config)
	if err != nil {
		t.Fatalf("local client: %v", err)
	}
	defer client.Close()
	client.clock = func() int64 {
		return mustLocalFixtureDeadline(t, fixture, entry.QuoteID) - 1
	}
	var value any
	var callErr error
	if entry.Method == "prepareSourceSwap" {
		value, callErr = client.PrepareSourceSwap(baseContext, contextValue)
	} else {
		if entry.SourceSwapPlanRef == nil {
			t.Fatalf("missing local plan reference %s", entry.CaseID)
		}
		plan, ok := plans[*entry.SourceSwapPlanRef]
		if !ok {
			t.Fatalf("missing local plan %s", *entry.SourceSwapPlanRef)
		}
		if entry.Mutation != nil && entry.Mutation["kind"] == "plan-set" {
			encoded, _ := json.Marshal(plan)
			var raw any
			decoder := json.NewDecoder(strings.NewReader(string(encoded)))
			decoder.UseNumber()
			_ = decoder.Decode(&raw)
			if !goLocalSetPath(raw, goLocalString(t, entry.Mutation["path"], "plan path"), entry.Mutation["value"]) {
				t.Fatalf("set plan path")
			}
			mutated, _ := json.Marshal(raw)
			var mutatedPlan MayanSwiftV2SourceSwapPlan
			if err := json.Unmarshal(mutated, &mutatedPlan); err != nil {
				t.Fatalf("decode mutated plan: %v", err)
			}
			plan = mutatedPlan
		}
		value, callErr = client.BuildLocalUnsigned(baseContext, MayanSwiftV2LocalBuildRequest{Quote: quote, SwapperAddress: contextValue.SwapperAddress, DestinationAddress: contextValue.DestinationAddress, OrderNonce: contextValue.OrderNonce, SourceSwapPlan: plan})
	}
	return goBridgeOutcome(value, callErr), goLocalTrace(capturedHTTP), goLocalTrace(capturedRPC)
}

func mustLocalFixtureDeadline(t *testing.T, fixture goLocalFixture, quoteID string) int64 {
	t.Helper()
	for _, record := range fixture.Quotes {
		if record.QuoteID == quoteID {
			value, err := strconv.ParseInt(record.Normalized.Deadline, 10, 64)
			if err != nil {
				t.Fatalf("quote deadline: %v", err)
			}
			return value
		}
	}
	t.Fatalf("missing quote deadline %s", quoteID)
	return 0
}

func goLocalBaseQuotes(t *testing.T, fixture goLocalFixture) map[string]MayanSwiftV2Quote {
	t.Helper()
	quotes := make(map[string]MayanSwiftV2Quote, len(fixture.Quotes))
	for _, record := range fixture.Quotes {
		quotes[record.QuoteID] = cloneBridgeQuote(record.Normalized)
	}
	return quotes
}

func goLocalBasePlans(t *testing.T, fixture goLocalFixture) map[string]MayanSwiftV2SourceSwapPlan {
	t.Helper()
	plans := make(map[string]MayanSwiftV2SourceSwapPlan)
	for _, entry := range fixture.Cases {
		if entry.Method != "prepareSourceSwap" || entry.Expected["kind"] != "success" {
			continue
		}
		encoded, err := json.Marshal(entry.Expected["value"])
		if err != nil {
			t.Fatalf("marshal expected local plan: %v", err)
		}
		var plan MayanSwiftV2SourceSwapPlan
		if err := json.Unmarshal(encoded, &plan); err != nil {
			t.Fatalf("decode expected local plan: %v", err)
		}
		plans[entry.CaseID] = plan
	}
	return plans
}

func goLocalFixtureBehavior(t *testing.T) (map[string][]map[string]any, string) {
	t.Helper()
	fixture := loadGoLocalFixture(t)
	quotes := goLocalBaseQuotes(t, fixture)
	plans := goLocalBasePlans(t, fixture)
	behavior := map[string][]map[string]any{"prepareSourceSwap": {}, "buildLocalUnsigned": {}}
	for _, entry := range fixture.Cases {
		outcome, httpTrace, rpcTrace := goLocalRunCase(t, fixture, entry, quotes, plans)
		mustSameJSON(t, outcome, entry.Expected)
		mustSameJSON(t, httpTrace, entry.HTTPTrace)
		mustSameJSON(t, rpcTrace, entry.RPCTrace)
		behavior[entry.Method] = append(behavior[entry.Method], map[string]any{"caseId": entry.CaseID, "outcome": outcome, "httpTrace": httpTrace, "rpcTrace": rpcTrace})
	}
	for _, cases := range behavior {
		sort.Slice(cases, func(i, j int) bool { return cases[i]["caseId"].(string) < cases[j]["caseId"].(string) })
	}
	return behavior, fixture.LocalFixtureDigest
}

func TestMayanSwiftV2LocalFixtures(t *testing.T) {
	fixture := loadGoLocalFixture(t)
	if fixture.LocalFixtureDigest != "19b1a9d601e7dedaf4e5ad8f8cbe9c7aec0d2b1f2f625b56eea53c48b16ee2d1" {
		t.Fatalf("local fixture digest = %s", fixture.LocalFixtureDigest)
	}
	prepareCount, buildCount := 0, 0
	for _, entry := range fixture.Cases {
		switch entry.Method {
		case "prepareSourceSwap":
			prepareCount++
		case "buildLocalUnsigned":
			buildCount++
		}
	}
	if len(fixture.Cases) != 87 || prepareCount != 42 || buildCount != 45 {
		t.Fatalf("local fixture counts = total %d, prepare %d, build %d", len(fixture.Cases), prepareCount, buildCount)
	}
	quotes := goLocalBaseQuotes(t, fixture)
	plans := goLocalBasePlans(t, fixture)
	for _, entry := range fixture.Cases {
		t.Run(entry.CaseID, func(t *testing.T) {
			outcome, httpTrace, rpcTrace := goLocalRunCase(t, fixture, entry, quotes, plans)
			mustSameJSON(t, outcome, entry.Expected)
			mustSameJSON(t, httpTrace, entry.HTTPTrace)
			mustSameJSON(t, rpcTrace, entry.RPCTrace)
		})
	}
}

func TestMayanSwiftV2LocalClientConstructionMakesNoIO(t *testing.T) {
	calls := 0
	client, err := NewMayanSwiftV2BridgeClient(MayanSwiftV2BridgeConfig{HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New("unexpected local request")
	})}, LocalBuild: &MayanSwiftV2LocalBuildConfig{EthereumRPC: &RPCEndpointConfig{HTTPURL: "https://ethereum.example/rpc"}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatalf("local client construction made %d calls", calls)
	}
}

func TestMayanSwiftV2LocalFixtureCasesAreSortedForCapture(t *testing.T) {
	fixture := loadGoLocalFixture(t)
	ids := make([]string, len(fixture.Cases))
	for index, entry := range fixture.Cases {
		ids[index] = entry.CaseID
	}
	sorted := append([]string(nil), ids...)
	sort.Strings(sorted)
	if len(ids) != len(sorted) {
		t.Fatal("local fixture case list changed while sorting")
	}
}

func TestMayanSwiftV2LocalPreflightRejectsRawAndNormalizedMetadata(t *testing.T) {
	fixture := loadGoLocalFixture(t)
	quotes := goLocalBaseQuotes(t, fixture)
	var baseCase goLocalFixtureCase
	for _, entry := range fixture.Cases {
		if entry.CaseID == "prepare-eurc-ethereum-to-solana" {
			baseCase = entry
			break
		}
	}
	base, ok := quotes[baseCase.QuoteID]
	if !ok {
		t.Fatal("missing EURC quote")
	}
	swapper := goLocalString(t, baseCase.Context["swapperAddress"], "swapperAddress")
	destination := goLocalString(t, baseCase.Context["destinationAddress"], "destinationAddress")
	nonce := goLocalString(t, baseCase.Context["orderNonce"], "orderNonce")
	deadline := mustLocalFixtureDeadline(t, fixture, baseCase.QuoteID)

	cases := []struct {
		name  string
		quote MayanSwiftV2Quote
	}{
		{
			name: "raw slippage 501",
			quote: goLocalQuoteWithMutation(t, base, map[string]any{
				"kind": "quote-raw-set", "path": "slippageBps", "value": 501,
			}),
		},
		{
			name: "normalized slippage 501",
			quote: func() MayanSwiftV2Quote {
				value := cloneBridgeQuote(base)
				value.SlippageBps = 501
				return value
			}(),
		},
		{
			name: "raw token chain metadata type",
			quote: goLocalQuoteWithMutation(t, base, map[string]any{
				"kind": "quote-raw-set", "path": "fromToken.chainId", "value": "1",
			}),
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			calls := 0
			zeroValidity := uint64(0)
			client, err := NewMayanSwiftV2BridgeClient(MayanSwiftV2BridgeConfig{
				Timeout:                     100 * time.Millisecond,
				MinimumQuoteValiditySeconds: &zeroValidity,
				HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
					calls++
					return nil, errors.New("unexpected preflight request")
				})},
				LocalBuild: &MayanSwiftV2LocalBuildConfig{SourceSwapEndpoint: "https://price-api.mayan.finance/v3"},
			})
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			client.clock = func() int64 { return deadline - 1 }
			_, callErr := client.PrepareSourceSwap(context.Background(), MayanSwiftV2LocalContext{
				Quote: testCase.quote, SwapperAddress: swapper, DestinationAddress: destination, OrderNonce: nonce,
			})
			if bridgeCode(callErr) != BridgeLocalPlanInvalid {
				t.Fatalf("error = %v, want %s", callErr, BridgeLocalPlanInvalid)
			}
			if calls != 0 {
				t.Fatalf("preflight made %d I/O calls", calls)
			}
		})
	}
}

func TestMayanSwiftV2LocalNativeCurveAndPDABoundaries(t *testing.T) {
	identity := make([]byte, 32)
	identity[0] = 1
	if !localIsOnCurveZIP215(identity) {
		t.Fatal("Edwards identity was rejected")
	}
	signOne := append([]byte(nil), identity...)
	signOne[31] |= 0x80
	if !localIsOnCurveZIP215(signOne) {
		t.Fatal("Edwards sign-bit identity was rejected")
	}
	nonCanonicalY := make([]byte, 32)
	nonCanonicalY[0] = 0xee
	for index := 1; index < 31; index++ {
		nonCanonicalY[index] = 0xff
	}
	nonCanonicalY[31] = 0x7f
	if !localIsOnCurveZIP215(nonCanonicalY) {
		t.Fatal("ZIP-215 non-canonical y encoding was rejected")
	}
	invalidSqrt := make([]byte, 32)
	invalidSqrt[0] = 0xef
	for index := 1; index < 31; index++ {
		invalidSqrt[index] = 0xff
	}
	invalidSqrt[31] = 0x7f
	if localIsOnCurveZIP215(invalidSqrt) {
		t.Fatal("invalid square-root encoding was accepted")
	}

	orderHash, err := localHexToBytes("0xc42deeea9cac160a58f83d57a274dcdb41c75c7863b2f412008bd87dfab2fbae")
	if err != nil {
		t.Fatal(err)
	}
	state, bump, err := localFindProgramAddress([][]byte{[]byte("STATE_SOURCE"), orderHash, localWriteUint16LE(2)}, bridgeSolanaSwiftProgram)
	if err != nil || state != "4QJszLcSnjKP4tZcTSYwyG7QdFst6T8wGU29rYPn8yjC" {
		t.Fatalf("state PDA = %s/%d/%v", state, bump, err)
	}
	if bump != 254 {
		t.Fatalf("state PDA bump = %d, want 254", bump)
	}
	tooManySeeds := make([][]byte, 17)
	if _, _, err := localFindProgramAddress(tooManySeeds, bridgeSolanaSwiftProgram); err == nil {
		t.Fatal("accepted more than 16 PDA seeds")
	}
	if _, _, err := localFindProgramAddress([][]byte{make([]byte, 33)}, bridgeSolanaSwiftProgram); err == nil {
		t.Fatal("accepted PDA seed longer than 32 bytes")
	}
}

type goLocalStreamBody struct {
	ctx         context.Context
	chunks      [][]byte
	cancelFirst context.CancelFunc
	waitAfter   bool
	index       int
	offset      int
	closed      chan struct{}
	once        sync.Once
}

func (body *goLocalStreamBody) Read(target []byte) (int, error) {
	if body.index < len(body.chunks) {
		chunk := body.chunks[body.index]
		count := copy(target, chunk[body.offset:])
		body.offset += count
		if body.offset == len(chunk) {
			body.index++
			body.offset = 0
		}
		if body.index == 1 && body.offset == 0 && body.cancelFirst != nil {
			body.cancelFirst()
		}
		return count, nil
	}
	if body.waitAfter {
		<-body.ctx.Done()
		return 0, body.ctx.Err()
	}
	return 0, io.EOF
}

func (body *goLocalStreamBody) Close() error {
	body.once.Do(func() { close(body.closed) })
	return nil
}

func TestMayanSwiftV2LocalSourceStreamingBoundsAndCancellation(t *testing.T) {
	fixture := loadGoLocalFixture(t)
	quotes := goLocalBaseQuotes(t, fixture)
	var baseCase goLocalFixtureCase
	for _, entry := range fixture.Cases {
		if entry.CaseID == "prepare-eurc-ethereum-to-solana" {
			baseCase = entry
			break
		}
	}
	base := quotes[baseCase.QuoteID]
	contextValue := MayanSwiftV2LocalContext{Quote: base, SwapperAddress: goLocalString(t, baseCase.Context["swapperAddress"], "swapperAddress"), DestinationAddress: goLocalString(t, baseCase.Context["destinationAddress"], "destinationAddress"), OrderNonce: goLocalString(t, baseCase.Context["orderNonce"], "orderNonce")}
	deadline := mustLocalFixtureDeadline(t, fixture, baseCase.QuoteID)

	t.Run("timeout through body", func(t *testing.T) {
		body := &goLocalStreamBody{ctx: context.Background(), chunks: [][]byte{[]byte("{")}, waitAfter: true, closed: make(chan struct{})}
		var requestContext context.Context
		transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
			requestContext = request.Context()
			body.ctx = request.Context()
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: body}, nil
		})
		zeroValidity := uint64(0)
		client, err := NewMayanSwiftV2BridgeClient(MayanSwiftV2BridgeConfig{Timeout: 5 * time.Millisecond, MinimumQuoteValiditySeconds: &zeroValidity, HTTPClient: &http.Client{Transport: transport}, LocalBuild: &MayanSwiftV2LocalBuildConfig{SourceSwapEndpoint: "https://price-api.mayan.finance/v3"}})
		if err != nil {
			t.Fatal(err)
		}
		defer client.Close()
		client.clock = func() int64 { return deadline - 1 }
		_, callErr := client.PrepareSourceSwap(context.Background(), contextValue)
		if bridgeCode(callErr) != BridgeTimeout || requestContext == nil {
			t.Fatalf("error = %v, context = %v", callErr, requestContext)
		}
		select {
		case <-body.closed:
		case <-time.After(time.Second):
			t.Fatal("timed-out response body was not closed")
		}
	})

	t.Run("abort through body", func(t *testing.T) {
		parent, cancel := context.WithCancel(context.Background())
		defer cancel()
		body := &goLocalStreamBody{ctx: parent, chunks: [][]byte{[]byte("{")}, waitAfter: true, closed: make(chan struct{}), cancelFirst: cancel}
		transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
			body.ctx = request.Context()
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: body}, nil
		})
		zeroValidity := uint64(0)
		client, err := NewMayanSwiftV2BridgeClient(MayanSwiftV2BridgeConfig{Timeout: time.Second, MinimumQuoteValiditySeconds: &zeroValidity, HTTPClient: &http.Client{Transport: transport}, LocalBuild: &MayanSwiftV2LocalBuildConfig{SourceSwapEndpoint: "https://price-api.mayan.finance/v3"}})
		if err != nil {
			t.Fatal(err)
		}
		defer client.Close()
		client.clock = func() int64 { return deadline - 1 }
		_, callErr := client.PrepareSourceSwap(parent, contextValue)
		if bridgeCode(callErr) != BridgeAborted {
			t.Fatalf("error = %v", callErr)
		}
		select {
		case <-body.closed:
		case <-time.After(time.Second):
			t.Fatal("aborted response body was not closed")
		}
	})

	t.Run("size cap during body", func(t *testing.T) {
		body := &goLocalStreamBody{ctx: context.Background(), chunks: [][]byte{bytes.Repeat([]byte("x"), 700_000), bytes.Repeat([]byte("x"), 400_000)}, closed: make(chan struct{})}
		transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
			body.ctx = request.Context()
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: body}, nil
		})
		zeroValidity := uint64(0)
		client, err := NewMayanSwiftV2BridgeClient(MayanSwiftV2BridgeConfig{Timeout: time.Second, MinimumQuoteValiditySeconds: &zeroValidity, HTTPClient: &http.Client{Transport: transport}, LocalBuild: &MayanSwiftV2LocalBuildConfig{SourceSwapEndpoint: "https://price-api.mayan.finance/v3"}})
		if err != nil {
			t.Fatal(err)
		}
		defer client.Close()
		client.clock = func() int64 { return deadline - 1 }
		_, callErr := client.PrepareSourceSwap(context.Background(), contextValue)
		if bridgeCode(callErr) != BridgeProviderInvalidResponse {
			t.Fatalf("error = %v", callErr)
		}
		select {
		case <-body.closed:
		case <-time.After(time.Second):
			t.Fatal("oversized response body was not closed")
		}
	})
}
