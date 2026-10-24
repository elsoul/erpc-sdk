package erpc

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func suiTestFacts() c1MethodFacts {
	return c1MethodFacts{methods: map[string]string{
		"GetServiceInfo": "/sui.rpc.v2.LedgerService/GetServiceInfo",
		"GetObject":      "/sui.rpc.v2.LedgerService/GetObject",
		"GetBalance":     "/sui.rpc.v2.StateService/GetBalance",
	}}
}

func TestSuiGoldenRequestFramesAndResponses(t *testing.T) {
	cases := []struct {
		name, kind, objectID, owner, coinType, want string
		version                                     *uint64
	}{
		{name: "service", kind: "GetServiceInfo", want: "0000000000"},
		{name: "object-version-zero", kind: "GetObject", objectID: "0x2", version: suiUint64Pointer(0), want: "00000000070a033078321000"},
		{name: "object-version-absent", kind: "GetObject", objectID: "0x2", want: "00000000050a03307832"},
		{name: "balance", kind: "GetBalance", owner: "owner", coinType: "coin", want: "000000000d0a056f776e65721204636f696e"},
	}
	for _, testCase := range cases {
		frame, err := encodeSuiRequest(testCase.kind, testCase.objectID, testCase.version, testCase.owner, testCase.coinType)
		if err != nil {
			t.Fatalf("%s encode: %v", testCase.name, err)
		}
		if got := hex.EncodeToString(frame); got != testCase.want {
			t.Fatalf("%s frame = %s, want %s", testCase.name, got, testCase.want)
		}
	}

	serviceBody := mustSuiHex(t, "00000000660a2c3462746975694d507645454e737474705a4337435a353344727543334d4167667a6e446241535a374452365312076d61696e6e657418ffffffffffffffffff01202a2a080895bae7b506107b3000380042087375692d746573749a060769676e6f7265648000000010677270632d7374617475733a20300d0a")
	servicePayload, err := suiDecodeFrames(serviceBody)
	if err != nil {
		t.Fatalf("service frames: %v", err)
	}
	var service suiServiceInfo
	if err := decodeSuiServiceInfo(servicePayload, &service, 0); err != nil {
		t.Fatalf("service decode: %v", err)
	}
	if service.chain != "mainnet" || service.epoch != ^uint64(0) || service.checkpoint != 42 || service.timestamp.seconds != 1_723_456_789 || service.timestamp.nanos != 123 || service.server == nil || *service.server != "sui-test" {
		t.Fatalf("service = %#v", service)
	}

	objectBody := mustSuiHex(t, "00000000110a0f1203307832180722066469676573748000000010677270632d7374617475733a20300d0a")
	objectPayload, err := suiDecodeFrames(objectBody)
	if err != nil {
		t.Fatalf("object frames: %v", err)
	}
	object, err := decodeSuiObjectResponse(objectPayload)
	if err != nil {
		t.Fatalf("object decode: %v", err)
	}
	if object.ObjectID != "0x2" || object.Version != 7 || object.Digest != "digest" {
		t.Fatalf("object = %#v", object)
	}

	balanceBody := mustSuiHex(t, "00000000170a150a0d3078323a3a7375693a3a535549182a202828028000000010677270632d7374617475733a20300d0a")
	balancePayload, err := suiDecodeFrames(balanceBody)
	if err != nil {
		t.Fatalf("balance frames: %v", err)
	}
	balance, err := decodeSuiBalanceResponse(balancePayload)
	if err != nil {
		t.Fatalf("balance decode: %v", err)
	}
	if balance.CoinType != "0x2::sui::SUI" || balance.Balance != 42 || balance.AddressBalance != 40 || balance.CoinBalance != 2 {
		t.Fatalf("balance = %#v", balance)
	}
}

func TestSuiActualLoopbackTransportAndPrefixRouting(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/tenant%2Fone/sui.rpc.v2.LedgerService/GetServiceInfo" && request.URL.Path != "/tenant/one/sui.rpc.v2.LedgerService/GetServiceInfo" {
			t.Errorf("path = %q", request.URL.Path)
		}
		if request.Header.Get("Content-Type") != SuiGRPCWebContentType || request.Header.Get("Accept") != SuiGRPCWebContentType || request.Header.Get("X-Grpc-Web") != "1" {
			t.Errorf("protocol headers = %#v", request.Header)
		}
		body := mustSuiHex(t, "00000000660a2c3462746975694d507645454e737474705a4337435a353344727543334d4167667a6e446241535a374452365312076d61696e6e657418ffffffffffffffffff01202a2a080895bae7b506107b3000380042087375692d746573749a060769676e6f7265648000000010677270632d7374617475733a20300d0a")
		response.Header().Set("Content-Type", SuiGRPCWebContentType)
		response.WriteHeader(http.StatusOK)
		_, _ = response.Write(body)
	}))
	defer server.Close()
	resolved, err := resolveConfig(Config{APIKey: "legacy", HTTPClient: &http.Client{}})
	if err != nil {
		t.Fatal(err)
	}
	direct, err := resolveSuiGRPCWebEndpoint(&SuiGRPCWebEndpointConfig{BaseURL: server.URL + "/tenant%2Fone?token=a%2Fb", Headers: http.Header{"Authorization": {"Bearer direct"}}}, "SuiGRPCWeb")
	if err != nil {
		t.Fatal(err)
	}
	transport := newSuiGRPCWebTransport(resolved, nil, direct)
	transport.facts = suiTestFacts()
	client := newSuiClient(transport)
	service, err := client.GRPC.GetServiceInfo(context.Background())
	if err != nil {
		t.Fatalf("GetServiceInfo: %v", err)
	}
	if service.Chain != "mainnet" || !strings.HasPrefix(client.GRPC.Endpoint(), "http://127.0.0.1:") || !strings.HasSuffix(client.GRPC.Endpoint(), "/") {
		t.Fatalf("service/client = %#v, %q", service, client.GRPC.Endpoint())
	}
}

func TestSuiFrameAndTrailerFailuresAreSafe(t *testing.T) {
	valid := mustSuiHex(t, "00000000008000000010677270632d7374617475733a20300d0a")
	if _, err := suiDecodeFrames(valid); err != nil {
		t.Fatalf("valid empty data = %v", err)
	}
	for _, body := range [][]byte{
		{0x01, 0, 0, 0, 0},
		{0, 0, 0, 0, 0, 0x80, 0, 0, 0, 0},
		{0, 0, 0, 0, 0, 0x80, 0, 0, 0, 0, 0},
	} {
		if _, err := suiDecodeFrames(body); err == nil {
			t.Fatalf("invalid frame accepted: %x", body)
		}
	}
	if err := validateSuiInput("\n"); err == nil {
		t.Fatal("control input accepted")
	}
	group := suiReader{data: []byte{0x9b, 0x06, 0x08, 0x01, 0x9c, 0x06}}
	field, wire, err := group.key()
	if err != nil || field != 99 || wire != 3 || group.skip(field, wire, 0) != nil || group.remaining() != 0 {
		t.Fatal("matched unknown group was not skipped")
	}
	unmatched := suiReader{data: []byte{0x9c, 0x06}}
	field, wire, err = unmatched.key()
	if err == nil && unmatched.skip(field, wire, 0) == nil {
		t.Fatal("unmatched group end was accepted")
	}
}

func TestSuiWholeDepthAndMergedPartialMessages(t *testing.T) {
	objectFields := []byte{0x12, 0x00, 0x18, 0x00, 0x22, 0x00}
	for _, testCase := range []struct {
		groups    int
		wantError bool
	}{{99, false}, {100, true}} {
		groups := []byte{}
		for index := 0; index < testCase.groups; index++ {
			groups = append(suiTestVarint(uint64(99<<3|3)), groups...)
			groups = append(groups, suiTestVarint(uint64(99<<3|4))...)
		}
		payload := append(append([]byte(nil), objectFields...), groups...)
		_, err := decodeSuiObjectResponse(msg(1, payload))
		if (err != nil) != testCase.wantError {
			t.Fatalf("groups=%d error=%v", testCase.groups, err)
		}
	}

	objectPayload := append(msg(1, []byte{0x12, 0x00}), msg(1, []byte{0x18, 0x00, 0x22, 0x00})...)
	object, err := decodeSuiObjectResponse(objectPayload)
	if err != nil || object.ObjectID != "" || object.Version != 0 || object.Digest != "" {
		t.Fatalf("merged object = %#v, %v", object, err)
	}

	balancePayload := append(msg(1, []byte{0x0a, 0x00, 0x18, 0x2a}), msg(1, []byte{0x20, 0x28, 0x28, 0x02})...)
	balance, err := decodeSuiBalanceResponse(balancePayload)
	if err != nil || balance.CoinType != "" || balance.Balance != 42 || balance.AddressBalance != 40 || balance.CoinBalance != 2 {
		t.Fatalf("merged balance = %#v, %v", balance, err)
	}
}

func TestSuiTimestampMergeValidatesOnlyFinalState(t *testing.T) {
	base := []byte{0x0a, 0x00, 0x12, 0x00, 0x18, 0x00, 0x20, 0x00, 0x30, 0x00, 0x38, 0x00}
	validAfterInvalid := append(append([]byte{}, base...), msg(5, []byte{0x10, 0x80, 0x94, 0xeb, 0xdc, 0x03})...)
	validAfterInvalid = append(validAfterInvalid, msg(5, []byte{0x10, 0x00})...)
	if err := decodeSuiServiceInfo(validAfterInvalid, &suiServiceInfo{}, 0); err != nil {
		t.Fatalf("invalid then valid timestamp: %v", err)
	}
	invalidFinal := append(append([]byte{}, base...), msg(5, []byte{0x10, 0x00})...)
	invalidFinal = append(invalidFinal, msg(5, []byte{0x10, 0x80, 0x94, 0xeb, 0xdc, 0x03})...)
	if err := decodeSuiServiceInfo(invalidFinal, &suiServiceInfo{}, 0); err == nil {
		t.Fatal("invalid final timestamp accepted")
	}
}

func TestSuiInputAndLifecycleErrorsAreSafe(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls++
		response.Header().Set("Content-Type", SuiGRPCWebContentType)
		_, _ = response.Write(mustSuiHex(t, "00000000110a0f1203307832180722066469676573748000000010677270632d7374617475733a20300d0a"))
	}))
	defer server.Close()
	client, err := NewClient(Config{SuiGRPCWeb: &SuiGRPCWebEndpointConfig{BaseURL: server.URL}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Sui.GRPC.GetObject(context.Background(), string([]byte{0xff}), nil); err == nil {
		t.Fatal("invalid UTF-8 input accepted")
	}
	if calls != 0 {
		t.Fatalf("invalid input calls = %d", calls)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := client.Sui.GRPC.GetObject(cancelled, "x", nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("pre-cancel error = %v", err)
	}
	if calls != 0 {
		t.Fatalf("pre-cancel calls = %d", calls)
	}

	failedClient, err := NewClient(Config{SuiGRPCWeb: &SuiGRPCWebEndpointConfig{BaseURL: server.URL}, HTTPClient: &http.Client{Transport: suiFailingRoundTripper{}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := failedClient.Sui.GRPC.GetObject(context.Background(), "x", nil); err == nil {
		t.Fatal("native body read error succeeded")
	} else {
		var sdkErr *Error
		if !errors.As(err, &sdkErr) || sdkErr.Kind != ErrorTransport {
			t.Fatalf("native body read error = %#v", err)
		}
	}
}

func TestSuiEndpointConfigDisplayUsesOriginAndHeaderNames(t *testing.T) {
	endpoint := SuiGRPCWebEndpointConfig{
		BaseURL: "https://example.invalid/REVIEW-PATH?key=REVIEW-QUERY",
		Headers: http.Header{"Authorization": {"Bearer REVIEW-HEADER"}},
	}
	for _, display := range []string{
		fmt.Sprint(endpoint),
		fmt.Sprintf("%+v", endpoint),
		fmt.Sprintf("%#v", endpoint),
	} {
		if strings.Contains(display, "REVIEW-PATH") || strings.Contains(display, "REVIEW-QUERY") || strings.Contains(display, "REVIEW-HEADER") {
			t.Fatalf("endpoint display leaked credentials or target details: %q", display)
		}
		if !strings.Contains(display, "https://example.invalid/") || !strings.Contains(display, "Authorization") {
			t.Fatalf("endpoint display omitted safe metadata: %q", display)
		}
	}
}

type suiFailingRoundTripper struct{}

func (suiFailingRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {SuiGRPCWebContentType}}, Body: suiFailingBody{}}, nil
}

type suiFailingBody struct{}

func (suiFailingBody) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func (suiFailingBody) Close() error             { return nil }

func suiTestVarint(value uint64) []byte {
	var result []byte
	for value >= 0x80 {
		result = append(result, byte(value)|0x80)
		value >>= 7
	}
	return append(result, byte(value))
}

func msg(field uint64, payload []byte) []byte {
	result := append(suiTestVarint(field<<3|2), suiTestVarint(uint64(len(payload)))...)
	return append(result, payload...)
}

func mustSuiHex(t *testing.T, value string) []byte {
	t.Helper()
	result, err := hex.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func suiUint64Pointer(value uint64) *uint64 { return &value }
