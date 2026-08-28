package erpc

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// ErrorKind identifies an SDK failure without exposing request credentials.
type ErrorKind string

const (
	ErrorConfig          ErrorKind = "config"
	ErrorTransport       ErrorKind = "transport"
	ErrorHTTP            ErrorKind = "http"
	ErrorRPC             ErrorKind = "rpc"
	ErrorInvalidResponse ErrorKind = "invalid_response"
	ErrorBatchPolicy     ErrorKind = "batch_policy"
)

// Error is the credential-safe error returned by the SDK.
type Error struct {
	Kind    ErrorKind
	Message string
	Status  int
	Code    int
	Data    json.RawMessage
}

func (e *Error) Error() string {
	switch {
	case e.Status != 0:
		return fmt.Sprintf("erpc: %s (HTTP %d)", e.Message, e.Status)
	case e.Code != 0:
		return fmt.Sprintf("erpc: %s (RPC %d)", e.Message, e.Code)
	default:
		return "erpc: " + e.Message
	}
}

func sdkError(kind ErrorKind, message string) error {
	return &Error{Kind: kind, Message: message}
}

func redactCredential(value, credential string) string {
	value = strings.ReplaceAll(value, credential, "[REDACTED]")
	return strings.ReplaceAll(value, url.QueryEscape(credential), "[REDACTED]")
}

func redactJSON(raw json.RawMessage, credential string) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return json.RawMessage(`"[REDACTED]"`)
	}
	value = redactJSONValue(value, credential)
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage(`"[REDACTED]"`)
	}
	return encoded
}

func redactJSONValue(value any, credential string) any {
	switch typed := value.(type) {
	case string:
		return redactCredential(typed, credential)
	case []any:
		for i, item := range typed {
			typed[i] = redactJSONValue(item, credential)
		}
		return typed
	case map[string]any:
		redacted := make(map[string]any, len(typed))
		for key, item := range typed {
			redacted[redactCredential(key, credential)] = redactJSONValue(item, credential)
		}
		return redacted
	default:
		return value
	}
}
