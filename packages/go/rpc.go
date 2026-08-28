package erpc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"sync/atomic"
	"time"
)

// BatchCall is one call in a caller-defined, unsplit JSON-RPC batch.
type BatchCall struct {
	Method string
	Params any
}

type batchPolicy uint8

const (
	batchAny batchPolicy = iota
	batchSolanaStandard
	batchUnsupported
)

// RPCNamespace provides generic and batch JSON-RPC access.
type RPCNamespace struct {
	transport *httpRPCTransport
	policy    batchPolicy
}

// Endpoint returns the public endpoint without credentials, query, or fragment.
func (n *RPCNamespace) Endpoint() string { return n.transport.endpoint.String() }

// Request executes one JSON-RPC call and decodes its result into result.
func (n *RPCNamespace) Request(ctx context.Context, method string, params any, result any) error {
	return n.transport.request(ctx, method, params, result)
}

// Raw is an alias for Request for forward-compatible methods.
func (n *RPCNamespace) Raw(ctx context.Context, method string, params any, result any) error {
	return n.Request(ctx, method, params, result)
}

// Batch sends exactly one JSON-RPC batch and returns results in caller order.
// The transport never silently splits a batch.
func (n *RPCNamespace) Batch(ctx context.Context, calls []BatchCall) ([]json.RawMessage, error) {
	if n.policy == batchUnsupported && len(calls) != 0 {
		return nil, sdkError(ErrorBatchPolicy, "leader RPC methods do not support batching")
	}
	if n.policy == batchSolanaStandard {
		if err := validateSolanaBatch(calls); err != nil {
			return nil, err
		}
	}
	return n.transport.batch(ctx, calls)
}

// PendingRequest is an inert typed request. I/O starts when Send is called.
type PendingRequest[T any] struct {
	namespace *RPCNamespace
	method    string
	params    any
}

// NewRequest creates a typed pending JSON-RPC request.
func NewRequest[T any](namespace *RPCNamespace, method string, params any) *PendingRequest[T] {
	return &PendingRequest[T]{namespace: namespace, method: method, params: params}
}

// Send performs the pending request.
func (r *PendingRequest[T]) Send(ctx context.Context) (T, error) {
	var result T
	err := r.namespace.Request(ctx, r.method, r.params, &result)
	return result, err
}

type httpRPCTransport struct {
	apiKey   string
	endpoint *url.URL
	headers  http.Header
	timeout  time.Duration
	client   *http.Client
	nextID   atomic.Uint64
	maxBatch int
}

type wireRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      uint64 `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type wireResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      uint64          `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *rpcErrorObject `json:"error"`
}

type rpcErrorObject struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func newHTTPRPCTransport(config resolvedConfig, endpoint *url.URL) *httpRPCTransport {
	t := &httpRPCTransport{
		apiKey: config.apiKey, endpoint: endpoint, headers: config.headers.Clone(),
		timeout: config.timeout, client: config.httpClient, maxBatch: 256,
	}
	t.nextID.Store(0)
	return t
}

func (t *httpRPCTransport) id() uint64 { return t.nextID.Add(1) }

func (t *httpRPCTransport) request(ctx context.Context, method string, params, result any) error {
	id := t.id()
	var response wireResponse
	if err := t.post(ctx, wireRequest{JSONRPC: "2.0", ID: id, Method: method, Params: params}, &response); err != nil {
		return err
	}
	if response.ID != id {
		return sdkError(ErrorInvalidResponse, "ERPC returned an unexpected response id")
	}
	if response.Error != nil {
		return t.rpcError(response.Error)
	}
	if response.Result == nil {
		return sdkError(ErrorInvalidResponse, "ERPC returned an invalid response")
	}
	if err := json.Unmarshal(response.Result, result); err != nil {
		return sdkError(ErrorInvalidResponse, "ERPC returned an unexpected result shape")
	}
	return nil
}

func (t *httpRPCTransport) batch(ctx context.Context, calls []BatchCall) ([]json.RawMessage, error) {
	if len(calls) == 0 {
		return []json.RawMessage{}, nil
	}
	if len(calls) > t.maxBatch {
		return nil, sdkError(ErrorInvalidResponse, fmt.Sprintf("a batch may contain at most %d calls", t.maxBatch))
	}
	requests := make([]wireRequest, len(calls))
	order := make([]uint64, len(calls))
	for i, call := range calls {
		id := t.id()
		order[i] = id
		requests[i] = wireRequest{JSONRPC: "2.0", ID: id, Method: call.Method, Params: call.Params}
	}
	var responses []wireResponse
	if err := t.post(ctx, requests, &responses); err != nil {
		return nil, err
	}
	byID := make(map[uint64]wireResponse, len(responses))
	for _, response := range responses {
		if _, exists := byID[response.ID]; exists {
			return nil, sdkError(ErrorInvalidResponse, "ERPC returned a duplicate batch id")
		}
		byID[response.ID] = response
	}
	results := make([]json.RawMessage, len(order))
	for i, id := range order {
		response, exists := byID[id]
		if !exists {
			return nil, sdkError(ErrorInvalidResponse, "ERPC omitted a batch response")
		}
		if response.Error != nil {
			return nil, t.rpcError(response.Error)
		}
		if response.Result == nil {
			return nil, sdkError(ErrorInvalidResponse, "ERPC returned an invalid batch item")
		}
		results[i] = response.Result
		delete(byID, id)
	}
	if len(byID) != 0 {
		return nil, sdkError(ErrorInvalidResponse, "ERPC returned an unexpected batch response id")
	}
	return results, nil
}

func (t *httpRPCTransport) post(ctx context.Context, body, destination any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return sdkError(ErrorConfig, "RPC parameters could not be serialized")
	}
	u := *t.endpoint
	query := u.Query()
	query.Set("api-key", t.apiKey)
	u.RawQuery = query.Encode()
	requestContext, cancel := context.WithTimeout(ctx, t.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, u.String(), bytes.NewReader(payload))
	if err != nil {
		return sdkError(ErrorConfig, "unable to create RPC request")
	}
	request.Header = t.headers.Clone()
	request.Header.Set("Content-Type", "application/json")
	response, err := t.client.Do(request)
	if err != nil {
		if requestContext.Err() != nil {
			return requestContext.Err()
		}
		return sdkError(ErrorTransport, "unable to reach ERPC")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &Error{Kind: ErrorHTTP, Message: "request failed", Status: response.StatusCode}
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 16<<20))
	if err := decoder.Decode(destination); err != nil {
		return sdkError(ErrorInvalidResponse, "ERPC returned malformed JSON")
	}
	return nil
}

func (t *httpRPCTransport) rpcError(value *rpcErrorObject) error {
	return &Error{
		Kind: ErrorRPC, Code: value.Code,
		Message: redactCredential(value.Message, t.apiKey),
		Data:    redactJSON(value.Data, t.apiKey),
	}
}

func validateSolanaBatch(calls []BatchCall) error {
	heavy := map[string]bool{
		"getPriorityFeeEstimate": true, "getProgramAccounts": true,
		"getProgramAccountsV2": true, "getTokenLargestAccounts": true,
	}
	var hasHeavy, hasStandard bool
	for _, call := range calls {
		if heavy[call.Method] {
			hasHeavy = true
		} else {
			hasStandard = true
		}
	}
	if hasHeavy && hasStandard {
		return sdkError(ErrorBatchPolicy, "Solana indexed and standard RPC methods cannot share a batch")
	}
	return nil
}

func decodeRaw[T any](raw json.RawMessage) (T, error) {
	var result T
	if err := json.Unmarshal(raw, &result); err != nil {
		return result, sdkError(ErrorInvalidResponse, "ERPC returned an unexpected result shape")
	}
	return result, nil
}

func boolString(value bool) string { return strconv.FormatBool(value) }
