package erpc

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// bitcoinJSONNumberTuple is the canonical mathematical representation used by
// the exact Bitcoin response decoder. The wire spelling is retained by
// json.Number; this tuple is only used internally when a numeric value has to
// be compared with another numeric value such as a JSON-RPC id.
type bitcoinJSONNumberTuple struct {
	Sign        int
	Coefficient string
	Exponent10  string
}

const (
	bitcoinMaxBodyBytes         int64 = 67_108_864
	bitcoinMaxDepth                   = 64
	bitcoinMaxTokens                  = 1_000_000
	bitcoinMaxLexemeBytes             = 1_024
	bitcoinMaxCoefficientDigits       = 1_000
	bitcoinMinExponent10              = -10_000
	bitcoinMaxExponent10              = 10_000
)

var bitcoinUnsignedIntegerToken = func(value string) bool {
	if value == "0" {
		return true
	}
	if value == "" || value[0] < '1' || value[0] > '9' {
		return false
	}
	for index := 1; index < len(value); index++ {
		if value[index] < '0' || value[index] > '9' {
			return false
		}
	}
	return true
}

func bitcoinSignedIntegerToken(value string) bool {
	if value == "" {
		return false
	}
	if value[0] == '-' {
		return bitcoinUnsignedIntegerToken(value[1:])
	}
	if value[0] == '+' {
		return bitcoinUnsignedIntegerToken(value[1:])
	}
	return bitcoinUnsignedIntegerToken(value)
}

func bitcoinInvalidResponse() error {
	return sdkError(ErrorInvalidResponse, "ERPC returned an invalid response")
}

// canonicalizeBitcoinNumber validates a JSON number without converting it to
// a binary floating-point value.
func canonicalizeBitcoinNumber(value string) (bitcoinJSONNumberTuple, bool) {
	if len(value) == 0 || len(value) > bitcoinMaxLexemeBytes {
		return bitcoinJSONNumberTuple{}, false
	}
	index := 0
	sign := 1
	if value[index] == '-' {
		sign = -1
		index++
		if index == len(value) {
			return bitcoinJSONNumberTuple{}, false
		}
	}

	integerStart := index
	if value[index] == '0' {
		index++
		if index < len(value) && value[index] >= '0' && value[index] <= '9' {
			return bitcoinJSONNumberTuple{}, false
		}
	} else if value[index] >= '1' && value[index] <= '9' {
		index++
		for index < len(value) && value[index] >= '0' && value[index] <= '9' {
			index++
		}
	} else {
		return bitcoinJSONNumberTuple{}, false
	}
	integer := value[integerStart:index]
	fraction := ""
	if index < len(value) && value[index] == '.' {
		index++
		fractionStart := index
		for index < len(value) && value[index] >= '0' && value[index] <= '9' {
			index++
		}
		if fractionStart == index {
			return bitcoinJSONNumberTuple{}, false
		}
		fraction = value[fractionStart:index]
	}

	exponent := 0
	if index < len(value) && (value[index] == 'e' || value[index] == 'E') {
		index++
		exponentSign := 1
		if index < len(value) && (value[index] == '-' || value[index] == '+') {
			if value[index] == '-' {
				exponentSign = -1
			}
			index++
		}
		exponentStart := index
		exponentValue := 0
		significantDigits := 0
		seenNonZero := false
		for index < len(value) && value[index] >= '0' && value[index] <= '9' {
			digit := int(value[index] - '0')
			if digit != 0 || seenNonZero {
				seenNonZero = true
				significantDigits++
				// A five-digit bound is enough for the approved +/-10,000 domain
				// after insignificant leading zeroes have been discarded.
				if significantDigits > 5 {
					return bitcoinJSONNumberTuple{}, false
				}
				exponentValue = exponentValue*10 + digit
			}
			if exponentValue > bitcoinMaxExponent10 {
				return bitcoinJSONNumberTuple{}, false
			}
			index++
		}
		if exponentStart == index {
			return bitcoinJSONNumberTuple{}, false
		}
		exponent = exponentSign * exponentValue
	}
	if index != len(value) {
		return bitcoinJSONNumberTuple{}, false
	}
	if len(integer)+len(fraction) > bitcoinMaxCoefficientDigits {
		return bitcoinJSONNumberTuple{}, false
	}

	coefficient := strings.TrimLeft(integer+fraction, "0")
	if coefficient == "" {
		return bitcoinJSONNumberTuple{Sign: 0, Coefficient: "0", Exponent10: "0"}, true
	}
	trimmed := strings.TrimRight(coefficient, "0")
	trailingZeroes := len(coefficient) - len(trimmed)
	exponent10 := exponent - len(fraction) + trailingZeroes
	if exponent10 < bitcoinMinExponent10 || exponent10 > bitcoinMaxExponent10 {
		return bitcoinJSONNumberTuple{}, false
	}
	return bitcoinJSONNumberTuple{
		Sign:        sign,
		Coefficient: trimmed,
		Exponent10:  strconv.Itoa(exponent10),
	}, true
}

func bitcoinNumberTuplesEqual(left, right bitcoinJSONNumberTuple) bool {
	return left.Sign == right.Sign && left.Coefficient == right.Coefficient && left.Exponent10 == right.Exponent10
}

func bitcoinScanString(value []byte, start int) (int, bool) {
	index := start + 1
	for index < len(value) {
		switch value[index] {
		case '\\':
			index += 2
			if index > len(value) {
				return 0, false
			}
		case '"':
			return index + 1, true
		default:
			index++
		}
	}
	return 0, false
}

func bitcoinScanNumber(value []byte, start int) (int, bool) {
	index := start
	if value[index] == '-' {
		index++
		if index >= len(value) {
			return 0, false
		}
	}
	if value[index] == '0' {
		index++
		if index < len(value) && value[index] >= '0' && value[index] <= '9' {
			return 0, false
		}
	} else if value[index] >= '1' && value[index] <= '9' {
		index++
		for index < len(value) && value[index] >= '0' && value[index] <= '9' {
			index++
		}
	} else {
		return 0, false
	}
	if index < len(value) && value[index] == '.' {
		index++
		fractionStart := index
		for index < len(value) && value[index] >= '0' && value[index] <= '9' {
			index++
		}
		if fractionStart == index {
			return 0, false
		}
	}
	if index < len(value) && (value[index] == 'e' || value[index] == 'E') {
		index++
		if index < len(value) && (value[index] == '-' || value[index] == '+') {
			index++
		}
		exponentStart := index
		for index < len(value) && value[index] >= '0' && value[index] <= '9' {
			index++
		}
		if exponentStart == index {
			return 0, false
		}
	}
	if _, ok := canonicalizeBitcoinNumber(string(value[start:index])); !ok {
		return 0, false
	}
	return index, true
}

func bitcoinScanLiteral(value []byte, start int, literal string) (int, bool) {
	end := start + len(literal)
	if end > len(value) || string(value[start:end]) != literal {
		return 0, false
	}
	return end, true
}

// preflightBitcoinJSON performs the bounded non-recursive scan required before
// the standard library parser constructs any generic values.
func preflightBitcoinJSON(value []byte) error {
	if !utf8.Valid(value) {
		return bitcoinInvalidResponse()
	}
	depth := 0
	tokens := 0
	stack := make([]byte, 0, bitcoinMaxDepth)
	addToken := func() bool {
		tokens++
		return tokens <= bitcoinMaxTokens
	}
	for index := 0; index < len(value); {
		character := value[index]
		switch {
		case character == ' ' || character == '\t' || character == '\r' || character == '\n' || character == ',' || character == ':':
			index++
		case character == '"':
			if !addToken() {
				return bitcoinInvalidResponse()
			}
			end, ok := bitcoinScanString(value, index)
			if !ok {
				return bitcoinInvalidResponse()
			}
			index = end
		case character == '{' || character == '[':
			if !addToken() {
				return bitcoinInvalidResponse()
			}
			depth++
			if depth > bitcoinMaxDepth {
				return bitcoinInvalidResponse()
			}
			stack = append(stack, character)
			index++
		case character == '}' || character == ']':
			if depth == 0 || (character == '}' && stack[len(stack)-1] != '{') || (character == ']' && stack[len(stack)-1] != '[') {
				return bitcoinInvalidResponse()
			}
			stack = stack[:len(stack)-1]
			depth--
			index++
		case character == '-' || character >= '0' && character <= '9':
			end, ok := bitcoinScanNumber(value, index)
			if !ok || !addToken() {
				return bitcoinInvalidResponse()
			}
			index = end
		case character == 't':
			end, ok := bitcoinScanLiteral(value, index, "true")
			if !ok || !addToken() {
				return bitcoinInvalidResponse()
			}
			index = end
		case character == 'f':
			end, ok := bitcoinScanLiteral(value, index, "false")
			if !ok || !addToken() {
				return bitcoinInvalidResponse()
			}
			index = end
		case character == 'n':
			end, ok := bitcoinScanLiteral(value, index, "null")
			if !ok || !addToken() {
				return bitcoinInvalidResponse()
			}
			index = end
		default:
			// Syntax and value construction remain the authority of encoding/json.
			index++
		}
	}
	if depth != 0 {
		return bitcoinInvalidResponse()
	}
	return nil
}

func decodeBitcoinJSON(value []byte) (any, error) {
	if err := preflightBitcoinJSON(value); err != nil {
		return nil, err
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

func bitcoinObject(value any) (map[string]any, bool) {
	result, ok := value.(map[string]any)
	return result, ok
}

func bitcoinRPCIDMatches(value any, expected uint64) bool {
	if number, ok := value.(json.Number); ok {
		actual, ok := canonicalizeBitcoinNumber(number.String())
		if !ok {
			return false
		}
		want, _ := canonicalizeBitcoinNumber(strconv.FormatUint(expected, 10))
		return bitcoinNumberTuplesEqual(actual, want)
	}
	return false
}

func bitcoinRPCCode(value any) (int, bool) {
	number, ok := value.(json.Number)
	if !ok || !bitcoinSignedIntegerToken(number.String()) {
		return 0, false
	}
	parsed, err := strconv.ParseInt(number.String(), 10, 64)
	if err != nil || parsed < math.MinInt || parsed > math.MaxInt {
		return 0, false
	}
	return int(parsed), true
}

func bitcoinRedactValue(value any, variants []string, depth int) any {
	if depth >= 32 {
		return "[REDACTED]"
	}
	switch typed := value.(type) {
	case string:
		return redactString(typed, variants)
	case json.Number:
		// Retain the original lossless token exactly.
		return typed
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			result[index] = bitcoinRedactValue(item, variants, depth+1)
		}
		return result
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			result[redactString(key, variants)] = bitcoinRedactValue(item, variants, depth+1)
		}
		return result
	default:
		return value
	}
}

func bitcoinRedactJSON(value any, variants []string) json.RawMessage {
	if value == nil {
		return nil
	}
	encoded, err := json.Marshal(bitcoinRedactValue(value, variants, 0))
	if err != nil {
		return json.RawMessage(`"[REDACTED]"`)
	}
	return encoded
}

func asBitcoinString(value any) (string, error) {
	result, ok := value.(string)
	if !ok {
		return "", bitcoinInvalidResponse()
	}
	return result, nil
}

func asBitcoinBlockCount(value any) (uint64, error) {
	number, ok := value.(json.Number)
	if !ok || !bitcoinUnsignedIntegerToken(number.String()) {
		return 0, bitcoinInvalidResponse()
	}
	result, err := strconv.ParseUint(number.String(), 10, 64)
	if err != nil {
		return 0, bitcoinInvalidResponse()
	}
	return result, nil
}

func asBitcoinNullableObject(value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	if _, ok := value.(map[string]any); !ok {
		return nil, bitcoinInvalidResponse()
	}
	return value, nil
}

func unwrapBitcoinRPCResponse(value any, expectedID uint64, variants []string) (any, error) {
	response, ok := bitcoinObject(value)
	if !ok {
		return nil, bitcoinInvalidResponse()
	}
	id, ok := response["id"]
	if !ok || !bitcoinRPCIDMatches(id, expectedID) {
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
