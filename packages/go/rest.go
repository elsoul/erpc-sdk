package erpc

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"time"
)

type restTransport struct {
	token    string
	endpoint *url.URL
	headers  http.Header
	timeout  time.Duration
	client   *http.Client
}

func newRESTTransport(token string, endpoint *url.URL, config resolvedConfig) *restTransport {
	return &restTransport{token: token, endpoint: endpoint, headers: config.headers.Clone(), timeout: config.timeout, client: config.httpClient}
}

func (t *restTransport) getJSON(ctx context.Context, path string, query url.Values, result any) error {
	response, err := t.get(ctx, path, query, "application/json")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if err := json.NewDecoder(io.LimitReader(response.Body, 16<<20)).Decode(result); err != nil {
		return sdkError(ErrorInvalidResponse, "ERPC returned malformed JSON")
	}
	return nil
}

func (t *restTransport) get(ctx context.Context, path string, query url.Values, accept string) (*http.Response, error) {
	u := endpointPath(t.endpoint, path)
	u.RawQuery = query.Encode()
	requestContext, cancel := context.WithTimeout(ctx, t.timeout)
	request, err := http.NewRequestWithContext(requestContext, http.MethodGet, u.String(), nil)
	if err != nil {
		cancel()
		return nil, sdkError(ErrorConfig, "unable to create REST request")
	}
	request.Header = t.headers.Clone()
	request.Header.Set("Authorization", "Bearer "+t.token)
	request.Header.Set("Accept", accept)
	response, err := t.client.Do(request)
	if err != nil {
		cancel()
		if requestContext.Err() != nil {
			return nil, requestContext.Err()
		}
		return nil, sdkError(ErrorTransport, "unable to reach ERPC")
	}
	response.Body = &cancelReadCloser{ReadCloser: response.Body, cancel: cancel}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		response.Body.Close()
		return nil, &Error{Kind: ErrorHTTP, Message: "request failed", Status: response.StatusCode}
	}
	return response, nil
}

type cancelReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c *cancelReadCloser) Close() error {
	c.cancel()
	return c.ReadCloser.Close()
}
