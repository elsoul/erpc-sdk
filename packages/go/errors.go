package erpc

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
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
	ErrorNotConfigured   ErrorKind = "not_configured"
)

// Error is the credential-safe error returned by the SDK.
type Error struct {
	Kind    ErrorKind
	Message string
	Status  int
	Code    int
	Data    json.RawMessage
	// Namespace identifies the unavailable SDK namespace for ErrorNotConfigured.
	// It is empty for all other error kinds.
	Namespace string
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

func notConfiguredError(namespace string) error {
	return &Error{
		Kind: ErrorNotConfigured, Namespace: namespace,
		Message: fmt.Sprintf("ERPC namespace %q is not configured", namespace),
	}
}

func redactCredential(value, credential string) string {
	return redactString(value, credentialVariants(credential))
}

func redactJSON(raw json.RawMessage, credential string) json.RawMessage {
	return redactJSONWithVariants(raw, credentialVariants(credential))
}

func redactJSONWithVariants(raw json.RawMessage, variants []string) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return json.RawMessage(`"[REDACTED]"`)
	}
	value = redactJSONValueWithVariants(value, variants, 0)
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage(`"[REDACTED]"`)
	}
	return encoded
}

func redactJSONValue(value any, credential string) any {
	return redactJSONValueWithVariants(value, credentialVariants(credential), 0)
}

func redactJSONValueWithVariants(value any, variants []string, depth int) any {
	if depth >= 32 {
		return "[REDACTED]"
	}
	switch typed := value.(type) {
	case string:
		return redactString(typed, variants)
	case []any:
		for i, item := range typed {
			typed[i] = redactJSONValueWithVariants(item, variants, depth+1)
		}
		return typed
	case map[string]any:
		redacted := make(map[string]any, len(typed))
		for key, item := range typed {
			redacted[redactString(key, variants)] = redactJSONValueWithVariants(item, variants, depth+1)
		}
		return redacted
	default:
		return value
	}
}

func credentialVariants(credential string) []string {
	if credential == "" {
		return nil
	}
	values := make(map[string]struct{}, 3)
	add := func(value string) {
		if value != "" {
			values[value] = struct{}{}
		}
	}
	add(credential)
	add(url.QueryEscape(credential))
	add(url.PathEscape(credential))
	return sortedVariants(values)
}

func directRedactionVariants(httpURL, webSocketURL *url.URL, headers map[string][]string) []string {
	values := make(map[string]struct{})
	add := func(value string) {
		if value == "" {
			return
		}
		values[value] = struct{}{}
	}
	collectQueryValues := func(endpoint *url.URL) {
		if endpoint == nil {
			return
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
	}
	collectQueryValues(httpURL)
	collectQueryValues(webSocketURL)
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
			if strings.EqualFold(parts[0], "basic") {
				decoded, err := base64.StdEncoding.DecodeString(credential)
				if err != nil {
					continue
				}
				decodedText := string(decoded)
				add(decodedText)
				if separator := strings.IndexByte(decodedText, ':'); separator >= 0 {
					add(decodedText[:separator])
					add(decodedText[separator+1:])
				}
			}
		}
	}
	variants := make(map[string]struct{})
	for value := range values {
		for _, variant := range credentialVariants(value) {
			variants[variant] = struct{}{}
		}
	}
	return sortedVariants(variants)
}

func sortedVariants(values map[string]struct{}) []string {
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

func redactString(value string, variants []string) string {
	for _, variant := range variants {
		// redactVariant treats only the hexadecimal digits in percent escapes as
		// case-insensitive; ordinary credential text retains its exact case.
		value = redactVariant(value, variant)
	}
	return value
}

func redactVariant(value, variant string) string {
	if variant == "" || len(value) < len(variant) {
		return value
	}
	var redacted strings.Builder
	redacted.Grow(len(value))
	for index := 0; index < len(value); {
		if end, ok := matchVariantAt(value, index, variant); ok {
			redacted.WriteString("[REDACTED]")
			index = end
			continue
		}
		redacted.WriteByte(value[index])
		index++
	}
	return redacted.String()
}

func matchVariantAt(value string, index int, variant string) (int, bool) {
	if index+len(variant) > len(value) {
		return 0, false
	}
	for variantIndex := 0; variantIndex < len(variant); {
		if variant[variantIndex] == '%' && variantIndex+2 < len(variant) &&
			isHexDigit(variant[variantIndex+1]) && isHexDigit(variant[variantIndex+2]) {
			if value[index+variantIndex] != '%' ||
				!equalHexDigit(value[index+variantIndex+1], variant[variantIndex+1]) ||
				!equalHexDigit(value[index+variantIndex+2], variant[variantIndex+2]) {
				return 0, false
			}
			variantIndex += 3
			continue
		}
		if value[index+variantIndex] != variant[variantIndex] {
			return 0, false
		}
		variantIndex++
	}
	return index + len(variant), true
}

func equalHexDigit(left, right byte) bool {
	if left == right {
		return true
	}
	if left >= 'a' && left <= 'f' {
		left -= 'a' - 'A'
	}
	if right >= 'a' && right <= 'f' {
		right -= 'a' - 'A'
	}
	return left == right
}

func isHexDigit(value byte) bool {
	return value >= '0' && value <= '9' || value >= 'a' && value <= 'f' || value >= 'A' && value <= 'F'
}
