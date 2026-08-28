package erpc

import (
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	DefaultEndpoint        = "https://edge.erpc.global"
	DefaultAccountEndpoint = "https://solana-rpc.erpc.global"
	DefaultUserEndpoint    = "https://user-api.erpc.global"
	DefaultTimeout         = 30 * time.Second
)

// Config configures Client. APIKey is retained in memory but never returned by
// Endpoint methods or SDK errors.
type Config struct {
	APIKey          string
	Endpoint        string
	AccountEndpoint string
	UserEndpoint    string
	Headers         http.Header
	Timeout         time.Duration
	HTTPClient      *http.Client
}

type resolvedConfig struct {
	apiKey          string
	endpoint        *url.URL
	accountEndpoint *url.URL
	userEndpoint    *url.URL
	headers         http.Header
	timeout         time.Duration
	httpClient      *http.Client
}

func resolveConfig(config Config) (resolvedConfig, error) {
	key := strings.TrimSpace(config.APIKey)
	if key == "" {
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
		httpClient: httpClient,
	}, nil
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
