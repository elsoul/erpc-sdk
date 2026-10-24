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
	APIKey              string
	Endpoint            string
	AvalancheEndpoint   string
	BaseEndpoint        string
	ArbitrumEndpoint    string
	PolygonEndpoint     string
	BscEndpoint         string
	OptimismEndpoint    string
	KaiaEndpoint        string
	SoneiumEndpoint     string
	MonadEndpoint       string
	HyperliquidEndpoint string
	ArcEndpoint         string
	RobinhoodEndpoint   string
	NearEndpoint        string
	TronEndpoint        string
	SuiEndpoint         string
	AccountEndpoint     string
	UserEndpoint        string
	Headers             http.Header
	Timeout             time.Duration
	HTTPClient          *http.Client
	SolanaRPC           *RPCEndpointConfig
	EthereumRPC         *RPCEndpointConfig
	AvalancheCRPC       *RPCEndpointConfig
	BitcoinRPC          *RPCEndpointConfig
	BaseRPC             *RPCEndpointConfig
	ArbitrumRPC         *RPCEndpointConfig
	PolygonRPC          *RPCEndpointConfig
	BscRPC              *RPCEndpointConfig
	OptimismRPC         *RPCEndpointConfig
	KaiaRPC             *RPCEndpointConfig
	SoneiumRPC          *RPCEndpointConfig
	MonadRPC            *RPCEndpointConfig
	HyperliquidRPC      *RPCEndpointConfig
	ArcRPC              *RPCEndpointConfig
	RobinhoodRPC        *RPCEndpointConfig
	NearRPC             *RPCEndpointConfig
	TronRPC             *RPCEndpointConfig
	SuiGRPCWeb          *SuiGRPCWebEndpointConfig
}

type resolvedRPCEndpointConfig struct {
	httpURL           *url.URL
	webSocketURL      *url.URL
	headers           http.Header
	redactionVariants []string
}

type resolvedConfig struct {
	apiKey              string
	endpoint            *url.URL
	avalancheEndpoint   *url.URL
	baseEndpoint        *url.URL
	arbitrumEndpoint    *url.URL
	polygonEndpoint     *url.URL
	bscEndpoint         *url.URL
	optimismEndpoint    *url.URL
	kaiaEndpoint        *url.URL
	soneiumEndpoint     *url.URL
	monadEndpoint       *url.URL
	hyperliquidEndpoint *url.URL
	arcEndpoint         *url.URL
	robinhoodEndpoint   *url.URL
	nearEndpoint        *url.URL
	tronEndpoint        *url.URL
	suiEndpoint         *url.URL
	accountEndpoint     *url.URL
	userEndpoint        *url.URL
	headers             http.Header
	timeout             time.Duration
	httpClient          *http.Client
	solanaRPC           *resolvedRPCEndpointConfig
	ethereumRPC         *resolvedRPCEndpointConfig
	avalancheCRPC       *resolvedRPCEndpointConfig
	bitcoinRPC          *resolvedRPCEndpointConfig
	baseRPC             *resolvedRPCEndpointConfig
	arbitrumRPC         *resolvedRPCEndpointConfig
	polygonRPC          *resolvedRPCEndpointConfig
	bscRPC              *resolvedRPCEndpointConfig
	optimismRPC         *resolvedRPCEndpointConfig
	kaiaRPC             *resolvedRPCEndpointConfig
	soneiumRPC          *resolvedRPCEndpointConfig
	monadRPC            *resolvedRPCEndpointConfig
	hyperliquidRPC      *resolvedRPCEndpointConfig
	arcRPC              *resolvedRPCEndpointConfig
	robinhoodRPC        *resolvedRPCEndpointConfig
	nearRPC             *resolvedRPCEndpointConfig
	tronRPC             *resolvedRPCEndpointConfig
	suiGRPCWeb          *resolvedSuiGRPCWebEndpoint
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
	bitcoinRPC, err := resolveSealedRPCEndpoint(config.BitcoinRPC, "BitcoinRPC")
	if err != nil {
		return resolvedConfig{}, err
	}
	baseRPC, err := resolveSealedRPCEndpoint(config.BaseRPC, "BaseRPC")
	if err != nil {
		return resolvedConfig{}, err
	}
	arbitrumRPC, err := resolveSealedRPCEndpoint(config.ArbitrumRPC, "ArbitrumRPC")
	if err != nil {
		return resolvedConfig{}, err
	}
	polygonRPC, err := resolveSealedRPCEndpoint(config.PolygonRPC, "PolygonRPC")
	if err != nil {
		return resolvedConfig{}, err
	}
	bscRPC, err := resolveSealedRPCEndpoint(config.BscRPC, "BscRPC")
	if err != nil {
		return resolvedConfig{}, err
	}
	optimismRPC, err := resolveSealedRPCEndpoint(config.OptimismRPC, "OptimismRPC")
	if err != nil {
		return resolvedConfig{}, err
	}
	kaiaRPC, err := resolveSealedRPCEndpoint(config.KaiaRPC, "KaiaRPC")
	if err != nil {
		return resolvedConfig{}, err
	}
	soneiumRPC, err := resolveSealedRPCEndpoint(config.SoneiumRPC, "SoneiumRPC")
	if err != nil {
		return resolvedConfig{}, err
	}
	monadRPC, err := resolveSealedRPCEndpoint(config.MonadRPC, "MonadRPC")
	if err != nil {
		return resolvedConfig{}, err
	}
	hyperliquidRPC, err := resolveSealedRPCEndpoint(config.HyperliquidRPC, "HyperliquidRPC")
	if err != nil {
		return resolvedConfig{}, err
	}
	arcRPC, err := resolveSealedRPCEndpoint(config.ArcRPC, "ArcRPC")
	if err != nil {
		return resolvedConfig{}, err
	}
	robinhoodRPC, err := resolveSealedRPCEndpoint(config.RobinhoodRPC, "RobinhoodRPC")
	if err != nil {
		return resolvedConfig{}, err
	}
	nearRPC, err := resolveSealedRPCEndpoint(config.NearRPC, "NearRPC")
	if err != nil {
		return resolvedConfig{}, err
	}
	tronRPC, err := resolveSealedRPCEndpoint(config.TronRPC, "TronRPC")
	if err != nil {
		return resolvedConfig{}, err
	}
	suiGRPCWeb, err := resolveSuiGRPCWebEndpoint(config.SuiGRPCWeb, "SuiGRPCWeb")
	if err != nil {
		return resolvedConfig{}, err
	}
	if key == "" && solanaRPC == nil && ethereumRPC == nil && avalancheCRPC == nil && bitcoinRPC == nil && baseRPC == nil && arbitrumRPC == nil && polygonRPC == nil && bscRPC == nil && optimismRPC == nil && kaiaRPC == nil && soneiumRPC == nil && monadRPC == nil && hyperliquidRPC == nil && arcRPC == nil && robinhoodRPC == nil && nearRPC == nil && tronRPC == nil && suiGRPCWeb == nil {
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
	base, err := parseC1HostedEndpoint(defaultString(config.BaseEndpoint, DefaultBaseEndpoint), "BaseEndpoint")
	if err != nil {
		return resolvedConfig{}, err
	}
	arbitrum, err := parseC1HostedEndpoint(defaultString(config.ArbitrumEndpoint, DefaultArbitrumEndpoint), "ArbitrumEndpoint")
	if err != nil {
		return resolvedConfig{}, err
	}
	polygon, err := parseGeneratedHostedEndpoint(config.PolygonEndpoint, "client-polygon-rpc", "PolygonEndpoint")
	if err != nil {
		return resolvedConfig{}, err
	}
	bsc, err := parseGeneratedHostedEndpoint(config.BscEndpoint, "client-bsc-rpc", "BscEndpoint")
	if err != nil {
		return resolvedConfig{}, err
	}
	optimism, err := parseGeneratedHostedEndpoint(config.OptimismEndpoint, "client-optimism-rpc", "OptimismEndpoint")
	if err != nil {
		return resolvedConfig{}, err
	}
	kaia, err := parseGeneratedHostedEndpoint(config.KaiaEndpoint, "client-kaia-rpc", "KaiaEndpoint")
	if err != nil {
		return resolvedConfig{}, err
	}
	soneium, err := parseGeneratedHostedEndpoint(config.SoneiumEndpoint, "client-soneium-rpc", "SoneiumEndpoint")
	if err != nil {
		return resolvedConfig{}, err
	}
	monad, err := parseGeneratedHostedEndpoint(config.MonadEndpoint, "client-monad-rpc", "MonadEndpoint")
	if err != nil {
		return resolvedConfig{}, err
	}
	hyperliquid, err := parseGeneratedHostedEndpoint(config.HyperliquidEndpoint, "client-hyperliquid-rpc", "HyperliquidEndpoint")
	if err != nil {
		return resolvedConfig{}, err
	}
	arc, err := parseGeneratedHostedEndpoint(config.ArcEndpoint, "client-arc-rpc", "ArcEndpoint")
	if err != nil {
		return resolvedConfig{}, err
	}
	robinhood, err := parseGeneratedHostedEndpoint(config.RobinhoodEndpoint, "client-robinhood-rpc", "RobinhoodEndpoint")
	if err != nil {
		return resolvedConfig{}, err
	}
	near, err := parseGeneratedHostedEndpoint(config.NearEndpoint, "client-near-rpc", "NearEndpoint")
	if err != nil {
		return resolvedConfig{}, err
	}
	tron, err := parseGeneratedHostedEndpoint(config.TronEndpoint, "client-tron-rpc", "TronEndpoint")
	if err != nil {
		return resolvedConfig{}, err
	}
	sui, err := parseGeneratedHostedEndpoint(config.SuiEndpoint, "client-sui-grpc", "SuiEndpoint")
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
		baseEndpoint: base, arbitrumEndpoint: arbitrum,
		polygonEndpoint: polygon, bscEndpoint: bsc, optimismEndpoint: optimism,
		kaiaEndpoint: kaia, soneiumEndpoint: soneium, monadEndpoint: monad,
		hyperliquidEndpoint: hyperliquid, arcEndpoint: arc, robinhoodEndpoint: robinhood,
		nearEndpoint: near, tronEndpoint: tron, suiEndpoint: sui,
		solanaRPC: solanaRPC, ethereumRPC: ethereumRPC, avalancheCRPC: avalancheCRPC,
		bitcoinRPC: bitcoinRPC, baseRPC: baseRPC, arbitrumRPC: arbitrumRPC,
		polygonRPC: polygonRPC, bscRPC: bscRPC, optimismRPC: optimismRPC,
		kaiaRPC: kaiaRPC, soneiumRPC: soneiumRPC, monadRPC: monadRPC,
		hyperliquidRPC: hyperliquidRPC, arcRPC: arcRPC, robinhoodRPC: robinhoodRPC,
		nearRPC: nearRPC, tronRPC: tronRPC, suiGRPCWeb: suiGRPCWeb,
	}, nil
}

func resolveSealedRPCEndpoint(config *RPCEndpointConfig, namespace string) (*resolvedRPCEndpointConfig, error) {
	if config == nil {
		return nil, nil
	}
	if config.WebSocketURL != "" {
		return nil, sdkError(ErrorConfig, namespace+" does not support WebSocket URLs")
	}
	httpURL, err := parseDirectEndpoint(config.HTTPURL, false, namespace+" HTTPURL")
	if err != nil {
		return nil, err
	}
	headers := config.Headers.Clone()
	if headers == nil {
		headers = make(http.Header)
	}
	return &resolvedRPCEndpointConfig{
		httpURL:           httpURL,
		headers:           headers,
		redactionVariants: directRedactionVariants(httpURL, nil, headers),
	}, nil
}

func resolveSuiGRPCWebEndpoint(config *SuiGRPCWebEndpointConfig, namespace string) (*resolvedSuiGRPCWebEndpoint, error) {
	if config == nil {
		return nil, nil
	}
	baseURL, err := parseDirectEndpoint(config.BaseURL, false, namespace+" BaseURL")
	if err != nil {
		return nil, err
	}
	headers := config.Headers.Clone()
	if headers == nil {
		headers = make(http.Header)
	}
	return &resolvedSuiGRPCWebEndpoint{
		baseURL:    baseURL,
		headers:    headers,
		redactions: c1DirectRedactionVariants(baseURL, nil, headers),
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

func parseC1HostedEndpoint(value, namespace string) (*url.URL, error) {
	input := strings.TrimSpace(value)
	separator := strings.Index(input, "://")
	if input == "" || separator <= 0 || strings.Contains(input, "#") {
		return nil, sdkError(ErrorConfig, namespace+" must be an absolute HTTP(S) URL")
	}
	if !strings.EqualFold(input[:separator], "http") && !strings.EqualFold(input[:separator], "https") {
		return nil, sdkError(ErrorConfig, namespace+" must be an absolute HTTP(S) URL")
	}
	authority := input[separator+3:]
	if end := strings.IndexAny(authority, "/?#"); end >= 0 {
		authority = authority[:end]
	}
	if authority == "" || strings.Contains(authority, "@") {
		return nil, sdkError(ErrorConfig, namespace+" must be an absolute HTTP(S) URL")
	}
	u, err := url.Parse(input)
	if err != nil || u.Host == "" || u.Hostname() == "" || u.User != nil {
		return nil, sdkError(ErrorConfig, namespace+" must be an absolute HTTP(S) URL")
	}
	u.RawQuery = ""
	u.ForceQuery = false
	u.Fragment = ""
	u.RawFragment = ""
	u.Path = strings.TrimRight(u.Path, "/")
	return u, nil
}

func parseGeneratedHostedEndpoint(value, clientContractID, namespace string) (*url.URL, error) {
	if value == "" {
		generated, err := generatedC1PublicDefault(clientContractID)
		if err != nil {
			// Later-cohort projection facts may be refreshed after this source
			// lane. Keep existing clients constructible while the sibling is
			// unavailable; an explicit endpoint still validates normally.
			return nil, nil
		}
		value = generated
	}
	return parseC1HostedEndpoint(value, namespace)
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
	baseEndpoint := config.BaseEndpoint
	if baseEndpoint == "" {
		baseEndpoint = DefaultBaseEndpoint
	}
	arbitrumEndpoint := config.ArbitrumEndpoint
	if arbitrumEndpoint == "" {
		arbitrumEndpoint = DefaultArbitrumEndpoint
	}
	return fmt.Sprintf("Config{APIKey:%q, Endpoint:%q, AvalancheEndpoint:%q, BaseEndpoint:%q, ArbitrumEndpoint:%q, PolygonEndpoint:%q, BscEndpoint:%q, OptimismEndpoint:%q, KaiaEndpoint:%q, SoneiumEndpoint:%q, MonadEndpoint:%q, HyperliquidEndpoint:%q, ArcEndpoint:%q, RobinhoodEndpoint:%q, NearEndpoint:%q, TronEndpoint:%q, SuiEndpoint:%q, AccountEndpoint:%q, UserEndpoint:%q, HeaderNames:%q, Timeout:%s, SolanaRPC:%v, EthereumRPC:%v, AvalancheCRPC:%v, BitcoinRPC:%s, BaseRPC:%s, ArbitrumRPC:%s, PolygonRPC:%s, BscRPC:%s, OptimismRPC:%s, KaiaRPC:%s, SoneiumRPC:%s, MonadRPC:%s, HyperliquidRPC:%s, ArcRPC:%s, RobinhoodRPC:%s, NearRPC:%s, TronRPC:%s, SuiGRPCWeb:%s}",
		apiKey, publicDirectEndpoint(config.Endpoint), publicDirectEndpoint(config.AvalancheEndpoint),
		publicOriginEndpoint(baseEndpoint), publicOriginEndpoint(arbitrumEndpoint),
		c1ConfigOrigin(config.PolygonEndpoint, "client-polygon-rpc"), c1ConfigOrigin(config.BscEndpoint, "client-bsc-rpc"),
		c1ConfigOrigin(config.OptimismEndpoint, "client-optimism-rpc"), c1ConfigOrigin(config.KaiaEndpoint, "client-kaia-rpc"),
		c1ConfigOrigin(config.SoneiumEndpoint, "client-soneium-rpc"), c1ConfigOrigin(config.MonadEndpoint, "client-monad-rpc"),
		c1ConfigOrigin(config.HyperliquidEndpoint, "client-hyperliquid-rpc"), c1ConfigOrigin(config.ArcEndpoint, "client-arc-rpc"),
		c1ConfigOrigin(config.RobinhoodEndpoint, "client-robinhood-rpc"), c1ConfigOrigin(config.NearEndpoint, "client-near-rpc"),
		c1ConfigOrigin(config.TronEndpoint, "client-tron-rpc"), c1ConfigOrigin(config.SuiEndpoint, "client-sui-grpc"),
		publicDirectEndpoint(config.AccountEndpoint), publicDirectEndpoint(config.UserEndpoint),
		headerNames(config.Headers), config.Timeout, config.SolanaRPC, config.EthereumRPC, config.AvalancheCRPC,
		c1RPCEndpointString(config.BitcoinRPC), c1RPCEndpointString(config.BaseRPC), c1RPCEndpointString(config.ArbitrumRPC),
		c1RPCEndpointString(config.PolygonRPC), c1RPCEndpointString(config.BscRPC), c1RPCEndpointString(config.OptimismRPC),
		c1RPCEndpointString(config.KaiaRPC), c1RPCEndpointString(config.SoneiumRPC), c1RPCEndpointString(config.MonadRPC),
		c1RPCEndpointString(config.HyperliquidRPC), c1RPCEndpointString(config.ArcRPC), c1RPCEndpointString(config.RobinhoodRPC),
		c1RPCEndpointString(config.NearRPC), c1RPCEndpointString(config.TronRPC), suiGRPCWebString(config.SuiGRPCWeb))
}

func (config Config) GoString() string { return config.String() }

func publicDirectEndpoint(value string) string {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || u.Host == "" {
		return "[REDACTED]"
	}
	return publicEndpointURL(u)
}

func publicOriginEndpoint(value string) string {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || u.Host == "" || u.Scheme == "" {
		return "[REDACTED]"
	}
	return c1OriginRoot(u)
}

func c1RPCEndpointString(endpoint *RPCEndpointConfig) string {
	if endpoint == nil {
		return "<nil>"
	}
	return fmt.Sprintf("RPCEndpointConfig{HTTPURL:%q, WebSocketURL:%q, HeaderNames:%q}",
		publicOriginEndpoint(endpoint.HTTPURL), "", headerNames(endpoint.Headers))
}

func c1ConfigOrigin(value, clientContractID string) string {
	if value == "" {
		value, err := generatedC1PublicDefault(clientContractID)
		if err != nil {
			return "[REDACTED]"
		}
		return publicOriginEndpoint(value)
	}
	return publicOriginEndpoint(value)
}

func suiGRPCWebString(endpoint *SuiGRPCWebEndpointConfig) string {
	if endpoint == nil {
		return "<nil>"
	}
	return fmt.Sprintf("SuiGRPCWebEndpointConfig{BaseURL:%q, HeaderNames:%q}", publicOriginEndpoint(endpoint.BaseURL), headerNames(endpoint.Headers))
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
