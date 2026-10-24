package erpc

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBitcoinCodecRetainsNumbersAndUsesLastDecodedKey(t *testing.T) {
	value, err := decodeBitcoinJSON([]byte(`{"result":1.20,"\u0072esult":3.40,"nested":[18446744073709551616,1e-1000]}`))
	if err != nil {
		t.Fatalf("decodeBitcoinJSON() error = %v", err)
	}
	root, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("decoded root type = %T, want object", value)
	}
	if got := root["result"].(json.Number).String(); got != "3.40" {
		t.Fatalf("last duplicate result = %q, want 3.40", got)
	}
	nested, ok := root["nested"].([]any)
	if !ok || len(nested) != 2 {
		t.Fatalf("nested = %#v, want two values", root["nested"])
	}
	if got := nested[0].(json.Number).String(); got != "18446744073709551616" {
		t.Fatalf("large integer = %q, want lossless spelling", got)
	}
	if got := nested[1].(json.Number).String(); got != "1e-1000" {
		t.Fatalf("exponent = %q, want lossless spelling", got)
	}

	decimal, ok := canonicalizeBitcoinNumber("0.00000001")
	if !ok {
		t.Fatal("canonicalizeBitcoinNumber(0.00000001) rejected")
	}
	exponent, ok := canonicalizeBitcoinNumber("1e-8")
	if !ok || !bitcoinNumberTuplesEqual(decimal, exponent) {
		t.Fatalf("equal mathematical values differ: %#v vs %#v", decimal, exponent)
	}
	zero, ok := canonicalizeBitcoinNumber("-0e10000")
	if !ok || zero.Sign != 0 || zero.Coefficient != "0" || zero.Exponent10 != "0" {
		t.Fatalf("negative zero tuple = %#v", zero)
	}
}

func TestBitcoinCodecU64ProjectionIsIntegerTokenOnly(t *testing.T) {
	accepted := func(token string) uint64 {
		value, err := decodeBitcoinJSON([]byte(`{"result":` + token + `}`))
		if err != nil {
			t.Fatalf("decode %q: %v", token, err)
		}
		result, err := asBitcoinBlockCount(value.(map[string]any)["result"])
		if err != nil {
			t.Fatalf("project %q: %v", token, err)
		}
		return result
	}
	if got := accepted("0"); got != 0 {
		t.Fatalf("zero = %d", got)
	}
	if got := accepted("18446744073709551615"); got != ^uint64(0) {
		t.Fatalf("max u64 = %d", got)
	}
	for _, token := range []string{"-0", "1.0", "1e0", "18446744073709551616"} {
		value, err := decodeBitcoinJSON([]byte(`{"result":` + token + `}`))
		if err != nil {
			// A syntactically valid but out-of-domain token must reach the
			// typed projection, not be accepted by a lossy parser.
			t.Fatalf("decode %q: %v", token, err)
		}
		if _, err := asBitcoinBlockCount(value.(map[string]any)["result"]); err == nil {
			t.Fatalf("projection accepted %q", token)
		}
	}
	if value, err := decodeBitcoinJSON([]byte(`{"result":1}`)); err != nil {
		t.Fatalf("decode nullable scalar: %v", err)
	} else if _, err := asBitcoinNullableObject(value.(map[string]any)["result"]); err == nil {
		t.Fatal("nullable gettxout projection accepted a scalar")
	}
}

func TestBitcoinCodecEnforcesResourceLimitsBeforeParser(t *testing.T) {
	cases := []string{
		`{"value":` + strings.Repeat("1", bitcoinMaxCoefficientDigits+1) + `}`,
		`{"value":1e10001}`,
		`{"value":` + strings.Repeat("1", bitcoinMaxLexemeBytes+1) + `}`,
		strings.Repeat("[", bitcoinMaxDepth+1) + `0` + strings.Repeat("]", bitcoinMaxDepth+1),
		`{"result":0,"result":` + strings.Repeat("1", bitcoinMaxCoefficientDigits+1) + `}`,
	}
	for _, text := range cases {
		if err := preflightBitcoinJSON([]byte(text)); err == nil {
			t.Fatalf("preflight accepted a resource violation: length=%d", len(text))
		}
	}
	if err := preflightBitcoinJSON([]byte("\xc3\x28")); err == nil {
		t.Fatal("preflight accepted malformed UTF-8")
	}

	if _, err := decodeBitcoinJSON([]byte(`{"result":1} {"result":2}`)); err == nil {
		t.Fatal("decoder accepted a second JSON document")
	}
	if _, err := decodeBitcoinJSON([]byte(`{"result":1,}`)); err == nil {
		t.Fatal("decoder accepted malformed JSON")
	}
}

func TestBitcoinCodecLimitsBindToCanonicalResponsePolicy(t *testing.T) {
	// The parser deliberately uses local compile-time constants at runtime; it
	// does not load the generated contract JSON. This binding test keeps every
	// local limit synchronized with the canonical Bitcoin response policy.
	type canonicalLimits struct {
		DecodedEntityBytes   int64 `json:"decodedEntityBytes"`
		ContainerDepth       int   `json:"containerDepth"`
		JSONTokens           int   `json:"jsonTokens"`
		NumericLexemeBytes   int   `json:"numericLexemeBytes"`
		CoefficientDigits    int   `json:"coefficientDigits"`
		ExplicitExponentMin  int   `json:"explicitExponentMin"`
		ExplicitExponentMax  int   `json:"explicitExponentMax"`
		CanonicalExponentMin int   `json:"canonicalExponentMin"`
		CanonicalExponentMax int   `json:"canonicalExponentMax"`
	}
	var contract struct {
		ClientContracts []struct {
			ClientContractID string `json:"clientContractId"`
			ResponsePolicy   struct {
				PolicyID           string          `json:"policyId"`
				LimitApplicability []string        `json:"limitApplicability"`
				Limits             canonicalLimits `json:"limits"`
			} `json:"responsePolicy"`
		} `json:"clientContracts"`
	}
	if err := json.Unmarshal([]byte(rpcNetworkContractJSON), &contract); err != nil {
		t.Fatalf("canonical contract decode: %v", err)
	}
	var limits canonicalLimits
	found := false
	for _, client := range contract.ClientContracts {
		if client.ClientContractID == "client-bitcoin-rpc" {
			limits = client.ResponsePolicy.Limits
			found = true
			break
		}
	}
	if !found {
		t.Fatal("canonical Bitcoin response policy is missing")
	}
	for _, client := range contract.ClientContracts {
		if client.ClientContractID != "client-bitcoin-rpc" {
			continue
		}
		if client.ResponsePolicy.PolicyID != "bitcoin-exact-json-v1" {
			t.Fatalf("Bitcoin response policy ID = %q, want bitcoin-exact-json-v1", client.ResponsePolicy.PolicyID)
		}
		if !sameStringSlice(client.ResponsePolicy.LimitApplicability, []string{"typescript", "python", "go", "ruby"}) {
			t.Fatalf("Bitcoin response policy applicability = %#v", client.ResponsePolicy.LimitApplicability)
		}
	}
	actual := map[string]int64{
		"decodedEntityBytes":   bitcoinMaxBodyBytes,
		"containerDepth":       bitcoinMaxDepth,
		"jsonTokens":           bitcoinMaxTokens,
		"numericLexemeBytes":   bitcoinMaxLexemeBytes,
		"coefficientDigits":    bitcoinMaxCoefficientDigits,
		"explicitExponentMin":  bitcoinMinExponent10,
		"explicitExponentMax":  bitcoinMaxExponent10,
		"canonicalExponentMin": bitcoinMinExponent10,
		"canonicalExponentMax": bitcoinMaxExponent10,
	}
	expected := map[string]int64{
		"decodedEntityBytes":   limits.DecodedEntityBytes,
		"containerDepth":       int64(limits.ContainerDepth),
		"jsonTokens":           int64(limits.JSONTokens),
		"numericLexemeBytes":   int64(limits.NumericLexemeBytes),
		"coefficientDigits":    int64(limits.CoefficientDigits),
		"explicitExponentMin":  int64(limits.ExplicitExponentMin),
		"explicitExponentMax":  int64(limits.ExplicitExponentMax),
		"canonicalExponentMin": int64(limits.CanonicalExponentMin),
		"canonicalExponentMax": int64(limits.CanonicalExponentMax),
	}
	for name, value := range actual {
		if value != expected[name] {
			t.Fatalf("Bitcoin limit %s = %d, want canonical response policy %d", name, value, expected[name])
		}
	}
}

func TestBitcoinCodecRedactionPreservesLosslessErrorNumbers(t *testing.T) {
	decoded, err := decodeBitcoinJSON([]byte(`{"id":1,"error":{"code":-32000,"message":"rpc-secret failed","data":{"credential":"rpc-secret","precise":1e1000}}}`))
	if err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}
	_, err = unwrapBitcoinRPCResponse(decoded, 1, credentialVariants("rpc-secret"))
	if err == nil {
		t.Fatal("error envelope unexpectedly succeeded")
	}
	var sdkErr *Error
	if !asError(err, &sdkErr) || sdkErr.Kind != ErrorRPC {
		t.Fatalf("error type = %#v", err)
	}
	if strings.Contains(sdkErr.Error(), "rpc-secret") || strings.Contains(string(sdkErr.Data), "rpc-secret") {
		t.Fatalf("credential leaked: error=%q data=%s", sdkErr.Error(), sdkErr.Data)
	}
	if !strings.Contains(string(sdkErr.Data), "1e1000") {
		t.Fatalf("lossless number was changed: %s", sdkErr.Data)
	}
}

func asError(err error, destination **Error) bool {
	value, ok := err.(*Error)
	if ok {
		*destination = value
	}
	return ok
}
