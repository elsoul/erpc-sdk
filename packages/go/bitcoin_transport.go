package erpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

// c1MethodFacts is supplied by the accepted generated contract projection.
// Keeping the source units parameterized lets codec and transport tests run
// without creating a second production method table.
type c1MethodFacts struct {
	methods map[string]string
}

type generatedC1MethodSet struct {
	MethodSetID  string                  `json:"methodSetId"`
	Capabilities []generatedC1Capability `json:"capabilities"`
}

type generatedC1Capability struct {
	PublicOperation string `json:"publicOperation"`
	WireOperation   string `json:"wireOperation"`
	PublicNames     struct {
		Go string `json:"go"`
	} `json:"publicNames"`
}

type generatedC1Contract struct {
	MethodSets      []generatedC1MethodSet      `json:"methodSets"`
	ClientContracts []generatedC1ClientContract `json:"clientContracts"`
}

type generatedC1ClientContract struct {
	ClientContractID string                    `json:"clientContractId"`
	MethodSetID      string                    `json:"methodSetId"`
	EndpointModes    []generatedC1EndpointMode `json:"endpointModes"`
}

type generatedC1EndpointMode struct {
	Mode          string  `json:"mode"`
	DefaultTarget *string `json:"defaultTarget"`
	PublicDefault *string `json:"publicDefault"`
}

// generatedC1Facts selects language-native method names from the accepted
// generated projection.  It intentionally does not maintain a second Go
// method table.
func generatedC1Facts(methodSetID string) (c1MethodFacts, error) {
	var contract generatedC1Contract
	if err := json.Unmarshal([]byte(rpcNetworkContractJSON), &contract); err != nil {
		return c1MethodFacts{}, sdkError(ErrorConfig, "generated RPC contract facts are unavailable")
	}
	for _, methodSet := range contract.MethodSets {
		if methodSet.MethodSetID != methodSetID {
			continue
		}
		methods := make(map[string]string, len(methodSet.Capabilities))
		for _, capability := range methodSet.Capabilities {
			publicName := capability.PublicNames.Go
			if publicName == "" {
				publicName = generatedGoName(capability.PublicOperation, capability.WireOperation)
			}
			if capability.WireOperation == "" || publicName == "" {
				return c1MethodFacts{}, sdkError(ErrorConfig, "generated RPC contract facts are unavailable")
			}
			methods[publicName] = capability.WireOperation
		}
		if len(methods) == 0 {
			return c1MethodFacts{}, sdkError(ErrorConfig, "generated RPC contract facts are unavailable")
		}
		return c1MethodFacts{methods: methods}, nil
	}
	return c1MethodFacts{}, sdkError(ErrorConfig, "generated RPC contract facts are unavailable")
}

func generatedGoName(publicOperation, wireOperation string) string {
	if publicOperation == "view_account" || wireOperation == "query" {
		return "ViewAccount"
	}
	if publicOperation == "getServiceInfo" || publicOperation == "getObject" || publicOperation == "getBalance" {
		return strings.ToUpper(publicOperation[:1]) + publicOperation[1:]
	}
	if publicOperation == "status" || publicOperation == "block" {
		return strings.ToUpper(publicOperation[:1]) + publicOperation[1:]
	}
	return ""
}

func generatedC1PublicDefault(clientContractID string) (string, error) {
	var contract generatedC1Contract
	if err := json.Unmarshal([]byte(rpcNetworkContractJSON), &contract); err != nil {
		return "", sdkError(ErrorConfig, "generated RPC contract facts are unavailable")
	}
	for _, client := range contract.ClientContracts {
		if client.ClientContractID != clientContractID {
			continue
		}
		for _, mode := range client.EndpointModes {
			if mode.Mode == "hosted" && mode.PublicDefault != nil && *mode.PublicDefault != "" {
				return *mode.PublicDefault, nil
			}
		}
		return "", sdkError(ErrorConfig, "generated RPC contract facts are unavailable")
	}
	return "", sdkError(ErrorConfig, "generated RPC contract facts are unavailable")
}

func (facts c1MethodFacts) method(name string) (string, bool) {
	method, ok := facts.methods[name]
	return method, ok
}

func (facts c1MethodFacts) containsWire(method string) bool {
	for _, candidate := range facts.methods {
		if candidate == method {
			return true
		}
	}
	return false
}

// c1HTTPTransport is private to the new sealed C1 clients.  It deliberately
// does not implement or expose RPCNamespace, Raw, Batch, or a public transport
// type.
type c1HTTPTransport struct {
	requestEndpoint      *url.URL
	publicEndpoint       string
	apiKey               string
	headers              http.Header
	timeout              time.Duration
	client               *http.Client
	direct               bool
	bitcoin              bool
	maxBodyBytes         int64
	unavailableNamespace string
	redactionVariants    []string
	facts                c1MethodFacts
	nextID               atomic.Uint64
}

type c1WireRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      uint64 `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type c1NamedWireRequest struct {
	JSONRPC string         `json:"jsonrpc"`
	ID      uint64         `json:"id"`
	Method  string         `json:"method"`
	Params  map[string]any `json:"params"`
}

func newC1BitcoinTransport(
	config resolvedConfig,
	hostedEndpoint *url.URL,
	directEndpoint *resolvedRPCEndpointConfig,
	facts c1MethodFacts,
) *c1HTTPTransport {
	return newC1Transport(config, hostedEndpoint, directEndpoint, facts, true, "bitcoin.rpc")
}

func newC1EVMTransport(
	config resolvedConfig,
	hostedEndpoint *url.URL,
	directEndpoint *resolvedRPCEndpointConfig,
	facts c1MethodFacts,
	namespace string,
) *c1HTTPTransport {
	return newC1Transport(config, hostedEndpoint, directEndpoint, facts, false, namespace)
}

func newC1Transport(
	config resolvedConfig,
	hostedEndpoint *url.URL,
	directEndpoint *resolvedRPCEndpointConfig,
	facts c1MethodFacts,
	bitcoin bool,
	namespace string,
) *c1HTTPTransport {
	transport := &c1HTTPTransport{
		timeout: config.timeout,
		facts:   facts,
		bitcoin: bitcoin,
		nextID:  atomic.Uint64{},
	}
	transport.nextID.Store(0)
	if bitcoin {
		transport.maxBodyBytes = bitcoinMaxBodyBytes
	} else {
		// EVM responses retain the legacy 16 MiB safety bound while their
		// numeric semantics stay ordinary wire strings.
		transport.maxBodyBytes = 16 << 20
	}

	if directEndpoint != nil {
		transport.direct = true
		transport.requestEndpoint = cloneURL(directEndpoint.httpURL)
		transport.headers = directEndpoint.headers.Clone()
		transport.publicEndpoint = c1OriginRoot(transport.requestEndpoint)
		transport.redactionVariants = c1DirectRedactionVariants(
			directEndpoint.httpURL,
			directEndpoint.webSocketURL,
			directEndpoint.headers,
		)
		transport.client = c1NoRedirectHTTPClient(config.httpClient)
		return transport
	}

	if strings.TrimSpace(config.apiKey) == "" || hostedEndpoint == nil {
		transport.unavailableNamespace = namespace
		transport.publicEndpoint = ""
		transport.client = config.httpClient
		return transport
	}
	transport.apiKey = strings.TrimSpace(config.apiKey)
	transport.requestEndpoint = cloneURL(hostedEndpoint)
	transport.requestEndpoint.RawQuery = removeQueryKeyFold(transport.requestEndpoint.RawQuery, "api-key")
	if !bitcoin {
		transport.requestEndpoint.RawQuery = addQueryKey(transport.requestEndpoint.RawQuery, "api-key", transport.apiKey)
	}
	transport.publicEndpoint = c1OriginRoot(transport.requestEndpoint)
	transport.headers = config.headers.Clone()
	if bitcoin {
		deleteHeaderFold(transport.headers, "Authorization")
		transport.headers.Set("Authorization", "Bearer "+transport.apiKey)
	}
	transport.redactionVariants = credentialVariants(transport.apiKey)
	transport.client = c1NoRedirectHTTPClient(config.httpClient)
	return transport
}

func c1NoRedirectHTTPClient(client *http.Client) *http.Client {
	if client == nil {
		client = &http.Client{}
	}
	copy := *client
	copy.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	copy.Jar = nil
	return &copy
}

func c1OriginRoot(endpoint *url.URL) string {
	if endpoint == nil {
		return ""
	}
	return (&url.URL{Scheme: endpoint.Scheme, Host: endpoint.Host, Path: "/"}).String()
}

func removeQueryKeyFold(rawQuery, key string) string {
	if rawQuery == "" {
		return ""
	}
	parts := strings.Split(rawQuery, "&")
	kept := make([]string, 0, len(parts))
	for _, part := range parts {
		name := part
		if separator := strings.IndexByte(part, '='); separator >= 0 {
			name = part[:separator]
		}
		decoded, err := url.QueryUnescape(name)
		if err == nil {
			name = decoded
		}
		if strings.EqualFold(name, key) {
			continue
		}
		if part != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, "&")
}

func addQueryKey(rawQuery, key, value string) string {
	query := rawQuery
	if query != "" {
		query += "&"
	}
	return query + url.QueryEscape(key) + "=" + url.QueryEscape(value)
}

func deleteHeaderFold(headers http.Header, name string) {
	for candidate := range headers {
		if strings.EqualFold(candidate, name) {
			delete(headers, candidate)
		}
	}
}

func c1DirectRedactionVariants(httpURL, webSocketURL *url.URL, headers http.Header) []string {
	values := make(map[string]struct{})
	add := func(value string) {
		if value != "" {
			values[value] = struct{}{}
		}
	}
	for _, endpoint := range []*url.URL{httpURL, webSocketURL} {
		if endpoint == nil {
			continue
		}
		for _, component := range strings.Split(endpoint.RawQuery, "&") {
			if component == "" {
				continue
			}
			rawValue := component
			if separator := strings.IndexByte(component, '='); separator >= 0 {
				rawValue = component[separator+1:]
			}
			add(rawValue)
			if decoded, err := url.QueryUnescape(rawValue); err == nil {
				add(decoded)
			}
		}
		pathValues := []string{endpoint.EscapedPath(), endpoint.Path, endpoint.RawPath}
		for _, pathValue := range pathValues {
			for _, segment := range strings.Split(pathValue, "/") {
				add(segment)
				if decoded, err := url.PathUnescape(segment); err == nil {
					add(decoded)
					add(url.PathEscape(decoded))
				}
			}
		}
	}
	for name, valuesForName := range headers {
		for _, value := range valuesForName {
			add(value)
			if !strings.EqualFold(name, "Authorization") && !strings.EqualFold(name, "Proxy-Authorization") {
				continue
			}
			parts := strings.Fields(value)
			if len(parts) < 2 || (strings.ToLower(parts[0]) != "bearer" && strings.ToLower(parts[0]) != "basic") {
				continue
			}
			credential := strings.Join(parts[1:], " ")
			add(credential)
		}
	}
	for _, value := range directRedactionVariants(httpURL, webSocketURL, headers) {
		add(value)
	}
	return sortedVariants(values)
}

func c1ValidHeaderToken(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' {
			continue
		}
		switch character {
		case '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~':
		default:
			return false
		}
	}
	return true
}

func c1ValidHeaderValue(value string) bool {
	if !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if character == '\t' || character >= 0x20 && character != 0x7f {
			continue
		}
		return false
	}
	return true
}

func c1HeadersValid(headers http.Header) bool {
	for name, values := range headers {
		if !c1ValidHeaderToken(name) {
			return false
		}
		for _, value := range values {
			if !c1ValidHeaderValue(value) {
				return false
			}
		}
	}
	return true
}

func (transport *c1HTTPTransport) ensureConfigured() error {
	if transport.unavailableNamespace != "" {
		return notConfiguredError(transport.unavailableNamespace)
	}
	if transport.requestEndpoint == nil || transport.client == nil {
		return sdkError(ErrorConfig, "RPC endpoint is unavailable")
	}
	if !c1HeadersValid(transport.headers) {
		return sdkError(ErrorConfig, "HTTP headers are invalid")
	}
	return nil
}

func (transport *c1HTTPTransport) nextRequestID() uint64 {
	return transport.nextID.Add(1)
}

func (transport *c1HTTPTransport) requestBitcoin(ctx context.Context, method string, params []any) (any, error) {
	if err := transport.ensureConfigured(); err != nil {
		return nil, err
	}
	if !transport.facts.containsWire(method) {
		return nil, sdkError(ErrorConfig, "Bitcoin method is not in the accepted named-read contract")
	}
	requestID := transport.nextRequestID()
	payload, err := json.Marshal(c1WireRequest{JSONRPC: "2.0", ID: requestID, Method: method, Params: normalizeParams(params)})
	if err != nil {
		return nil, sdkError(ErrorConfig, "RPC parameters could not be serialized")
	}
	body, err := transport.post(ctx, payload)
	if err != nil {
		return nil, err
	}
	decoded, err := decodeBitcoinJSON(body)
	if err != nil {
		return nil, err
	}
	return unwrapBitcoinRPCResponse(decoded, requestID, transport.redactionVariants)
}

func (transport *c1HTTPTransport) requestEVM(ctx context.Context, method string, params []any) (string, error) {
	value, err := transport.requestJSON(ctx, method, params)
	if err != nil {
		return "", err
	}
	result, ok := value.(string)
	if !ok {
		return "", bitcoinInvalidResponse()
	}
	return result, nil
}

func (transport *c1HTTPTransport) requestJSON(ctx context.Context, method string, params []any) (any, error) {
	if err := transport.ensureConfigured(); err != nil {
		return nil, err
	}
	if !transport.facts.containsWire(method) {
		return nil, sdkError(ErrorConfig, "sealed JSON-RPC method is not in the accepted named-read contract")
	}
	requestID := transport.nextRequestID()
	payload, err := json.Marshal(c1WireRequest{JSONRPC: "2.0", ID: requestID, Method: method, Params: normalizeParams(params)})
	if err != nil {
		return nil, sdkError(ErrorConfig, "RPC parameters could not be serialized")
	}
	body, err := transport.post(ctx, payload)
	if err != nil {
		return nil, err
	}
	decoded, err := decodeC1JSON(body)
	if err != nil {
		return nil, err
	}
	return unwrapC1JSONResponse(decoded, requestID, transport.redactionVariants)
}

func (transport *c1HTTPTransport) requestNamedJSON(ctx context.Context, method string, params map[string]any) (any, error) {
	if err := transport.ensureConfigured(); err != nil {
		return nil, err
	}
	if !transport.facts.containsWire(method) {
		return nil, sdkError(ErrorConfig, "sealed JSON-RPC method is not in the accepted named-read contract")
	}
	requestID := transport.nextRequestID()
	payload, err := json.Marshal(c1NamedWireRequest{JSONRPC: "2.0", ID: requestID, Method: method, Params: params})
	if err != nil {
		return nil, sdkError(ErrorConfig, "RPC parameters could not be serialized")
	}
	body, err := transport.post(ctx, payload)
	if err != nil {
		return nil, err
	}
	decoded, err := decodeC1JSON(body)
	if err != nil {
		return nil, err
	}
	return unwrapC1JSONResponse(decoded, requestID, transport.redactionVariants)
}

func normalizeParams(params []any) []any {
	if params == nil {
		return []any{}
	}
	return params
}

func (transport *c1HTTPTransport) post(ctx context.Context, payload []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	requestContext, cancel := context.WithTimeout(ctx, transport.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, transport.requestEndpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return nil, sdkError(ErrorConfig, "unable to create RPC request")
	}
	request.Header = transport.headers.Clone()
	if request.Header == nil {
		request.Header = make(http.Header)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := transport.client.Do(request)
	if err != nil {
		if requestContext.Err() != nil {
			return nil, requestContext.Err()
		}
		return nil, sdkError(ErrorTransport, "unable to reach ERPC")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.Body != nil {
			_ = response.Body.Close()
		}
		return nil, &Error{Kind: ErrorHTTP, Message: "request failed", Status: response.StatusCode}
	}
	if response.Body == nil {
		return nil, bitcoinInvalidResponse()
	}
	defer response.Body.Close()
	body, err := c1ReadResponseBody(requestContext, response.Body, transport.maxBodyBytes)
	if err != nil {
		if requestContext.Err() != nil {
			return nil, requestContext.Err()
		}
		if err == errC1BodyLimit || err == errC1InvalidUTF8 {
			return nil, bitcoinInvalidResponse()
		}
		return nil, sdkError(ErrorTransport, "unable to read ERPC response")
	}
	return body, nil
}

var (
	errC1BodyLimit   = errors.New("c1 response body limit")
	errC1InvalidUTF8 = errors.New("c1 response body is not valid UTF-8")
)

type c1ReadResult struct {
	count int
	err   error
}

func c1ReadResponseBody(ctx context.Context, body io.ReadCloser, maximum int64) ([]byte, error) {
	const chunkSize = 32 * 1024
	buffer := bytes.NewBuffer(nil)
	chunk := make([]byte, chunkSize)
	var total int64
	for {
		resultChannel := make(chan c1ReadResult, 1)
		go func() {
			count, err := body.Read(chunk)
			resultChannel <- c1ReadResult{count: count, err: err}
		}()
		select {
		case <-ctx.Done():
			_ = body.Close()
			return nil, ctx.Err()
		case result := <-resultChannel:
			if result.count > 0 {
				if result.count > len(chunk) || total > maximum-int64(result.count) {
					_ = body.Close()
					return nil, errC1BodyLimit
				}
				total += int64(result.count)
				_, _ = buffer.Write(chunk[:result.count])
			}
			if result.err != nil {
				if result.err == io.EOF {
					if !utf8.Valid(buffer.Bytes()) {
						return nil, errC1InvalidUTF8
					}
					return buffer.Bytes(), nil
				}
				return nil, result.err
			}
		}
	}
}

func decodeC1JSON(value []byte) (any, error) {
	if !utf8.Valid(value) {
		return nil, bitcoinInvalidResponse()
	}
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.UseNumber()
	var result any
	if err := decoder.Decode(&result); err != nil {
		return nil, bitcoinInvalidResponse()
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, bitcoinInvalidResponse()
	}
	return result, nil
}

func unwrapC1EVMResponse(value any, expectedID uint64, variants []string) (string, error) {
	result, err := unwrapC1JSONResponse(value, expectedID, variants)
	if err != nil {
		return "", err
	}
	stringResult, ok := result.(string)
	if !ok {
		return "", bitcoinInvalidResponse()
	}
	return stringResult, nil
}

func unwrapC1JSONResponse(value any, expectedID uint64, variants []string) (any, error) {
	response, ok := bitcoinObject(value)
	if !ok || !bitcoinRPCIDMatches(response["id"], expectedID) {
		return nil, bitcoinInvalidResponse()
	}
	if errorValue, exists := response["error"]; exists && errorValue != nil {
		errorObject, ok := bitcoinObject(errorValue)
		if !ok {
			return nil, bitcoinInvalidResponse()
		}
		code, ok := bitcoinRPCCode(errorObject["code"])
		message, messageOK := errorObject["message"].(string)
		if !ok || !messageOK {
			return nil, bitcoinInvalidResponse()
		}
		err := &Error{Kind: ErrorRPC, Code: code, Message: redactString(message, variants)}
		if data, present := errorObject["data"]; present {
			err.Data = bitcoinRedactJSON(data, variants)
		}
		return nil, err
	}
	result, ok := response["result"]
	if !ok {
		return nil, bitcoinInvalidResponse()
	}
	return result, nil
}

// c1MethodList returns a deterministic copy for exported method variables.
func c1MethodList(facts c1MethodFacts) []string {
	methods := make([]string, 0, len(facts.methods))
	for _, method := range facts.methods {
		methods = append(methods, method)
	}
	sort.Strings(methods)
	return methods
}
