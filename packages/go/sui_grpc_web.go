package erpc

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

const SuiGRPCWebContentType = "application/grpc-web+proto"

var (
	errSuiBodyLimit = errors.New("sui response body limit")
	errSuiBodyRead  = errors.New("sui response body read")
)

type SuiGRPCWebEndpointConfig struct {
	BaseURL string
	Headers http.Header
}

func (config SuiGRPCWebEndpointConfig) String() string {
	return config.display()
}

func (config SuiGRPCWebEndpointConfig) GoString() string {
	return config.display()
}

func (config SuiGRPCWebEndpointConfig) display() string {
	origin := ""
	if endpoint, err := url.Parse(config.BaseURL); err == nil {
		origin = c1OriginRoot(endpoint)
	}
	headerNames := make([]string, 0, len(config.Headers))
	for name := range config.Headers {
		headerNames = append(headerNames, name)
	}
	sort.Strings(headerNames)
	return fmt.Sprintf("SuiGRPCWebEndpointConfig{BaseURL:%q, HeaderNames:%q}", origin, headerNames)
}

type resolvedSuiGRPCWebEndpoint struct {
	baseURL    *url.URL
	headers    http.Header
	redactions []string
}

type suiGRPCWebTransport struct {
	requestPrefix        *url.URL
	publicEndpoint       string
	apiKey               string
	headers              http.Header
	client               *http.Client
	timeout              time.Duration
	unavailableNamespace string
	facts                c1MethodFacts
	redactions           []string
	nextID               atomic.Uint64
}

func newSuiGRPCWebTransport(config resolvedConfig, hostedEndpoint *url.URL, direct *resolvedSuiGRPCWebEndpoint) *suiGRPCWebTransport {
	transport := &suiGRPCWebTransport{timeout: config.timeout}
	if direct != nil {
		transport.requestPrefix = cloneURL(direct.baseURL)
		transport.publicEndpoint = c1OriginRoot(transport.requestPrefix)
		transport.headers = direct.headers.Clone()
		transport.redactions = c1DirectRedactionVariants(direct.baseURL, nil, direct.headers)
		transport.client = c1NoRedirectHTTPClient(config.httpClient)
	} else if strings.TrimSpace(config.apiKey) != "" && hostedEndpoint != nil {
		transport.requestPrefix = cloneURL(hostedEndpoint)
		transport.publicEndpoint = c1OriginRoot(transport.requestPrefix)
		transport.apiKey = strings.TrimSpace(config.apiKey)
		transport.headers = config.headers.Clone()
		deleteHeaderFold(transport.headers, "Authorization")
		transport.headers.Set("Authorization", "Bearer "+transport.apiKey)
		transport.redactions = credentialVariants(transport.apiKey)
		transport.client = c1NoRedirectHTTPClient(config.httpClient)
	} else {
		transport.unavailableNamespace = "sui.grpc"
		transport.client = config.httpClient
	}
	facts, err := generatedC1Facts("sui-unary3")
	if err == nil {
		transport.facts = facts
	}
	transport.nextID.Store(0)
	return transport
}

func (transport *suiGRPCWebTransport) ensureConfigured() error {
	if transport.unavailableNamespace != "" {
		return notConfiguredError(transport.unavailableNamespace)
	}
	if transport.requestPrefix == nil || transport.client == nil || len(transport.facts.methods) == 0 {
		return sdkError(ErrorConfig, "Sui RPC facts are unavailable")
	}
	if !c1HeadersValid(transport.headers) {
		return sdkError(ErrorConfig, "HTTP headers are invalid")
	}
	return nil
}

func suiJoinPath(prefix *url.URL, methodPath string) *url.URL {
	result := *prefix
	encodedPrefix := strings.TrimRight(prefix.EscapedPath(), "/")
	encodedPath := encodedPrefix + "/" + strings.TrimLeft(methodPath, "/")
	result.Path = strings.TrimRight(prefix.Path, "/") + "/" + strings.TrimLeft(methodPath, "/")
	result.RawPath = encodedPath
	return &result
}

func (transport *suiGRPCWebTransport) request(ctx context.Context, publicName string, frame []byte) ([]byte, error) {
	if err := transport.ensureConfigured(); err != nil {
		return nil, err
	}
	methodPath, ok := transport.facts.methods[publicName]
	if !ok {
		return nil, sdkError(ErrorConfig, "Sui method is not in the accepted named-read contract")
	}
	if len(frame) > suiMaxRequestBytes {
		return nil, sdkError(ErrorConfig, "Sui request exceeds the supported size")
	}
	endpoint := suiJoinPath(transport.requestPrefix, methodPath)
	requestContext, cancel := context.WithTimeout(ctx, transport.timeout)
	defer cancel()
	if err := requestContext.Err(); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, endpoint.String(), bytes.NewReader(frame))
	if err != nil {
		return nil, sdkError(ErrorConfig, "unable to create Sui request")
	}
	request.Header = transport.headers.Clone()
	if request.Header == nil {
		request.Header = make(http.Header)
	}
	deleteHeaderFold(request.Header, "Content-Type")
	deleteHeaderFold(request.Header, "Accept")
	deleteHeaderFold(request.Header, "X-Grpc-Web")
	request.Header.Set("Content-Type", SuiGRPCWebContentType)
	request.Header.Set("Accept", SuiGRPCWebContentType)
	request.Header.Set("X-Grpc-Web", "1")
	response, err := transport.client.Do(request)
	if err != nil {
		if requestContext.Err() != nil {
			return nil, requestContext.Err()
		}
		return nil, sdkError(ErrorTransport, "unable to reach ERPC")
	}
	if response.Body == nil {
		return nil, bitcoinInvalidResponse()
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, &Error{Kind: ErrorHTTP, Message: "request failed", Status: response.StatusCode}
	}
	contentTypes := response.Header.Values("Content-Type")
	if len(contentTypes) != 1 || contentTypes[0] != SuiGRPCWebContentType {
		return nil, bitcoinInvalidResponse()
	}
	body, err := suiReadBody(requestContext, response.Body, suiMaxResponseBytes)
	if err != nil {
		if requestContext.Err() != nil {
			return nil, requestContext.Err()
		}
		if err == errSuiBodyRead {
			return nil, sdkError(ErrorTransport, "unable to read Sui response")
		}
		return nil, bitcoinInvalidResponse()
	}
	payload, err := suiDecodeFrames(body)
	if err != nil {
		return nil, err
	}
	return payload, nil
}

type suiReadResult struct {
	count int
	err   error
}

func suiReadBody(ctx context.Context, body io.ReadCloser, maximum int64) ([]byte, error) {
	const chunkSize = 32 * 1024
	var output bytes.Buffer
	var total int64
	chunk := make([]byte, chunkSize)
	for {
		resultChannel := make(chan suiReadResult, 1)
		go func() { count, err := body.Read(chunk); resultChannel <- suiReadResult{count: count, err: err} }()
		select {
		case <-ctx.Done():
			_ = body.Close()
			return nil, ctx.Err()
		case result := <-resultChannel:
			if result.count > 0 {
				if result.count > len(chunk) || total > maximum-int64(result.count) {
					_ = body.Close()
					return nil, errSuiBodyLimit
				}
				total += int64(result.count)
				_, _ = output.Write(chunk[:result.count])
			}
			if result.err != nil {
				if result.err == io.EOF {
					return output.Bytes(), nil
				}
				return nil, errSuiBodyRead
			}
		}
	}
}

func suiDecodeFrames(body []byte) ([]byte, error) {
	if len(body) < 5 || body[0] != 0 {
		return nil, bitcoinInvalidResponse()
	}
	dataLength := int(binary.BigEndian.Uint32(body[1:5]))
	dataEnd := 5 + dataLength
	if dataLength > len(body)-5 || dataEnd+5 > len(body) {
		return nil, bitcoinInvalidResponse()
	}
	if body[dataEnd] != 0x80 {
		return nil, bitcoinInvalidResponse()
	}
	trailerLength := int(binary.BigEndian.Uint32(body[dataEnd+1 : dataEnd+5]))
	trailerStart := dataEnd + 5
	trailerEnd := trailerStart + trailerLength
	if trailerLength > len(body)-trailerStart || trailerEnd != len(body) || trailerLength > suiMaxTrailerBytes {
		return nil, bitcoinInvalidResponse()
	}
	if err := suiValidateTrailer(body[trailerStart:trailerEnd]); err != nil {
		return nil, err
	}
	return body[5:dataEnd], nil
}

func suiValidateTrailer(data []byte) error {
	if len(data) == 0 || !utf8.Valid(data) || len(data) < 2 || !bytes.HasSuffix(data, []byte("\r\n")) {
		return bitcoinInvalidResponse()
	}
	statusCount := 0
	lines := strings.Split(string(data), "\r\n")
	for index, line := range lines {
		if index == len(lines)-1 {
			if line != "" {
				return bitcoinInvalidResponse()
			}
			continue
		}
		if line == "" {
			return bitcoinInvalidResponse()
		}
		separator := strings.IndexByte(line, ':')
		if separator <= 0 {
			return bitcoinInvalidResponse()
		}
		name, value := line[:separator], line[separator+1:]
		if !suiValidTrailerName(name) || !suiValidTrailerValue(value) {
			return bitcoinInvalidResponse()
		}
		if name == "grpc-status" {
			statusCount++
			if strings.Trim(value, " \t") != "0" {
				return bitcoinInvalidResponse()
			}
		}
	}
	if statusCount != 1 {
		return bitcoinInvalidResponse()
	}
	return nil
}

func suiValidTrailerName(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if char >= 'a' && char <= 'z' || char >= '0' && char <= '9' {
			continue
		}
		switch char {
		case '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~':
		default:
			return false
		}
	}
	return true
}

func suiValidTrailerValue(value string) bool {
	for _, char := range value {
		if char != '\t' && (char < 0x20 || char == 0x7f) {
			return false
		}
	}
	return true
}
