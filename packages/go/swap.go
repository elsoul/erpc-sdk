package erpc

import (
	"context"
	"encoding/json"
	"errors"
	"math"
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

// SwapExecutionErrorCode is a stable local validation code for unsigned swap
// preparation and RPC simulation. Existing quote, transport, timeout,
// cancellation, and non-revert JSON-RPC errors retain their native behavior.
type SwapExecutionErrorCode string

const (
	SwapExecutionInvalidArgument       SwapExecutionErrorCode = "SWAP_EXECUTION_INVALID_ARGUMENT"
	SwapExecutionUnsupported           SwapExecutionErrorCode = "SWAP_UNSUPPORTED_EXECUTION"
	SwapExecutionProgramMismatch       SwapExecutionErrorCode = "SWAP_PROGRAM_MISMATCH"
	SwapExecutionInsufficientAllowance SwapExecutionErrorCode = "SWAP_INSUFFICIENT_ALLOWANCE"
	SwapExecutionSimulationReverted    SwapExecutionErrorCode = "SWAP_SIMULATION_REVERTED"
	SwapExecutionInvalidSimulation     SwapExecutionErrorCode = "SWAP_INVALID_SIMULATION"
	SwapExecutionUnsupportedExecution  SwapExecutionErrorCode = SwapExecutionUnsupported

	// The prefixed spellings are convenient when code shares identifiers with
	// the other SDK languages or a wire-level error map.
	SWAP_EXECUTION_INVALID_ARGUMENT = SwapExecutionInvalidArgument
	SWAP_UNSUPPORTED_EXECUTION      = SwapExecutionUnsupported
	SWAP_EXECUTION_PROGRAM_MISMATCH = SwapExecutionProgramMismatch
	SWAP_INSUFFICIENT_ALLOWANCE     = SwapExecutionInsufficientAllowance
	SWAP_SIMULATION_REVERTED        = SwapExecutionSimulationReverted
	SWAP_INVALID_SIMULATION         = SwapExecutionInvalidSimulation
)

var swapExecutionMessages = map[SwapExecutionErrorCode]string{
	SwapExecutionInvalidArgument:       "Swap execution request is invalid",
	SwapExecutionUnsupported:           "Swap execution is unsupported for the selected records",
	SwapExecutionProgramMismatch:       "Swap program does not match the selected records",
	SwapExecutionInsufficientAllowance: "Swap allowance is insufficient",
	SwapExecutionSimulationReverted:    "Swap simulation reverted",
	SwapExecutionInvalidSimulation:     "Swap simulation result is invalid",
}

// SwapExecutionError is a deterministic local error produced by execution
// preflight or simulation validation. Quote-domain errors are returned as the
// existing *SwapQuoteError so callers retain their source-compatible type.
type SwapExecutionError struct {
	Code SwapExecutionErrorCode
}

func (e *SwapExecutionError) Error() string {
	if e == nil {
		return "erpc: swap execution failed"
	}
	if message, ok := swapExecutionMessages[e.Code]; ok {
		return message
	}
	return "Swap execution failed"
}

// SwapExecutionErrorMessage returns the fixed safe message for an execution
// code.
func SwapExecutionErrorMessage(code SwapExecutionErrorCode) string {
	return swapExecutionMessages[code]
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

// PrepareExactInputSwapRequest selects a reviewed ERC20-to-ERC20 execution
// capability and its caller-owned execution scalars. SlippageBps is kept as
// an interface so native fixture and JSON callers can be rejected at runtime
// for boolean or fractional values; integer Go values in the 0..9999 range
// are accepted.
type PrepareExactInputSwapRequest struct {
	ChainID                 string         `json:"chainId"`
	PoolDefinitionID        string         `json:"poolDefinitionId"`
	InputTokenDeploymentID  string         `json:"inputTokenDeploymentId"`
	OutputTokenDeploymentID string         `json:"outputTokenDeploymentId"`
	AmountIn                string         `json:"amountIn"`
	Freshness               *SwapFreshness `json:"freshness,omitempty"`
	Sender                  string         `json:"sender"`
	Recipient               string         `json:"recipient"`
	SlippageBps             any            `json:"slippageBps"`
	Deadline                string         `json:"deadline"`
}

// ExactInputSwapRequest is an alias for the execution request type.
type ExactInputSwapRequest = PrepareExactInputSwapRequest

// SwapPathEntry identifies one ERC20 token in the exact-input path.
type SwapPathEntry struct {
	TokenDeploymentID  string                  `json:"tokenDeploymentId"`
	Address            string                  `json:"address"`
	Standard           string                  `json:"standard"`
	RepresentationKind TokenRepresentationKind `json:"representationKind"`
}

// ExactInputSwapPathEntry is an alias for SwapPathEntry.
type ExactInputSwapPathEntry = SwapPathEntry

// EvmUnsignedTransaction is a chain-bound unsigned transaction envelope.
// It is intended for caller wallet conversion; the SDK never signs or sends
// this value.
type EvmUnsignedTransaction struct {
	Kind    string `json:"kind"`
	ChainID string `json:"chainId"`
	From    string `json:"from"`
	To      string `json:"to"`
	Data    string `json:"data"`
	Value   string `json:"value"`
}

// SwapAllowance describes the allowance required by a prepared swap. The
// caller controls any allowance transaction and policy.
type SwapAllowance struct {
	TokenDeploymentID string `json:"tokenDeploymentId"`
	TokenAddress      string `json:"tokenAddress"`
	Owner             string `json:"owner"`
	Spender           string `json:"spender"`
	RequiredAmount    string `json:"requiredAmount"`
}

// ExactInputSwapPreparation is an unsigned ERC20-to-ERC20 router
// preparation built from a fresh quote and reviewed execution capability.
type ExactInputSwapPreparation struct {
	PreparationKind           string                    `json:"preparationKind"`
	ExecutionCapabilityID     string                    `json:"executionCapabilityId"`
	ExecutionCapabilityDigest string                    `json:"executionCapabilityDigest"`
	Quote                     ExactInputQuoteResult     `json:"quote"`
	MinimumAmountOut          string                    `json:"minimumAmountOut"`
	SlippageBps               uint64                    `json:"slippageBps"`
	Deadline                  string                    `json:"deadline"`
	Recipient                 string                    `json:"recipient"`
	Path                      []ExactInputSwapPathEntry `json:"path"`
	Transaction               EvmUnsignedTransaction    `json:"transaction"`
	Allowance                 SwapAllowance             `json:"allowance"`
}

// PrepareExactInputSwapResult is an alias for the preparation result.
type PrepareExactInputSwapResult = ExactInputSwapPreparation

// SwapPreparation is an alias for callers preferring a shorter result name.
type SwapPreparation = ExactInputSwapPreparation

// ExactInputSwapSimulation is the result of a successful router simulation.
type ExactInputSwapSimulation struct {
	SimulationKind   string                    `json:"simulationKind"`
	Preparation      ExactInputSwapPreparation `json:"preparation"`
	Snapshot         EvmBlockSnapshot          `json:"snapshot"`
	CurrentAllowance string                    `json:"currentAllowance"`
	Amounts          []string                  `json:"amounts"`
	AmountOut        string                    `json:"amountOut"`
}

// SimulateExactInputSwapResult is an alias for the simulation result.
type SimulateExactInputSwapResult = ExactInputSwapSimulation

// SwapSimulation is an alias for callers preferring a shorter result name.
type SwapSimulation = ExactInputSwapSimulation

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

type normalizedExecutionRequest struct {
	normalized    normalizedSwapRequest
	sender        string
	recipient     string
	slippageBps   uint64
	deadline      string
	deadlineValue *big.Int
}

type swapExecutionCapability struct {
	SwapExecutionCapabilityID      string `json:"swapExecutionCapabilityId"`
	ChainID                        string `json:"chainId"`
	DexDeploymentID                string `json:"dexDeploymentId"`
	PoolDefinitionID               string `json:"poolDefinitionId"`
	FactoryAddress                 string `json:"factoryAddress"`
	RouterAddress                  string `json:"routerAddress"`
	RouterKind                     string `json:"routerKind"`
	AdapterKind                    string `json:"adapterKind"`
	Token0DeploymentID             string `json:"token0DeploymentId"`
	Token0Address                  string `json:"token0Address"`
	Token0Standard                 string `json:"token0Standard"`
	Token1DeploymentID             string `json:"token1DeploymentId"`
	Token1Address                  string `json:"token1Address"`
	Token1Standard                 string `json:"token1Standard"`
	WrappedNativeTokenDeploymentID string `json:"wrappedNativeTokenDeploymentId"`
	WrappedNativeTokenAddress      string `json:"wrappedNativeTokenAddress"`
	WrappedNativeFunctionSelector  string `json:"wrappedNativeFunctionSelector"`
	FunctionKind                   string `json:"functionKind"`
	FunctionSignature              string `json:"functionSignature"`
	FunctionSelector               string `json:"functionSelector"`
	Status                         string `json:"status"`
}

type preparedExecutionContext struct {
	normalized  normalizedExecutionRequest
	capability  swapExecutionCapability
	transport   *httpRPCTransport
	state       evmSwapState
	quote       ExactInputQuoteResult
	preparation ExactInputSwapPreparation
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
	factoryGetPairSelector      = "0xe6a43905"
	pairFactorySelector         = "0xc45a0155"
	pairToken0Selector          = "0x0dfe1681"
	pairToken1Selector          = "0xd21220a7"
	pairGetReservesSelector     = "0x0902f1ac"
	routerFactorySelector       = "0xc45a0155"
	routerGetAmountsOutSelector = "0xd06ca61f"
	erc20AllowanceSelector      = "0xdd62ed3e"
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

// PrepareExactInputSwap prepares unsigned ERC20-to-ERC20 router calldata from
// a fresh quote and the configured chain RPC. It never signs, broadcasts, or
// changes allowance state.
func (s *SwapClient) PrepareExactInputSwap(ctx context.Context, request PrepareExactInputSwapRequest) (ExactInputSwapPreparation, error) {
	execution, err := normalizeExecutionRequest(request, s.currentClockSeconds)
	if err != nil {
		return ExactInputSwapPreparation{}, err
	}
	capability, err := executionCapabilityFor(execution)
	if err != nil {
		return ExactInputSwapPreparation{}, err
	}
	transport, err := s.executionTransportFor(execution.normalized)
	if err != nil {
		return ExactInputSwapPreparation{}, err
	}
	prepared, err := s.prepareExecutionContext(ctx, execution, capability, transport)
	if err != nil {
		return ExactInputSwapPreparation{}, err
	}
	return prepared.preparation, nil
}

// SimulateExactInputSwap prepares and simulates an unsigned ERC20-to-ERC20
// router call through the configured chain RPC. A successful result means the
// final RPC call returned valid ABI amounts; it does not sign or send a
// transaction and does not imply wallet balance beyond the allowance check.
func (s *SwapClient) SimulateExactInputSwap(ctx context.Context, request PrepareExactInputSwapRequest) (ExactInputSwapSimulation, error) {
	execution, err := normalizeExecutionRequest(request, s.currentClockSeconds)
	if err != nil {
		return ExactInputSwapSimulation{}, err
	}
	capability, err := executionCapabilityFor(execution)
	if err != nil {
		return ExactInputSwapSimulation{}, err
	}
	transport, err := s.executionTransportFor(execution.normalized)
	if err != nil {
		return ExactInputSwapSimulation{}, err
	}
	prepared, err := s.prepareExecutionContext(ctx, execution, capability, transport)
	if err != nil {
		return ExactInputSwapSimulation{}, err
	}

	selector := map[string]any{"blockHash": prepared.state.initial.hash, "requireCanonical": true}
	allowanceData := erc20AllowanceSelector
	ownerWord, ok := encodeSwapAddressArgument(execution.sender)
	if !ok {
		return ExactInputSwapSimulation{}, executionDomainError(SwapExecutionInvalidArgument)
	}
	spenderWord, ok := encodeSwapAddressArgument(capability.RouterAddress)
	if !ok {
		return ExactInputSwapSimulation{}, executionDomainError(SwapExecutionInvalidSimulation)
	}
	allowanceData += ownerWord + spenderWord
	allowanceRaw, err := s.rpcRaw(ctx, transport, "eth_call", []any{
		map[string]string{"to": prepared.preparation.allowanceTokenAddress(), "data": allowanceData},
		selector,
	})
	if err != nil {
		return ExactInputSwapSimulation{}, err
	}
	currentAllowance, err := parseExecutionUintWord(allowanceRaw, SwapExecutionInsufficientAllowance)
	if err != nil {
		return ExactInputSwapSimulation{}, err
	}
	if currentAllowance.Cmp(execution.normalized.amountIn) < 0 {
		return ExactInputSwapSimulation{}, executionDomainError(SwapExecutionInsufficientAllowance)
	}

	simulationRaw, err := s.rpcRaw(ctx, transport, "eth_call", []any{
		map[string]string{
			"from":  prepared.preparation.Transaction.From,
			"to":    prepared.preparation.Transaction.To,
			"data":  prepared.preparation.Transaction.Data,
			"value": "0x0",
		},
		selector,
	})
	if err != nil {
		if isRecognizedExecutionRevert(err) {
			return ExactInputSwapSimulation{}, executionDomainError(SwapExecutionSimulationReverted)
		}
		return ExactInputSwapSimulation{}, err
	}

	latestRaw, err := s.rpcRaw(ctx, transport, "eth_getBlockByNumber", []any{"latest", false})
	if err != nil {
		return ExactInputSwapSimulation{}, err
	}
	latest, err := parseSwapHeader(latestRaw)
	if err != nil {
		return ExactInputSwapSimulation{}, err
	}
	if err := s.assertFreshness(evmSwapState{initial: prepared.state.initial, latestAfterReads: latest}, execution.normalized.freshness); err != nil {
		return ExactInputSwapSimulation{}, err
	}

	amounts, err := parseExecutionUintArrayOfTwo(simulationRaw)
	if err != nil {
		return ExactInputSwapSimulation{}, err
	}
	quoteAmountOut, err := parseSwapDecimalQuantity(&prepared.quote.AmountOut, SwapQuoteArithmetic)
	if err != nil {
		return ExactInputSwapSimulation{}, err
	}
	minimumAmountOut, err := parseSwapDecimalQuantity(&prepared.preparation.MinimumAmountOut, SwapQuoteArithmetic)
	if err != nil {
		return ExactInputSwapSimulation{}, err
	}
	if amounts[0].Cmp(execution.normalized.amountIn) != 0 || amounts[1].Cmp(quoteAmountOut) != 0 || amounts[1].Cmp(minimumAmountOut) < 0 {
		return ExactInputSwapSimulation{}, executionDomainError(SwapExecutionInvalidSimulation)
	}
	if err := assertExecutionDeadline(execution, prepared.state.initial.timestamp, big.NewInt(s.currentClockSeconds())); err != nil {
		return ExactInputSwapSimulation{}, err
	}
	return ExactInputSwapSimulation{
		SimulationKind:   "evm-call",
		Preparation:      prepared.preparation,
		Snapshot:         prepared.quote.Snapshot,
		CurrentAllowance: currentAllowance.String(),
		Amounts:          []string{amounts[0].String(), amounts[1].String()},
		AmountOut:        amounts[1].String(),
	}, nil
}

// allowanceTokenAddress returns the input token address already captured in a
// preparation. Keeping this small helper beside the execution code avoids
// reconstructing a caller request after the first RPC.
func (p ExactInputSwapPreparation) allowanceTokenAddress() string {
	return p.Allowance.TokenAddress
}

func executionDomainError(code SwapExecutionErrorCode) error {
	return &SwapExecutionError{Code: code}
}

func normalizeExecutionRequest(request PrepareExactInputSwapRequest, clock func() int64) (normalizedExecutionRequest, error) {
	sender, err := normalizeExecutionAddress(request.Sender)
	if err != nil {
		return normalizedExecutionRequest{}, err
	}
	recipient, err := normalizeExecutionAddress(request.Recipient)
	if err != nil {
		return normalizedExecutionRequest{}, err
	}
	slippageBps, err := normalizeExecutionSlippage(request.SlippageBps)
	if err != nil {
		return normalizedExecutionRequest{}, err
	}
	deadline, deadlineValue, err := parseExecutionDeadline(request.Deadline)
	if err != nil {
		return normalizedExecutionRequest{}, err
	}
	if deadlineValue.Cmp(big.NewInt(clock())) <= 0 {
		return normalizedExecutionRequest{}, executionDomainError(SwapExecutionInvalidArgument)
	}

	// Copy the one nested request value before quote normalization. The
	// normalized quote retains only scalar freshness bounds, so mutations made
	// while RPC is in flight cannot affect validation or freshness policy.
	var freshness *SwapFreshness
	if request.Freshness != nil {
		copyValue := *request.Freshness
		if request.Freshness.MaxBlockAgeSeconds != nil {
			value := *request.Freshness.MaxBlockAgeSeconds
			copyValue.MaxBlockAgeSeconds = &value
		}
		if request.Freshness.MaxBlockLag != nil {
			value := *request.Freshness.MaxBlockLag
			copyValue.MaxBlockLag = &value
		}
		if request.Freshness.MaxClockSkewSeconds != nil {
			value := *request.Freshness.MaxClockSkewSeconds
			copyValue.MaxClockSkewSeconds = &value
		}
		freshness = &copyValue
	}
	quoteRequest := ExactInputQuoteRequest{
		ChainID:                 request.ChainID,
		PoolDefinitionID:        request.PoolDefinitionID,
		InputTokenDeploymentID:  request.InputTokenDeploymentID,
		OutputTokenDeploymentID: request.OutputTokenDeploymentID,
		AmountIn:                request.AmountIn,
		Freshness:               freshness,
	}
	normalized, err := normalizeSwapRequest(quoteRequest)
	if err != nil {
		var quoteErr *SwapQuoteError
		if errors.As(err, &quoteErr) {
			switch quoteErr.Code {
			case SwapQuoteUnknownPool, SwapQuoteUnsupportedAdapter, SwapQuoteUnsupportedToken, SwapQuoteUnsupportedStandard:
				return normalizedExecutionRequest{}, executionDomainError(SwapExecutionUnsupported)
			}
		}
		return normalizedExecutionRequest{}, err
	}
	return normalizedExecutionRequest{
		normalized:    normalized,
		sender:        sender,
		recipient:     recipient,
		slippageBps:   slippageBps,
		deadline:      deadline,
		deadlineValue: deadlineValue,
	}, nil
}

func normalizeExecutionAddress(value string) (string, error) {
	if !evmAddressPattern.MatchString(value) {
		return "", executionDomainError(SwapExecutionInvalidArgument)
	}
	normalized := strings.ToLower(value)
	if normalized == "0x"+strings.Repeat("0", 40) {
		return "", executionDomainError(SwapExecutionInvalidArgument)
	}
	return normalized, nil
}

func normalizeExecutionSlippage(value any) (uint64, error) {
	invalid := func() (uint64, error) {
		return 0, executionDomainError(SwapExecutionInvalidArgument)
	}
	acceptSigned := func(value int64) (uint64, error) {
		if value < 0 || value > 9999 {
			return invalid()
		}
		return uint64(value), nil
	}
	acceptUnsigned := func(value uint64) (uint64, error) {
		if value > 9999 {
			return invalid()
		}
		return value, nil
	}
	switch typed := value.(type) {
	case int:
		return acceptSigned(int64(typed))
	case int8:
		return acceptSigned(int64(typed))
	case int16:
		return acceptSigned(int64(typed))
	case int32:
		return acceptSigned(int64(typed))
	case int64:
		return acceptSigned(typed)
	case uint:
		return acceptUnsigned(uint64(typed))
	case uint8:
		return acceptUnsigned(uint64(typed))
	case uint16:
		return acceptUnsigned(uint64(typed))
	case uint32:
		return acceptUnsigned(uint64(typed))
	case uint64:
		return acceptUnsigned(typed)
	case float32:
		converted := float64(typed)
		if math.IsNaN(converted) || math.IsInf(converted, 0) || math.Trunc(converted) != converted || converted < 0 || converted > 9999 {
			return invalid()
		}
		return uint64(converted), nil
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) || math.Trunc(typed) != typed || typed < 0 || typed > 9999 {
			return invalid()
		}
		return uint64(typed), nil
	case json.Number:
		parsed, parseErr := typed.Float64()
		if parseErr != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || math.Trunc(parsed) != parsed || parsed < 0 || parsed > 9999 {
			return invalid()
		}
		return uint64(parsed), nil
	default:
		return invalid()
	}
}

func parseExecutionDeadline(value string) (string, *big.Int, error) {
	if len(value) > 78 || !uint256DecimalPattern.MatchString(value) {
		return "", nil, executionDomainError(SwapExecutionInvalidArgument)
	}
	parsed, ok := new(big.Int).SetString(value, 10)
	if !ok || parsed.Sign() <= 0 || !fitsSwapUint256(parsed) {
		return "", nil, executionDomainError(SwapExecutionInvalidArgument)
	}
	return value, parsed, nil
}

func generatedSwapExecutionCapabilities() []swapExecutionCapability {
	var capabilities []swapExecutionCapability
	if err := json.Unmarshal([]byte(swapExecutionCapabilitiesJSON), &capabilities); err != nil {
		return nil
	}
	return capabilities
}

var swapExecutionCapabilities = generatedSwapExecutionCapabilities()

func executionCapabilityFor(normalized normalizedExecutionRequest) (swapExecutionCapability, error) {
	for _, capability := range swapExecutionCapabilities {
		if capability.PoolDefinitionID != normalized.normalized.poolDefinitionID {
			continue
		}
		if executionCapabilityMatches(capability, normalized) {
			return capability, nil
		}
		return swapExecutionCapability{}, executionDomainError(SwapExecutionUnsupported)
	}
	return swapExecutionCapability{}, executionDomainError(SwapExecutionUnsupported)
}

func executionCapabilityMatches(capability swapExecutionCapability, execution normalizedExecutionRequest) bool {
	normalized := execution.normalized
	if !matchesSupportedQuoteCapability(normalized.pool, normalized.dex, normalized.input, normalized.output) {
		return false
	}
	if capability.SwapExecutionCapabilityID == "" || capability.Status != "active" || capability.ChainID != normalized.pool.ChainID || capability.DexDeploymentID != normalized.pool.DexDeploymentID || capability.PoolDefinitionID != normalized.pool.PoolDefinitionID {
		return false
	}
	if capability.RouterKind != "uniswap-v2-router02" && capability.RouterKind != "joe-v1-router02" {
		return false
	}
	if capability.AdapterKind != supportedQuoteAdapter || capability.FunctionKind != "exact-input-erc20-to-erc20" || capability.FunctionSignature != swapExecutionFunctionSignature || capability.FunctionSelector != swapExecutionFunctionSelector {
		return false
	}
	if !isExecutionAddress(capability.FactoryAddress) || !isExecutionAddress(capability.RouterAddress) || !isExecutionAddress(capability.WrappedNativeTokenAddress) || !isExecutionSelector(capability.WrappedNativeFunctionSelector) || !isExecutionSelector(capability.FunctionSelector) {
		return false
	}
	if capability.FactoryAddress != normalized.dex.ProgramAddress || normalized.dex.AdapterKind != capability.AdapterKind || normalized.dex.Status != "active" || normalized.pool.Status != "active" || normalized.pool.Adapter.Kind != capability.AdapterKind {
		return false
	}
	if normalized.pool.Adapter.FeeNumerator == nil || *normalized.pool.Adapter.FeeNumerator != "3" || normalized.pool.Adapter.FeeDenominator == nil || *normalized.pool.Adapter.FeeDenominator != "1000" {
		return false
	}
	if normalized.pool.Token0DeploymentID != capability.Token0DeploymentID || normalized.pool.Token1DeploymentID != capability.Token1DeploymentID {
		return false
	}
	token0, ok0 := TokenDeploymentByID(capability.Token0DeploymentID)
	token1, ok1 := TokenDeploymentByID(capability.Token1DeploymentID)
	wrapped, okWrapped := TokenDeploymentByID(capability.WrappedNativeTokenDeploymentID)
	if !ok0 || !ok1 || !okWrapped || !executionCatalogTokenMatches(token0, capability.ChainID, capability.Token0DeploymentID, capability.Token0Address, capability.Token0Standard) || !executionCatalogTokenMatches(token1, capability.ChainID, capability.Token1DeploymentID, capability.Token1Address, capability.Token1Standard) {
		return false
	}
	if !executionCatalogTokenMatches(wrapped, capability.ChainID, capability.WrappedNativeTokenDeploymentID, capability.WrappedNativeTokenAddress, "erc20") {
		return false
	}
	if wrapped.Status != TokenStatusActive {
		return false
	}
	if !executionCatalogTokenMatches(normalized.input, capability.ChainID, normalized.input.DeploymentID, executionTokenAddressForCapability(normalized.input), "erc20") || !executionCatalogTokenMatches(normalized.output, capability.ChainID, normalized.output.DeploymentID, executionTokenAddressForCapability(normalized.output), "erc20") {
		return false
	}
	if !executionInputOutputMatch(normalized.input, capability) || !executionInputOutputMatch(normalized.output, capability) {
		return false
	}
	for _, definition := range NativeWrapDefinitions() {
		if definition.ChainID == capability.ChainID && definition.WrappedTokenDeploymentID == capability.WrappedNativeTokenDeploymentID {
			return definition.Status == "active"
		}
	}
	return false
}

func executionCatalogTokenMatches(token TokenDeployment, chainID, deploymentID, address, standard string) bool {
	return string(token.ChainID) == chainID && token.DeploymentID == deploymentID && token.Status == TokenStatusActive && token.Standard == TokenStandard(standard) && token.Address != nil && strings.EqualFold(*token.Address, address)
}

func executionTokenAddressForCapability(token TokenDeployment) string {
	if token.Address == nil {
		return ""
	}
	return strings.ToLower(*token.Address)
}

func executionInputOutputMatch(token TokenDeployment, capability swapExecutionCapability) bool {
	if token.Address == nil || token.Standard != TokenStandardERC20 || token.Status != TokenStatusActive || string(token.ChainID) != capability.ChainID {
		return false
	}
	return (token.DeploymentID == capability.Token0DeploymentID && strings.EqualFold(*token.Address, capability.Token0Address) && capability.Token0Standard == "erc20") || (token.DeploymentID == capability.Token1DeploymentID && strings.EqualFold(*token.Address, capability.Token1Address) && capability.Token1Standard == "erc20")
}

func isExecutionAddress(value string) bool {
	return evmAddressPattern.MatchString(value) && strings.ToLower(value) != "0x"+strings.Repeat("0", 40)
}

func isExecutionSelector(value string) bool {
	return len(value) == 10 && hexBytesPattern.MatchString(value)
}

func (s *SwapClient) executionTransportFor(normalized normalizedSwapRequest) (*httpRPCTransport, error) {
	ids := DexChainIDs()
	switch normalized.chainID {
	case ids["ethereum"]:
		return s.ethereum, nil
	case ids["avalancheC"]:
		return s.avalanche, nil
	default:
		return nil, executionDomainError(SwapExecutionUnsupported)
	}
}

func (s *SwapClient) prepareExecutionContext(ctx context.Context, execution normalizedExecutionRequest, capability swapExecutionCapability, transport *httpRPCTransport) (preparedExecutionContext, error) {
	state, err := s.readEVMState(ctx, transport, execution.normalized)
	if err != nil {
		return preparedExecutionContext{}, err
	}
	if err := s.assertFreshness(state, execution.normalized.freshness); err != nil {
		return preparedExecutionContext{}, err
	}
	amountOut, feeNumerator, feeDenominator, err := calculateSwapQuote(execution.normalized, state)
	if err != nil {
		return preparedExecutionContext{}, err
	}
	quote := ExactInputQuoteResult{
		QuoteKind:               "exact-input",
		ChainID:                 execution.normalized.chainID,
		PoolDefinitionID:        execution.normalized.poolDefinitionID,
		DexDeploymentID:         execution.normalized.pool.DexDeploymentID,
		AdapterKind:             execution.normalized.pool.Adapter.Kind,
		InputTokenDeploymentID:  execution.normalized.inputTokenDeploymentID,
		OutputTokenDeploymentID: execution.normalized.outputTokenDeploymentID,
		AmountIn:                execution.normalized.amountIn.String(),
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
	}
	if execution.deadlineValue.Cmp(state.initial.timestamp) <= 0 {
		return preparedExecutionContext{}, executionDomainError(SwapExecutionInvalidArgument)
	}
	inputAddress, err := executionTokenAddress(execution.normalized.input)
	if err != nil {
		return preparedExecutionContext{}, err
	}
	outputAddress, err := executionTokenAddress(execution.normalized.output)
	if err != nil {
		return preparedExecutionContext{}, err
	}
	selector := map[string]any{"blockHash": state.initial.hash, "requireCanonical": true}
	routerCodeRaw, err := s.rpcRaw(ctx, transport, "eth_getCode", []any{capability.RouterAddress, selector})
	if err != nil {
		return preparedExecutionContext{}, err
	}
	routerCode, err := parseExecutionHexBytes(routerCodeRaw, 0, SwapExecutionInvalidSimulation)
	if err != nil {
		return preparedExecutionContext{}, err
	}
	if len(routerCode) <= 2 {
		return preparedExecutionContext{}, executionDomainError(SwapExecutionInvalidSimulation)
	}
	routerFactoryRaw, err := s.rpcRaw(ctx, transport, "eth_call", []any{map[string]string{"to": capability.RouterAddress, "data": routerFactorySelector}, selector})
	if err != nil {
		return preparedExecutionContext{}, err
	}
	routerFactory, err := parseExecutionAddressWord(routerFactoryRaw, SwapExecutionInvalidSimulation)
	if err != nil {
		return preparedExecutionContext{}, err
	}
	if routerFactory != capability.FactoryAddress {
		return preparedExecutionContext{}, executionDomainError(SwapExecutionProgramMismatch)
	}
	wrappedNativeRaw, err := s.rpcRaw(ctx, transport, "eth_call", []any{map[string]string{"to": capability.RouterAddress, "data": capability.WrappedNativeFunctionSelector}, selector})
	if err != nil {
		return preparedExecutionContext{}, err
	}
	wrappedNative, err := parseExecutionAddressWord(wrappedNativeRaw, SwapExecutionInvalidSimulation)
	if err != nil {
		return preparedExecutionContext{}, err
	}
	if wrappedNative != capability.WrappedNativeTokenAddress {
		return preparedExecutionContext{}, executionDomainError(SwapExecutionProgramMismatch)
	}
	amountsOutRaw, err := s.rpcRaw(ctx, transport, "eth_call", []any{map[string]string{"to": capability.RouterAddress, "data": executionGetAmountsOutData(execution.normalized.amountIn, inputAddress, outputAddress)}, selector})
	if err != nil {
		return preparedExecutionContext{}, err
	}
	amountsOut, err := parseExecutionUintArrayOfTwo(amountsOutRaw)
	if err != nil {
		return preparedExecutionContext{}, err
	}
	quoteAmountOut, err := parseSwapDecimalQuantity(&quote.AmountOut, SwapQuoteArithmetic)
	if err != nil {
		return preparedExecutionContext{}, err
	}
	if amountsOut[0].Cmp(execution.normalized.amountIn) != 0 || amountsOut[1].Cmp(quoteAmountOut) != 0 {
		return preparedExecutionContext{}, executionDomainError(SwapExecutionInvalidSimulation)
	}
	latestRaw, err := s.rpcRaw(ctx, transport, "eth_getBlockByNumber", []any{"latest", false})
	if err != nil {
		return preparedExecutionContext{}, err
	}
	latest, err := parseSwapHeader(latestRaw)
	if err != nil {
		return preparedExecutionContext{}, err
	}
	if err := s.assertFreshness(evmSwapState{initial: state.initial, latestAfterReads: latest}, execution.normalized.freshness); err != nil {
		return preparedExecutionContext{}, err
	}
	preparation, err := buildExecutionPreparation(execution, capability, quote)
	if err != nil {
		return preparedExecutionContext{}, err
	}
	if err := assertExecutionDeadline(execution, state.initial.timestamp, big.NewInt(s.currentClockSeconds())); err != nil {
		return preparedExecutionContext{}, err
	}
	return preparedExecutionContext{normalized: execution, capability: capability, transport: transport, state: state, quote: quote, preparation: preparation}, nil
}

func executionTokenAddress(token TokenDeployment) (string, error) {
	if token.Address == nil || !evmAddressPattern.MatchString(*token.Address) {
		return "", executionDomainError(SwapExecutionInvalidSimulation)
	}
	return strings.ToLower(*token.Address), nil
}

func buildExecutionPreparation(execution normalizedExecutionRequest, capability swapExecutionCapability, quote ExactInputQuoteResult) (ExactInputSwapPreparation, error) {
	quoteAmountOut, err := parseSwapDecimalQuantity(&quote.AmountOut, SwapQuoteArithmetic)
	if err != nil {
		return ExactInputSwapPreparation{}, err
	}
	factor := new(big.Int).SetUint64(10000 - execution.slippageBps)
	product := new(big.Int).Mul(quoteAmountOut, factor)
	if !fitsSwapUint256(product) {
		return ExactInputSwapPreparation{}, swapDomainError(SwapQuoteArithmetic)
	}
	minimumAmountOut := new(big.Int).Quo(product, big.NewInt(10000))
	if minimumAmountOut.Sign() <= 0 {
		return ExactInputSwapPreparation{}, executionDomainError(SwapExecutionInvalidArgument)
	}
	inputAddress, err := executionTokenAddress(execution.normalized.input)
	if err != nil {
		return ExactInputSwapPreparation{}, err
	}
	outputAddress, err := executionTokenAddress(execution.normalized.output)
	if err != nil {
		return ExactInputSwapPreparation{}, err
	}
	data, ok := executionSwapData(execution.normalized.amountIn, minimumAmountOut, inputAddress, outputAddress, execution.recipient, execution.deadlineValue)
	if !ok {
		return ExactInputSwapPreparation{}, executionDomainError(SwapExecutionInvalidSimulation)
	}
	path := []ExactInputSwapPathEntry{
		{TokenDeploymentID: execution.normalized.input.DeploymentID, Address: inputAddress, Standard: "erc20", RepresentationKind: execution.normalized.input.RepresentationKind},
		{TokenDeploymentID: execution.normalized.output.DeploymentID, Address: outputAddress, Standard: "erc20", RepresentationKind: execution.normalized.output.RepresentationKind},
	}
	return ExactInputSwapPreparation{
		PreparationKind:           "evm-router-v2-exact-input",
		ExecutionCapabilityID:     capability.SwapExecutionCapabilityID,
		ExecutionCapabilityDigest: swapExecutionCapabilitiesContentDigest,
		Quote:                     quote,
		MinimumAmountOut:          minimumAmountOut.String(),
		SlippageBps:               execution.slippageBps,
		Deadline:                  execution.deadline,
		Recipient:                 execution.recipient,
		Path:                      path,
		Transaction: EvmUnsignedTransaction{
			Kind:    "evm-unsigned-transaction",
			ChainID: quote.ChainID,
			From:    execution.sender,
			To:      capability.RouterAddress,
			Data:    data,
			Value:   "0",
		},
		Allowance: SwapAllowance{
			TokenDeploymentID: execution.normalized.input.DeploymentID,
			TokenAddress:      inputAddress,
			Owner:             execution.sender,
			Spender:           capability.RouterAddress,
			RequiredAmount:    quote.AmountIn,
		},
	}, nil
}

func encodeExecutionUint256Word(value *big.Int) (string, bool) {
	if !fitsSwapUint256(value) {
		return "", false
	}
	digits := strings.ToLower(value.Text(16))
	if len(digits) > 64 {
		return "", false
	}
	return strings.Repeat("0", 64-len(digits)) + digits, true
}

func executionGetAmountsOutData(amountIn *big.Int, inputAddress, outputAddress string) string {
	amountWord, _ := encodeExecutionUint256Word(amountIn)
	offsetWord, _ := encodeExecutionUint256Word(big.NewInt(0x40))
	lengthWord, _ := encodeExecutionUint256Word(big.NewInt(2))
	inputWord, _ := encodeSwapAddressArgument(inputAddress)
	outputWord, _ := encodeSwapAddressArgument(outputAddress)
	return routerGetAmountsOutSelector + amountWord + offsetWord + lengthWord + inputWord + outputWord
}

func executionSwapData(amountIn, minimumAmountOut *big.Int, inputAddress, outputAddress, recipient string, deadline *big.Int) (string, bool) {
	amountWord, ok := encodeExecutionUint256Word(amountIn)
	if !ok {
		return "", false
	}
	minimumWord, ok := encodeExecutionUint256Word(minimumAmountOut)
	if !ok {
		return "", false
	}
	offsetWord, ok := encodeExecutionUint256Word(big.NewInt(0xa0))
	if !ok {
		return "", false
	}
	recipientWord, ok := encodeSwapAddressArgument(recipient)
	if !ok {
		return "", false
	}
	deadlineWord, ok := encodeExecutionUint256Word(deadline)
	if !ok {
		return "", false
	}
	lengthWord, ok := encodeExecutionUint256Word(big.NewInt(2))
	if !ok {
		return "", false
	}
	inputWord, ok := encodeSwapAddressArgument(inputAddress)
	if !ok {
		return "", false
	}
	outputWord, ok := encodeSwapAddressArgument(outputAddress)
	if !ok {
		return "", false
	}
	return swapExecutionFunctionSelector + amountWord + minimumWord + offsetWord + recipientWord + deadlineWord + lengthWord + inputWord + outputWord, true
}

func assertExecutionDeadline(execution normalizedExecutionRequest, quoteTimestamp, completionClock *big.Int) error {
	if execution.deadlineValue.Cmp(quoteTimestamp) <= 0 || execution.deadlineValue.Cmp(completionClock) <= 0 {
		return executionDomainError(SwapExecutionInvalidArgument)
	}
	return nil
}

func parseExecutionHexBytes(raw json.RawMessage, expectedBytes int, code SwapExecutionErrorCode) (string, error) {
	value, ok := rawString(raw)
	if !ok || !hexBytesPattern.MatchString(value) || (len(value)-2)%2 != 0 || (expectedBytes > 0 && len(value) != expectedBytes*2+2) {
		return "", executionDomainError(code)
	}
	return strings.ToLower(value), nil
}

func parseExecutionAddressWord(raw json.RawMessage, code SwapExecutionErrorCode) (string, error) {
	value, err := parseExecutionHexBytes(raw, 32, code)
	if err != nil {
		return "", err
	}
	word := value[2:]
	if !strings.HasPrefix(word, strings.Repeat("0", 24)) || !evmAddressPattern.MatchString("0x"+word[24:]) {
		return "", executionDomainError(code)
	}
	return "0x" + word[24:], nil
}

func parseExecutionUintWord(raw json.RawMessage, code SwapExecutionErrorCode) (*big.Int, error) {
	value, err := parseExecutionHexBytes(raw, 32, code)
	if err != nil {
		return nil, err
	}
	parsed, ok := new(big.Int).SetString(value[2:], 16)
	if !ok || !fitsSwapUint256(parsed) {
		return nil, executionDomainError(code)
	}
	return parsed, nil
}

func parseExecutionUintArrayOfTwo(raw json.RawMessage) ([2]*big.Int, error) {
	value, err := parseExecutionHexBytes(raw, 0, SwapExecutionInvalidSimulation)
	if err != nil {
		return [2]*big.Int{}, err
	}
	payload := value[2:]
	if len(payload) != 256 {
		return [2]*big.Int{}, executionDomainError(SwapExecutionInvalidSimulation)
	}
	offset, ok := new(big.Int).SetString(payload[:64], 16)
	if !ok || offset.Cmp(big.NewInt(0x20)) != 0 {
		return [2]*big.Int{}, executionDomainError(SwapExecutionInvalidSimulation)
	}
	length, ok := new(big.Int).SetString(payload[64:128], 16)
	if !ok || length.Cmp(big.NewInt(2)) != 0 {
		return [2]*big.Int{}, executionDomainError(SwapExecutionInvalidSimulation)
	}
	first, ok := new(big.Int).SetString(payload[128:192], 16)
	if !ok || !fitsSwapUint256(first) {
		return [2]*big.Int{}, executionDomainError(SwapExecutionInvalidSimulation)
	}
	second, ok := new(big.Int).SetString(payload[192:256], 16)
	if !ok || !fitsSwapUint256(second) {
		return [2]*big.Int{}, executionDomainError(SwapExecutionInvalidSimulation)
	}
	return [2]*big.Int{first, second}, nil
}

func isRecognizedExecutionRevert(err error) bool {
	var rpcErr *Error
	if !errors.As(err, &rpcErr) || rpcErr.Kind != ErrorRPC {
		return false
	}
	if rpcErr.Code != 3 && rpcErr.Code != -32000 && rpcErr.Code != -32015 && rpcErr.Code != -32603 {
		return false
	}
	message := strings.ToLower(rpcErr.Message)
	return strings.Contains(message, "execution reverted") || strings.Contains(message, "transaction reverted") || strings.Contains(message, "vm execution error") || message == "revert" || message == "reverted" || strings.HasPrefix(message, "revert ") || strings.HasPrefix(message, "revert:") || strings.HasPrefix(message, "reverted ") || strings.HasPrefix(message, "reverted:")
}
