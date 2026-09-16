package erpc

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

func websocketURL(endpoint *url.URL, apiKey, path string) *url.URL {
	u := endpointPath(endpoint, path)
	if endpoint.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	query := u.Query()
	query.Set("api-key", apiKey)
	u.RawQuery = query.Encode()
	return u
}

type wsResult struct {
	value json.RawMessage
	err   error
}

type webSocketTransport struct {
	connectionURL        *url.URL
	publicEndpoint       string
	credential           string
	timeout              time.Duration
	direct               bool
	unavailableNamespace string
	redactionVariants    []string
	nextID               atomic.Uint64

	mu            sync.Mutex
	writeMu       sync.Mutex
	conn          *websocket.Conn
	pending       map[uint64]chan wsResult
	subscriptions map[string]chan json.RawMessage
	orphans       map[string][]json.RawMessage
}

func newWebSocketTransport(connectionURL *url.URL, timeout time.Duration) *webSocketTransport {
	credential := connectionURL.Query().Get("api-key")
	return newConfiguredWebSocketTransport(connectionURL, timeout, credential, false, nil, "")
}

func newDirectWebSocketTransport(endpoint *resolvedRPCEndpointConfig, timeout time.Duration, namespace string) *webSocketTransport {
	if endpoint.webSocketURL == nil {
		return newUnavailableWebSocketTransport(timeout, namespace)
	}
	return newConfiguredWebSocketTransport(
		endpoint.webSocketURL, timeout, "", true, endpoint.redactionVariants, "",
	)
}

func newUnavailableWebSocketTransport(timeout time.Duration, namespace string) *webSocketTransport {
	endpoint := unavailableEndpoint(namespace)
	return newConfiguredWebSocketTransport(endpoint, timeout, "", false, nil, namespace)
}

func newConfiguredWebSocketTransport(
	connectionURL *url.URL,
	timeout time.Duration,
	credential string,
	direct bool,
	redactionVariants []string,
	unavailableNamespace string,
) *webSocketTransport {
	public := *connectionURL
	public.RawQuery = ""
	public.ForceQuery = false
	public.Fragment = ""
	return &webSocketTransport{
		connectionURL: cloneURL(connectionURL), publicEndpoint: public.String(), credential: credential,
		timeout: timeout, direct: direct, unavailableNamespace: unavailableNamespace,
		redactionVariants: append([]string(nil), redactionVariants...),
		pending:           make(map[uint64]chan wsResult), subscriptions: make(map[string]chan json.RawMessage),
		orphans: make(map[string][]json.RawMessage),
	}
}

func (t *webSocketTransport) endpoint() string { return t.publicEndpoint }

func (t *webSocketTransport) String() string {
	return fmt.Sprintf("WebSocketTransport{Endpoint:%q}", t.publicEndpoint)
}

func (t *webSocketTransport) GoString() string { return t.String() }

func (t *webSocketTransport) ensureConnection(ctx context.Context) (*websocket.Conn, error) {
	if t.unavailableNamespace != "" {
		return nil, notConfiguredError(t.unavailableNamespace)
	}
	t.mu.Lock()
	if t.conn != nil {
		conn := t.conn
		t.mu.Unlock()
		return conn, nil
	}
	t.mu.Unlock()
	dialContext, cancel := context.WithTimeout(ctx, t.timeout)
	defer cancel()
	conn, _, err := websocket.DefaultDialer.DialContext(dialContext, t.connectionURL.String(), nil)
	if err != nil {
		return nil, sdkError(ErrorTransport, "unable to connect to ERPC WebSocket")
	}
	t.mu.Lock()
	if t.conn != nil {
		existing := t.conn
		t.mu.Unlock()
		_ = conn.Close()
		return existing, nil
	}
	t.conn = conn
	t.mu.Unlock()
	go t.readLoop(conn)
	return conn, nil
}

func (t *webSocketTransport) request(ctx context.Context, method string, params any, result any) error {
	conn, err := t.ensureConnection(ctx)
	if err != nil {
		return err
	}
	id := t.nextID.Add(1)
	reply := make(chan wsResult, 1)
	t.mu.Lock()
	t.pending[id] = reply
	t.mu.Unlock()
	request := wireRequest{JSONRPC: "2.0", ID: id, Method: method, Params: params}
	t.writeMu.Lock()
	err = conn.WriteJSON(request)
	t.writeMu.Unlock()
	if err != nil {
		t.mu.Lock()
		delete(t.pending, id)
		t.mu.Unlock()
		return sdkError(ErrorTransport, "unable to send ERPC WebSocket request")
	}
	waitContext, cancel := context.WithTimeout(ctx, t.timeout)
	defer cancel()
	select {
	case response, ok := <-reply:
		if !ok {
			return sdkError(ErrorTransport, "ERPC WebSocket connection closed")
		}
		if response.err != nil {
			return response.err
		}
		if err := json.Unmarshal(response.value, result); err != nil {
			return sdkError(ErrorInvalidResponse, "ERPC returned an unexpected result shape")
		}
		return nil
	case <-waitContext.Done():
		t.mu.Lock()
		delete(t.pending, id)
		t.mu.Unlock()
		return waitContext.Err()
	}
}

func (t *webSocketTransport) readLoop(conn *websocket.Conn) {
	defer t.connectionClosed(conn)
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var values []json.RawMessage
		if len(message) > 0 && message[0] == '[' {
			if json.Unmarshal(message, &values) != nil {
				continue
			}
		} else {
			values = []json.RawMessage{message}
		}
		for _, value := range values {
			t.dispatch(value)
		}
	}
}

func (t *webSocketTransport) dispatch(value json.RawMessage) {
	var envelope struct {
		ID     *uint64         `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *rpcErrorObject `json:"error"`
		Params *struct {
			Subscription json.RawMessage `json:"subscription"`
			Result       json.RawMessage `json:"result"`
		} `json:"params"`
	}
	if json.Unmarshal(value, &envelope) != nil {
		return
	}
	if envelope.ID != nil {
		t.mu.Lock()
		reply := t.pending[*envelope.ID]
		delete(t.pending, *envelope.ID)
		t.mu.Unlock()
		if reply == nil {
			return
		}
		if envelope.Error != nil {
			reply <- wsResult{err: t.rpcError(envelope.Error)}
		} else {
			reply <- wsResult{value: envelope.Result}
		}
		return
	}
	if envelope.Params == nil {
		return
	}
	key := string(envelope.Params.Subscription)
	t.mu.Lock()
	channel := t.subscriptions[key]
	if channel == nil {
		t.orphans[key] = append(t.orphans[key], envelope.Params.Result)
		t.mu.Unlock()
		return
	}
	select {
	case channel <- envelope.Params.Result:
	default:
	}
	t.mu.Unlock()
}

func (t *webSocketTransport) rpcError(value *rpcErrorObject) error {
	variants := t.redactionVariants
	if !t.direct {
		variants = credentialVariants(t.credential)
	}
	return &Error{
		Kind: ErrorRPC, Code: value.Code,
		Message: redactString(value.Message, variants),
		Data:    redactJSONWithVariants(value.Data, variants),
	}
}

func (t *webSocketTransport) register(id json.RawMessage) chan json.RawMessage {
	channel := make(chan json.RawMessage, 256)
	key := string(id)
	t.mu.Lock()
	t.subscriptions[key] = channel
	orphans := t.orphans[key]
	delete(t.orphans, key)
	for _, value := range orphans {
		select {
		case channel <- value:
		default:
		}
	}
	t.mu.Unlock()
	return channel
}

func (t *webSocketTransport) unregister(id json.RawMessage) {
	t.mu.Lock()
	channel := t.subscriptions[string(id)]
	delete(t.subscriptions, string(id))
	delete(t.orphans, string(id))
	t.mu.Unlock()
	if channel != nil {
		close(channel)
	}
}

func (t *webSocketTransport) connectionClosed(conn *websocket.Conn) {
	t.mu.Lock()
	if t.conn != conn {
		t.mu.Unlock()
		return
	}
	t.conn = nil
	for id, reply := range t.pending {
		close(reply)
		delete(t.pending, id)
	}
	for id, channel := range t.subscriptions {
		close(channel)
		delete(t.subscriptions, id)
	}
	t.orphans = make(map[string][]json.RawMessage)
	t.mu.Unlock()
}

func (t *webSocketTransport) close() error {
	t.mu.Lock()
	conn := t.conn
	t.mu.Unlock()
	if conn == nil {
		return nil
	}
	t.writeMu.Lock()
	err := conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
	closeErr := conn.Close()
	t.writeMu.Unlock()
	t.connectionClosed(conn)
	if err != nil {
		return sdkError(ErrorTransport, "unable to close ERPC WebSocket")
	}
	return closeErr
}

// Subscription is an active JSON-RPC subscription.
type Subscription struct {
	ID                json.RawMessage
	transport         *webSocketTransport
	unsubscribeMethod string
	notifications     <-chan json.RawMessage
	closed            atomic.Bool
}

func (s *Subscription) Next(ctx context.Context, result any) error {
	select {
	case value, ok := <-s.notifications:
		if !ok {
			return sdkError(ErrorTransport, "ERPC WebSocket notification stream closed")
		}
		if err := json.Unmarshal(value, result); err != nil {
			return sdkError(ErrorInvalidResponse, "ERPC returned an unexpected result shape")
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Unsubscribe is idempotent after a successful server response.
func (s *Subscription) Unsubscribe(ctx context.Context) (bool, error) {
	if s.closed.Load() {
		return true, nil
	}
	var result bool
	var id any
	if err := json.Unmarshal(s.ID, &id); err != nil {
		return false, sdkError(ErrorInvalidResponse, "invalid subscription id")
	}
	if err := s.transport.request(ctx, s.unsubscribeMethod, []any{id}, &result); err != nil {
		return false, err
	}
	if result {
		s.closed.Store(true)
		s.transport.unregister(s.ID)
	}
	return result, nil
}

type SolanaSubscriptions struct{ transport *webSocketTransport }

func (c *SolanaSubscriptions) Endpoint() string { return c.transport.endpoint() }

func (c *SolanaSubscriptions) AccountSubscribe(ctx context.Context, address string, options ...any) (*Subscription, error) {
	return c.RawSubscribe(ctx, "accountSubscribe", append([]any{address}, options...), "accountUnsubscribe")
}

func (c *SolanaSubscriptions) TransactionSubscribe(ctx context.Context, filter any, options ...any) (*Subscription, error) {
	return c.RawSubscribe(ctx, "transactionSubscribe", append([]any{filter}, options...), "transactionUnsubscribe")
}

func (c *SolanaSubscriptions) RawSubscribe(ctx context.Context, method string, params any, unsubscribeMethod string) (*Subscription, error) {
	var id json.RawMessage
	if err := c.transport.request(ctx, method, params, &id); err != nil {
		return nil, err
	}
	channel := c.transport.register(id)
	return &Subscription{ID: id, transport: c.transport, unsubscribeMethod: unsubscribeMethod, notifications: channel}, nil
}

func (c *SolanaSubscriptions) Raw(ctx context.Context, method string, params, result any) error {
	return c.transport.request(ctx, method, params, result)
}

func (c *SolanaSubscriptions) close() error { return c.transport.close() }

type EthereumSubscriptions struct{ transport *webSocketTransport }

func (c *EthereumSubscriptions) Endpoint() string { return c.transport.endpoint() }

func (c *EthereumSubscriptions) Subscribe(ctx context.Context, subscription string, options ...any) (*Subscription, error) {
	params := append([]any{subscription}, options...)
	var id json.RawMessage
	if err := c.transport.request(ctx, "eth_subscribe", params, &id); err != nil {
		return nil, err
	}
	channel := c.transport.register(id)
	return &Subscription{ID: id, transport: c.transport, unsubscribeMethod: "eth_unsubscribe", notifications: channel}, nil
}

func (c *EthereumSubscriptions) Raw(ctx context.Context, method string, params, result any) error {
	return c.transport.request(ctx, method, params, result)
}

func (c *EthereumSubscriptions) close() error { return c.transport.close() }
