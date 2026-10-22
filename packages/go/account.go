package erpc

import "context"

// TokenBalance is the current account token balance.
type TokenBalance struct {
	MaxTokens       uint64  `json:"max_tokens"`
	NextRefillAt    *string `json:"next_refill_at"`
	Plan            string  `json:"plan"`
	RemainingTokens uint64  `json:"remaining_tokens"`
}

// AccountClient provides account and token-balance APIs.
type AccountClient struct{ transport *restTransport }

func (c *AccountClient) GetTokenBalance(ctx context.Context) (TokenBalance, error) {
	var result TokenBalance
	err := c.transport.getJSON(ctx, "/v3/erpc/token-balance", nil, &result)
	return result, err
}
