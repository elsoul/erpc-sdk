package erpc

import (
	"context"
	"encoding/json"
	"math/big"
	"regexp"
	"strings"
	"time"
)

// SwapQuoteErrorCode is a stable local validation code for an exact-input
// quote. Transport, timeout, cancellation, and JSON-RPC errors are returned
// directly from the configured RPC transport and do not use this type.
type SwapQuoteErrorCode string

const (
	SwapQuoteInvalidArgument       SwapQuoteErrorCode = "SWAP_INVALID_ARGUMENT"
	SwapQuoteUnsupportedChain      SwapQuoteErrorCode = "SWAP_UNSUPPORTED_CHAIN"
	SwapQuoteUnknownPool           SwapQuoteErrorCode = "SWAP_UNKNOWN_POOL"
	SwapQuoteChainMismatch         SwapQuoteErrorCode = "SWAP_CHAIN_MISMATCH"
	SwapQuoteInvalidPoolState      SwapQuoteErrorCode = "SWAP_INVALID_POOL_STATE"
	SwapQuoteUnknownToken          SwapQuoteErrorCode = "SWAP_UNKNOWN_TOKEN"
	SwapQuoteTokenNotActive        SwapQuoteErrorCode = "SWAP_TOKEN_NOT_ACTIVE"
	SwapQuoteUnsupportedStandard   SwapQuoteErrorCode = "SWAP_UNSUPPORTED_TOKEN_STANDARD"
	SwapQuotePoolTokenMismatch     SwapQuoteErrorCode = "SWAP_POOL_TOKEN_MISMATCH"
	SwapQuoteUnsupportedAdapter    SwapQuoteErrorCode = "SWAP_UNSUPPORTED_ADAPTER"
	SwapQuoteUnsupportedToken      SwapQuoteErrorCode = "SWAP_UNSUPPORTED_TOKEN"
	SwapQuoteProgramMismatch       SwapQuoteErrorCode = "SWAP_PROGRAM_MISMATCH"
	SwapQuoteStateStale            SwapQuoteErrorCode = "SWAP_STATE_STALE"
	SwapQuoteInsufficientLiquidity SwapQuoteErrorCode = "SWAP_INSUFFICIENT_LIQUIDITY"
	SwapQuoteArithmetic            SwapQuoteErrorCode = "SWAP_ARITHMETIC"

	// The prefixed spellings are convenient when code shares the identifiers
	// with another SDK language or a wire-level error map.
	SWAP_INVALID_ARGUMENT           = SwapQuoteInvalidArgument
	SWAP_UNSUPPORTED_CHAIN          = SwapQuoteUnsupportedChain
	SWAP_UNKNOWN_POOL               = SwapQuoteUnknownPool
	SWAP_CHAIN_MISMATCH             = SwapQuoteChainMismatch
	SWAP_INVALID_POOL_STATE         = SwapQuoteInvalidPoolState
	SWAP_UNKNOWN_TOKEN              = SwapQuoteUnknownToken
	SWAP_TOKEN_NOT_ACTIVE           = SwapQuoteTokenNotActive
	SWAP_UNSUPPORTED_TOKEN_STANDARD = SwapQuoteUnsupportedStandard
	SWAP_POOL_TOKEN_MISMATCH        = SwapQuotePoolTokenMismatch
	SWAP_UNSUPPORTED_ADAPTER        = SwapQuoteUnsupportedAdapter
	SWAP_UNSUPPORTED_TOKEN          = SwapQuoteUnsupportedToken
	SWAP_PROGRAM_MISMATCH           = SwapQuoteProgramMismatch
	SWAP_STATE_STALE                = SwapQuoteStateStale
	SWAP_INSUFFICIENT_LIQUIDITY     = SwapQuoteInsufficientLiquidity
	SWAP_ARITHMETIC                 = SwapQuoteArithmetic
)

var swapQuoteMessages = map[SwapQuoteErrorCode]string{
	SwapQuoteInvalidArgument:       "Swap request is invalid",
	SwapQuoteUnsupportedChain:      "Swap chain is unsupported",
	SwapQuoteUnknownPool:           "Swap pool is unknown",
	SwapQuoteChainMismatch:         "Swap chain does not match the selected records",
	SwapQuoteInvalidPoolState:      "Swap pool state is invalid",
	SwapQuoteUnknownToken:          "Swap token is unknown",
	SwapQuoteTokenNotActive:        "Swap token is not active",
	SwapQuoteUnsupportedStandard:   "Swap token standard is unsupported",
	SwapQuotePoolTokenMismatch:     "Swap pool tokens do not match the request",
	SwapQuoteUnsupportedAdapter:    "Swap adapter is unsupported",
	SwapQuoteUnsupportedToken:      "Swap token is unsupported for the selected pool",
	SwapQuoteProgramMismatch:       "Swap program does not match the selected records",
	SwapQuoteStateStale:            "Swap pool state is stale",
	SwapQuoteInsufficientLiquidity: "Swap pool liquidity is insufficient",
	SwapQuoteArithmetic:            "Swap arithmetic overflowed or produced an invalid result",
}

// SwapQuoteError is a deterministic local error produced by quote validation.
type SwapQuoteError struct {
	Code SwapQuoteErrorCode
}

func (e *SwapQuoteError) Error() string {
	if e == nil {
		return "erpc: swap quote failed"
	}
	if message, ok := swapQuoteMessages[e.Code]; ok {
		return message
	}
	return "Swap quote failed"
}

// SwapQuoteErrorMessage returns the fixed safe message for a quote code.
func SwapQuoteErrorMessage(code SwapQuoteErrorCode) string {
	return swapQuoteMessages[code]
}

// SwapFreshness controls the age and block-distance bounds for one quote.
// A nil field uses the SDK default. Pointers distinguish an explicit zero
// bound from an omitted field.
type SwapFreshness struct {
	MaxBlockAgeSeconds  *uint64 `json:"maxBlockAgeSeconds,omitempty"`
	MaxBlockLag         *uint64 `json:"maxBlockLag,omitempty"`
	MaxClockSkewSeconds *uint64 `json:"maxClockSkewSeconds,omitempty"`
}

// ExactInputQuoteRequest selects one catalogued pool and direction.
type ExactInputQuoteRequest struct {
	ChainID                 string         `json:"chainId"`
	PoolDefinitionID        string         `json:"poolDefinitionId"`
	InputTokenDeploymentID  string         `json:"inputTokenDeploymentId"`
	OutputTokenDeploymentID string         `json:"outputTokenDeploymentId"`
	AmountIn                string         `json:"amountIn"`
	Freshness               *SwapFreshness `json:"freshness,omitempty"`
}

// SwapQuoteRequest is an alias for the exact-input request type.
type SwapQuoteRequest = ExactInputQuoteRequest

// QuoteFee is the fee fraction charged by the pool adapter.
type QuoteFee struct {
	Numerator   string `json:"numerator"`
	Denominator string `json:"denominator"`
}

// EvmBlockSnapshot identifies the block used for every state read.
type EvmBlockSnapshot struct {
	Kind           string `json:"kind"`
	BlockNumber    string `json:"blockNumber"`
	BlockHash      string `json:"blockHash"`
	BlockTimestamp string `json:"blockTimestamp"`
}

// ExactInputQuoteResult contains a deterministic decimal-string quote.
type ExactInputQuoteResult struct {
	QuoteKind               string           `json:"quoteKind"`
	ChainID                 string           `json:"chainId"`
	PoolDefinitionID        string           `json:"poolDefinitionId"`
	DexDeploymentID         string           `json:"dexDeploymentId"`
	AdapterKind             string           `json:"adapterKind"`
	InputTokenDeploymentID  string           `json:"inputTokenDeploymentId"`
	OutputTokenDeploymentID string           `json:"outputTokenDeploymentId"`
	AmountIn                string           `json:"amountIn"`
	AmountOut               string           `json:"amountOut"`
	Fee                     QuoteFee         `json:"fee"`
	Snapshot                EvmBlockSnapshot `json:"snapshot"`
	TokenCatalogDigest      string           `json:"tokenCatalogDigest"`
	DexCatalogDigest        string           `json:"dexCatalogDigest"`
}

type normalizedFreshness struct {
	maxBlockAgeSeconds  uint64
	maxBlockLag         uint64
	maxClockSkewSeconds uint64
}

type normalizedSwapRequest struct {
	chainID                 string
	poolDefinitionID        string
	inputTokenDeploymentID  string
	outputTokenDeploymentID string
	amountInText            string
	amountIn                *big.Int
	freshness               normalizedFreshness
	pool                    PoolDefinition
	dex                     DexDeployment
	input                   TokenDeployment
	output                  TokenDeployment
}

type swapHeader struct {
	number    *big.Int
	hash      string
	timestamp *big.Int
}

type swapReserves struct {
	reserve0 *big.Int
	reserve1 *big.Int
}

type evmSwapState struct {
	initial          swapHeader
	latestAfterReads swapHeader
	reserves         swapReserves
}

const supportedQuoteAdapter = "evm-constant-product-v2"

type supportedQuoteCapability struct {
	chainID          string
	dexDeploymentID  string
	factoryAddress   string
	poolDefinitionID string
	poolAddress      string
	token0ID         string
	token0Address    string
	token0Decimals   uint8
	token1ID         string
	token1Address    string
	token1Decimals   uint8
	adapterKind      string
	feeNumerator     string
	feeDenominator   string
}

// Swap eligibility is deliberately a handwritten, reviewed boundary. Catalog
// growth can add lookup and ranking records without granting RPC quote access.
var supportedQuoteCapabilities = []supportedQuoteCapability{
	{
		chainID:          "eip155:1",
		dexDeploymentID:  "dex-deployment-0001",
		factoryAddress:   "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
		poolDefinitionID: "pool-0001",
		poolAddress:      "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc",
		token0ID:         "deployment-0008",
		token0Address:    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
		token0Decimals:   6,
		token1ID:         "deployment-0002",
		token1Address:    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
		token1Decimals:   18,
		adapterKind:      supportedQuoteAdapter,
		feeNumerator:     "3",
		feeDenominator:   "1000",
	},
	{
		chainID:          "eip155:43114",
		dexDeploymentID:  "dex-deployment-0002",
		factoryAddress:   "0x9ad6c38be94206ca50bb0d90783181662f0cfa10",
		poolDefinitionID: "pool-0002",
		poolAddress:      "0xf4003f4efbe8691b60249e6afbd307abe7758adb",
		token0ID:         "deployment-0004",
		token0Address:    "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
		token0Decimals:   18,
		token1ID:         "deployment-0009",
		token1Address:    "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
		token1Decimals:   6,
		adapterKind:      supportedQuoteAdapter,
		feeNumerator:     "3",
		feeDenominator:   "1000",
	},
}

var (
	uint256Max                = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	uint112Max                = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 112), big.NewInt(1))
	uint32Max                 = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 32), big.NewInt(1))
	uint256DecimalPattern     = regexp.MustCompile(`^[1-9][0-9]*$`)
	nonNegativeDecimalPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
	hexBytesPattern           = regexp.MustCompile(`^0x[0-9a-fA-F]*$`)
	hexQuantityPattern        = regexp.MustCompile(`^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$`)
	evmAddressPattern         = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
	opaqueIDPattern           = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)
)

const (
	factoryGetPairSelector  = "0xe6a43905"
	pairFactorySelector     = "0xc45a0155"
	pairToken0Selector      = "0x0dfe1681"
	pairToken1Selector      = "0xd21220a7"
	pairGetReservesSelector = "0x0902f1ac"
)

// SwapClient provides configured RPC-backed quote methods.
type SwapClient struct {
	ethereum  *httpRPCTransport
	avalanche *httpRPCTransport
	// clock is intentionally private and is only set by package tests for
	// deterministic fixture capture. Production clients use time.Now.
	clock func() int64
}

func newSwapClient(ethereum, avalanche *httpRPCTransport) *SwapClient {
	return &SwapClient{ethereum: ethereum, avalanche: avalanche}
}

// QuoteExactInput reads one consistent EVM pool snapshot and calculates an
// exact-input quote. Context cancellation and upstream RPC errors are returned
// unchanged from the configured transport.
func (s *SwapClient) QuoteExactInput(ctx context.Context, request ExactInputQuoteRequest) (ExactInputQuoteResult, error) {
	normalized, err := normalizeSwapRequest(request)
	if err != nil {
		return ExactInputQuoteResult{}, err
	}
	if normalized.pool.Adapter.Kind != supportedQuoteAdapter || normalized.dex.AdapterKind != supportedQuoteAdapter {
		return ExactInputQuoteResult{}, swapDomainError(SwapQuoteUnsupportedAdapter)
	}
	var transport *httpRPCTransport
	ids := DexChainIDs()
	switch normalized.chainID {
	case ids["ethereum"]:
		transport = s.ethereum
	case ids["avalancheC"]:
		transport = s.avalanche
	default:
		return ExactInputQuoteResult{}, swapDomainError(SwapQuoteUnsupportedAdapter)
	}
	state, err := s.readEVMState(ctx, transport, normalized)
	if err != nil {
		return ExactInputQuoteResult{}, err
	}
	if err := s.assertFreshness(state, normalized.freshness); err != nil {
		return ExactInputQuoteResult{}, err
	}
	amountOut, feeNumerator, feeDenominator, err := calculateSwapQuote(normalized, state)
	if err != nil {
		return ExactInputQuoteResult{}, err
	}
	return ExactInputQuoteResult{
		QuoteKind:               "exact-input",
		ChainID:                 normalized.chainID,
		PoolDefinitionID:        normalized.poolDefinitionID,
		DexDeploymentID:         normalized.pool.DexDeploymentID,
		AdapterKind:             normalized.pool.Adapter.Kind,
		InputTokenDeploymentID:  normalized.inputTokenDeploymentID,
		OutputTokenDeploymentID: normalized.outputTokenDeploymentID,
		AmountIn:                normalized.amountIn.String(),
		AmountOut:               amountOut.String(),
		Fee: QuoteFee{
			Numerator:   feeNumerator.String(),
			Denominator: feeDenominator.String(),
		},
		Snapshot: EvmBlockSnapshot{
			Kind:           "evm-block",
			BlockNumber:    state.initial.number.String(),
			BlockHash:      state.initial.hash,
			BlockTimestamp: state.initial.timestamp.String(),
		},
		TokenCatalogDigest: TOKEN_CATALOG_CONTENT_DIGEST,
		DexCatalogDigest:   DexCatalogContentDigest,
	}, nil
}

func normalizeSwapRequest(request ExactInputQuoteRequest) (normalizedSwapRequest, error) {
	for _, value := range []string{
		request.ChainID,
		request.PoolDefinitionID,
		request.InputTokenDeploymentID,
		request.OutputTokenDeploymentID,
		request.AmountIn,
	} {
		if value == "" || strings.TrimSpace(value) != value {
			return normalizedSwapRequest{}, swapDomainError(SwapQuoteInvalidArgument)
		}
	}
	for _, value := range []string{request.PoolDefinitionID, request.InputTokenDeploymentID, request.OutputTokenDeploymentID} {
		if !opaqueIDPattern.MatchString(value) {
			return normalizedSwapRequest{}, swapDomainError(SwapQuoteInvalidArgument)
		}
	}
	freshness, err := normalizeSwapFreshness(request.Freshness)
	if err != nil {
		return normalizedSwapRequest{}, err
	}
	amountIn, err := parseSwapAmount(request.AmountIn)
	if err != nil {
		return normalizedSwapRequest{}, err
	}
	if !isKnownDexChain(request.ChainID) {
		return normalizedSwapRequest{}, swapDomainError(SwapQuoteUnsupportedChain)
	}
	pool, ok := GetPoolDefinition(request.PoolDefinitionID)
	if !ok {
		return normalizedSwapRequest{}, swapDomainError(SwapQuoteUnknownPool)
	}
	if pool.ChainID != request.ChainID {
		return normalizedSwapRequest{}, swapDomainError(SwapQuoteChainMismatch)
	}
	if pool.Status != "active" {
		return normalizedSwapRequest{}, swapDomainError(SwapQuoteInvalidPoolState)
	}
	dex, ok := GetDexDeployment(pool.DexDeploymentID)
	if !ok || dex.Status != "active" {
		return normalizedSwapRequest{}, swapDomainError(SwapQuoteInvalidPoolState)
	}
	input, ok := TokenDeploymentByID(request.InputTokenDeploymentID)
	if !ok {
		return normalizedSwapRequest{}, swapDomainError(SwapQuoteUnknownToken)
	}
	output, ok := TokenDeploymentByID(request.OutputTokenDeploymentID)
	if !ok {
		return normalizedSwapRequest{}, swapDomainError(SwapQuoteUnknownToken)
	}
	if string(input.ChainID) != request.ChainID || string(output.ChainID) != request.ChainID {
		return normalizedSwapRequest{}, swapDomainError(SwapQuoteChainMismatch)
	}
	for _, token := range []TokenDeployment{input, output} {
		if token.Status != TokenStatusActive {
			return normalizedSwapRequest{}, swapDomainError(SwapQuoteTokenNotActive)
		}
	}
	for _, token := range []TokenDeployment{input, output} {
		if token.Standard != TokenStandardERC20 && token.Standard != TokenStandardSPLToken {
			return normalizedSwapRequest{}, swapDomainError(SwapQuoteUnsupportedStandard)
		}
	}
	if request.InputTokenDeploymentID == request.OutputTokenDeploymentID ||
		!sameUnorderedPair(request.InputTokenDeploymentID, request.OutputTokenDeploymentID, pool.Token0DeploymentID, pool.Token1DeploymentID) {
		return normalizedSwapRequest{}, swapDomainError(SwapQuotePoolTokenMismatch)
	}
	if pool.Adapter.Kind != supportedQuoteAdapter || dex.AdapterKind != supportedQuoteAdapter {
		return normalizedSwapRequest{}, swapDomainError(SwapQuoteUnsupportedAdapter)
	}
	if input.Standard != TokenStandardERC20 || output.Standard != TokenStandardERC20 {
		return normalizedSwapRequest{}, swapDomainError(SwapQuoteUnsupportedStandard)
	}
	if !matchesSupportedQuoteCapability(pool, dex, input, output) {
		return normalizedSwapRequest{}, swapDomainError(SwapQuoteUnsupportedToken)
	}
	return normalizedSwapRequest{
		chainID:                 request.ChainID,
		poolDefinitionID:        request.PoolDefinitionID,
		inputTokenDeploymentID:  request.InputTokenDeploymentID,
		outputTokenDeploymentID: request.OutputTokenDeploymentID,
		amountInText:            request.AmountIn,
		amountIn:                amountIn,
		freshness:               freshness,
		pool:                    pool,
		dex:                     dex,
		input:                   input,
		output:                  output,
	}, nil
}

func matchesSupportedQuoteCapability(pool PoolDefinition, dex DexDeployment, input, output TokenDeployment) bool {
	var capability *supportedQuoteCapability
	for index := range supportedQuoteCapabilities {
		candidate := &supportedQuoteCapabilities[index]
		if candidate.poolDefinitionID == pool.PoolDefinitionID {
			capability = candidate
			break
		}
	}
	if capability == nil {
		return false
	}
	if input.RepresentationKind == TokenRepresentationUnclassified || output.RepresentationKind == TokenRepresentationUnclassified {
		return false
	}

	matchesToken := func(token TokenDeployment, deploymentID, address string, decimals uint8) bool {
		return string(token.ChainID) == capability.chainID &&
			token.DeploymentID == deploymentID &&
			token.Address != nil &&
			*token.Address == address &&
			token.Decimals == decimals &&
			token.Standard == TokenStandardERC20
	}

	return pool.ChainID == capability.chainID &&
		pool.DexDeploymentID == capability.dexDeploymentID &&
		pool.Address == capability.poolAddress &&
		pool.Token0DeploymentID == capability.token0ID &&
		pool.Token1DeploymentID == capability.token1ID &&
		dex.ChainID == capability.chainID &&
		dex.DexDeploymentID == capability.dexDeploymentID &&
		dex.ProgramAddress == capability.factoryAddress &&
		dex.AdapterKind == capability.adapterKind &&
		pool.Adapter.Kind == capability.adapterKind &&
		pool.Adapter.FeeNumerator != nil &&
		*pool.Adapter.FeeNumerator == capability.feeNumerator &&
		pool.Adapter.FeeDenominator != nil &&
		*pool.Adapter.FeeDenominator == capability.feeDenominator &&
		((matchesToken(input, capability.token0ID, capability.token0Address, capability.token0Decimals) ||
			matchesToken(input, capability.token1ID, capability.token1Address, capability.token1Decimals)) &&
			(matchesToken(output, capability.token0ID, capability.token0Address, capability.token0Decimals) ||
				matchesToken(output, capability.token1ID, capability.token1Address, capability.token1Decimals)))
}

func normalizeSwapFreshness(value *SwapFreshness) (normalizedFreshness, error) {
	result := normalizedFreshness{maxBlockAgeSeconds: 120, maxBlockLag: 3, maxClockSkewSeconds: 5}
	if value == nil {
		return result, nil
	}
	if value.MaxBlockAgeSeconds != nil {
		if *value.MaxBlockAgeSeconds > 86400 {
			return normalizedFreshness{}, swapDomainError(SwapQuoteInvalidArgument)
		}
		result.maxBlockAgeSeconds = *value.MaxBlockAgeSeconds
	}
	if value.MaxBlockLag != nil {
		if *value.MaxBlockLag > 1024 {
			return normalizedFreshness{}, swapDomainError(SwapQuoteInvalidArgument)
		}
		result.maxBlockLag = *value.MaxBlockLag
	}
	if value.MaxClockSkewSeconds != nil {
		if *value.MaxClockSkewSeconds > 300 {
			return normalizedFreshness{}, swapDomainError(SwapQuoteInvalidArgument)
		}
		result.maxClockSkewSeconds = *value.MaxClockSkewSeconds
	}
	return result, nil
}

func parseSwapAmount(value string) (*big.Int, error) {
	if len(value) > 78 || !uint256DecimalPattern.MatchString(value) {
		return nil, swapDomainError(SwapQuoteInvalidArgument)
	}
	parsed, ok := new(big.Int).SetString(value, 10)
	if !ok || parsed.Sign() <= 0 || parsed.Cmp(uint256Max) > 0 {
		return nil, swapDomainError(SwapQuoteInvalidArgument)
	}
	return parsed, nil
}

func sameUnorderedPair(requestA, requestB, poolA, poolB string) bool {
	left, right := requestA, requestB
	if right < left {
		left, right = right, left
	}
	poolLeft, poolRight := poolA, poolB
	if poolRight < poolLeft {
		poolLeft, poolRight = poolRight, poolLeft
	}
	return left == poolLeft && right == poolRight
}

func swapDomainError(code SwapQuoteErrorCode) error {
	return &SwapQuoteError{Code: code}
}

func (s *SwapClient) rpcRaw(ctx context.Context, transport *httpRPCTransport, method string, params []any) (json.RawMessage, error) {
	var result json.RawMessage
	if err := transport.request(ctx, method, params, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *SwapClient) readEVMState(ctx context.Context, transport *httpRPCTransport, normalized normalizedSwapRequest) (evmSwapState, error) {
	chainRaw, err := s.rpcRaw(ctx, transport, "eth_chainId", []any{})
	if err != nil {
		return evmSwapState{}, err
	}
	if err := assertSwapChainID(chainRaw, normalized.chainID); err != nil {
		return evmSwapState{}, err
	}
	initialRaw, err := s.rpcRaw(ctx, transport, "eth_getBlockByNumber", []any{"latest", false})
	if err != nil {
		return evmSwapState{}, err
	}
	initial, err := parseSwapHeader(initialRaw)
	if err != nil {
		return evmSwapState{}, err
	}
	selector := map[string]any{"blockHash": initial.hash, "requireCanonical": true}
	factoryCodeRaw, err := s.rpcRaw(ctx, transport, "eth_getCode", []any{normalized.dex.ProgramAddress, selector})
	if err != nil {
		return evmSwapState{}, err
	}
	poolCodeRaw, err := s.rpcRaw(ctx, transport, "eth_getCode", []any{normalized.pool.Address, selector})
	if err != nil {
		return evmSwapState{}, err
	}
	token0, ok := TokenDeploymentByID(normalized.pool.Token0DeploymentID)
	if !ok || token0.Address == nil {
		return evmSwapState{}, swapDomainError(SwapQuoteInvalidPoolState)
	}
	token1, ok := TokenDeploymentByID(normalized.pool.Token1DeploymentID)
	if !ok || token1.Address == nil {
		return evmSwapState{}, swapDomainError(SwapQuoteInvalidPoolState)
	}
	pairData, ok := encodeSwapAddressArgument(*token0.Address)
	if !ok {
		return evmSwapState{}, swapDomainError(SwapQuoteInvalidPoolState)
	}
	second, ok := encodeSwapAddressArgument(*token1.Address)
	if !ok {
		return evmSwapState{}, swapDomainError(SwapQuoteInvalidPoolState)
	}
	pairData = factoryGetPairSelector + pairData + second
	factoryPairRaw, err := s.rpcRaw(ctx, transport, "eth_call", []any{map[string]string{"to": normalized.dex.ProgramAddress, "data": pairData}, selector})
	if err != nil {
		return evmSwapState{}, err
	}
	pairFactoryRaw, err := s.rpcRaw(ctx, transport, "eth_call", []any{map[string]string{"to": normalized.pool.Address, "data": pairFactorySelector}, selector})
	if err != nil {
		return evmSwapState{}, err
	}
	pairToken0Raw, err := s.rpcRaw(ctx, transport, "eth_call", []any{map[string]string{"to": normalized.pool.Address, "data": pairToken0Selector}, selector})
	if err != nil {
		return evmSwapState{}, err
	}
	pairToken1Raw, err := s.rpcRaw(ctx, transport, "eth_call", []any{map[string]string{"to": normalized.pool.Address, "data": pairToken1Selector}, selector})
	if err != nil {
		return evmSwapState{}, err
	}
	reservesRaw, err := s.rpcRaw(ctx, transport, "eth_call", []any{map[string]string{"to": normalized.pool.Address, "data": pairGetReservesSelector}, selector})
	if err != nil {
		return evmSwapState{}, err
	}
	latestRaw, err := s.rpcRaw(ctx, transport, "eth_getBlockByNumber", []any{"latest", false})
	if err != nil {
		return evmSwapState{}, err
	}
	latest, err := parseSwapHeader(latestRaw)
	if err != nil {
		return evmSwapState{}, err
	}
	rereadRaw, err := s.rpcRaw(ctx, transport, "eth_getBlockByNumber", []any{"0x" + initial.number.Text(16), false})
	if err != nil {
		return evmSwapState{}, err
	}
	reread, err := parseSwapHeader(rereadRaw)
	if err != nil {
		return evmSwapState{}, err
	}
	if reread.number.Cmp(initial.number) != 0 || reread.hash != initial.hash || reread.timestamp.Cmp(initial.timestamp) != 0 {
		return evmSwapState{}, swapDomainError(SwapQuoteStateStale)
	}
	// Freshness and reorg checks run before any buffered ABI response is
	// decoded, so stale state wins over malformed code/data.
	state := evmSwapState{initial: initial, latestAfterReads: latest}
	if err := s.assertFreshness(state, normalized.freshness); err != nil {
		return evmSwapState{}, err
	}
	factoryCode, err := parseSwapHexBytes(factoryCodeRaw, 0, SwapQuoteInvalidPoolState)
	if err != nil {
		return evmSwapState{}, err
	}
	if len(factoryCode) <= 2 {
		return evmSwapState{}, swapDomainError(SwapQuoteProgramMismatch)
	}
	poolCode, err := parseSwapHexBytes(poolCodeRaw, 0, SwapQuoteInvalidPoolState)
	if err != nil {
		return evmSwapState{}, err
	}
	if len(poolCode) <= 2 {
		return evmSwapState{}, swapDomainError(SwapQuoteInvalidPoolState)
	}
	factoryPair, err := parseSwapAddressWord(factoryPairRaw)
	if err != nil {
		return evmSwapState{}, err
	}
	if factoryPair != normalized.pool.Address {
		return evmSwapState{}, swapDomainError(SwapQuoteProgramMismatch)
	}
	pairFactory, err := parseSwapAddressWord(pairFactoryRaw)
	if err != nil {
		return evmSwapState{}, err
	}
	if pairFactory != normalized.dex.ProgramAddress {
		return evmSwapState{}, swapDomainError(SwapQuoteProgramMismatch)
	}
	pairToken0, err := parseSwapAddressWord(pairToken0Raw)
	if err != nil {
		return evmSwapState{}, err
	}
	pairToken1, err := parseSwapAddressWord(pairToken1Raw)
	if err != nil {
		return evmSwapState{}, err
	}
	if pairToken0 != *token0.Address || pairToken1 != *token1.Address {
		return evmSwapState{}, swapDomainError(SwapQuotePoolTokenMismatch)
	}
	reserves, err := parseSwapReserves(reservesRaw)
	if err != nil {
		return evmSwapState{}, err
	}
	state.reserves = reserves
	return state, nil
}

func (s *SwapClient) currentClockSeconds() int64 {
	if s.clock != nil {
		return s.clock()
	}
	return time.Now().Unix()
}

func (s *SwapClient) assertFreshness(state evmSwapState, freshness normalizedFreshness) error {
	now := big.NewInt(s.currentClockSeconds())
	for _, timestamp := range []*big.Int{state.initial.timestamp, state.latestAfterReads.timestamp} {
		age := new(big.Int).Sub(now, timestamp)
		if age.Sign() < 0 {
			if new(big.Int).Neg(age).Cmp(new(big.Int).SetUint64(freshness.maxClockSkewSeconds)) > 0 {
				return swapDomainError(SwapQuoteStateStale)
			}
		} else if age.Cmp(new(big.Int).SetUint64(freshness.maxBlockAgeSeconds)) > 0 {
			return swapDomainError(SwapQuoteStateStale)
		}
	}
	if state.latestAfterReads.number.Cmp(state.initial.number) < 0 {
		return swapDomainError(SwapQuoteStateStale)
	}
	lag := new(big.Int).Sub(state.latestAfterReads.number, state.initial.number)
	if lag.Cmp(new(big.Int).SetUint64(freshness.maxBlockLag)) > 0 {
		return swapDomainError(SwapQuoteStateStale)
	}
	if state.latestAfterReads.number.Cmp(state.initial.number) == 0 && state.latestAfterReads.hash != state.initial.hash {
		return swapDomainError(SwapQuoteStateStale)
	}
	if state.latestAfterReads.number.Cmp(state.initial.number) > 0 && state.latestAfterReads.timestamp.Cmp(state.initial.timestamp) < 0 {
		return swapDomainError(SwapQuoteStateStale)
	}
	if state.latestAfterReads.number.Cmp(state.initial.number) == 0 &&
		state.latestAfterReads.hash == state.initial.hash &&
		state.latestAfterReads.timestamp.Cmp(state.initial.timestamp) != 0 {
		return swapDomainError(SwapQuoteStateStale)
	}
	return nil
}

func calculateSwapQuote(normalized normalizedSwapRequest, state evmSwapState) (*big.Int, *big.Int, *big.Int, error) {
	feeNumerator, err := parseSwapDecimalQuantity(normalized.pool.Adapter.FeeNumerator, SwapQuoteArithmetic)
	if err != nil {
		return nil, nil, nil, err
	}
	feeDenominator, err := parseSwapDecimalQuantity(normalized.pool.Adapter.FeeDenominator, SwapQuoteArithmetic)
	if err != nil {
		return nil, nil, nil, err
	}
	if feeDenominator.Cmp(feeNumerator) <= 0 {
		return nil, nil, nil, swapDomainError(SwapQuoteArithmetic)
	}
	if normalized.input.Address == nil || normalized.pool.Token0DeploymentID == "" {
		return nil, nil, nil, swapDomainError(SwapQuoteInvalidPoolState)
	}
	token0, ok := TokenDeploymentByID(normalized.pool.Token0DeploymentID)
	if !ok || token0.Address == nil {
		return nil, nil, nil, swapDomainError(SwapQuoteInvalidPoolState)
	}
	inputIsToken0 := strings.EqualFold(*normalized.input.Address, *token0.Address)
	reserveIn, reserveOut := state.reserves.reserve1, state.reserves.reserve0
	if inputIsToken0 {
		reserveIn, reserveOut = state.reserves.reserve0, state.reserves.reserve1
	}
	if reserveIn.Sign() <= 0 || reserveOut.Sign() <= 0 {
		return nil, nil, nil, swapDomainError(SwapQuoteInsufficientLiquidity)
	}
	feeDelta := new(big.Int).Sub(feeDenominator, feeNumerator)
	adjusted := new(big.Int).Mul(normalized.amountIn, feeDelta)
	if !fitsSwapUint256(adjusted) {
		return nil, nil, nil, swapDomainError(SwapQuoteArithmetic)
	}
	reserveTimesFee := new(big.Int).Mul(reserveIn, feeDenominator)
	if !fitsSwapUint256(reserveTimesFee) {
		return nil, nil, nil, swapDomainError(SwapQuoteArithmetic)
	}
	denominator := new(big.Int).Add(reserveTimesFee, adjusted)
	if !fitsSwapUint256(denominator) || denominator.Sign() <= 0 {
		return nil, nil, nil, swapDomainError(SwapQuoteArithmetic)
	}
	numerator := new(big.Int).Mul(adjusted, reserveOut)
	if !fitsSwapUint256(numerator) {
		return nil, nil, nil, swapDomainError(SwapQuoteArithmetic)
	}
	amountOut := new(big.Int).Quo(numerator, denominator)
	if !fitsSwapUint256(amountOut) {
		return nil, nil, nil, swapDomainError(SwapQuoteArithmetic)
	}
	if amountOut.Sign() <= 0 || amountOut.Cmp(reserveOut) > 0 {
		return nil, nil, nil, swapDomainError(SwapQuoteInsufficientLiquidity)
	}
	return amountOut, feeNumerator, feeDenominator, nil
}

func fitsSwapUint256(value *big.Int) bool {
	return value != nil && value.Sign() >= 0 && value.Cmp(uint256Max) <= 0
}

func assertSwapChainID(raw json.RawMessage, chainID string) error {
	network, err := parseSwapHexQuantity(raw, SwapQuoteChainMismatch)
	if err != nil {
		return err
	}
	var expected uint64
	ids := DexChainIDs()
	switch chainID {
	case ids["ethereum"]:
		expected = 1
	case ids["avalancheC"]:
		expected = 43114
	default:
		return swapDomainError(SwapQuoteChainMismatch)
	}
	if network.Cmp(new(big.Int).SetUint64(expected)) != 0 {
		return swapDomainError(SwapQuoteChainMismatch)
	}
	return nil
}

func parseSwapHeader(raw json.RawMessage) (swapHeader, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return swapHeader{}, swapDomainError(SwapQuoteStateStale)
	}
	number, err := parseSwapHexQuantity(object["number"], SwapQuoteStateStale)
	if err != nil {
		return swapHeader{}, err
	}
	hash, err := parseSwapHexBytes(object["hash"], 32, SwapQuoteStateStale)
	if err != nil {
		return swapHeader{}, err
	}
	timestamp, err := parseSwapHexQuantity(object["timestamp"], SwapQuoteStateStale)
	if err != nil {
		return swapHeader{}, err
	}
	return swapHeader{number: number, hash: hash, timestamp: timestamp}, nil
}

func rawString(raw json.RawMessage) (string, bool) {
	var value string
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	return value, true
}

func parseSwapHexBytes(raw json.RawMessage, expectedBytes int, code SwapQuoteErrorCode) (string, error) {
	value, ok := rawString(raw)
	if !ok || !hexBytesPattern.MatchString(value) || (len(value)-2)%2 != 0 {
		return "", swapDomainError(code)
	}
	if expectedBytes > 0 && len(value) != expectedBytes*2+2 {
		return "", swapDomainError(code)
	}
	return strings.ToLower(value), nil
}

func parseSwapHexQuantity(raw json.RawMessage, code SwapQuoteErrorCode) (*big.Int, error) {
	value, ok := rawString(raw)
	if !ok || len(value) > 66 || !hexQuantityPattern.MatchString(value) {
		return nil, swapDomainError(code)
	}
	parsed, ok := new(big.Int).SetString(value[2:], 16)
	if !ok || !fitsSwapUint256(parsed) {
		return nil, swapDomainError(code)
	}
	return parsed, nil
}

func parseSwapDecimalQuantity(value *string, code SwapQuoteErrorCode) (*big.Int, error) {
	if value == nil || len(*value) > 78 || !nonNegativeDecimalPattern.MatchString(*value) {
		return nil, swapDomainError(code)
	}
	parsed, ok := new(big.Int).SetString(*value, 10)
	if !ok || !fitsSwapUint256(parsed) {
		return nil, swapDomainError(code)
	}
	return parsed, nil
}

func parseSwapAddressWord(raw json.RawMessage) (string, error) {
	value, err := parseSwapHexBytes(raw, 32, SwapQuoteInvalidPoolState)
	if err != nil {
		return "", err
	}
	word := value[2:]
	if !strings.HasPrefix(word, strings.Repeat("0", 24)) || !evmAddressPattern.MatchString("0x"+word[24:]) {
		return "", swapDomainError(SwapQuoteInvalidPoolState)
	}
	return "0x" + word[24:], nil
}

func parseSwapReserves(raw json.RawMessage) (swapReserves, error) {
	value, err := parseSwapHexBytes(raw, 96, SwapQuoteInvalidPoolState)
	if err != nil {
		return swapReserves{}, err
	}
	payload := value[2:]
	reserve0, err := parseSwapWord(payload[:64], uint112Max)
	if err != nil {
		return swapReserves{}, err
	}
	reserve1, err := parseSwapWord(payload[64:128], uint112Max)
	if err != nil {
		return swapReserves{}, err
	}
	if _, err := parseSwapWord(payload[128:192], uint32Max); err != nil {
		return swapReserves{}, err
	}
	return swapReserves{reserve0: reserve0, reserve1: reserve1}, nil
}

func parseSwapWord(payload string, maximum *big.Int) (*big.Int, error) {
	parsed, ok := new(big.Int).SetString(payload, 16)
	if !ok || parsed.Cmp(maximum) > 0 {
		return nil, swapDomainError(SwapQuoteInvalidPoolState)
	}
	return parsed, nil
}

func encodeSwapAddressArgument(address string) (string, bool) {
	if !evmAddressPattern.MatchString(address) {
		return "", false
	}
	return strings.Repeat("0", 24) + strings.ToLower(address[2:]), true
}
