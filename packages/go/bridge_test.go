package erpc

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

type goBridgeFixture struct {
	SchemaVersion    int                   `json:"schemaVersion"`
	FixtureKind      string                `json:"fixtureKind"`
	CapabilityAsOf   string                `json:"capabilityAsOfDate"`
	CapabilityDigest string                `json:"capabilityDigest"`
	Cases            []goBridgeFixtureCase `json:"cases"`
}

type goBridgeFixtureCase struct {
	CaseID         string           `json:"caseId"`
	Method         string           `json:"method"`
	Source         string           `json:"source"`
	CapabilityID   string           `json:"capabilityId"`
	Request        map[string]any   `json:"request"`
	NowSeconds     int64            `json:"nowSeconds"`
	ProviderStatus *int             `json:"providerStatus"`
	ProviderBody   *string          `json:"providerBody"`
	Expected       map[string]any   `json:"expected"`
	HTTPTrace      []map[string]any `json:"httpTrace"`
	Config         map[string]any   `json:"config"`
	QuoteCaseID    *string          `json:"quoteCaseId"`
}

type goBridgeCapturedRequest struct {
	Method  string
	URL     string
	Headers map[string]string
	Body    *string
}

func goBridgeFixturePath() string {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		return filepath.Join("..", "..", "registry", "fixtures", "mayan-swift-v2-cases.json")
	}
	return filepath.Join(filepath.Dir(source), "..", "..", "registry", "fixtures", "mayan-swift-v2-cases.json")
}

func loadGoBridgeFixture(t *testing.T) goBridgeFixture {
	t.Helper()
	data, err := os.ReadFile(goBridgeFixturePath())
	if err != nil {
		t.Fatalf("read bridge fixture: %v", err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	var fixture goBridgeFixture
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatalf("decode bridge fixture: %v", err)
	}
	if fixture.SchemaVersion != 1 || fixture.FixtureKind != "mayan-swift-v2-fixtures" {
		t.Fatalf("unexpected bridge fixture metadata: %#v", fixture)
	}
	return fixture
}

func goBridgeString(t *testing.T, value any, field string) string {
	t.Helper()
	text, ok := value.(string)
	if !ok {
		t.Fatalf("bridge fixture field %s is not a string: %#v", field, value)
	}
	return text
}

func goBridgeUint(t *testing.T, value any, field string) uint64 {
	t.Helper()
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil || parsed < 0 {
			t.Fatalf("bridge fixture field %s is not an integer: %#v", field, value)
		}
		return uint64(parsed)
	case float64:
		if typed < 0 || typed != float64(uint64(typed)) {
			t.Fatalf("bridge fixture field %s is not an integer: %#v", field, value)
		}
		return uint64(typed)
	default:
		t.Fatalf("bridge fixture field %s is not an integer: %#v", field, value)
		return 0
	}
}

func goBridgeQuoteRequest(t *testing.T, raw map[string]any) MayanSwiftV2QuoteRequest {
	t.Helper()
	return MayanSwiftV2QuoteRequest{
		SourceChainID:                goBridgeString(t, raw["sourceChainId"], "sourceChainId"),
		DestinationChainID:           goBridgeString(t, raw["destinationChainId"], "destinationChainId"),
		SourceTokenDeploymentID:      goBridgeString(t, raw["sourceTokenDeploymentId"], "sourceTokenDeploymentId"),
		DestinationTokenDeploymentID: goBridgeString(t, raw["destinationTokenDeploymentId"], "destinationTokenDeploymentId"),
		AmountIn:                     goBridgeString(t, raw["amountIn"], "amountIn"),
		SlippageBps:                  goBridgeUint(t, raw["slippageBps"], "slippageBps"),
	}
}

func goBridgeQuoteFromJSON(t *testing.T, raw map[string]any) MayanSwiftV2Quote {
	t.Helper()
	encoded, err := json.Marshal(raw)
	if err != nil {
		t.Fatalf("marshal bridge quote fixture: %v", err)
	}
	var quote MayanSwiftV2Quote
	if err := json.Unmarshal(encoded, &quote); err != nil {
		t.Fatalf("decode bridge quote fixture: %v", err)
	}
	return quote
}

func goBridgeResponse(body string, status int) string {
	if body == "__SYNTHETIC_BODY_EXCEEDS_1MIB__" {
		return strings.Repeat("x", bridgeMaxResponseBytes+1)
	}
	if status == http.StatusNotFound && body == "" {
		return ""
	}
	return body
}

func goBridgeFixtureServer(t *testing.T, fixtureCase goBridgeFixtureCase, captured *[]goBridgeCapturedRequest, abort func()) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body *string
		if request.Body != nil {
			data, err := io.ReadAll(request.Body)
			if err != nil {
				t.Errorf("read bridge request body: %v", err)
			} else if len(data) != 0 {
				value := string(data)
				body = &value
			}
		}
		headers := make(map[string]string)
		for name, values := range request.Header {
			if len(values) == 0 {
				continue
			}
			lowerName := strings.ToLower(name)
			switch lowerName {
			case "accept", "content-type", "x-api-key":
				headers[lowerName] = values[0]
			case "authorization", "cookie":
				t.Errorf("bridge request carried forbidden %s header", lowerName)
			case "user-agent", "host", "content-length":
				// These are transport-generated and excluded from the
				// cross-language trace contract.
			default:
				t.Errorf("bridge request carried unexpected %s header", lowerName)
			}
		}
		traceURL := request.URL.String()
		if len(fixtureCase.HTTPTrace) > 0 {
			if expected, ok := fixtureCase.HTTPTrace[0]["url"].(string); ok {
				traceURL = expected
			}
		}
		*captured = append(*captured, goBridgeCapturedRequest{Method: request.Method, URL: traceURL, Headers: headers, Body: body})
		if fixtureCase.CaseID == "quote-aborted" && abort != nil {
			abort()
		}
		if fixtureCase.CaseID == "quote-timeout" {
			<-request.Context().Done()
			return
		}
		status := http.StatusOK
		if fixtureCase.ProviderStatus != nil {
			status = *fixtureCase.ProviderStatus
		}
		writer.WriteHeader(status)
		if fixtureCase.ProviderBody != nil {
			_, _ = io.WriteString(writer, goBridgeResponse(*fixtureCase.ProviderBody, status))
		}
	}))
}

func goBridgeTrace(captured []goBridgeCapturedRequest) []map[string]any {
	trace := make([]map[string]any, 0, len(captured))
	for _, request := range captured {
		value := map[string]any{
			"method":  request.Method,
			"url":     request.URL,
			"headers": request.Headers,
			"body":    nil,
		}
		if request.Body != nil {
			value["body"] = *request.Body
		}
		trace = append(trace, value)
	}
	return trace
}

func goBridgeErrorOutcome(err error) map[string]any {
	var bridgeErr *BridgeError
	if !errors.As(err, &bridgeErr) || bridgeErr == nil {
		return map[string]any{"kind": "transport-error", "sourcePreserved": true}
	}
	result := map[string]any{
		"kind":    "sdk-error",
		"code":    string(bridgeErr.Code),
		"message": bridgeErr.Error(),
	}
	if bridgeErr.Status != 0 {
		result["status"] = bridgeErr.Status
	}
	return result
}

func goBridgeOutcome(value any, err error) map[string]any {
	if err != nil {
		return goBridgeErrorOutcome(err)
	}
	encoded, marshalErr := json.Marshal(value)
	if marshalErr != nil {
		panic(marshalErr)
	}
	var result any
	if err := json.Unmarshal(encoded, &result); err != nil {
		panic(err)
	}
	return map[string]any{"kind": "success", "value": result}
}

func goBridgeConfig(t *testing.T, fixtureCase goBridgeFixtureCase, endpoint string) MayanSwiftV2BridgeConfig {
	t.Helper()
	config := MayanSwiftV2BridgeConfig{BuilderEndpoint: endpoint, ExplorerEndpoint: endpoint}
	for key, value := range fixtureCase.Config {
		switch key {
		case "allowUnauthenticatedBuild":
			allowed, ok := value.(bool)
			if !ok {
				t.Fatalf("allowUnauthenticatedBuild is not bool")
			}
			config.AllowUnauthenticatedBuild = allowed
		case "builderApiKey":
			config.BuilderAPIKey = goBridgeString(t, value, key)
		case "minimumQuoteValiditySeconds":
			minimum := goBridgeUint(t, value, key)
			config.MinimumQuoteValiditySeconds = &minimum
		}
	}
	if fixtureCase.CaseID == "quote-timeout" {
		config.Timeout = time.Millisecond
	}
	return config
}

func goBridgeCaptureBaseQuotes(t *testing.T, fixture goBridgeFixture) map[string]MayanSwiftV2Quote {
	t.Helper()
	quotes := make(map[string]MayanSwiftV2Quote)
	for _, fixtureCase := range fixture.Cases {
		if fixtureCase.Method != "quote" || fixtureCase.Expected["kind"] != "success" || fixtureCase.ProviderBody == nil || *fixtureCase.ProviderBody == "__SYNTHETIC_BODY_EXCEEDS_1MIB__" {
			continue
		}
		captured := make([]goBridgeCapturedRequest, 0, 1)
		server := goBridgeFixtureServer(t, fixtureCase, &captured, nil)
		client, err := NewMayanSwiftV2BridgeClient(goBridgeConfig(t, fixtureCase, server.URL))
		if err != nil {
			server.Close()
			t.Fatalf("base quote client %s: %v", fixtureCase.CaseID, err)
		}
		client.clock = func() int64 { return fixtureCase.NowSeconds }
		value, callErr := client.QuoteExactInput(context.Background(), goBridgeQuoteRequest(t, fixtureCase.Request))
		client.Close()
		server.Close()
		if callErr != nil || len(value) == 0 {
			t.Fatalf("base quote %s: %v", fixtureCase.CaseID, callErr)
		}
		quotes[fixtureCase.CaseID] = value[0]
	}
	return quotes
}

func TestMayanSwiftV2BridgeFixtures(t *testing.T) {
	fixture := loadGoBridgeFixture(t)
	if fixture.CapabilityAsOf != bridgeCapabilitiesAsOfDate || fixture.CapabilityDigest != bridgeCapabilitiesContentDigest {
		t.Fatalf("bridge capability metadata = (%s, %s), want (%s, %s)", fixture.CapabilityAsOf, fixture.CapabilityDigest, bridgeCapabilitiesAsOfDate, bridgeCapabilitiesContentDigest)
	}
	quotes := goBridgeCaptureBaseQuotes(t, fixture)
	for _, fixtureCase := range fixture.Cases {
		t.Run(fixtureCase.CaseID, func(t *testing.T) {
			captured := make([]goBridgeCapturedRequest, 0, 1)
			cancel := func() {}
			server := goBridgeFixtureServer(t, fixtureCase, &captured, func() {
				cancel()
			})
			config := goBridgeConfig(t, fixtureCase, server.URL)
			client, err := NewMayanSwiftV2BridgeClient(config)
			if err != nil {
				server.Close()
				t.Fatalf("bridge client: %v", err)
			}
			client.clock = func() int64 { return fixtureCase.NowSeconds }
			var value any
			var callErr error
			callContext := context.Background()
			if fixtureCase.CaseID == "quote-aborted" {
				callContext, cancel = context.WithCancel(context.Background())
				defer cancel()
			}
			switch fixtureCase.Method {
			case "quote":
				value, callErr = client.QuoteExactInput(callContext, goBridgeQuoteRequest(t, fixtureCase.Request))
			case "build":
				quoteID := ""
				if fixtureCase.QuoteCaseID != nil {
					quoteID = *fixtureCase.QuoteCaseID
				}
				if fixtureCase.CaseID == "build-quote-mismatch" {
					quoteID = "quote-eth-sol-synthetic"
				}
				quote, ok := quotes[quoteID]
				if !ok {
					t.Fatalf("missing quote %s", quoteID)
				}
				if fixtureCase.CaseID == "build-quote-mismatch" {
					quote.AmountIn = "100000001"
				}
				request := MayanSwiftV2BuildRequest{Quote: quote, SwapperAddress: goBridgeString(t, fixtureCase.Request["swapperAddress"], "swapperAddress"), DestinationAddress: goBridgeString(t, fixtureCase.Request["destinationAddress"], "destinationAddress")}
				value, callErr = client.BuildUnsigned(callContext, request)
			case "status":
				value, callErr = client.GetStatus(callContext, MayanSwiftV2StatusRequest{SourceChainID: goBridgeString(t, fixtureCase.Request["sourceChainId"], "sourceChainId"), SourceTransactionHash: goBridgeString(t, fixtureCase.Request["sourceTransactionHash"], "sourceTransactionHash")})
			default:
				t.Fatalf("unsupported fixture method %s", fixtureCase.Method)
			}
			client.Close()
			server.Close()
			mustSameJSON(t, goBridgeOutcome(value, callErr), fixtureCase.Expected)
			mustSameJSON(t, goBridgeTrace(captured), fixtureCase.HTTPTrace)
		})
	}
}

func TestMayanSwiftV2BridgeConstructsWithoutIOAndCloseIsSafe(t *testing.T) {
	calls := 0
	baseClient := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New("unexpected provider request")
	})}
	client, err := NewMayanSwiftV2BridgeClient(MayanSwiftV2BridgeConfig{HTTPClient: baseClient})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatalf("construction or close made %d provider calls", calls)
	}
	if strings.Contains(client.String(), "unexpected") {
		t.Fatal("client debug string includes transport details")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func TestMayanSwiftV2BridgeWritesNativeParityCapture(t *testing.T) {
	outputPath := os.Getenv("ERPC_SDK_BRIDGE_PARITY_OUTPUT")
	if outputPath == "" {
		return
	}
	fixture := loadGoBridgeFixture(t)
	quotes := goBridgeCaptureBaseQuotes(t, fixture)
	behavior := map[string][]map[string]any{"quote": {}, "build": {}, "status": {}}
	for _, fixtureCase := range fixture.Cases {
		captured := make([]goBridgeCapturedRequest, 0, 1)
		cancel := func() {}
		server := goBridgeFixtureServer(t, fixtureCase, &captured, func() {
			cancel()
		})
		client, err := NewMayanSwiftV2BridgeClient(goBridgeConfig(t, fixtureCase, server.URL))
		if err != nil {
			server.Close()
			t.Fatal(err)
		}
		client.clock = func() int64 { return fixtureCase.NowSeconds }
		callContext := context.Background()
		if fixtureCase.CaseID == "quote-aborted" {
			callContext, cancel = context.WithCancel(context.Background())
			defer cancel()
		}
		var value any
		var callErr error
		switch fixtureCase.Method {
		case "quote":
			value, callErr = client.QuoteExactInput(callContext, goBridgeQuoteRequest(t, fixtureCase.Request))
		case "build":
			quoteID := ""
			if fixtureCase.QuoteCaseID != nil {
				quoteID = *fixtureCase.QuoteCaseID
			}
			if fixtureCase.CaseID == "build-quote-mismatch" {
				quoteID = "quote-eth-sol-synthetic"
			}
			quote := quotes[quoteID]
			if fixtureCase.CaseID == "build-quote-mismatch" {
				quote.AmountIn = "100000001"
			}
			value, callErr = client.BuildUnsigned(callContext, MayanSwiftV2BuildRequest{Quote: quote, SwapperAddress: goBridgeString(t, fixtureCase.Request["swapperAddress"], "swapperAddress"), DestinationAddress: goBridgeString(t, fixtureCase.Request["destinationAddress"], "destinationAddress")})
		case "status":
			value, callErr = client.GetStatus(callContext, MayanSwiftV2StatusRequest{SourceChainID: goBridgeString(t, fixtureCase.Request["sourceChainId"], "sourceChainId"), SourceTransactionHash: goBridgeString(t, fixtureCase.Request["sourceTransactionHash"], "sourceTransactionHash")})
		}
		client.Close()
		server.Close()
		outcome := goBridgeOutcome(value, callErr)
		trace := goBridgeTrace(captured)
		mustSameJSON(t, outcome, fixtureCase.Expected)
		mustSameJSON(t, trace, fixtureCase.HTTPTrace)
		behavior[fixtureCase.Method] = append(behavior[fixtureCase.Method], map[string]any{"caseId": fixtureCase.CaseID, "outcome": outcome, "httpTrace": trace})
	}
	for _, cases := range behavior {
		sort.Slice(cases, func(i, j int) bool { return cases[i]["caseId"].(string) < cases[j]["caseId"].(string) })
	}
	snapshot := map[string]any{
		"snapshotVersion":    1,
		"snapshotKind":       "bridge-native-runtime",
		"language":           "go",
		"runtime":            "go-" + runtime.Version(),
		"capabilityAsOfDate": bridgeCapabilitiesAsOfDate,
		"capabilityDigest":   bridgeCapabilitiesContentDigest,
		"behavior":           behavior,
	}
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, '\n')
	if err := os.WriteFile(outputPath, data, 0o644); err != nil {
		t.Fatalf("write bridge parity capture: %v", err)
	}
}
