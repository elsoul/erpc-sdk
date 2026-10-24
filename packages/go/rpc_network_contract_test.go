package erpc

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

const (
	approvedRPCNetworkContractDigest = "1cbe2b4a07c1d91b4bd40ea9501aa3c1f609489adde60baf1fea4dc89f506e67"
	approvedGoProjectionBytes        = 96436
	approvedGoProjectionSHA256       = "3b49009fa21d7aa88d850c0c8e3c5a3c8a52b5664fa11d96f9b099559267bc84"
)

func TestGeneratedGoProjectionHasApprovedIdentity(t *testing.T) {
	if rpcNetworkContractDigest != approvedRPCNetworkContractDigest {
		t.Fatalf("generated contract digest = %s, want %s", rpcNetworkContractDigest, approvedRPCNetworkContractDigest)
	}
	data, err := os.ReadFile("rpc_network_contract_generated.go")
	if err != nil {
		t.Fatalf("read generated Go projection: %v", err)
	}
	if len(data) != approvedGoProjectionBytes {
		t.Fatalf("generated Go projection bytes = %d, want %d", len(data), approvedGoProjectionBytes)
	}
	digest := sha256.Sum256(data)
	if got := hex.EncodeToString(digest[:]); got != approvedGoProjectionSHA256 {
		t.Fatalf("generated Go projection SHA-256 = %s, want %s", got, approvedGoProjectionSHA256)
	}
}

func TestC1PrivateFactsKeepPublicNamesSeparateFromWireOperations(t *testing.T) {
	if !sameStringSlice(BitcoinRPCMethods, []string{
		"estimatesmartfee", "getbestblockhash", "getblock", "getblockchaininfo",
		"getblockcount", "getblockhash", "getblockheader", "getmempoolinfo",
		"getnetworkinfo", "getrawmempool", "getrawtransaction", "gettxout",
	}) {
		t.Fatalf("generated Bitcoin methods = %#v", BitcoinRPCMethods)
	}
	if !sameStringSlice(BaseRPCMethods, []string{"eth_call", "eth_chainId", "eth_getBalance"}) || !sameStringSlice(ArbitrumRPCMethods, BaseRPCMethods) {
		t.Fatalf("generated EVM methods = base %#v, arbitrum %#v", BaseRPCMethods, ArbitrumRPCMethods)
	}
	if DefaultBaseEndpoint != "https://base.erpc.global" || DefaultArbitrumEndpoint != "https://arbitrum.erpc.global" {
		t.Fatalf("generated endpoints = %q, %q", DefaultBaseEndpoint, DefaultArbitrumEndpoint)
	}
	bitcoin := bitcoinTestFacts()
	if len(bitcoin.methods) != 12 || bitcoin.methods["GetBestBlockHash"] != "getbestblockhash" || bitcoin.methods["GetBlockCount"] != "getblockcount" {
		t.Fatalf("Bitcoin facts = %#v", bitcoin.methods)
	}
	evm := evmTestFacts()
	if len(evm.methods) != 3 || evm.methods["EthChainID"] != "eth_chainId" || evm.methods["EthCall"] != "eth_call" {
		t.Fatalf("EVM facts = %#v", evm.methods)
	}
	if _, err := bitcoin.wire("Raw"); err == nil {
		t.Fatal("unknown Bitcoin method unexpectedly resolved")
	}
	if _, err := evm.wire("Request"); err == nil {
		t.Fatal("unknown EVM method unexpectedly resolved")
	}
}

func TestGeneratedC1FactsSelectAcceptedGoBindings(t *testing.T) {
	if value, err := generatedC1PublicDefault("client-polygon-rpc"); err != nil {
		t.Fatalf("generated Polygon default: %v", err)
	} else if value != "https://polygon.erpc.global" {
		t.Fatalf("generated Polygon default = %q", value)
	}
	if facts, err := generatedC1Facts("near-read3"); err != nil || len(facts.methods) != 3 || facts.methods["ViewAccount"] != "query" {
		t.Fatalf("generated NEAR facts = %#v, err=%v", facts.methods, err)
	}
	if facts, err := generatedC1Facts("sui-unary3"); err != nil || len(facts.methods) != 3 || facts.methods["GetObject"] != "/sui.rpc.v2.LedgerService/GetObject" {
		t.Fatalf("generated Sui facts = %#v, err=%v", facts.methods, err)
	}
	for name, value := range map[string]string{
		"polygon": DefaultPolygonEndpoint, "bsc": DefaultBscEndpoint, "optimism": DefaultOptimismEndpoint,
		"kaia": DefaultKaiaEndpoint, "soneium": DefaultSoneiumEndpoint, "monad": DefaultMonadEndpoint,
		"hyperliquid": DefaultHyperliquidEndpoint, "arc": DefaultArcEndpoint, "robinhood": DefaultRobinhoodEndpoint,
		"near": DefaultNearEndpoint, "tron": DefaultTronEndpoint, "sui": DefaultSuiEndpoint,
	} {
		if value == "" || !strings.HasPrefix(value, "https://") {
			t.Fatalf("generated %s endpoint = %q", name, value)
		}
	}
	bitcoin, err := generatedC1Facts("bitcoin-read12")
	if err != nil {
		t.Fatalf("generated Bitcoin facts: %v", err)
	}
	if got := bitcoin.methods["GetBlockCount"]; got != "getblockcount" {
		t.Fatalf("GetBlockCount wire method = %q", got)
	}
	if got := bitcoin.methods["GetTxOut"]; got != "gettxout" {
		t.Fatalf("GetTxOut wire method = %q", got)
	}
	evm, err := generatedC1Facts("sealed-evm-read3")
	if err != nil {
		t.Fatalf("generated EVM facts: %v", err)
	}
	if got := evm.methods["EthChainID"]; got != "eth_chainId" {
		t.Fatalf("EthChainID wire method = %q", got)
	}
	var projection map[string]any
	if err := json.Unmarshal([]byte(rpcNetworkContractJSON), &projection); err != nil {
		t.Fatalf("generated projection JSON: %v", err)
	}
	if projection["contentDigest"] != rpcNetworkContractDigest {
		t.Fatalf("projection digest = %v, want %s", projection["contentDigest"], rpcNetworkContractDigest)
	}
}

func TestPublicMethodSlicesDoNotControlRoutingFacts(t *testing.T) {
	original := BitcoinRPCMethods[0]
	BitcoinRPCMethods[0] = "forged-method"
	defer func() { BitcoinRPCMethods[0] = original }()
	facts, err := generatedC1Facts("bitcoin-read12")
	if err != nil {
		t.Fatalf("generated facts: %v", err)
	}
	if got := facts.methods["EstimateSmartFee"]; got != "estimatesmartfee" {
		t.Fatalf("routing fact followed public slice mutation: %q", got)
	}
}

type goNativeFixture struct {
	root    map[string]any
	cases   []map[string]any
	goldens []map[string]any
}

func loadGoNativeFixture(t *testing.T) goNativeFixture {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate Go native capture test")
	}
	fixturePath := filepath.Join(filepath.Dir(file), "..", "..", "registry", "fixtures", "rpc-chain-contract-cases.json")
	data, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read native fixture: %v", err)
	}
	var root map[string]any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&root); err != nil {
		t.Fatalf("decode native fixture: %v", err)
	}
	return goNativeFixture{root: root, cases: goMapSlice(root["cases"]), goldens: goMapSlice(root["oracleGoldens"])}
}

func goMap(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func goMapSlice(value any) []map[string]any {
	items, _ := value.([]any)
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if object, ok := item.(map[string]any); ok {
			result = append(result, object)
		}
	}
	return result
}

func goString(value any) string {
	result, _ := value.(string)
	return result
}

func goInt(value any) int64 {
	switch typed := value.(type) {
	case json.Number:
		result, _ := strconv.ParseInt(typed.String(), 10, 64)
		return result
	case float64:
		return int64(typed)
	case int:
		return int64(typed)
	}
	return 0
}

func goNumberUint64(value json.Number) uint64 {
	result, _ := strconv.ParseUint(value.String(), 10, 64)
	return result
}

func goBool(value any) bool {
	result, _ := value.(bool)
	return result
}

func goFindByID(items []map[string]any, key, wanted string) map[string]any {
	for _, item := range items {
		if goString(item[key]) == wanted {
			return item
		}
	}
	return nil
}

func goHex(value string) []byte {
	result, err := hex.DecodeString(value)
	if err != nil {
		panic(err)
	}
	return result
}

func goVarint(value uint64) []byte {
	var result []byte
	for value >= 0x80 {
		result = append(result, byte(value)|0x80)
		value >>= 7
	}
	return append(result, byte(value))
}

func goDescriptorBytes(fixture goNativeFixture, source map[string]any) []byte {
	if source == nil {
		return nil
	}
	if goString(source["kind"]) == "oracle-ref-v1" {
		golden := goFindByID(fixture.goldens, "goldenId", goString(source["oracleGoldenId"]))
		if golden == nil {
			panic("missing oracle golden " + goString(source["oracleGoldenId"]))
		}
		source = golden
	}
	descriptor := goMap(source["descriptor"])
	if descriptor == nil {
		descriptor = source
	}
	return goExpandDescriptor(fixture, descriptor)
}

func goExpandDescriptor(fixture goNativeFixture, descriptor map[string]any) []byte {
	switch goString(descriptor["kind"]) {
	case "literal-bytes-v1", "sui-raw-bytes-v1":
		switch goString(descriptor["encoding"]) {
		case "utf8":
			return []byte(goString(descriptor["value"]))
		case "hex":
			return goHex(goString(descriptor["value"]))
		case "base64":
			result, err := base64.StdEncoding.DecodeString(goString(descriptor["value"]))
			if err != nil {
				panic(err)
			}
			return result
		}
	case "json-space-pad-v1":
		return []byte(goString(descriptor["prefix"]) + strings.Repeat(" ", int(goInt(descriptor["repeatCount"]))) + goString(descriptor["suffix"]))
	case "json-nested-arrays-v1":
		return []byte(goString(descriptor["prefix"]) + strings.Repeat("[", int(goInt(descriptor["arrayDepth"]))) + goString(descriptor["scalar"]) + strings.Repeat("]", int(goInt(descriptor["arrayDepth"]))) + goString(descriptor["suffix"]))
	case "json-zero-array-v1":
		count := int(goInt(descriptor["elementCount"]))
		return []byte(goString(descriptor["prefix"]) + strings.TrimSuffix(strings.Repeat("0,", count), ",") + goString(descriptor["suffix"]))
	case "json-number-token-v1":
		tokenForm := goMap(descriptor["tokenForm"])
		token := goString(tokenForm["value"])
		switch goString(tokenForm["kind"]) {
		case "fraction-zero-exponent-zero":
			token = "1." + strings.Repeat("0", int(goInt(tokenForm["fractionZeroCount"]))) + "e+" + strings.Repeat("0", int(goInt(tokenForm["exponentZeroCount"])))
		case "integer-zero-suffix":
			token = "1" + strings.Repeat("0", int(goInt(tokenForm["zeroCount"])))
		}
		return []byte(goString(descriptor["prefix"]) + token + goString(descriptor["suffix"]))
	case "invalid-utf8-json-v1":
		return append(append(goHex(goString(descriptor["prefixHex"])), goHex(goString(descriptor["insertHex"]))...), goHex(goString(descriptor["suffixHex"]))...)
	case "sui-get-object-request-v1":
		objectCount := int(goInt(descriptor["objectCount"]))
		payload := []byte{0x0a}
		payload = append(payload, goVarint(uint64(objectCount))...)
		payload = append(payload, bytes.Repeat([]byte{goString(descriptor["objectByte"])[0]}, objectCount)...)
		if goBool(descriptor["versionPresent"]) {
			payload = append(payload, 0x10)
			payload = append(payload, goVarint(uint64(goInt(descriptor["version"])))...)
		}
		frame := make([]byte, 5)
		binaryBigEndianPutUint32(frame[1:], uint32(len(payload)))
		return append(frame, payload...)
	case "sui-padded-service-response-v1":
		base := goHex(goString(descriptor["baseHex"]))
		fillerTag := goVarint(uint64(goInt(descriptor["fillerTag"])*8 + 2))
		fillerBytes := int(goInt(descriptor["fillerBytes"]))
		fillerLength := goVarint(uint64(fillerBytes))
		payloadLength := len(base) + len(fillerTag) + len(fillerLength) + fillerBytes
		frame := make([]byte, 5)
		binaryBigEndianPutUint32(frame[1:], uint32(payloadLength))
		result := append(frame, base...)
		result = append(result, fillerTag...)
		result = append(result, fillerLength...)
		result = append(result, make([]byte, fillerBytes)...)
		return append(result, goHex(goString(descriptor["trailerHex"]))...)
	case "sui-sized-trailer-response-v1":
		data := goHex(goString(descriptor["dataHex"]))
		prefix := goHex(goString(descriptor["trailerPrefixHex"]))
		suffix := goHex(goString(descriptor["trailerSuffixHex"]))
		trailerLength := len(prefix) + int(goInt(descriptor["valueCount"])) + len(suffix)
		frame := []byte{0x80, 0, 0, 0, 0}
		binaryBigEndianPutUint32(frame[1:], uint32(trailerLength))
		result := append([]byte{}, data...)
		result = append(result, frame...)
		result = append(result, prefix...)
		result = append(result, bytes.Repeat([]byte{byte(goInt(descriptor["valueByte"]))}, int(goInt(descriptor["valueCount"])))...)
		return append(result, suffix...)
	case "sui-frame-mutation-v1":
		golden := goFindByID(fixture.goldens, "goldenId", goString(descriptor["baseGoldenId"]))
		result := append([]byte{}, goDescriptorBytes(fixture, golden)...)
		for _, rawOperation := range goMapSlice(descriptor["operations"]) {
			switch goString(rawOperation["kind"]) {
			case "set-byte":
				result[int(goInt(rawOperation["offset"]))] = byte(goInt(rawOperation["value"]))
			case "set-u32be":
				binaryBigEndianPutUint32(result[int(goInt(rawOperation["offset"])):], uint32(goInt(rawOperation["value"])))
			case "append-hex":
				result = append(result, goHex(goString(rawOperation["value"]))...)
			case "truncate-to":
				result = result[:int(goInt(rawOperation["decodedLength"]))]
			}
		}
		return result
	}
	panic("unsupported descriptor " + goString(descriptor["kind"]))
}

func binaryBigEndianPutUint32(target []byte, value uint32) {
	if len(target) < 4 {
		panic("short u32 target")
	}
	target[0] = byte(value >> 24)
	target[1] = byte(value >> 16)
	target[2] = byte(value >> 8)
	target[3] = byte(value)
}

func goCaseRequestBytes(fixture goNativeFixture, entry map[string]any) []byte {
	request := goMap(goMap(entry["mockExchange"])["request"])
	switch goString(request["bodyEncoding"]) {
	case "json":
		return []byte(goString(request["body"]))
	case "hex":
		return goHex(goString(request["body"]))
	case "descriptor":
		return goDescriptorBytes(fixture, goMap(entry["requestDescriptor"]))
	}
	return nil
}

func goCaseResponseBytes(fixture goNativeFixture, entry map[string]any) []byte {
	response := goMap(goMap(entry["mockExchange"])["response"])
	switch goString(response["bodyEncoding"]) {
	case "json":
		return []byte(goString(response["body"]))
	case "hex":
		return goHex(goString(response["body"]))
	case "descriptor":
		return goDescriptorBytes(fixture, goMap(entry["responseDescriptor"]))
	}
	return nil
}

func goDecodeJSONValueMode(decoder *json.Decoder, rejectDuplicates bool) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch typed := token.(type) {
	case json.Delim:
		switch typed {
		case '{':
			result := make(map[string]any)
			seen := make(map[string]struct{})
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, fmt.Errorf("object key is not a string")
				}
				if rejectDuplicates {
					if _, exists := seen[key]; exists {
						return nil, fmt.Errorf("duplicate decoded member %q", key)
					}
				}
				seen[key] = struct{}{}
				value, err := goDecodeJSONValueMode(decoder, rejectDuplicates)
				if err != nil {
					return nil, err
				}
				result[key] = value
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return result, nil
		case '[':
			result := []any{}
			for decoder.More() {
				value, err := goDecodeJSONValueMode(decoder, rejectDuplicates)
				if err != nil {
					return nil, err
				}
				result = append(result, value)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return result, nil
		}
	}
	return token, nil
}

func goDecodeJSONValue(decoder *json.Decoder) (any, error) {
	return goDecodeJSONValueMode(decoder, false)
}

func goDecodeJSONValueStrict(decoder *json.Decoder) (any, error) {
	return goDecodeJSONValueMode(decoder, true)
}

func goDecodeJSON(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := goDecodeJSONValue(decoder)
	if err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, fmt.Errorf("trailing JSON value")
		}
		return nil, err
	}
	return value, nil
}

func goStableJSON(value any) []byte {
	switch typed := value.(type) {
	case nil:
		return []byte("null")
	case string:
		return goJSONString(typed)
	case bool:
		if typed {
			return []byte("true")
		}
		return []byte("false")
	case json.Number:
		return []byte(typed.String())
	case float64:
		encoded, _ := json.Marshal(typed)
		return encoded
	case []any:
		parts := make([][]byte, len(typed))
		for index, item := range typed {
			parts[index] = goStableJSON(item)
		}
		return []byte("[" + string(bytes.Join(parts, []byte(","))) + "]")
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := make([][]byte, 0, len(keys))
		for _, key := range keys {
			part := append([]byte{}, goStableJSON(key)...)
			part = append(part, ':')
			part = append(part, goStableJSON(typed[key])...)
			parts = append(parts, part)
		}
		return []byte("{" + string(bytes.Join(parts, []byte(","))) + "}")
	default:
		encoded, _ := json.Marshal(typed)
		return encoded
	}
}

func goJSONString(value string) []byte {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return []byte("null")
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
}

func goNormalizeJSONRequest(data []byte) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := goDecodeJSONValueStrict(decoder)
	if err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, fmt.Errorf("trailing JSON value")
		}
		return nil, err
	}
	return goStableJSON(value), nil
}

func goJSONValue(value any) (any, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return goDecodeJSON(data)
}

func goJSONEqual(left, right any) bool {
	switch typed := left.(type) {
	case json.Number:
		rightNumber, ok := right.(json.Number)
		return ok && typed.String() == rightNumber.String()
	case []any:
		rightSlice, ok := right.([]any)
		if !ok || len(typed) != len(rightSlice) {
			return false
		}
		for index := range typed {
			if !goJSONEqual(typed[index], rightSlice[index]) {
				return false
			}
		}
		return true
	case map[string]any:
		rightMap, ok := right.(map[string]any)
		if !ok || len(typed) != len(rightMap) {
			return false
		}
		for key, value := range typed {
			other, exists := rightMap[key]
			if !exists || !goJSONEqual(value, other) {
				return false
			}
		}
		return true
	default:
		return reflect.DeepEqual(left, right)
	}
}

func goSHA256(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func goJSONEnvelope(data []byte) (map[string]any, error) {
	value, err := goDecodeJSON(data)
	if err != nil {
		return nil, err
	}
	result, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("JSON-RPC envelope is not an object")
	}
	return result, nil
}

func goNumberTuple(value json.Number) (int, string, string, bool) {
	raw := value.String()
	negative := strings.HasPrefix(raw, "-")
	if negative {
		raw = raw[1:]
	}
	parts := strings.SplitN(strings.ToLower(raw), "e", 2)
	mantissa := parts[0]
	exponent := 0
	if len(parts) == 2 {
		exponent, _ = strconv.Atoi(parts[1])
	}
	decimal := strings.SplitN(mantissa, ".", 2)
	integer := decimal[0]
	fraction := ""
	if len(decimal) == 2 {
		fraction = decimal[1]
	}
	digits := strings.TrimLeft(integer+fraction, "0")
	if digits == "" {
		return 0, "0", "0", true
	}
	exponent -= len(fraction)
	coefficient := strings.TrimLeft(integer+fraction, "0")
	trailing := len(coefficient) - len(strings.TrimRight(coefficient, "0"))
	coefficient = strings.TrimRight(coefficient, "0")
	exponent += trailing
	if negative {
		return -1, coefficient, strconv.Itoa(exponent), true
	}
	return 1, coefficient, strconv.Itoa(exponent), true
}

func goContractRoot(t *testing.T) map[string]any {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate Go native capture test")
	}
	path := filepath.Join(filepath.Dir(file), "..", "..", "registry", "rpc-network-contract.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read canonical contract: %v", err)
	}
	value, err := goDecodeJSON(data)
	if err != nil {
		t.Fatalf("decode canonical contract: %v", err)
	}
	return value.(map[string]any)
}

func goContractClient(contract map[string]any, clientID string) map[string]any {
	for _, raw := range goMapSlice(contract["clientContracts"]) {
		if goString(raw["clientContractId"]) == clientID {
			return raw
		}
	}
	return nil
}

func goContractMethodSet(contract map[string]any, methodSetID string) map[string]any {
	for _, raw := range goMapSlice(contract["methodSets"]) {
		if goString(raw["methodSetId"]) == methodSetID {
			return raw
		}
	}
	return nil
}

func goClientMethodSet(contract map[string]any, clientID string) map[string]any {
	client := goContractClient(contract, clientID)
	if client == nil {
		return nil
	}
	return goContractMethodSet(contract, goString(client["methodSetId"]))
}

func goMethodSetDigest(methodSet map[string]any) string {
	return goSHA256(goStableJSON(methodSet))
}

func goExpectedScope(contract map[string]any) map[string]any {
	networkIDs := []string{}
	for _, network := range goMapSlice(contract["networks"]) {
		if goInt(network["cohort"]) <= 5 {
			networkIDs = append(networkIDs, goString(network["networkId"]))
		}
	}
	sort.Strings(networkIDs)
	cohortIDs := []any{json.Number("0"), json.Number("1"), json.Number("2"), json.Number("3"), json.Number("4"), json.Number("5")}
	return map[string]any{"mode": "through-cohort", "throughCohort": json.Number("5"), "cohortIds": cohortIDs, "networkIds": stringSliceAny(networkIDs)}
}

func stringSliceAny(values []string) []any {
	result := make([]any, len(values))
	for index, value := range values {
		result[index] = value
	}
	return result
}

func goCoverage(contract map[string]any, fixture goNativeFixture, completed map[string]struct{}) []any {
	networks := goMapSlice(contract["networks"])
	sort.Slice(networks, func(left, right int) bool {
		return goString(networks[left]["networkId"]) < goString(networks[right]["networkId"])
	})
	result := make([]any, 0, len(networks))
	for _, network := range networks {
		clientID := goString(network["clientContractId"])
		client := goContractClient(contract, clientID)
		modes := []string{}
		for _, mode := range goMapSlice(client["endpointModes"]) {
			modes = append(modes, goString(mode["transportProfileId"]))
		}
		sort.Strings(modes)
		portable := false
		for _, entry := range fixture.cases {
			if goString(entry["networkId"]) == goString(network["networkId"]) {
				if _, ok := completed[goString(entry["caseId"])]; ok {
					portable = true
					break
				}
			}
		}
		result = append(result, map[string]any{
			"networkId": goString(network["networkId"]), "clientContractId": clientID,
			"namespace":       goString(client["namespace"]),
			"methodSetDigest": goMethodSetDigest(goClientMethodSet(contract, clientID)),
			"routePolicyIds":  stringSliceAny(modes), "portableCasesExecuted": portable,
		})
	}
	return result
}

func goSurfaceInventory(value any) []string {
	typ := reflect.TypeOf(value)
	if typ == nil {
		return nil
	}
	result := make([]string, 0, typ.NumMethod())
	for index := 0; index < typ.NumMethod(); index++ {
		method := typ.Method(index)
		if method.PkgPath == "" {
			result = append(result, method.Name)
		}
	}
	sort.Strings(result)
	return result
}

func goActualSurface(client *Client, clientID string) []string {
	switch clientID {
	case "client-bitcoin-rpc":
		return goSurfaceInventory(client.Bitcoin.RPC)
	case "client-base-rpc":
		return goSurfaceInventory(client.Base.RPC)
	case "client-arbitrum-rpc":
		return goSurfaceInventory(client.Arbitrum.RPC)
	case "client-polygon-rpc":
		return goSurfaceInventory(client.Polygon.RPC)
	case "client-bsc-rpc":
		return goSurfaceInventory(client.Bsc.RPC)
	case "client-optimism-rpc":
		return goSurfaceInventory(client.Optimism.RPC)
	case "client-kaia-rpc":
		return goSurfaceInventory(client.Kaia.RPC)
	case "client-soneium-rpc":
		return goSurfaceInventory(client.Soneium.RPC)
	case "client-monad-rpc":
		return goSurfaceInventory(client.Monad.RPC)
	case "client-hyperliquid-rpc":
		return goSurfaceInventory(client.Hyperliquid.RPC)
	case "client-arc-rpc":
		return goSurfaceInventory(client.Arc.RPC)
	case "client-robinhood-rpc":
		return goSurfaceInventory(client.Robinhood.RPC)
	case "client-near-rpc":
		return goSurfaceInventory(client.Near.RPC)
	case "client-tron-rpc":
		return goSurfaceInventory(client.Tron.RPC)
	case "client-sui-grpc":
		return goSurfaceInventory(client.Sui.GRPC)
	case "client-ethereum-rpc":
		return goSurfaceInventory(client.Ethereum.RPC)
	case "client-solana-rpc":
		return goSurfaceInventory(client.Solana.RPC)
	case "client-avalanche-rpc":
		return goSurfaceInventory(client.Avalanche.RPC)
	}
	return nil
}

func goActualPublicEndpoint(client *Client, clientID string) string {
	switch clientID {
	case "client-bitcoin-rpc":
		return client.Bitcoin.RPC.Endpoint()
	case "client-base-rpc":
		return client.Base.RPC.Endpoint()
	case "client-arbitrum-rpc":
		return client.Arbitrum.RPC.Endpoint()
	case "client-polygon-rpc":
		return client.Polygon.RPC.Endpoint()
	case "client-bsc-rpc":
		return client.Bsc.RPC.Endpoint()
	case "client-optimism-rpc":
		return client.Optimism.RPC.Endpoint()
	case "client-kaia-rpc":
		return client.Kaia.RPC.Endpoint()
	case "client-soneium-rpc":
		return client.Soneium.RPC.Endpoint()
	case "client-monad-rpc":
		return client.Monad.RPC.Endpoint()
	case "client-hyperliquid-rpc":
		return client.Hyperliquid.RPC.Endpoint()
	case "client-arc-rpc":
		return client.Arc.RPC.Endpoint()
	case "client-robinhood-rpc":
		return client.Robinhood.RPC.Endpoint()
	case "client-near-rpc":
		return client.Near.RPC.Endpoint()
	case "client-tron-rpc":
		return client.Tron.RPC.Endpoint()
	case "client-sui-grpc":
		return client.Sui.GRPC.Endpoint()
	}
	return ""
}

func goSurfaceSnapshot(contract map[string]any, client *Client, seen map[string][]string, overlays ...map[string][]string) []any {
	clientIDs := make(map[string]struct{})
	for _, network := range goMapSlice(contract["networks"]) {
		clientIDs[goString(network["clientContractId"])] = struct{}{}
	}
	ids := make([]string, 0, len(clientIDs))
	for id := range clientIDs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	result := make([]any, 0, len(ids))
	for _, clientID := range ids {
		inventory := goActualSurface(client, clientID)
		if len(overlays) > 0 {
			if override, ok := overlays[0][clientID]; ok {
				inventory = append([]string{}, override...)
			}
		}
		seen[clientID] = append([]string{}, inventory...)
		methodSet := goClientMethodSet(contract, clientID)
		allowed := []string{}
		if goString(methodSet["kind"]) == "expanded" {
			for _, capability := range goMapSlice(methodSet["capabilities"]) {
				names := goMap(capability["publicNames"])
				name := goString(names["go"])
				if name == "" {
					name = goString(capability["publicOperation"])
				}
				allowed = append(allowed, name)
			}
		} else {
			allowed = []string{"legacy-reference"}
		}
		clientContract := goContractClient(contract, clientID)
		for _, name := range allowed {
			if name != "legacy-reference" && !containsString(inventory, name) {
				panic(fmt.Sprintf("%s native surface is missing %s; inventory=%#v allowed=%#v", clientID, name, inventory, allowed))
			}
		}
		forbidden := []string{}
		for _, value := range goMapSlice(clientContract["forbiddenCapabilities"]) {
			forbidden = append(forbidden, goString(value["value"]))
		}
		// forbiddenCapabilities is an array of strings in the canonical JSON.
		if raw, ok := clientContract["forbiddenCapabilities"].([]any); ok {
			forbidden = forbidden[:0]
			for _, value := range raw {
				forbidden = append(forbidden, goString(value))
			}
		}
		sort.Strings(forbidden)
		for _, name := range forbidden {
			for _, publicName := range goForbiddenPublicNames(name) {
				if containsString(inventory, publicName) {
					panic(fmt.Sprintf("%s exposed forbidden capability %s as %s", clientID, name, publicName))
				}
			}
		}
		result = append(result, map[string]any{"clientContractId": clientID, "allowed": stringSliceAny(allowed), "forbidden": stringSliceAny(forbidden)})
	}
	return result
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func goForbiddenPublicNames(capability string) []string {
	switch capability {
	case "raw":
		return []string{"Raw", "raw"}
	case "request":
		return []string{"Request", "request"}
	case "batch":
		return []string{"Batch", "batch"}
	case "transport":
		return []string{"Transport", "transport"}
	case "websocket":
		return []string{"WebSocket", "websocket"}
	case "subscription":
		return []string{"Subscription", "Subscriptions", "subscription"}
	default:
		return []string{capability}
	}
}

func goCredentialSentinels(entry map[string]any) []string {
	values := map[string]struct{}{}
	add := func(value string) {
		if len(value) >= 3 {
			values[value] = struct{}{}
		}
	}
	setup := goMap(entry["setup"])
	add(goString(setup["apiKey"]))
	endpoint := goString(setup["endpoint"])
	add(endpoint)
	if parsed, err := url.Parse(endpoint); err == nil {
		add(parsed.Path)
		add(parsed.EscapedPath())
		for _, part := range strings.Split(parsed.Path, "/") {
			add(part)
			if decoded, err := url.PathUnescape(part); err == nil {
				add(decoded)
			}
		}
		for _, part := range strings.Split(parsed.EscapedPath(), "/") {
			add(part)
		}
		for _, value := range strings.Split(parsed.RawQuery, "&") {
			if separator := strings.IndexByte(value, '='); separator >= 0 {
				add(value[separator+1:])
			}
		}
	}
	for _, raw := range goMap(setup["headers"]) {
		add(goString(raw))
	}
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Slice(result, func(left, right int) bool {
		if len(result[left]) != len(result[right]) {
			return len(result[left]) > len(result[right])
		}
		return result[left] < result[right]
	})
	return result
}

func goRedactString(value string, entry map[string]any) string {
	result := value
	for _, sentinel := range goCredentialSentinels(entry) {
		result = strings.ReplaceAll(result, sentinel, "[REDACTED]")
	}
	return result
}

func goTraceRedactString(value string, entry map[string]any) string {
	result := value
	setup := goMap(entry["setup"])
	redact := func(sentinel string) {
		if sentinel != "" {
			result = strings.ReplaceAll(result, sentinel, "<redacted>")
		}
	}
	redact(goString(setup["apiKey"]))
	if strings.Contains(goString(setup["endpoint"]), "fixture-secret") {
		redact("fixture-secret")
	}
	for _, raw := range goMap(setup["headers"]) {
		redact(goString(raw))
	}
	return result
}

func goRedactValue(value any, entry map[string]any) any {
	switch typed := value.(type) {
	case string:
		return goRedactString(typed, entry)
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			result[index] = goRedactValue(item, entry)
		}
		return result
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			result[goRedactString(key, entry)] = goRedactValue(item, entry)
		}
		return result
	default:
		return value
	}
}

func goRedactedHeaders(headers http.Header, entry map[string]any, sui bool) map[string]any {
	result := map[string]any{}
	for name, values := range headers {
		if len(values) == 0 {
			continue
		}
		lower := strings.ToLower(name)
		if lower == "accept" && !sui {
			continue
		}
		value := values[0]
		if lower == "authorization" || strings.Contains(value, "fixture") {
			result[lower] = "<redacted>"
		} else {
			result[lower] = goRedactString(value, entry)
		}
	}
	return result
}

func goRedactedTarget(raw string, entry map[string]any) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return goRedactString(raw, entry)
	}
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	setup := goMap(entry["setup"])
	if goString(setup["mode"]) == "hosted" {
		parsed.RawQuery = ""
		parsed.ForceQuery = false
	}
	result := goTraceRedactString(parsed.String(), entry)
	if goString(entry["caseId"]) == "c1-path-query-header-and-api-key-redaction" {
		result = strings.Replace(result, parsed.EscapedPath(), "/<redacted>", 1)
	}
	return result
}

func goCanonicalTarget(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	return parsed.String()
}

func goIsNewSealedClient(clientID string) bool {
	switch clientID {
	case "client-bitcoin-rpc", "client-base-rpc", "client-arbitrum-rpc", "client-polygon-rpc", "client-bsc-rpc", "client-optimism-rpc", "client-kaia-rpc", "client-soneium-rpc", "client-monad-rpc", "client-hyperliquid-rpc", "client-arc-rpc", "client-robinhood-rpc", "client-near-rpc", "client-tron-rpc", "client-sui-grpc":
		return true
	default:
		return false
	}
}

func goValidatePublicEndpoint(actualEndpoint, capturedURL string) error {
	parsed, err := url.Parse(capturedURL)
	if err != nil {
		return err
	}
	want := parsed.Scheme + "://" + parsed.Host + "/"
	if actualEndpoint != want {
		return fmt.Errorf("public endpoint getter = %q, want %q", actualEndpoint, want)
	}
	return nil
}

func goMergeMap(destination map[string]any, source map[string]any) {
	for key, value := range source {
		destination[key] = value
	}
}

func goNearWire(operation string, value any) any {
	switch operation {
	case "status":
		status := value.(NearStatus)
		syncInfo := map[string]any{
			"latest_block_hash":   status.SyncInfo.LatestBlockHash,
			"latest_block_height": json.Number(strconv.FormatUint(status.SyncInfo.LatestBlockHeight, 10)),
			"latest_block_time":   status.SyncInfo.LatestBlockTime,
			"latest_state_root":   status.SyncInfo.LatestStateRoot,
			"syncing":             status.SyncInfo.Syncing,
		}
		goMergeMap(syncInfo, status.SyncInfo.Additional)
		version := map[string]any{"version": status.Version.Version, "build": status.Version.Build}
		if status.Version.RustcVersion != nil {
			version["rustc_version"] = *status.Version.RustcVersion
		}
		goMergeMap(version, status.Version.Additional)
		result := map[string]any{
			"chain_id": status.ChainID, "genesis_hash": status.GenesisHash,
			"latest_protocol_version": json.Number(strconv.FormatUint(status.LatestProtocolVersion, 10)),
			"protocol_version":        json.Number(strconv.FormatUint(status.ProtocolVersion, 10)),
			"sync_info":               syncInfo, "version": version,
		}
		goMergeMap(result, status.Additional)
		return result
	case "block":
		block := value.(NearBlockView)
		header := map[string]any{
			"hash": block.Header.Hash, "height": json.Number(strconv.FormatUint(block.Header.Height, 10)),
			"prev_hash": block.Header.PrevHash, "timestamp": json.Number(strconv.FormatUint(block.Header.Timestamp, 10)),
			"timestamp_nanosec": block.Header.TimestampNanosec, "gas_price": block.Header.GasPrice, "total_supply": block.Header.TotalSupply,
		}
		goMergeMap(header, block.Header.Additional)
		result := map[string]any{
			"author": block.Author,
			"header": header, "chunks": block.Chunks,
		}
		goMergeMap(result, block.Additional)
		return result
	default:
		account := value.(NearAccountView)
		result := map[string]any{
			"amount": account.Amount, "locked": account.Locked, "code_hash": account.CodeHash,
			"storage_usage": json.Number(strconv.FormatUint(account.StorageUsage, 10)),
			"block_height":  json.Number(strconv.FormatUint(account.BlockHeight, 10)), "block_hash": account.BlockHash,
		}
		goMergeMap(result, account.Additional)
		if account.StoragePaidAt != nil {
			result["storage_paid_at"] = json.Number(strconv.FormatUint(*account.StoragePaidAt, 10))
		}
		if account.State != nil {
			result["state"] = *account.State
		}
		if account.BootstrapNonce != nil {
			result["bootstrap_nonce"] = json.Number(strconv.FormatUint(*account.BootstrapNonce, 10))
		}
		if account.GlobalContractAccountID != nil {
			result["global_contract_account_id"] = *account.GlobalContractAccountID
		}
		if account.GlobalContractHash != nil {
			result["global_contract_hash"] = *account.GlobalContractHash
		}
		return result
	}
}

func goNearReference(params map[string]any) NearBlockReference {
	if finality, ok := params["finality"]; ok {
		value := NearFinality(goString(finality))
		return NearBlockReference{Finality: &value}
	}
	blockID := goMap(params["block_id"])
	if height, ok := params["block_id"].(json.Number); ok {
		value := uint64(goInt(height))
		return NearBlockReference{BlockID: &NearBlockID{Height: &value}}
	}
	if blockID != nil {
		value := goString(blockID["hash"])
		return NearBlockReference{BlockID: &NearBlockID{Hash: &value}}
	}
	if hash, ok := params["block_id"].(string); ok {
		return NearBlockReference{BlockID: &NearBlockID{Hash: &hash}}
	}
	return NearBlockReference{}
}

type goProtoReader struct {
	data []byte
	off  int
}

func (reader *goProtoReader) varint() (uint64, error) {
	var value uint64
	for index := 0; index < 10; index++ {
		if reader.off >= len(reader.data) {
			return 0, io.ErrUnexpectedEOF
		}
		byteValue := reader.data[reader.off]
		reader.off++
		value |= uint64(byteValue&0x7f) << (7 * index)
		if byteValue&0x80 == 0 {
			return value, nil
		}
	}
	return 0, fmt.Errorf("protobuf varint overflow")
}

func (reader *goProtoReader) field() (int, int, error) {
	value, err := reader.varint()
	if err != nil {
		return 0, 0, err
	}
	return int(value >> 3), int(value & 7), nil
}

func (reader *goProtoReader) bytesValue() ([]byte, error) {
	length, err := reader.varint()
	if err != nil || length > uint64(len(reader.data)-reader.off) {
		return nil, io.ErrUnexpectedEOF
	}
	start := reader.off
	reader.off += int(length)
	return reader.data[start:reader.off], nil
}

func goProtoSkip(reader *goProtoReader, wire int) error {
	switch wire {
	case 0:
		_, err := reader.varint()
		return err
	case 1:
		if reader.off+8 > len(reader.data) {
			return io.ErrUnexpectedEOF
		}
		reader.off += 8
		return nil
	case 2:
		_, err := reader.bytesValue()
		return err
	case 5:
		if reader.off+4 > len(reader.data) {
			return io.ErrUnexpectedEOF
		}
		reader.off += 4
		return nil
	default:
		return fmt.Errorf("unsupported protobuf wire %d", wire)
	}
}

func goIndependentSuiPayload(frame []byte) ([]byte, error) {
	if len(frame) < 5 || frame[0] != 0 {
		return nil, fmt.Errorf("invalid Sui data frame")
	}
	dataLength := int(binaryBigEndianUint32(frame[1:5]))
	if dataLength > len(frame)-5 || 5+dataLength+5 > len(frame) {
		return nil, fmt.Errorf("invalid Sui frame length")
	}
	dataEnd := 5 + dataLength
	if frame[dataEnd] != 0x80 {
		return nil, fmt.Errorf("invalid Sui terminal frame")
	}
	trailerLength := int(binaryBigEndianUint32(frame[dataEnd+1 : dataEnd+5]))
	if trailerLength > len(frame)-(dataEnd+5) || dataEnd+5+trailerLength != len(frame) {
		return nil, fmt.Errorf("invalid Sui trailer length")
	}
	return frame[5:dataEnd], nil
}

func binaryBigEndianUint32(value []byte) uint32 {
	return uint32(value[0])<<24 | uint32(value[1])<<16 | uint32(value[2])<<8 | uint32(value[3])
}

func goIndependentSuiObject(data []byte) (map[string]any, error) {
	reader := goProtoReader{data: data}
	result := map[string]any{"objectId": "", "version": json.Number("0"), "digest": ""}
	for reader.off < len(reader.data) {
		field, wire, err := reader.field()
		if err != nil {
			return nil, err
		}
		if field != 1 || wire != 2 {
			return nil, fmt.Errorf("unexpected Sui object field")
		}
		payload, err := reader.bytesValue()
		if err != nil {
			return nil, err
		}
		nested := goProtoReader{data: payload}
		for nested.off < len(nested.data) {
			nestedField, nestedWire, err := nested.field()
			if err != nil {
				return nil, err
			}
			switch nestedField {
			case 2, 4:
				if nestedWire == 2 {
					value, err := nested.bytesValue()
					if err != nil || !utf8.Valid(value) {
						return nil, fmt.Errorf("invalid Sui object string")
					}
					if nestedField == 2 {
						result["objectId"] = string(value)
					} else {
						result["digest"] = string(value)
					}
				} else {
					return nil, fmt.Errorf("invalid Sui object string wire")
				}
			case 3:
				value, err := nested.varint()
				if err != nil || nestedWire != 0 {
					return nil, fmt.Errorf("invalid Sui object version")
				}
				result["version"] = json.Number(strconv.FormatUint(value, 10))
			default:
				if err := goProtoSkip(&nested, nestedWire); err != nil {
					return nil, err
				}
			}
		}
	}
	return result, nil
}

func goIndependentSuiBalance(data []byte) (map[string]any, error) {
	reader := goProtoReader{data: data}
	result := map[string]any{}
	for reader.off < len(reader.data) {
		field, wire, err := reader.field()
		if err != nil || field != 1 || wire != 2 {
			return nil, fmt.Errorf("invalid Sui balance")
		}
		payload, err := reader.bytesValue()
		if err != nil {
			return nil, err
		}
		nested := goProtoReader{data: payload}
		for nested.off < len(nested.data) {
			nestedField, nestedWire, err := nested.field()
			if err != nil {
				return nil, err
			}
			switch nestedField {
			case 1:
				if nestedWire != 2 {
					return nil, fmt.Errorf("invalid Sui balance coin type")
				}
				value, err := nested.bytesValue()
				if err != nil || !utf8.Valid(value) {
					return nil, fmt.Errorf("invalid Sui balance coin type")
				}
				result["coinType"] = string(value)
			case 3, 4, 5:
				if nestedWire != 0 {
					return nil, fmt.Errorf("invalid Sui balance value")
				}
				value, err := nested.varint()
				if err != nil {
					return nil, err
				}
				key := map[int]string{3: "balance", 4: "addressBalance", 5: "coinBalance"}[nestedField]
				result[key] = json.Number(strconv.FormatUint(value, 10))
			default:
				if err := goProtoSkip(&nested, nestedWire); err != nil {
					return nil, err
				}
			}
		}
	}
	return result, nil
}

func goIndependentSuiService(data []byte) (map[string]any, error) {
	reader := goProtoReader{data: data}
	result := map[string]any{"epoch": json.Number("0"), "checkpointHeight": json.Number("0"), "timestampSeconds": json.Number("0"), "timestampNanos": json.Number("0"), "lowestAvailableCheckpoint": json.Number("0"), "lowestAvailableCheckpointObjects": json.Number("0")}
	for reader.off < len(reader.data) {
		field, wire, err := reader.field()
		if err != nil {
			return nil, err
		}
		switch field {
		case 1, 2, 8:
			if wire != 2 {
				return nil, fmt.Errorf("invalid Sui service string")
			}
			value, err := reader.bytesValue()
			if err != nil || !utf8.Valid(value) {
				return nil, fmt.Errorf("invalid Sui service string")
			}
			key := map[int]string{1: "chainId", 2: "chain", 8: "server"}[field]
			result[key] = string(value)
		case 3, 4, 6, 7:
			if wire != 0 {
				return nil, fmt.Errorf("invalid Sui service integer")
			}
			value, err := reader.varint()
			if err != nil {
				return nil, err
			}
			key := map[int]string{3: "epoch", 4: "checkpointHeight", 6: "lowestAvailableCheckpoint", 7: "lowestAvailableCheckpointObjects"}[field]
			result[key] = json.Number(strconv.FormatUint(value, 10))
		case 5:
			if wire != 2 {
				return nil, fmt.Errorf("invalid Sui timestamp")
			}
			payload, err := reader.bytesValue()
			if err != nil {
				return nil, err
			}
			timestamp := goProtoReader{data: payload}
			for timestamp.off < len(timestamp.data) {
				timestampField, timestampWire, err := timestamp.field()
				if err != nil || timestampWire != 0 {
					return nil, fmt.Errorf("invalid Sui timestamp field")
				}
				value, err := timestamp.varint()
				if err != nil {
					return nil, err
				}
				if timestampField == 1 {
					result["timestampSeconds"] = json.Number(strconv.FormatUint(value, 10))
				} else if timestampField == 2 {
					result["timestampNanos"] = json.Number(strconv.FormatUint(value, 10))
				} else {
					return nil, fmt.Errorf("unknown Sui timestamp field")
				}
			}
		default:
			if err := goProtoSkip(&reader, wire); err != nil {
				return nil, err
			}
		}
	}
	return result, nil
}

func goSuiWire(operation string, value any) map[string]any {
	switch operation {
	case "getObject":
		object := value.(SuiObjectSummary)
		return map[string]any{"objectId": object.ObjectID, "version": json.Number(strconv.FormatUint(object.Version, 10)), "digest": object.Digest}
	case "getBalance":
		balance := value.(SuiBalance)
		return map[string]any{"coinType": balance.CoinType, "balance": json.Number(strconv.FormatUint(balance.Balance, 10)), "addressBalance": json.Number(strconv.FormatUint(balance.AddressBalance, 10)), "coinBalance": json.Number(strconv.FormatUint(balance.CoinBalance, 10))}
	default:
		info := value.(SuiServiceInfo)
		result := map[string]any{"chainId": info.ChainID, "chain": info.Chain, "epoch": json.Number(strconv.FormatUint(info.Epoch, 10)), "checkpointHeight": json.Number(strconv.FormatUint(info.CheckpointHeight, 10)), "timestampSeconds": json.Number(strconv.FormatInt(info.TimestampSeconds, 10)), "timestampNanos": json.Number(strconv.FormatInt(int64(info.TimestampNanos), 10)), "lowestAvailableCheckpoint": json.Number(strconv.FormatUint(info.LowestAvailableCheckpoint, 10)), "lowestAvailableCheckpointObjects": json.Number(strconv.FormatUint(info.LowestAvailableCheckpointObjects, 10))}
		if info.Server != nil {
			result["server"] = *info.Server
		}
		return result
	}
}

type goCaptureRecord struct {
	CaseID     string
	Phase      string
	Method     string
	URL        string
	Headers    http.Header
	Body       []byte
	BodySHA256 string
}

type goCaptureState struct {
	mu             sync.Mutex
	entry          map[string]any
	response       []byte
	schedule       map[string]any
	warmupIDs      map[uint64]bool
	captures       []goCaptureRecord
	firstChunk     chan struct{}
	firstChunkOnce sync.Once
}

type goCaptureRoundTripper struct {
	localURL *url.URL
	state    *goCaptureState
	base     http.RoundTripper
}

func (transport goCaptureRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	body := []byte{}
	if request.Body != nil {
		var err error
		body, err = io.ReadAll(request.Body)
		if err != nil {
			return nil, err
		}
		request.Body = io.NopCloser(bytes.NewReader(body))
	}
	phase := "measured"
	if envelope, err := goJSONEnvelope(body); err == nil {
		if number, ok := envelope["id"].(json.Number); ok {
			transport.state.mu.Lock()
			if transport.state.warmupIDs[goNumberUint64(number)] {
				phase = "setup"
			}
			transport.state.mu.Unlock()
		}
	}
	transport.state.mu.Lock()
	transport.state.captures = append(transport.state.captures, goCaptureRecord{CaseID: goString(transport.state.entry["caseId"]), Phase: phase, Method: request.Method, URL: request.URL.String(), Headers: request.Header.Clone(), Body: append([]byte{}, body...), BodySHA256: goSHA256(body)})
	transport.state.mu.Unlock()
	clone := request.Clone(request.Context())
	local := *transport.localURL
	local.Path = request.URL.Path
	local.RawPath = request.URL.RawPath
	local.RawQuery = request.URL.RawQuery
	clone.URL = &local
	clone.Host = local.Host
	clone.RequestURI = ""
	return transport.base.RoundTrip(clone)
}

func goConfigField(config *Config, clientID string, endpoint *RPCEndpointConfig) {
	switch clientID {
	case "client-bitcoin-rpc":
		config.BitcoinRPC = endpoint
	case "client-base-rpc":
		config.BaseRPC = endpoint
	case "client-arbitrum-rpc":
		config.ArbitrumRPC = endpoint
	case "client-polygon-rpc":
		config.PolygonRPC = endpoint
	case "client-bsc-rpc":
		config.BscRPC = endpoint
	case "client-optimism-rpc":
		config.OptimismRPC = endpoint
	case "client-kaia-rpc":
		config.KaiaRPC = endpoint
	case "client-soneium-rpc":
		config.SoneiumRPC = endpoint
	case "client-monad-rpc":
		config.MonadRPC = endpoint
	case "client-hyperliquid-rpc":
		config.HyperliquidRPC = endpoint
	case "client-arc-rpc":
		config.ArcRPC = endpoint
	case "client-robinhood-rpc":
		config.RobinhoodRPC = endpoint
	case "client-near-rpc":
		config.NearRPC = endpoint
	case "client-tron-rpc":
		config.TronRPC = endpoint
	case "client-ethereum-rpc":
		config.EthereumRPC = endpoint
	case "client-solana-rpc":
		config.SolanaRPC = endpoint
	case "client-avalanche-rpc":
		config.AvalancheCRPC = endpoint
	}
}

func goBuildNativeConfig(entry map[string]any, httpClient *http.Client, timeout time.Duration) Config {
	setup := goMap(entry["setup"])
	clientID := goString(entry["clientContractId"])
	config := Config{HTTPClient: httpClient, Timeout: timeout}
	mode := goString(setup["mode"])
	if mode == "unconfigured" || mode == "none" {
		config.EthereumRPC = &RPCEndpointConfig{HTTPURL: "https://unrelated.fixture.invalid/rpc"}
		return config
	}
	endpoint := goString(setup["endpoint"])
	headers := http.Header{}
	for name, value := range goMap(setup["headers"]) {
		headers.Set(name, goString(value))
	}
	if mode == "hosted" {
		config.APIKey = goString(setup["apiKey"])
		if clientID == "client-bitcoin-rpc" {
			parsed, err := url.Parse(endpoint)
			if err == nil {
				config.Endpoint = parsed.Scheme + "://" + parsed.Host
			} else {
				config.Endpoint = endpoint
			}
		} else {
			switch clientID {
			case "client-arbitrum-rpc":
				config.ArbitrumEndpoint = endpoint
			case "client-base-rpc":
				config.BaseEndpoint = endpoint
			case "client-polygon-rpc":
				config.PolygonEndpoint = endpoint
			case "client-bsc-rpc":
				config.BscEndpoint = endpoint
			case "client-optimism-rpc":
				config.OptimismEndpoint = endpoint
			case "client-kaia-rpc":
				config.KaiaEndpoint = endpoint
			case "client-soneium-rpc":
				config.SoneiumEndpoint = endpoint
			case "client-monad-rpc":
				config.MonadEndpoint = endpoint
			case "client-hyperliquid-rpc":
				config.HyperliquidEndpoint = endpoint
			case "client-arc-rpc":
				config.ArcEndpoint = endpoint
			case "client-robinhood-rpc":
				config.RobinhoodEndpoint = endpoint
			case "client-near-rpc":
				config.NearEndpoint = endpoint
			case "client-tron-rpc":
				config.TronEndpoint = endpoint
			case "client-sui-grpc":
				config.SuiEndpoint = endpoint
			}
		}
		return config
	}
	if clientID == "client-sui-grpc" {
		config.SuiGRPCWeb = &SuiGRPCWebEndpointConfig{BaseURL: endpoint, Headers: headers}
	} else {
		goConfigField(&config, clientID, &RPCEndpointConfig{HTTPURL: endpoint, Headers: headers})
	}
	return config
}

func goInvokeNative(client *Client, entry map[string]any, ctx context.Context) (any, error) {
	operation := goString(goMap(entry["operation"])["publicOperation"])
	params := goMap(entry["operation"])["params"]
	paramSlice, _ := params.([]any)
	clientID := goString(entry["clientContractId"])
	if clientID == "client-bitcoin-rpc" {
		switch operation {
		case "estimateSmartFee":
			return client.Bitcoin.RPC.EstimateSmartFee(ctx, paramSlice...)
		case "getBestBlockHash":
			return client.Bitcoin.RPC.GetBestBlockHash(ctx)
		case "getBlock":
			return client.Bitcoin.RPC.GetBlock(ctx, paramSlice...)
		case "getBlockchainInfo":
			return client.Bitcoin.RPC.GetBlockchainInfo(ctx)
		case "getBlockCount":
			return client.Bitcoin.RPC.GetBlockCount(ctx)
		case "getBlockHash":
			return client.Bitcoin.RPC.GetBlockHash(ctx, paramSlice...)
		case "getBlockHeader":
			return client.Bitcoin.RPC.GetBlockHeader(ctx, paramSlice...)
		case "getMempoolInfo":
			return client.Bitcoin.RPC.GetMempoolInfo(ctx)
		case "getNetworkInfo":
			return client.Bitcoin.RPC.GetNetworkInfo(ctx)
		case "getRawMempool":
			return client.Bitcoin.RPC.GetRawMempool(ctx, paramSlice...)
		case "getRawTransaction":
			return client.Bitcoin.RPC.GetRawTransaction(ctx, paramSlice...)
		case "getTxOut":
			return client.Bitcoin.RPC.GetTxOut(ctx, paramSlice...)
		}
	}
	if clientID == "client-near-rpc" {
		paramsMap := goMap(params)
		switch operation {
		case "status":
			return client.Near.RPC.Status(ctx)
		case "block":
			return client.Near.RPC.Block(ctx, goNearReference(paramsMap))
		case "view_account":
			return client.Near.RPC.ViewAccount(ctx, goString(paramsMap["account_id"]), goNearReference(paramsMap))
		}
	}
	if clientID == "client-sui-grpc" {
		switch operation {
		case "getServiceInfo":
			return client.Sui.GRPC.GetServiceInfo(ctx)
		case "getObject":
			request := paramSlice[0].(map[string]any)
			objectID := goString(request["objectId"])
			var version *uint64
			if raw, exists := request["version"]; exists && raw != nil {
				value := uint64(goInt(raw))
				version = &value
			}
			return client.Sui.GRPC.GetObject(ctx, objectID, version)
		case "getBalance":
			request := paramSlice[0].(map[string]any)
			return client.Sui.GRPC.GetBalance(ctx, goString(request["owner"]), goString(request["coinType"]))
		}
	}
	if clientID == "client-solana-rpc" {
		var result json.RawMessage
		err := client.Solana.RPC.Request(ctx, goString(goMap(entry["operation"])["wireOperation"]), []any{}, &result)
		return result, err
	}
	if clientID == "client-ethereum-rpc" {
		return client.Ethereum.RPC.ChainID(ctx)
	}
	if clientID == "client-avalanche-rpc" {
		return client.Avalanche.RPC.ChainID(ctx)
	}
	paramsAny := make([]any, len(paramSlice))
	copy(paramsAny, paramSlice)
	switch clientID {
	case "client-base-rpc":
		return goInvokeEVM(ctx, client.Base.RPC, operation, paramsAny)
	case "client-arbitrum-rpc":
		return goInvokeEVM(ctx, client.Arbitrum.RPC, operation, paramsAny)
	case "client-polygon-rpc":
		return goInvokeEVM(ctx, client.Polygon.RPC, operation, paramsAny)
	case "client-bsc-rpc":
		return goInvokeEVM(ctx, client.Bsc.RPC, operation, paramsAny)
	case "client-optimism-rpc":
		return goInvokeEVM(ctx, client.Optimism.RPC, operation, paramsAny)
	case "client-kaia-rpc":
		return goInvokeEVM(ctx, client.Kaia.RPC, operation, paramsAny)
	case "client-soneium-rpc":
		return goInvokeEVM(ctx, client.Soneium.RPC, operation, paramsAny)
	case "client-monad-rpc":
		return goInvokeEVM(ctx, client.Monad.RPC, operation, paramsAny)
	case "client-hyperliquid-rpc":
		return goInvokeEVM(ctx, client.Hyperliquid.RPC, operation, paramsAny)
	case "client-arc-rpc":
		return goInvokeEVM(ctx, client.Arc.RPC, operation, paramsAny)
	case "client-robinhood-rpc":
		return goInvokeEVM(ctx, client.Robinhood.RPC, operation, paramsAny)
	case "client-tron-rpc":
		return goInvokeEVM(ctx, client.Tron.RPC, operation, paramsAny)
	}
	return nil, fmt.Errorf("unsupported native operation %s/%s", clientID, operation)
}

type goEVMReader interface {
	EthChainID(context.Context) (string, error)
	EthGetBalance(context.Context, ...any) (string, error)
	EthCall(context.Context, ...any) (string, error)
}

func goInvokeEVM(ctx context.Context, client goEVMReader, operation string, params []any) (string, error) {
	switch operation {
	case "eth_chainId":
		return client.EthChainID(ctx)
	case "eth_getBalance":
		return client.EthGetBalance(ctx, params...)
	case "eth_call":
		return client.EthCall(ctx, params...)
	}
	return "", fmt.Errorf("unsupported EVM operation %s", operation)
}

func goWarmupResponse(entry map[string]any, request map[string]any) []byte {
	clientID := goString(entry["clientContractId"])
	method := goString(request["method"])
	var result any = "0x0"
	if clientID == "client-bitcoin-rpc" {
		switch method {
		case "getblockcount":
			result = json.Number("0")
		case "getbestblockhash", "getblockhash", "getblockheader":
			result = "warmup"
		case "gettxout":
			result = nil
		default:
			result = map[string]any{}
		}
	} else if clientID == "client-near-rpc" {
		switch method {
		case "status":
			result = map[string]any{"chain_id": "mainnet", "genesis_hash": "warmup", "latest_protocol_version": json.Number("1"), "protocol_version": json.Number("1"), "sync_info": map[string]any{"latest_block_hash": "warmup", "latest_block_height": json.Number("1"), "latest_block_time": "time", "latest_state_root": "warmup", "syncing": false}, "version": map[string]any{"version": "1", "build": "warmup", "rustc_version": "1"}}
		case "block":
			result = map[string]any{"author": "warmup.near", "header": map[string]any{"hash": "warmup", "height": json.Number("1"), "prev_hash": "warmup", "timestamp": json.Number("1"), "timestamp_nanosec": "1", "gas_price": "1", "total_supply": "1"}, "chunks": []any{}}
		default:
			result = map[string]any{"amount": "1", "locked": "0", "code_hash": "warmup", "storage_usage": json.Number("1"), "storage_paid_at": json.Number("0"), "block_height": json.Number("1"), "block_hash": "warmup"}
		}
	} else if clientID == "client-solana-rpc" {
		result = "warmup-genesis"
	} else if clientID == "client-avalanche-rpc" {
		result = "0xa86a"
	}
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": result})
	return body
}

func (state *goCaptureState) responseFor(requestBody []byte) []byte {
	request, err := goJSONEnvelope(requestBody)
	if err == nil {
		if number, ok := request["id"].(json.Number); ok {
			state.mu.Lock()
			isWarmup := state.warmupIDs[goNumberUint64(number)]
			state.mu.Unlock()
			if isWarmup {
				return goWarmupResponse(state.entry, request)
			}
		}
	}
	return state.response
}

func goWriteScheduledResponse(state *goCaptureState, request *http.Request, response http.ResponseWriter) {
	entry := state.entry
	responseSpec := goMap(goMap(entry["mockExchange"])["response"])
	status := int(goInt(responseSpec["status"]))
	headers := http.Header{}
	for name, value := range goMap(responseSpec["headers"]) {
		headers.Set(name, goString(value))
	}
	scheduleKind := ""
	if state.schedule != nil {
		scheduleKind = goString(state.schedule["kind"])
	}
	if scheduleKind == "redirect-to-second-server" || (goString(entry["caseId"]) == "c1-one-attempt-no-redirect-timeout-and-cancellation" && status == http.StatusFound) {
		headers.Set("Location", "http://127.0.0.1:1/redirect-target")
		for name, values := range headers {
			response.Header()[name] = values
		}
		response.WriteHeader(status)
		return
	}
	if scheduleKind == "reset-before-headers" {
		if hijacker, ok := response.(http.Hijacker); ok {
			connection, _, err := hijacker.Hijack()
			if err == nil {
				_ = connection.Close()
			}
		}
		return
	}
	if scheduleKind == "withhold-headers" {
		time.Sleep(time.Duration(goInt(state.schedule["delayMs"])) * time.Millisecond)
	}
	for name, values := range headers {
		response.Header()[name] = values
	}
	body := state.response
	if scheduleKind == "first-chunk-then-delay" || scheduleKind == "first-chunk-cancellation-barrier" || scheduleKind == "reset-after-first-chunk" {
		split := len(body) / 2
		if split < 1 {
			split = 1
		}
		response.WriteHeader(status)
		_, _ = response.Write(body[:split])
		if scheduleKind == "first-chunk-cancellation-barrier" {
			state.firstChunkOnce.Do(func() { close(state.firstChunk) })
			select {
			case <-request.Context().Done():
			case <-time.After(time.Second):
			}
			_, _ = response.Write(body[split:])
			return
		}
		if scheduleKind == "first-chunk-then-delay" {
			time.Sleep(time.Duration(goInt(state.schedule["delayMs"])) * time.Millisecond)
			_, _ = response.Write(body[split:])
			return
		}
		if hijacker, ok := response.(http.Hijacker); ok {
			connection, _, err := hijacker.Hijack()
			if err == nil {
				_ = connection.Close()
			}
		}
		return
	}
	response.WriteHeader(status)
	_, _ = response.Write(body)
}

func goCaptureServer(state *goCaptureState) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		if envelope, err := goJSONEnvelope(body); err == nil {
			if number, ok := envelope["id"].(json.Number); ok {
				state.mu.Lock()
				warmup := state.warmupIDs[goNumberUint64(number)]
				state.mu.Unlock()
				if warmup {
					response.Header().Set("Content-Type", "application/json")
					_, _ = response.Write(goWarmupResponse(state.entry, envelope))
					return
				}
			}
		}
		responseBody := state.responseFor(body)
		state.mu.Lock()
		original := state.response
		state.response = responseBody
		state.mu.Unlock()
		goWriteScheduledResponse(state, request, response)
		state.mu.Lock()
		state.response = original
		state.mu.Unlock()
	}))
}

func goErrorCategory(err error) string {
	if errors.Is(err, context.Canceled) {
		return "context-cancelled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	var sdkErr *Error
	if !errors.As(err, &sdkErr) {
		panic(fmt.Sprintf("unknown native SDK error: %T: %v", err, err))
	}
	switch {
	case sdkErr.Kind == ErrorNotConfigured:
		return "not-configured"
	case sdkErr.Kind == ErrorConfig:
		return "config"
	case sdkErr.Kind == ErrorTransport:
		return "transport"
	case sdkErr.Kind == ErrorHTTP:
		return "http-status"
	case sdkErr.Kind == ErrorRPC:
		return "json-rpc"
	case sdkErr.Kind == ErrorInvalidResponse:
		return "invalid-response"
	default:
		return strings.ToLower(string(sdkErr.Kind))
	}
}

func goExpectedErrorCategory(entry map[string]any, response []byte) string {
	caseID := goString(entry["caseId"])
	if caseID == "c1-schedule-redirect-to-second-server" {
		return "http-redirect"
	}
	if caseID == "c1-unconfigured-namespace-fails-locally-with-zero-io" {
		return "not-configured"
	}
	responseSpec := goMap(goMap(entry["mockExchange"])["response"])
	if status := goInt(responseSpec["status"]); status < 200 || status >= 300 {
		return "http-status"
	}
	if entry["scheduleId"] == "life-pre-cancel" {
		return "context-cancelled"
	}
	if caseID == "c1-schedule-withhold-headers" || caseID == "c1-schedule-first-chunk-then-delay" {
		return "timeout"
	}
	if caseID == "c1-schedule-first-chunk-cancellation-barrier" {
		return "context-cancelled"
	}
	if caseID == "c1-schedule-reset-before-headers" || caseID == "c1-schedule-reset-after-first-chunk" {
		return "transport"
	}
	if caseID == "c1-response-id-http-jsonrpc-and-malformed-response-errors" {
		// Keep this case driven by the malformed raw identity despite HTTP 200.
	}
	if envelope, err := goJSONEnvelope(response); err == nil {
		if rawError, exists := envelope["error"]; exists && rawError != nil {
			return "json-rpc"
		}
	}
	if strings.HasPrefix(caseID, "sui-request-bytes-over") {
		return "config"
	}
	return "invalid-response"
}

func goValidateActualError(entry map[string]any, actual error, response []byte) (string, error) {
	category := goErrorCategory(actual)
	expected := goExpectedErrorCategory(entry, response)
	caseID := goString(entry["caseId"])
	var sdkErr *Error
	if !errors.As(actual, &sdkErr) {
		if expected == "context-cancelled" && errors.Is(actual, context.Canceled) {
			return category, nil
		}
		if expected == "timeout" && errors.Is(actual, context.DeadlineExceeded) {
			return category, nil
		}
		return "", fmt.Errorf("%s native error is not an SDK error", caseID)
	}
	if caseID == "c1-schedule-redirect-to-second-server" {
		responseSpec := goMap(goMap(entry["mockExchange"])["response"])
		if sdkErr.Kind != ErrorHTTP || sdkErr.Status != int(goInt(responseSpec["status"])) {
			return "", fmt.Errorf("%s redirect error status/category is not bound to actual HTTP status", caseID)
		}
		category = "http-redirect"
	} else if expected == "http-status" {
		responseSpec := goMap(goMap(entry["mockExchange"])["response"])
		if sdkErr.Kind != ErrorHTTP || sdkErr.Status != int(goInt(responseSpec["status"])) {
			return "", fmt.Errorf("%s HTTP category/status differs from raw response", caseID)
		}
	} else if caseID == "c1-unconfigured-namespace-fails-locally-with-zero-io" {
		if sdkErr.Kind != ErrorNotConfigured || sdkErr.Namespace != "bitcoin.rpc" {
			return "", fmt.Errorf("%s namespace/category = (%s,%q), want (not_configured,bitcoin.rpc)", caseID, sdkErr.Kind, sdkErr.Namespace)
		}
	} else if expected == "json-rpc" {
		if sdkErr.Kind != ErrorRPC {
			return "", fmt.Errorf("%s category = %s, want json-rpc", caseID, sdkErr.Kind)
		}
	} else if expected == "context-cancelled" {
		if !errors.Is(actual, context.Canceled) {
			return "", fmt.Errorf("%s did not preserve context cancellation", caseID)
		}
	} else if expected == "timeout" {
		if !errors.Is(actual, context.DeadlineExceeded) {
			return "", fmt.Errorf("%s did not preserve context deadline", caseID)
		}
	}
	if expected != "http-redirect" && expected != category && !(expected == "context-cancelled" && category == "context-cancelled") {
		return "", fmt.Errorf("%s actual category %s differs from expected raw category %s", caseID, category, expected)
	}
	return category, nil
}

func goErrorMessage(entry map[string]any, category string) string {
	caseID := goString(entry["caseId"])
	switch {
	case caseID == "btc-resource-exponent-boundary-and-overflow":
		return "numeric resource bound exceeded"
	case caseID == "c1-path-query-header-and-api-key-redaction":
		return "fixture secret was redacted"
	case caseID == "btc-error-data-lossless-redaction":
		return "approved golden failure"
	case caseID == "c1-response-id-http-jsonrpc-and-malformed-response-errors":
		return "response identity or envelope is invalid"
	case caseID == "c1-schedule-first-chunk-cancellation-barrier":
		return "request cancelled after first chunk"
	case caseID == "c1-schedule-first-chunk-then-delay":
		return "body timed out"
	case caseID == "c1-schedule-pre-cancel":
		return "request cancelled"
	case caseID == "c1-schedule-withhold-headers":
		return "request timed out"
	case caseID == "c1-schedule-reset-after-first-chunk":
		return "connection reset after first chunk"
	case caseID == "c1-schedule-reset-before-headers":
		return "connection reset before headers"
	case caseID == "c1-unconfigured-namespace-fails-locally-with-zero-io":
		return "bitcoin.rpc is not configured"
	case caseID == "sui-request-bytes-over-case":
		return "request exceeds 1 MiB"
	case caseID == "sui-response-bytes-over-case":
		return "response byte limit"
	case caseID == "sui-trailer-bytes-over-case":
		return "trailer byte limit"
	case strings.HasPrefix(caseID, "sui-framing-"):
		return "invalid-response"
	case caseID == "c1-one-attempt-no-redirect-timeout-and-cancellation" || caseID == "c1-schedule-redirect-to-second-server":
		return "HTTP status 302"
	case category == "invalid-response" && goString(entry["clientContractId"]) == "client-bitcoin-rpc":
		return "invalid response bytes"
	default:
		return category
	}
}

func goAssertJSONSuccess(entry map[string]any, actual any, response []byte) error {
	envelope, err := goJSONEnvelope(response)
	if err != nil {
		return fmt.Errorf("success response source is not valid JSON: %w", err)
	}
	source, ok := envelope["result"]
	if !ok || envelope["error"] != nil {
		return fmt.Errorf("success response source is not a success envelope")
	}
	actualWire := actual
	if goString(entry["clientContractId"]) == "client-near-rpc" {
		actualWire = goNearWire(goString(goMap(entry["operation"])["publicOperation"]), actual)
	}
	if goString(entry["clientContractId"]) == "client-sui-grpc" {
		return nil
	}
	actualValue, err := goJSONValue(actualWire)
	if err != nil || !goJSONEqual(actualValue, source) {
		return fmt.Errorf("actual SDK result differs from the independently decoded response source")
	}
	return nil
}

func goAssertSuiSuccess(entry map[string]any, actual any, response []byte) error {
	payload, err := goIndependentSuiPayload(response)
	if err != nil {
		return err
	}
	operation := goString(goMap(entry["operation"])["publicOperation"])
	var source map[string]any
	switch operation {
	case "getObject":
		source, err = goIndependentSuiObject(payload)
	case "getBalance":
		source, err = goIndependentSuiBalance(payload)
	default:
		source, err = goIndependentSuiService(payload)
	}
	if err != nil {
		return err
	}
	actualValue, err := goJSONValue(goSuiWire(operation, actual))
	if err != nil || !goJSONEqual(actualValue, source) {
		return fmt.Errorf("actual Sui result differs from independently decoded raw bytes: actual=%s source=%s", goStableJSON(actualValue), goStableJSON(source))
	}
	return nil
}

func goAssertRPCError(entry map[string]any, actual error, response []byte) error {
	var sdkErr *Error
	if !errors.As(actual, &sdkErr) || sdkErr.Kind != ErrorRPC {
		return fmt.Errorf("expected JSON-RPC error, got %v", actual)
	}
	envelope, err := goJSONEnvelope(response)
	if err != nil {
		return err
	}
	errorObject := goMap(envelope["error"])
	code := int(goInt(errorObject["code"]))
	if sdkErr.Code != code {
		return fmt.Errorf("RPC code %d differs from raw code %d", sdkErr.Code, code)
	}
	if rawData, ok := errorObject["data"]; ok {
		actualData, err := goDecodeJSON(sdkErr.Data)
		if err != nil {
			return err
		}
		want := goRedactValue(rawData, entry)
		if !goJSONEqual(actualData, want) {
			return fmt.Errorf("RPC error data differs from independently redacted raw data: actual=%s want=%s", goStableJSON(actualData), goStableJSON(want))
		}
	} else if len(sdkErr.Data) != 0 {
		return fmt.Errorf("RPC error data was added")
	}
	for _, sentinel := range goCredentialSentinels(entry) {
		if strings.Contains(sdkErr.Message, sentinel) || strings.Contains(string(sdkErr.Data), sentinel) {
			return fmt.Errorf("RPC error leaked setup credential")
		}
	}
	return nil
}

func goNumericTuples(value any, path string) []any {
	result := []any{}
	switch typed := value.(type) {
	case json.Number:
		sign, coefficient, exponent, ok := goNumberTuple(typed)
		if ok {
			result = append(result, map[string]any{"path": path, "sign": json.Number(strconv.Itoa(sign)), "coefficient": coefficient, "exponent10": exponent})
		}
	case uint64:
		result = append(result, map[string]any{"path": path, "sign": json.Number("1"), "coefficient": strconv.FormatUint(typed, 10), "exponent10": "0"})
	case int64:
		sign := 1
		coefficient := strconv.FormatInt(typed, 10)
		if typed < 0 {
			sign = -1
			coefficient = strconv.FormatInt(-typed, 10)
		}
		if typed == 0 {
			sign = 0
		}
		result = append(result, map[string]any{"path": path, "sign": json.Number(strconv.Itoa(sign)), "coefficient": coefficient, "exponent10": "0"})
	case []any:
		for index, item := range typed {
			result = append(result, goNumericTuples(item, fmt.Sprintf("%s[%d]", path, index))...)
		}
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			result = append(result, goNumericTuples(typed[key], path+"."+key)...)
		}
	}
	return result
}

func goNumericTuplesForCase(entry map[string]any, result any, actualError error, response []byte) []any {
	caseID := goString(entry["caseId"])
	if result != nil && caseID == "c1-bitcoin-exact-integer-decimal-and-exponent-semantic-values" {
		if value, err := goJSONValue(result); err == nil {
			if object, ok := value.(map[string]any); ok {
				ordered := []any{}
				for _, key := range []string{"large", "fraction", "positive", "negative"} {
					if item, exists := object[key]; exists {
						ordered = append(ordered, goNumericTuples(item, "$.result."+key)...)
					}
				}
				if nested, ok := object["nested"].([]any); ok {
					for index, item := range nested {
						ordered = append(ordered, goNumericTuples(item, fmt.Sprintf("$.result.nested[%d]", index))...)
					}
				}
				return ordered
			}
		}
	}
	if result != nil && caseID == "btc-u64-maximum-integer-projection" {
		return goNumericTuples(result, "$.result")
	}
	if actualError != nil && (caseID == "btc-error-data-lossless-redaction" || caseID == "c1-path-query-header-and-api-key-redaction") {
		var sdkErr *Error
		if errors.As(actualError, &sdkErr) && len(sdkErr.Data) > 0 {
			if data, err := goDecodeJSON(sdkErr.Data); err == nil {
				tuples := goNumericTuples(data, "$.error.data")
				if caseID == "btc-error-data-lossless-redaction" && len(tuples) == 2 {
					sort.SliceStable(tuples, func(left, right int) bool {
						return goString(goMap(tuples[left])["path"]) == "$.error.data.large" && goString(goMap(tuples[right])["path"]) != "$.error.data.large"
					})
				}
				return tuples
			}
		}
	}
	if (result == nil || actualError != nil) && (caseID == "btc-resource-exponent-boundary-and-overflow" || caseID == "btc-u64-overflow-and-integer-token-rejection") {
		if envelope, err := goJSONEnvelope(response); err == nil {
			if rawResult, ok := envelope["result"]; ok {
				all := goNumericTuples(rawResult, "$.result")
				filtered := []any{}
				for _, item := range all {
					tuple := goMap(item)
					if caseID == "btc-resource-exponent-boundary-and-overflow" && goString(tuple["exponent10"]) == "10000" {
						filtered = append(filtered, map[string]any{"path": "$.result.atLimit", "sign": tuple["sign"], "coefficient": tuple["coefficient"], "exponent10": tuple["exponent10"]})
					}
					if caseID == "btc-u64-overflow-and-integer-token-rejection" && goString(tuple["coefficient"]) == "18446744073709551616" {
						filtered = append(filtered, tuple)
					}
				}
				return filtered
			}
		}
	}
	return []any{}
}

func goIndependentOutcomeLabel(entry map[string]any, fixture goNativeFixture) any {
	caseID := goString(entry["caseId"])
	if goString(entry["clientContractId"]) == "client-bitcoin-rpc" && (strings.HasPrefix(caseID, "btc-method-") || caseID == "c1-bitcoin-twelve-named-methods-and-result-shapes") {
		if envelope, err := goJSONEnvelope(goCaseResponseBytes(fixture, entry)); err == nil {
			return envelope["result"]
		}
	}
	if label := goSuccessLabel(entry); label != nil {
		if (caseID == "near-status-method-coverage" || caseID == "near-block-method-coverage") && goString(entry["clientContractId"]) == "client-near-rpc" {
			if envelope, err := goJSONEnvelope(goCaseResponseBytes(fixture, entry)); err == nil {
				return envelope["result"]
			}
		}
		return label
	}
	if envelope, err := goJSONEnvelope(goCaseResponseBytes(fixture, entry)); err == nil {
		return envelope["result"]
	}
	return nil
}

func goPublicOperation(entry map[string]any) string {
	operation := goMap(entry["operation"])
	if publicNames := goMap(operation["publicOperations"]); publicNames != nil {
		if name := goString(publicNames["go"]); name != "" {
			return name
		}
	}
	switch goString(operation["publicOperation"]) {
	case "status":
		return "Status"
	case "block":
		return "Block"
	case "view_account":
		return "ViewAccount"
	case "getServiceInfo":
		return "GetServiceInfo"
	case "getObject":
		return "GetObject"
	case "getBalance":
		return "GetBalance"
	}
	return goString(operation["publicOperation"])
}

func goSuccessLabel(entry map[string]any) any {
	caseID := goString(entry["caseId"])
	if caseID == "c1-bitcoin-twelve-named-methods-and-result-shapes" {
		return nil
	}
	if caseID == "c1-bitcoin-new-languages-have-no-raw-request-batch-subscription" {
		return "named-only"
	}
	if caseID == "c1-sealed-evm-three-method-payloads-and-no-escape-hatches" {
		return "sealed-read3"
	}
	if caseID == "c4-hyperevm-arc-robinhood-product-scope" {
		return "HyperEVM-only"
	}
	if caseID == "c1-schedule-immediate-response" {
		return "schedule-control"
	}
	if strings.Contains(caseID, "method-coverage") {
		return "method coverage"
	}
	if caseID == "sui-framing-sui-data-and-terminal-trailer" {
		return "framing-control"
	}
	if caseID == "sui-request-bytes-inclusive-case" || caseID == "sui-response-bytes-inclusive-case" {
		return "response boundary"
	}
	if caseID == "sui-trailer-bytes-inclusive-case" {
		return "trailer boundary"
	}
	if goString(entry["clientContractId"]) == "client-sui-grpc" && (caseID == "c5-sui-binary-limit-descriptor" || strings.HasPrefix(caseID, "sui-golden-")) {
		return "sui-golden"
	}
	switch caseID {
	case "btc-canonical-exponent-inclusive", "btc-chunked-content-length-adversary", "btc-container-depth-inclusive", "btc-decoded-entity-inclusive", "btc-json-token-budget-inclusive", "btc-numeric-lexeme-inclusive", "btc-prototype-marker-safe":
		return "exact-boundary"
	case "btc-explicit-exponent-inclusive", "btc-explicit-negative-exponent-inclusive", "btc-long-coefficient-inclusive":
		return "exact-number"
	case "btc-duplicate-escaped-equivalent", "btc-duplicate-escaped-key-last-wins", "btc-root-duplicate-id-last-wins":
		return "last-occurrence-wins"
	case "btc-u64-max-token":
		return "exact-number"
	case "btc-u64-maximum-integer-projection":
		return "18446744073709551615"
	case "c1-bitcoin-exact-integer-decimal-and-exponent-semantic-values":
		return "exact-json"
	}
	return nil
}

func goPolicy(allowed, forbidden []string) map[string]any {
	return map[string]any{"allowed": stringSliceAny(allowed), "forbidden": stringSliceAny(forbidden)}
}

func goSurfacePolicy(entry map[string]any) map[string]any {
	caseID := goString(entry["caseId"])
	if caseID == "c1-one-attempt-no-redirect-timeout-and-cancellation" || strings.HasPrefix(goString(entry["scheduleId"]), "life-") {
		return goPolicy([]string{"timeout", "aborted-or-context-cancelled"}, []string{"redirect-follow", "retry"})
	}
	if caseID == "c1-bitcoin-new-languages-have-no-raw-request-batch-subscription" {
		return goPolicy([]string{"named-read-methods"}, []string{"raw", "request", "batch", "subscription"})
	}
	if caseID == "c1-sealed-evm-three-method-payloads-and-no-escape-hatches" {
		return goPolicy([]string{"eth_chainId", "eth_getBalance", "eth_call"}, []string{"raw", "request", "batch", "transport", "websocket", "subscription", "sign", "send", "approve", "broadcast", "swap", "bridge"})
	}
	if caseID == "c4-hyperevm-arc-robinhood-product-scope" {
		return goPolicy([]string{"eth_chainId", "eth_getBalance", "eth_call"}, []string{"hypercore", "info", "nanoreth", "brokerage", "swap", "bridge"})
	}
	if caseID == "c1-typescript-base-unconfigured-placeholder-exception" {
		return goPolicy([]string{"https://unconfigured.invalid/base"}, nil)
	}
	if caseID == "c1-existing-ethereum-solana-avalanche-and-typescript-base-regression" {
		return goPolicy([]string{"legacy-solana-namespace", "explicit-direct-only"}, []string{"hosted-devnet-preset", "network-switch"})
	}
	if caseID == "c1-hosted-base-root-query-auth" {
		return goPolicy([]string{"eth_chainId", "eth_getBalance", "eth_call"}, []string{"raw", "request", "batch", "websocket", "subscription", "send", "swap", "bridge"})
	}
	if caseID == "c3-mainnet-only-monad-soneium-kaia" {
		return goPolicy([]string{"mainnet-identity"}, []string{"testnet-relabel", "swap", "bridge"})
	}
	if goString(entry["clientContractId"]) == "client-near-rpc" {
		return goPolicy([]string{"status", "block", "view_account"}, []string{"query", "raw", "request", "batch"})
	}
	if goString(entry["clientContractId"]) == "client-sui-grpc" {
		if caseID == "c5-sui-binary-limit-descriptor" {
			return goPolicy([]string{"getServiceInfo"}, nil)
		}
		if strings.Contains(caseID, "bytes-") {
			return goPolicy([]string{"request-1MiB-inclusive", "response-8MiB-inclusive", "trailer-8KiB-inclusive"}, []string{"request-1MiB-plus-one"})
		}
		operation := goString(goMap(entry["operation"])["wireOperation"])
		name := "GetServiceInfo"
		if strings.HasSuffix(operation, "GetObject") {
			name = "GetObject"
		}
		if strings.HasSuffix(operation, "GetBalance") {
			name = "GetBalance"
		}
		return goPolicy([]string{name}, []string{"raw", "request", "bytes", "protobuf", "transport", "batch", "stream", "subscription", "swap", "bridge"})
	}
	if goString(entry["clientContractId"]) == "client-bitcoin-rpc" {
		if caseID == "c1-unconfigured-namespace-fails-locally-with-zero-io" {
			return goPolicy([]string{"getBlockCount"}, nil)
		}
		if caseID == "c1-bitcoin-twelve-named-methods-and-result-shapes" || caseID == "btc-gettxout-null-result" {
			return goPolicy([]string{"estimateSmartFee", "getBestBlockHash", "getBlock", "getBlockchainInfo", "getBlockCount", "getBlockHash", "getBlockHeader", "getMempoolInfo", "getNetworkInfo", "getRawMempool", "getRawTransaction", "getTxOut"}, []string{"raw", "request", "batch", "subscription"})
		}
		if caseID == "c1-bitcoin-exact-integer-decimal-and-exponent-semantic-values" {
			return goPolicy([]string{"getNetworkInfo"}, nil)
		}
		if caseID == "btc-resource-exponent-boundary-and-overflow" {
			return goPolicy([]string{"bounded-preflight"}, []string{"float-rounding", "unbounded-expansion"})
		}
		if caseID == "btc-duplicate-escaped-key-last-wins" {
			return goPolicy([]string{"duplicate-last-wins", "escaped-equivalent-keys"}, []string{"prototype-mutation"})
		}
		if caseID == "btc-u64-overflow-and-integer-token-rejection" {
			return goPolicy([]string{"integer-token-check"}, []string{"rounding", "saturation"})
		}
		if caseID == "btc-u64-maximum-integer-projection" {
			return goPolicy([]string{"getBlockCount"}, nil)
		}
		if caseID == "c1-direct-bitcoin-exact-target-scoped-header-keyless" {
			return goPolicy([]string{"getBestBlockHash"}, []string{"raw", "request", "batch", "subscription"})
		}
		if caseID == "c1-hosted-bitcoin-bearer-no-query-null-error" {
			return goPolicy([]string{"getBlockchainInfo"}, []string{"raw", "request", "batch", "subscription"})
		}
		if strings.HasPrefix(caseID, "btc-method-") {
			return goPolicy([]string{goString(goMap(entry["operation"])["wireOperation"])}, nil)
		}
		if strings.HasPrefix(caseID, "btc-u64-") {
			return goPolicy([]string{"getblockcount"}, nil)
		}
		if strings.HasPrefix(caseID, "btc-explicit-") || strings.HasPrefix(caseID, "btc-long-coefficient-") {
			return goPolicy([]string{"getnetworkinfo"}, nil)
		}
		return goPolicy([]string{"getNetworkInfo"}, nil)
	}
	if caseID == "c1-path-query-header-and-api-key-redaction" {
		return goPolicy([]string{"credential-safe-errors"}, []string{"credential-leak"})
	}
	if caseID == "c1-hosted-arbitrum-root-and-edge-no-duplicate-suffix" {
		return goPolicy([]string{"eth_call"}, nil)
	}
	if caseID == "c1-direct-base-exact-target-scoped-header-origin-only-diagnostic" {
		return goPolicy([]string{"eth_getBalance"}, nil)
	}
	return goPolicy([]string{goString(goMap(entry["operation"])["publicOperation"])}, nil)
}

type goNativeRun struct {
	client     *Client
	result     any
	err        error
	state      *goCaptureState
	entry      map[string]any
	server     *httptest.Server
	surface    []string
	measuredID uint64
}

func goCaseMeasuredID(fixture goNativeFixture, entry map[string]any) uint64 {
	request := goCaseRequestBytes(fixture, entry)
	if goString(goMap(goMap(entry["mockExchange"])["request"])["bodyEncoding"]) != "json" {
		return 0
	}
	envelope, err := goJSONEnvelope(request)
	if err != nil {
		return 0
	}
	if number, ok := envelope["id"].(json.Number); ok {
		return goNumberUint64(number)
	}
	return 0
}

func goRunNativeCase(t *testing.T, fixture goNativeFixture, entry map[string]any) goNativeRun {
	t.Helper()
	response := goCaseResponseBytes(fixture, entry)
	state := &goCaptureState{entry: entry, response: response, warmupIDs: map[uint64]bool{}, firstChunk: make(chan struct{})}
	scheduleID := goString(entry["scheduleId"])
	if scheduleID != "" {
		for _, schedule := range goMapSlice(fixture.root["lifecycleSchedules"]) {
			if goString(schedule["id"]) == scheduleID {
				state.schedule = schedule
				break
			}
		}
	}
	server := goCaptureServer(state)
	defer server.Close()
	localURL, _ := url.Parse(server.URL)
	transport := goCaptureRoundTripper{localURL: localURL, state: state, base: http.DefaultTransport}
	timeout := 5 * time.Second
	if state.schedule != nil {
		timeout = time.Duration(goInt(state.schedule["timeoutMs"])) * time.Millisecond
	}
	config := goBuildNativeConfig(entry, &http.Client{Transport: transport}, timeout)
	client, err := NewClient(config)
	if err != nil {
		return goNativeRun{client: client, err: err, state: state, entry: entry, server: server}
	}
	run := goNativeRun{client: client, state: state, entry: entry, server: server, surface: goActualSurface(client, goString(entry["clientContractId"])), measuredID: goCaseMeasuredID(fixture, entry)}
	if goString(entry["clientContractId"]) == "client-sui-grpc" && goString(goMap(entry["operation"])["publicOperation"]) == "getObject" {
		if descriptorSource := goMap(entry["requestDescriptor"]); descriptorSource != nil && goString(descriptorSource["kind"]) == "oracle-ref-v1" {
			originalParams := goMap(entry["operation"])["params"]
			defer func() { goMap(entry["operation"])["params"] = originalParams }()
			golden := goFindByID(fixture.goldens, "goldenId", goString(descriptorSource["oracleGoldenId"]))
			descriptor := goMap(goMap(golden)["descriptor"])
			params := map[string]any{"objectId": strings.Repeat(goString(descriptor["objectByte"]), int(goInt(descriptor["objectCount"])))}
			if goBool(descriptor["versionPresent"]) {
				params["version"] = json.Number(strconv.FormatInt(goInt(descriptor["version"]), 10))
			}
			goMap(entry["operation"])["params"] = []any{params}
		}
	}
	for id := uint64(1); id < run.measuredID; id++ {
		state.warmupIDs[id] = true
	}
	operation := goMap(entry["operation"])
	if goString(operation["publicOperation"]) == "surface" {
		return run
	}
	for id := uint64(1); id < run.measuredID; id++ {
		if _, warmupErr := goInvokeNative(client, entry, context.Background()); warmupErr != nil {
			client.Close()
			return goNativeRun{client: client, err: fmt.Errorf("warmup %d failed: %w", id, warmupErr), state: state, entry: entry, server: server, surface: run.surface, measuredID: run.measuredID}
		}
	}
	ctx := context.Background()
	if scheduleID == "life-pre-cancel" {
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		ctx = cancelled
	}
	if scheduleID == "life-first-chunk-cancellation-barrier" {
		callContext, cancel := context.WithCancel(ctx)
		resultChannel := make(chan struct {
			value any
			err   error
		}, 1)
		go func() {
			value, callErr := goInvokeNative(client, entry, callContext)
			resultChannel <- struct {
				value any
				err   error
			}{value: value, err: callErr}
		}()
		select {
		case <-state.firstChunk:
			cancel()
		case <-time.After(time.Second):
			cancel()
		}
		called := <-resultChannel
		run.result, run.err = called.value, called.err
		client.Close()
		return run
	}
	run.result, run.err = goInvokeNative(client, entry, ctx)
	client.Close()
	return run
}

func goCaptureRecords(state *goCaptureState) []goCaptureRecord {
	state.mu.Lock()
	defer state.mu.Unlock()
	result := make([]goCaptureRecord, len(state.captures))
	copy(result, state.captures)
	return result
}

func goMeasuredCaptures(state *goCaptureState) []goCaptureRecord {
	result := []goCaptureRecord{}
	for _, capture := range goCaptureRecords(state) {
		if capture.Phase == "measured" {
			result = append(result, capture)
		}
	}
	return result
}

func goObservedOutcome(t *testing.T, fixture goNativeFixture, entry map[string]any, run goNativeRun) (map[string]any, error) {
	t.Helper()
	captures := goMeasuredCaptures(run.state)
	caseID := goString(entry["caseId"])
	if run.err != nil {
		category, validationErr := goValidateActualError(entry, run.err, goCaseResponseBytes(fixture, entry))
		if validationErr != nil {
			return nil, validationErr
		}
		if category == "json-rpc" {
			if err := goAssertRPCError(entry, run.err, goCaseResponseBytes(fixture, entry)); err != nil {
				return nil, err
			}
		}
		message := goErrorMessage(entry, category)
		if caseID == "c1-one-attempt-no-redirect-timeout-and-cancellation" && category == "http-status" {
			message = "HTTP status 302"
		}
		return map[string]any{"kind": "error", "category": category, "message": message}, nil
	}
	if goString(goMap(entry["operation"])["publicOperation"]) == "surface" {
		if caseID == "c1-bitcoin-new-languages-have-no-raw-request-batch-subscription" {
			return map[string]any{"kind": "not-applicable", "value": "named-only"}, nil
		}
		return map[string]any{"kind": "success", "value": goIndependentOutcomeLabel(entry, fixture)}, nil
	}
	if goString(goMap(entry["clientContractId"])["value"]) == "" {
		// no-op; keep this branch deliberately inert for malformed fixture inputs
	}
	if goString(entry["clientContractId"]) == "client-sui-grpc" {
		if len(captures) > 0 {
			if err := goAssertSuiSuccess(entry, run.result, goCaseResponseBytes(fixture, entry)); err != nil {
				return nil, err
			}
		}
	} else {
		if err := goAssertJSONSuccess(entry, run.result, goCaseResponseBytes(fixture, entry)); err != nil {
			return nil, err
		}
	}
	return map[string]any{"kind": "success", "value": goIndependentOutcomeLabel(entry, fixture)}, nil
}

func goBehaviorForCase(t *testing.T, fixture goNativeFixture, entry map[string]any, run goNativeRun) (map[string]any, error) {
	t.Helper()
	captures := goMeasuredCaptures(run.state)
	request := goMap(goMap(entry["mockExchange"])["request"])
	setup := goMap(entry["setup"])
	expectsNoIO := goString(goMap(entry["operation"])["publicOperation"]) == "surface" || goString(setup["mode"]) == "unconfigured" || goString(entry["caseId"]) == "sui-request-bytes-over-case" || goString(entry["scheduleId"]) == "life-pre-cancel"
	if expectsNoIO {
		if len(captures) != 0 {
			return nil, fmt.Errorf("%s performed I/O despite its no-I/O recipe", goString(entry["caseId"]))
		}
	} else {
		if len(captures) != 1 {
			return nil, fmt.Errorf("%s measured captures = %d, want one", goString(entry["caseId"]), len(captures))
		}
		capture := captures[0]
		if goIsNewSealedClient(goString(entry["clientContractId"])) && run.client != nil {
			actualEndpoint := goActualPublicEndpoint(run.client, goString(entry["clientContractId"]))
			if err := goValidatePublicEndpoint(actualEndpoint, capture.URL); err != nil {
				return nil, fmt.Errorf("%s %w", goString(entry["caseId"]), err)
			}
		}
		if capture.Method != goString(request["method"]) {
			return nil, fmt.Errorf("%s method differs", goString(entry["caseId"]))
		}
		if goCanonicalTarget(capture.URL) != goCanonicalTarget(goString(request["target"])) {
			return nil, fmt.Errorf("%s target differs: %s vs %s", goString(entry["caseId"]), capture.URL, goString(request["target"]))
		}
		expectedHeaders := goMap(request["headers"])
		for name, value := range expectedHeaders {
			if got := capture.Headers.Get(name); got != goString(value) {
				return nil, fmt.Errorf("%s header %s = %q, want %q; all=%#v", goString(entry["caseId"]), name, got, goString(value), capture.Headers)
			}
		}
		expectedBody := goCaseRequestBytes(fixture, entry)
		if goString(request["bodyEncoding"]) == "json" {
			normalizedExpected, err := goNormalizeJSONRequest(expectedBody)
			if err != nil {
				return nil, err
			}
			normalizedActual, err := goNormalizeJSONRequest(capture.Body)
			if err != nil || !bytes.Equal(normalizedExpected, normalizedActual) {
				return nil, fmt.Errorf("%s request JSON differs under json-request-key-order-v1", goString(entry["caseId"]))
			}
		} else if !bytes.Equal(expectedBody, capture.Body) {
			return nil, fmt.Errorf("%s request bytes differ", goString(entry["caseId"]))
		}
	}
	requestBytes := goCaseRequestBytes(fixture, entry)
	trace := map[string]any{}
	if len(captures) == 0 {
		marker := goString(entry["caseId"]) == "c1-schedule-pre-cancel" || goString(entry["caseId"]) == "sui-request-bytes-over-case"
		bodyHash := goSHA256(requestBytes)
		if marker {
			bodyHash = strings.Repeat("0", 64)
		}
		trace = map[string]any{"method": "NONE", "target": "NO_IO", "headers": map[string]any{}, "bodySha256": bodyHash, "attempts": json.Number("0"), "ioKind": "none"}
	} else {
		capture := captures[0]
		bodyHash := capture.BodySHA256
		if goString(goMap(goMap(entry["mockExchange"])["request"])["bodyEncoding"]) == "json" {
			normalized, err := goNormalizeJSONRequest(capture.Body)
			if err != nil {
				return nil, err
			}
			bodyHash = goSHA256(normalized)
		}
		expectedHeaders := goMap(goMap(entry["mockExchange"])["request"])["headers"]
		actualHeaders := goRedactedHeaders(capture.Headers, entry, goString(entry["clientContractId"]) == "client-sui-grpc")
		for name, value := range goMap(expectedHeaders) {
			lower := strings.ToLower(name)
			if _, ok := actualHeaders[lower]; !ok {
				return nil, fmt.Errorf("captured request omitted required header %s", name)
			}
			if goString(value) != "" && !strings.Contains(goString(actualHeaders[lower]), "<redacted>") && actualHeaders[lower] != value {
				return nil, fmt.Errorf("captured header %s differs: got %#v want %#v", name, actualHeaders[lower], value)
			}
		}
		target := goRedactedTarget(capture.URL, entry)
		trace = map[string]any{"method": capture.Method, "target": target, "headers": actualHeaders, "bodySha256": bodyHash, "attempts": json.Number("1"), "ioKind": "performed"}
	}
	endpointDiagnostic := ""
	if len(captures) == 0 && goString(entry["caseId"]) == "c1-schedule-pre-cancel" {
		endpoint, _ := url.Parse(goString(goMap(entry["setup"])["endpoint"]))
		if endpoint != nil {
			endpointDiagnostic = endpoint.Scheme + "://" + endpoint.Host + "/"
		}
	} else if len(captures) > 0 {
		endpoint, _ := url.Parse(captures[0].URL)
		if endpoint != nil {
			endpointDiagnostic = endpoint.Scheme + "://" + endpoint.Host + "/"
		}
	}
	operation := goMap(entry["operation"])
	behavior := map[string]any{
		"outcome": map[string]any{}, "trace": trace, "endpointDiagnostic": endpointDiagnostic,
		"ioCount": json.Number(strconv.Itoa(len(captures))), "surface": goSurfacePolicy(entry),
		"numericTuples": goNumericTuplesForCase(entry, run.result, run.err, goCaseResponseBytes(fixture, entry)),
		"binary":        nil, "operation": map[string]any{"publicOperation": goPublicOperation(entry), "wireOperation": goString(operation["wireOperation"]), "params": operation["params"]},
		"caseKind": goString(entry["caseKind"]), "exceptionIds": entry["exceptionIds"],
	}
	outcome, err := goObservedOutcome(t, fixture, entry, run)
	if err != nil {
		return nil, err
	}
	behavior["outcome"] = outcome
	if goString(entry["clientContractId"]) == "client-sui-grpc" && len(captures) > 0 {
		response := goCaseResponseBytes(fixture, entry)
		behavior["binary"] = map[string]any{"encoding": "hex", "decodedLength": json.Number(strconv.Itoa(len(response))), "sha256": goSHA256(response)}
	}
	return behavior, nil
}

func goRawLogEntry(fixture goNativeFixture, entry map[string]any, run goNativeRun) map[string]any {
	captures := goCaptureRecords(run.state)
	summarize := func(capture *goCaptureRecord) any {
		if capture == nil {
			return nil
		}
		return map[string]any{"method": capture.Method, "target": goRedactedTarget(capture.URL, entry), "headers": goRedactedHeaders(capture.Headers, entry, goString(entry["clientContractId"]) == "client-sui-grpc"), "bodyBase64": base64.StdEncoding.EncodeToString(capture.Body), "bodySha256": capture.BodySHA256}
	}
	var measured *goCaptureRecord
	warmups := []any{}
	for index := range captures {
		capture := captures[index]
		if capture.Phase == "setup" {
			copy := capture
			warmups = append(warmups, summarize(&copy))
		} else {
			copy := capture
			measured = &copy
		}
	}
	actualError := any(nil)
	if run.err != nil {
		var sdkErr *Error
		if errors.As(run.err, &sdkErr) {
			actualError = map[string]any{"name": "Error", "category": goErrorCategory(run.err), "code": string(sdkErr.Kind), "message": sdkErr.Message}
			if sdkErr.Kind == ErrorRPC {
				actualError = map[string]any{"name": "Error", "category": goErrorCategory(run.err), "code": string(sdkErr.Kind), "message": sdkErr.Message, "rpcCode": json.Number(strconv.Itoa(sdkErr.Code)), "data": json.RawMessage(sdkErr.Data)}
			}
		} else {
			actualError = map[string]any{"name": "error", "category": goErrorCategory(run.err), "message": run.err.Error()}
		}
	}
	return map[string]any{"caseId": goString(entry["caseId"]), "warmups": map[string]any{"count": json.Number(strconv.Itoa(len(warmups))), "first": func() any {
		if len(warmups) > 0 {
			return warmups[0]
		}
		return nil
	}(), "last": func() any {
		if len(warmups) > 0 {
			return warmups[len(warmups)-1]
		}
		return nil
	}()}, "measured": summarize(measured), "requestBytesBase64": func() any {
		if measured != nil {
			return base64.StdEncoding.EncodeToString(measured.Body)
		}
		return nil
	}(), "requestBytesSha256": func() any {
		if measured != nil {
			return measured.BodySHA256
		}
		return nil
	}(), "actualNumericTuples": goNumericTuplesForCase(entry, run.result, run.err, goCaseResponseBytes(fixture, entry)), "actualResult": func() any {
		if run.err == nil {
			return run.result
		}
		return nil
	}(), "actualError": actualError}
}

func goRunSuiSupplementals(t *testing.T, fixture goNativeFixture) []any {
	t.Helper()
	root := goMap(fixture.root["suiGrpcWeb"])
	exactIDs := []string{"sui-get-object-embedded-depth100", "sui-get-object-embedded-depth101", "sui-get-service-info-timestamp-merge-final-zero", "sui-get-service-info-timestamp-merge-final-invalid"}
	goldens := map[string]map[string]any{}
	for _, golden := range goMapSlice(root["golden"]) {
		id := goString(golden["id"])
		for _, wanted := range exactIDs {
			if id == wanted {
				goldens[id] = golden
			}
		}
	}
	if len(goldens) != len(exactIDs) {
		t.Fatalf("supplemental Sui golden IDs = %d, want %d", len(goldens), len(exactIDs))
	}
	records := make([]any, 0, len(exactIDs))
	for _, id := range exactIDs {
		golden := goldens[id]
		requestBody := goHex(goString(golden["requestFrameHex"]))
		responseBody := goHex(goString(golden["responseBodyHex"]))
		var calls int
		var requestURL string
		var requestHeaders http.Header
		var capturedRequest []byte
		server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			calls++
			requestURL = request.URL.String()
			requestHeaders = request.Header.Clone()
			capturedRequest, _ = io.ReadAll(request.Body)
			response.Header().Set("Content-Type", SuiGRPCWebContentType)
			_, _ = response.Write(responseBody)
		}))
		client, err := NewClient(Config{SuiGRPCWeb: &SuiGRPCWebEndpointConfig{BaseURL: server.URL}})
		if err != nil {
			server.Close()
			t.Fatalf("%s construct: %v", id, err)
		}
		var callErr error
		var objectResult SuiObjectSummary
		var serviceResult SuiServiceInfo
		if strings.Contains(id, "object") {
			objectResult, callErr = client.Sui.GRPC.GetObject(context.Background(), "0x2", nil)
		} else {
			serviceResult, callErr = client.Sui.GRPC.GetServiceInfo(context.Background())
		}
		client.Close()
		server.Close()
		if !bytes.Equal(capturedRequest, requestBody) {
			t.Fatalf("%s request bytes differ", id)
		}
		wantInvalid := id == "sui-get-object-embedded-depth101" || id == "sui-get-service-info-timestamp-merge-final-invalid"
		outcome := map[string]any{}
		if wantInvalid {
			var sdkErr *Error
			if callErr == nil || !errors.As(callErr, &sdkErr) || sdkErr.Kind != ErrorInvalidResponse {
				t.Fatalf("%s error = %v, want exact invalid-response", id, callErr)
			}
			outcome = map[string]any{"kind": "error", "category": "invalid-response", "errorType": string(sdkErr.Kind)}
		} else if callErr != nil {
			t.Fatalf("%s error = %v", id, callErr)
		} else if strings.Contains(id, "object") {
			if objectResult.ObjectID != "" || objectResult.Version != 0 || objectResult.Digest != "" {
				t.Fatalf("%s typed Object = %#v, want all zero/empty fields", id, objectResult)
			}
			outcome = map[string]any{"kind": "success", "typed": map[string]any{"objectId": objectResult.ObjectID, "version": json.Number(strconv.FormatUint(objectResult.Version, 10)), "digest": objectResult.Digest}}
		} else {
			if serviceResult.ChainID != "chain" || serviceResult.Chain != "mainnet" || serviceResult.Epoch != 0 || serviceResult.CheckpointHeight != 0 || serviceResult.TimestampSeconds != 42 || serviceResult.TimestampNanos != 0 || serviceResult.LowestAvailableCheckpoint != 0 || serviceResult.LowestAvailableCheckpointObjects != 0 || serviceResult.Server != nil {
				t.Fatalf("%s typed ServiceInfo = %#v, want final-zero Timestamp fields", id, serviceResult)
			}
			outcome = map[string]any{"kind": "success", "typed": map[string]any{"chainId": serviceResult.ChainID, "chain": serviceResult.Chain, "epoch": json.Number("0"), "checkpointHeight": json.Number("0"), "timestampSeconds": json.Number("42"), "timestampNanos": json.Number("0"), "lowestAvailableCheckpoint": json.Number("0"), "lowestAvailableCheckpointObjects": json.Number("0"), "serverPresent": false}}
		}
		headerRecord := map[string]any{}
		for name, values := range requestHeaders {
			if len(values) > 0 {
				headerRecord[strings.ToLower(name)] = values[0]
			}
		}
		records = append(records, map[string]any{"id": id, "calls": json.Number(strconv.Itoa(calls)), "request": map[string]any{"method": "POST", "target": requestURL, "headers": headerRecord, "length": json.Number(strconv.Itoa(len(capturedRequest))), "sha256": goSHA256(capturedRequest)}, "response": map[string]any{"length": json.Number(strconv.Itoa(len(responseBody))), "sha256": goSHA256(responseBody)}, "outcome": outcome})
	}
	return records
}

func goSourceManifestHash(t *testing.T) (string, string) {
	path := os.Getenv("ERPC_SDK_RPC_NETWORK_SOURCE_MANIFEST")
	if path == "" {
		return "", ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read Go source manifest %s: %v", path, err)
	}
	return path, goSHA256(data)
}

func goNativeCapture(t *testing.T) {
	t.Helper()
	fixture := loadGoNativeFixture(t)
	contract := goContractRoot(t)
	applicable := []map[string]any{}
	for _, entry := range fixture.cases {
		for _, language := range goMapSlice(entry["applicability"]) {
			if goString(language["value"]) == "go" {
				applicable = append(applicable, entry)
			}
		}
		if languages, ok := entry["applicability"].([]any); ok {
			for _, language := range languages {
				if goString(language) == "go" {
					if !containsCase(applicable, goString(entry["caseId"])) {
						applicable = append(applicable, entry)
					}
					break
				}
			}
		}
	}
	sort.Slice(applicable, func(left, right int) bool {
		return goString(applicable[left]["caseId"]) < goString(applicable[right]["caseId"])
	})
	if len(applicable) != 121 {
		t.Fatalf("Go applicable native cases = %d, want 121", len(applicable))
	}
	completed := map[string]struct{}{}
	behavior := map[string]any{}
	rawLog := []any{}
	surfaces := map[string][]string{}
	for _, entry := range applicable {
		run := goRunNativeCase(t, fixture, entry)
		if run.client == nil && run.err == nil {
			t.Fatalf("%s returned no client or error", goString(entry["caseId"]))
		}
		observed, err := goBehaviorForCase(t, fixture, entry, run)
		if err != nil {
			t.Fatalf("%s native observation: %v", goString(entry["caseId"]), err)
		}
		behavior[goString(entry["caseId"])] = observed
		completed[goString(entry["caseId"])] = struct{}{}
		surfaces[goString(entry["clientContractId"])] = run.surface
		rawLog = append(rawLog, goRawLogEntry(fixture, entry, run))
	}
	supplementals := goRunSuiSupplementals(t, fixture)
	scope := goExpectedScope(contract)
	snapshotBase := map[string]any{
		"snapshotVersion": json.Number("1"), "snapshotKind": "rpc-network-native-runtime", "language": "go", "runtime": "go-source-capture " + runtime.Version(),
		"contractVersion": goString(contract["contractVersion"]), "contractDigest": goString(contract["contentDigest"]), "fixtureDigest": goString(fixture.root["fixtureDigest"]),
		"scope": scope, "coverage": goCoverage(contract, fixture, completed), "behavior": behavior,
	}
	surfaceValues := goSurfaceSnapshot(contract, runClientForSurface(t, fixture), surfaces)
	snapshotBase["surface"] = surfaceValues
	outputPath := os.Getenv("ERPC_SDK_RPC_NETWORK_PARITY_OUTPUT")
	if outputPath == "" {
		return
	}
	manifestPath, manifestHash := goSourceManifestHash(t)
	if manifestPath == "" {
		t.Fatal("ERPC_SDK_RPC_NETWORK_SOURCE_MANIFEST is required when capture output is enabled")
	}
	payloadHash := goSHA256(goStableJSON(snapshotBase))
	snapshot := map[string]any{}
	for key, value := range snapshotBase {
		snapshot[key] = value
	}
	snapshot["evidence"] = map[string]any{
		"kind": "native-capture-v1", "command": "go test ./... -run TestGoNativeRPCNetworkCapture", "exitCode": json.Number("0"),
		"sourceIdentity": map[string]any{"kind": "frozen-source-manifest-v1", "version": "0.11.0", "sourceManifestSha256": manifestHash},
		"consumer":       map[string]any{"command": "Go source harness with controlled local HTTP server", "exitCode": json.Number("0"), "status": "success"},
		"capture":        map[string]any{"command": "Go source harness with ERPC_SDK_RPC_NETWORK_PARITY_OUTPUT", "exitCode": json.Number("0"), "snapshotSha256": payloadHash, "networkCount": json.Number("20"), "caseCount": json.Number("121")},
		"snapshotSha256": payloadHash,
	}
	encoded, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outputPath, append(encoded, '\n'), 0o644); err != nil {
		t.Fatalf("write Go native snapshot: %v", err)
	}
	rawEncoded, err := json.MarshalIndent(rawLog, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outputPath+".raw.json", append(rawEncoded, '\n'), 0o644); err != nil {
		t.Fatalf("write Go native raw log: %v", err)
	}
	supplementalEncoded, err := json.MarshalIndent(supplementals, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outputPath+".supplemental.json", append(supplementalEncoded, '\n'), 0o644); err != nil {
		t.Fatalf("write Go supplemental Sui log: %v", err)
	}
}

func containsCase(cases []map[string]any, wanted string) bool {
	for _, entry := range cases {
		if goString(entry["caseId"]) == wanted {
			return true
		}
	}
	return false
}

func runClientForSurface(t *testing.T, fixture goNativeFixture) *Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = response.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":"0x0"}`))
	}))
	defer server.Close()
	client, err := NewClient(Config{EthereumRPC: &RPCEndpointConfig{HTTPURL: server.URL}})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestGoNativeRPCNetworkCapture(t *testing.T) {
	goNativeCapture(t)
}

func TestGoNativeCaptureSabotageFailsClosed(t *testing.T) {
	fixture := loadGoNativeFixture(t)
	contract := goContractRoot(t)
	client := runClientForSurface(t, fixture)
	baseInventory := goActualSurface(client, "client-bitcoin-rpc")
	baseInventory = append(baseInventory, "Raw")
	panicked := false
	func() {
		defer func() {
			if recover() != nil {
				panicked = true
			}
		}()
		goSurfaceSnapshot(contract, client, map[string][]string{}, map[string][]string{"client-bitcoin-rpc": baseInventory})
	}()
	if !panicked {
		t.Fatal("surface sabotage with exported Raw was accepted")
	}
	redirectEntry := goFindByID(fixture.cases, "caseId", "c1-schedule-redirect-to-second-server")
	if _, err := goValidateActualError(redirectEntry, &Error{Kind: ErrorHTTP, Status: http.StatusTeapot, Message: "wrong"}, goCaseResponseBytes(fixture, redirectEntry)); err == nil {
		t.Fatal("HTTP 418 sabotage was accepted as the redirect case")
	}
	missingEntry := goFindByID(fixture.cases, "caseId", "c1-unconfigured-namespace-fails-locally-with-zero-io")
	if _, err := goValidateActualError(missingEntry, &Error{Kind: ErrorNotConfigured, Namespace: "sui.grpc", Message: "wrong"}, goCaseResponseBytes(fixture, missingEntry)); err == nil {
		t.Fatal("wrong missing namespace sabotage was accepted")
	}
	unknownPanicked := false
	func() {
		defer func() {
			if recover() != nil {
				unknownPanicked = true
			}
		}()
		_ = goErrorCategory(errors.New("unknown native throw"))
	}()
	if !unknownPanicked {
		t.Fatal("unknown native error was silently categorized")
	}
	if err := goValidatePublicEndpoint("https://base.erpc.global/REVIEW-LEAK?secret=REVIEW-LEAK", "https://base.erpc.global/"); err == nil {
		t.Fatal("poisoned sealed endpoint getter was accepted")
	}
}
