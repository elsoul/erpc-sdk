package erpc

import (
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const (
	DefaultEndpoint          = "https://edge.erpc.global"
	DefaultAvalancheEndpoint = "https://ava-rpc.erpc.global"
	DefaultAccountEndpoint   = "https://solana-rpc.erpc.global"
	DefaultUserEndpoint      = "https://user-api.erpc.global"
	DefaultTimeout           = 30 * time.Second
)

// RPCEndpointConfig selects a caller-owned JSON-RPC endpoint.
//
// HTTPURL is the complete HTTP(S) request target. Its path and query are
// preserved exactly; the SDK does not add an eRPC route or API-key query
// parameter. WebSocketURL is an independent subscription target. Headers are
// scoped to this endpoint's HTTP requests.
type RPCEndpointConfig struct {
	HTTPURL      string
	WebSocketURL string
	Headers      http.Header
}

// RpcEndpointConfig is retained as a spelling-compatible alias for callers
// that use the initialism's mixed-case form.
type RpcEndpointConfig = RPCEndpointConfig

// Config configures Client. APIKey is retained in memory but never returned by
// Endpoint methods or SDK errors.
type Config struct {
	APIKey            string
	Endpoint          string
	AvalancheEndpoint string
	AccountEndpoint   string
	UserEndpoint      string
	Headers           http.Header
	Timeout           time.Duration
	HTTPClient        *http.Client
	SolanaRPC         *RPCEndpointConfig
	EthereumRPC       *RPCEndpointConfig
	AvalancheCRPC     *RPCEndpointConfig
}

type resolvedRPCEndpointConfig struct {
	httpURL           *url.URL
	webSocketURL      *url.URL
	headers           http.Header
	redactionVariants []string
}

type resolvedConfig struct {
	apiKey            string
	endpoint          *url.URL
	avalancheEndpoint *url.URL
	accountEndpoint   *url.URL
	userEndpoint      *url.URL
	headers           http.Header
	timeout           time.Duration
	httpClient        *http.Client
	solanaRPC         *resolvedRPCEndpointConfig
	ethereumRPC       *resolvedRPCEndpointConfig
	avalancheCRPC     *resolvedRPCEndpointConfig
}

func resolveConfig(config Config) (resolvedConfig, error) {
	key := strings.TrimSpace(config.APIKey)
	solanaRPC, err := resolveRPCEndpoint(config.SolanaRPC, "SolanaRPC")
	if err != nil {
		return resolvedConfig{}, err
	}
	ethereumRPC, err := resolveRPCEndpoint(config.EthereumRPC, "EthereumRPC")
	if err != nil {
		return resolvedConfig{}, err
	}
	avalancheCRPC, err := resolveRPCEndpoint(config.AvalancheCRPC, "AvalancheCRPC")
	if err != nil {
		return resolvedConfig{}, err
	}
	if key == "" && solanaRPC == nil && ethereumRPC == nil && avalancheCRPC == nil {
		return resolvedConfig{}, sdkError(ErrorConfig, "api_key must not be empty")
	}
	timeout := config.Timeout
	if timeout == 0 {
		timeout = DefaultTimeout
	}
	if timeout < 0 {
		return resolvedConfig{}, sdkError(ErrorConfig, "timeout must be positive")
	}
	endpoint, err := parseEndpoint(defaultString(config.Endpoint, DefaultEndpoint), false)
	if err != nil {
		return resolvedConfig{}, err
	}
	avalanche, err := parseEndpoint(defaultString(config.AvalancheEndpoint, DefaultAvalancheEndpoint), false)
	if err != nil {
		return resolvedConfig{}, err
	}
	account, err := parseEndpoint(defaultString(config.AccountEndpoint, DefaultAccountEndpoint), false)
	if err != nil {
		return resolvedConfig{}, err
	}
	user, err := parseEndpoint(defaultString(config.UserEndpoint, DefaultUserEndpoint), false)
	if err != nil {
		return resolvedConfig{}, err
	}
	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	headers := config.Headers.Clone()
	if headers == nil {
		headers = make(http.Header)
	}
	return resolvedConfig{
		apiKey: key, endpoint: endpoint, accountEndpoint: account,
		userEndpoint: user, headers: headers, timeout: timeout,
		httpClient: httpClient, avalancheEndpoint: avalanche,
		solanaRPC: solanaRPC, ethereumRPC: ethereumRPC, avalancheCRPC: avalancheCRPC,
	}, nil
}

func resolveRPCEndpoint(config *RPCEndpointConfig, namespace string) (*resolvedRPCEndpointConfig, error) {
	if config == nil {
		return nil, nil
	}
	httpURL, err := parseDirectEndpoint(config.HTTPURL, false, namespace+" HTTPURL")
	if err != nil {
		return nil, err
	}
	var webSocketURL *url.URL
	if config.WebSocketURL != "" {
		webSocketURL, err = parseDirectEndpoint(config.WebSocketURL, true, namespace+" WebSocketURL")
		if err != nil {
			return nil, err
		}
	}
	headers := config.Headers.Clone()
	if headers == nil {
		headers = make(http.Header)
	}
	return &resolvedRPCEndpointConfig{
		httpURL: httpURL, webSocketURL: webSocketURL, headers: headers,
		redactionVariants: directRedactionVariants(httpURL, webSocketURL, headers),
	}, nil
}

func parseDirectEndpoint(value string, websocket bool, label string) (*url.URL, error) {
	input := strings.TrimSpace(value)
	if input == "" || strings.Contains(input, "#") {
		return nil, sdkError(ErrorConfig, label+" must be an absolute URL")
	}
	separator := strings.Index(input, "://")
	if separator <= 0 {
		return nil, sdkError(ErrorConfig, label+" must be an absolute URL")
	}
	allowedScheme := map[string]bool{"http": true, "https": true}
	message := "HTTP(S)"
	if websocket {
		allowedScheme = map[string]bool{"ws": true, "wss": true}
		message = "WS(S)"
	}
	if !allowedScheme[strings.ToLower(input[:separator])] {
		return nil, sdkError(ErrorConfig, label+" must be an absolute "+message+" URL")
	}
	authority := input[separator+3:]
	if end := strings.IndexAny(authority, "/?#"); end >= 0 {
		authority = authority[:end]
	}
	if authority == "" || strings.Contains(authority, "@") {
		return nil, sdkError(ErrorConfig, label+" must be an absolute "+message+" URL")
	}
	u, err := url.Parse(input)
	if err != nil || u.Host == "" || u.Hostname() == "" || u.User != nil {
		return nil, sdkError(ErrorConfig, label+" must be an absolute "+message+" URL")
	}
	if !allowedScheme[strings.ToLower(u.Scheme)] {
		return nil, sdkError(ErrorConfig, label+" must be an absolute "+message+" URL")
	}
	return u, nil
}

func parseEndpoint(value string, localHTTPOnly bool) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, sdkError(ErrorConfig, "endpoint must be an absolute HTTP(S) URL")
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if localHTTPOnly && u.Scheme != "https" && !local {
		return nil, sdkError(ErrorConfig, "endpoint must use HTTPS except on localhost")
	}
	u.RawQuery = ""
	u.Fragment = ""
	u.Path = strings.TrimRight(u.Path, "/")
	return u, nil
}

func publicEndpointURL(endpoint *url.URL) string {
	if endpoint == nil {
		return ""
	}
	public := *endpoint
	public.RawQuery = ""
	public.ForceQuery = false
	public.Fragment = ""
	public.RawFragment = ""
	public.User = nil
	return public.String()
}

func unavailableEndpoint(namespace string) *url.URL {
	safeNamespace := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' {
			return r
		}
		return '-'
	}, namespace)
	return &url.URL{Scheme: "https", Host: "unconfigured.invalid", Path: "/" + safeNamespace}
}

func (endpoint RPCEndpointConfig) String() string {
	webSocket := ""
	if strings.TrimSpace(endpoint.WebSocketURL) != "" {
		webSocket = publicDirectEndpoint(endpoint.WebSocketURL)
	}
	return fmt.Sprintf("RPCEndpointConfig{HTTPURL:%q, WebSocketURL:%q, HeaderNames:%q}",
		publicDirectEndpoint(endpoint.HTTPURL), webSocket, headerNames(endpoint.Headers))
}

func (endpoint RPCEndpointConfig) GoString() string { return endpoint.String() }

func (config Config) String() string {
	apiKey := ""
	if strings.TrimSpace(config.APIKey) != "" {
		apiKey = "[REDACTED]"
	}
	return fmt.Sprintf("Config{APIKey:%q, Endpoint:%q, AvalancheEndpoint:%q, AccountEndpoint:%q, UserEndpoint:%q, HeaderNames:%q, Timeout:%s, SolanaRPC:%v, EthereumRPC:%v, AvalancheCRPC:%v}",
		apiKey, publicDirectEndpoint(config.Endpoint), publicDirectEndpoint(config.AvalancheEndpoint),
		publicDirectEndpoint(config.AccountEndpoint), publicDirectEndpoint(config.UserEndpoint),
		headerNames(config.Headers), config.Timeout, config.SolanaRPC, config.EthereumRPC, config.AvalancheCRPC)
}

func (config Config) GoString() string { return config.String() }

func publicDirectEndpoint(value string) string {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || u.Host == "" {
		return "[REDACTED]"
	}
	return publicEndpointURL(u)
}

func headerNames(headers http.Header) []string {
	if len(headers) == 0 {
		return nil
	}
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func endpointPath(base *url.URL, suffix string) *url.URL {
	u := *base
	u.Path = strings.TrimRight(base.Path, "/") + "/" + strings.TrimLeft(suffix, "/")
	return &u
}

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
