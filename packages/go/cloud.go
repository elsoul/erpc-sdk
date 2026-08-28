package erpc

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type CloudConfig struct {
	AccessToken string
	Endpoint    string
	Headers     http.Header
	Timeout     time.Duration
	HTTPClient  *http.Client
}

// CloudClient uses a scoped access token and never accepts refresh credentials.
type CloudClient struct {
	Catalog   *CloudCatalogClient
	Credit    *CloudCreditClient
	Resources *CloudResourcesClient
	Usage     *UsageClient
}

func NewCloudClient(config CloudConfig) (*CloudClient, error) {
	token := strings.TrimSpace(config.AccessToken)
	if token == "" {
		return nil, sdkError(ErrorConfig, "access_token must not be empty")
	}
	timeout := config.Timeout
	if timeout == 0 {
		timeout = DefaultTimeout
	}
	if timeout < 0 {
		return nil, sdkError(ErrorConfig, "timeout must be positive")
	}
	endpoint, err := parseEndpoint(defaultString(config.Endpoint, DefaultUserEndpoint), true)
	if err != nil {
		return nil, err
	}
	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	headers := config.Headers.Clone()
	if headers == nil {
		headers = make(http.Header)
	}
	resolved := resolvedConfig{headers: headers, timeout: timeout, httpClient: httpClient}
	transport := newRESTTransport(token, endpoint, resolved)
	return &CloudClient{
		Catalog: &CloudCatalogClient{transport: transport}, Credit: &CloudCreditClient{transport: transport},
		Resources: &CloudResourcesClient{transport: transport}, Usage: &UsageClient{transport: transport},
	}, nil
}

type CloudOfferingBilling struct {
	AmountCents uint64 `json:"amountCents"`
	Unit        string `json:"unit"`
}

type CloudOffering struct {
	Billing      *CloudOfferingBilling `json:"billing,omitempty"`
	Capabilities []string              `json:"capabilities"`
	Compute      map[string]string     `json:"compute,omitempty"`
	Description  string                `json:"description"`
	ID           string                `json:"id"`
	Kind         string                `json:"kind"`
	Mode         string                `json:"mode,omitempty"`
	Name         string                `json:"name"`
	Regions      []string              `json:"regions"`
	Solana       map[string]string     `json:"solana,omitempty"`
}

type CloudCredit struct {
	AlertLevel           string   `json:"alertLevel"`
	BalanceCents         int64    `json:"balanceCents"`
	BurnRateCentsPerHour uint64   `json:"burnRateCentsPerHour"`
	QuoteExpiresAt       string   `json:"quoteExpiresAt"`
	QuoteTimestamp       string   `json:"quoteTimestamp"`
	TimeToZeroHours      *float64 `json:"timeToZeroHours"`
}

type CloudResource struct {
	CreatedAt *string `json:"createdAt"`
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Mode      string  `json:"mode,omitempty"`
	Name      *string `json:"name"`
	Region    *string `json:"region"`
	Status    string  `json:"status"`
}

type CloudResourceStatusBilling struct {
	GraceEndsAt   *string  `json:"graceEndsAt"`
	HourlyCredits *float64 `json:"hourlyCredits"`
	NextChargeAt  *string  `json:"nextChargeAt"`
	Status        string   `json:"status"`
}

type CloudResourceStatus struct {
	Billing *CloudResourceStatusBilling `json:"billing,omitempty"`
	ID      string                      `json:"id"`
	Status  string                      `json:"status"`
}

type CloudCatalogClient struct{ transport *restTransport }
type CloudCreditClient struct{ transport *restTransport }
type CloudResourcesClient struct{ transport *restTransport }

func (c *CloudCatalogClient) List(ctx context.Context) ([]CloudOffering, error) {
	var envelope struct {
		Success bool `json:"success"`
		Message struct {
			Offerings []CloudOffering `json:"offerings"`
		} `json:"message"`
	}
	if err := c.transport.getJSON(ctx, "/v4/cloud/catalog", nil, &envelope); err != nil {
		return nil, err
	}
	if !envelope.Success {
		return nil, sdkError(ErrorInvalidResponse, "ERPC returned an invalid Cloud catalog")
	}
	for _, offering := range envelope.Message.Offerings {
		if offering.Billing != nil && offering.Billing.Unit != "cents-per-hour" {
			return nil, sdkError(ErrorInvalidResponse, "ERPC returned an invalid Cloud catalog")
		}
	}
	return envelope.Message.Offerings, nil
}

func (c *CloudCreditClient) Get(ctx context.Context) (CloudCredit, error) {
	var envelope struct {
		Success bool        `json:"success"`
		Message CloudCredit `json:"message"`
	}
	if err := c.transport.getJSON(ctx, "/v4/cloud/credit", nil, &envelope); err != nil {
		return CloudCredit{}, err
	}
	if !envelope.Success {
		return CloudCredit{}, sdkError(ErrorInvalidResponse, "ERPC returned an invalid Cloud credit snapshot")
	}
	return envelope.Message, nil
}

func (c *CloudResourcesClient) List(ctx context.Context) ([]CloudResource, error) {
	var envelope struct {
		Success bool `json:"success"`
		Message struct {
			Resources []CloudResource `json:"resources"`
		} `json:"message"`
	}
	if err := c.transport.getJSON(ctx, "/v4/cloud/resources", nil, &envelope); err != nil {
		return nil, err
	}
	if !envelope.Success {
		return nil, sdkError(ErrorInvalidResponse, "ERPC returned an invalid Cloud resource list")
	}
	return envelope.Message.Resources, nil
}

func (c *CloudResourcesClient) Get(ctx context.Context, resourceID string) (CloudResource, error) {
	id := strings.TrimSpace(resourceID)
	if id == "" {
		return CloudResource{}, sdkError(ErrorConfig, "resource_id must not be empty")
	}
	var envelope struct {
		Success bool          `json:"success"`
		Message CloudResource `json:"message"`
	}
	if err := c.transport.getJSON(ctx, "/v4/cloud/resources/"+url.PathEscape(id), nil, &envelope); err != nil {
		return CloudResource{}, err
	}
	if !envelope.Success {
		return CloudResource{}, sdkError(ErrorInvalidResponse, "ERPC returned an invalid Cloud resource")
	}
	return envelope.Message, nil
}

func (c *CloudResourcesClient) GetStatus(ctx context.Context, resourceID string) (CloudResourceStatus, error) {
	id := strings.TrimSpace(resourceID)
	if id == "" {
		return CloudResourceStatus{}, sdkError(ErrorConfig, "resource_id must not be empty")
	}
	var envelope struct {
		Success bool                `json:"success"`
		Message CloudResourceStatus `json:"message"`
	}
	path := "/v4/cloud/resources/" + url.PathEscape(id) + "/status"
	if err := c.transport.getJSON(ctx, path, nil, &envelope); err != nil {
		return CloudResourceStatus{}, err
	}
	if !envelope.Success {
		return CloudResourceStatus{}, sdkError(ErrorInvalidResponse, "ERPC returned an invalid Cloud resource status")
	}
	return envelope.Message, nil
}
