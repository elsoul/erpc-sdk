package erpc

import (
	"context"
	"net/url"
	"regexp"
)

type MonthlyAPIKeyMethodUsage struct {
	Count      float64 `json:"count"`
	CreditCost float64 `json:"creditCost"`
	Credits    float64 `json:"credits"`
	Method     string  `json:"method"`
	UpdatedAt  *string `json:"updatedAt"`
}

type MonthlyAPIKeyChainUsage struct {
	Chain     string                     `json:"chain"`
	Count     float64                    `json:"count"`
	Credits   float64                    `json:"credits"`
	Methods   []MonthlyAPIKeyMethodUsage `json:"methods"`
	UpdatedAt *string                    `json:"updatedAt"`
}

// MonthlyAPIKeyUsageEntry only contains the last four API-key characters.
type MonthlyAPIKeyUsageEntry struct {
	APIKeyLast4  string                    `json:"apiKeyLast4"`
	APIKeyLength float64                   `json:"apiKeyLength"`
	Chains       []MonthlyAPIKeyChainUsage `json:"chains"`
	Count        float64                   `json:"count"`
	Credits      float64                   `json:"credits"`
	KeyID        *float64                  `json:"keyId"`
	UpdatedAt    *string                   `json:"updatedAt"`
}

type MonthlyAPIKeyUsage struct {
	APIKeys          []MonthlyAPIKeyUsageEntry `json:"apiKeys"`
	Chains           []MonthlyAPIKeyChainUsage `json:"chains"`
	HasStrandedUsage bool                      `json:"hasStrandedUsage"`
	KeyCount         float64                   `json:"keyCount"`
	TotalCount       float64                   `json:"totalCount"`
	TotalCredits     float64                   `json:"totalCredits"`
	UpdatedAt        *string                   `json:"updatedAt"`
	YearMonth        string                    `json:"yearMonth"`
}

type UsageClient struct{ transport *restTransport }

var yearMonthPattern = regexp.MustCompile(`^[0-9]{4}-(0[1-9]|1[0-2])$`)

func (c *UsageClient) GetMonthlyAPIKeyUsage(ctx context.Context, yearMonth string) (MonthlyAPIKeyUsage, error) {
	query := url.Values{}
	if yearMonth != "" {
		if !yearMonthPattern.MatchString(yearMonth) {
			return MonthlyAPIKeyUsage{}, sdkError(ErrorConfig, "year_month must use YYYY-MM format")
		}
		query.Set("yearMonth", yearMonth)
	}
	var envelope struct {
		Success bool               `json:"success"`
		Message MonthlyAPIKeyUsage `json:"message"`
	}
	if err := c.transport.getJSON(ctx, "/v3/user/api-keys/usage", query, &envelope); err != nil {
		return MonthlyAPIKeyUsage{}, err
	}
	if !envelope.Success || !yearMonthPattern.MatchString(envelope.Message.YearMonth) {
		return MonthlyAPIKeyUsage{}, sdkError(ErrorInvalidResponse, "ERPC returned an invalid monthly API key usage response")
	}
	return envelope.Message, nil
}
