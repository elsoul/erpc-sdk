package erpc

// This file contains the deliberately standalone Mayan Swift v2 bridge
// adapter.  It does not use the ERPC Client, its credentials, or any of its
// transports.  The adapter only returns provider-supplied unsigned data and
// indexed status; it never signs, submits, broadcasts, approves, or polls.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	bridgeDefaultBuilderEndpoint  = "https://tx-builder.mayan.finance"
	bridgeDefaultExplorerEndpoint = "https://explorer-api.mayan.finance/v3"
	bridgeDefaultTimeout          = 30 * time.Second
	bridgeDefaultQuoteValidity    = uint64(60)
	bridgeMaxResponseBytes        = 1024 * 1024
	bridgeMaxRawQuoteBytes        = 256 * 1024
	bridgeMaxJSONDepth            = 32
	bridgeMaxQuotes               = 16
	bridgeMaxSolanaWireBytes      = 1232

	bridgeEthereumChainID = TokenChainEthereumMainnet
	bridgeSolanaChainID   = TokenChainSolanaMainnet
	bridgeEthereumName    = "ethereum"
	bridgeSolanaName      = "solana"

	bridgeEthereumEURCDeployment   = "deployment-0011"
	bridgeSolanaEURCDeployment     = "deployment-0013"
	bridgeEthereumUSDCDeployment   = "deployment-0008"
	bridgeSolanaUSDCDeployment     = "deployment-0010"
	bridgeEthereumEURCAddress      = "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c"
	bridgeSolanaEURCAddress        = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr"
	bridgeEthereumUSDCAddress      = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
	bridgeSolanaUSDCAddress        = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	bridgeEthereumSwiftContract    = "0x40ffe85a28dc9993541449464d7529a922142960"
	bridgeSolanaSwiftProgram       = "mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny"
	bridgeEthereumForwarder        = "0x337685fdab40d39bd02028545a4ffa7d287cc3e2"
	bridgeSolanaJupiterV6          = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
	bridgeEthereumEURCForwarderSel = "0x30dedc57"
	bridgeEthereumUSDCForwarderSel = "0xe4269fc4"
	bridgeEthereumForwarderSel     = bridgeEthereumEURCForwarderSel
	bridgeMayanUSDCMint            = "A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM"
)

var bridgeBaseDependencies = []string{
	"mayan-hosted-quote-api",
	"mayan-hosted-transaction-builder",
	"mayan-hosted-source-swap-builder",
	"swift-auction-solvers",
	"relayers",
	"wormhole-guardian-messaging",
	"mayan-explorer-indexer",
}

var bridgeDirectUSDCDependencies = []string{
	"mayan-hosted-quote-api",
	"mayan-hosted-transaction-builder",
	"swift-auction-solvers",
	"relayers",
	"wormhole-guardian-messaging",
	"mayan-explorer-indexer",
}

// BridgeErrorCode is the stable machine-readable code for a bridge failure.
type BridgeErrorCode string

const (
	BridgeInvalidArgument         BridgeErrorCode = "BRIDGE_INVALID_ARGUMENT"
	BridgeUnsupportedRoute        BridgeErrorCode = "BRIDGE_UNSUPPORTED_ROUTE"
	BridgeProviderAuthRequired    BridgeErrorCode = "BRIDGE_PROVIDER_AUTH_REQUIRED"
	BridgeProviderTransport       BridgeErrorCode = "BRIDGE_PROVIDER_TRANSPORT"
	BridgeProviderHTTP            BridgeErrorCode = "BRIDGE_PROVIDER_HTTP"
	BridgeProviderInvalidResponse BridgeErrorCode = "BRIDGE_PROVIDER_INVALID_RESPONSE"
	BridgeQuoteUnavailable        BridgeErrorCode = "BRIDGE_QUOTE_UNAVAILABLE"
	BridgeQuoteExpired            BridgeErrorCode = "BRIDGE_QUOTE_EXPIRED"
	BridgeQuoteMismatch           BridgeErrorCode = "BRIDGE_QUOTE_MISMATCH"
	BridgeBuildInvalid            BridgeErrorCode = "BRIDGE_BUILD_INVALID"
	BridgeStatusNotFound          BridgeErrorCode = "BRIDGE_STATUS_NOT_FOUND"
	BridgeTimeout                 BridgeErrorCode = "BRIDGE_TIMEOUT"
	BridgeAborted                 BridgeErrorCode = "BRIDGE_ABORTED"

	// Wire-style aliases are useful when applications share error maps with
	// the other SDKs.
	BRIDGE_INVALID_ARGUMENT          = BridgeInvalidArgument
	BRIDGE_UNSUPPORTED_ROUTE         = BridgeUnsupportedRoute
	BRIDGE_PROVIDER_AUTH_REQUIRED    = BridgeProviderAuthRequired
	BRIDGE_PROVIDER_TRANSPORT        = BridgeProviderTransport
	BRIDGE_PROVIDER_HTTP             = BridgeProviderHTTP
	BRIDGE_PROVIDER_INVALID_RESPONSE = BridgeProviderInvalidResponse
	BRIDGE_QUOTE_UNAVAILABLE         = BridgeQuoteUnavailable
	BRIDGE_QUOTE_EXPIRED             = BridgeQuoteExpired
	BRIDGE_QUOTE_MISMATCH            = BridgeQuoteMismatch
	BRIDGE_BUILD_INVALID             = BridgeBuildInvalid
	BRIDGE_STATUS_NOT_FOUND          = BridgeStatusNotFound
	BRIDGE_TIMEOUT                   = BridgeTimeout
	BRIDGE_ABORTED                   = BridgeAborted
)

var bridgeErrorMessages = map[BridgeErrorCode]string{
	BridgeInvalidArgument:         "Bridge request is invalid",
	BridgeUnsupportedRoute:        "Bridge route is unsupported",
	BridgeProviderAuthRequired:    "Bridge provider authentication is required",
	BridgeProviderTransport:       "Bridge provider transport failed",
	BridgeProviderHTTP:            "Bridge provider HTTP request failed",
	BridgeProviderInvalidResponse: "Bridge provider response is invalid",
	BridgeQuoteUnavailable:        "Bridge quote is unavailable",
	BridgeQuoteExpired:            "Bridge quote is expired",
	BridgeQuoteMismatch:           "Bridge quote does not match the request",
	BridgeBuildInvalid:            "Bridge provider build is invalid",
	BridgeStatusNotFound:          "Bridge status was not found",
	BridgeTimeout:                 "Bridge provider request timed out",
	BridgeAborted:                 "Bridge provider request was aborted",
}

// BridgeError is a secret-free, stable bridge error.  Status is zero when no
// provider HTTP status is applicable; it is never included in Error() so the
// human message remains identical across SDKs.
type BridgeError struct {
	Code   BridgeErrorCode
	Status int
}

func (e *BridgeError) Error() string {
	if e == nil {
		return "Bridge provider request failed"
	}
	if message, ok := bridgeErrorMessages[e.Code]; ok {
		return message
	}
	return "Bridge provider request failed"
}

// BridgeErrorMessage returns the fixed public message for a bridge code.
func BridgeErrorMessage(code BridgeErrorCode) string { return bridgeErrorMessages[code] }

func bridgeError(code BridgeErrorCode) error { return &BridgeError{Code: code} }

func bridgeHTTPError(code BridgeErrorCode, status int) error {
	return &BridgeError{Code: code, Status: status}
}

// MayanSwiftV2BridgeConfig configures the standalone provider endpoints.
// Empty endpoints and timeout use the documented defaults.  BuilderAPIKey is
// sent only to POST /build and is never read from the environment.
type MayanSwiftV2BridgeConfig struct {
	BuilderEndpoint           string
	ExplorerEndpoint          string
	BuilderAPIKey             string
	AllowUnauthenticatedBuild bool
	// MinimumQuoteValiditySeconds is nil for the 60-second default.  A
	// non-nil pointer to zero explicitly disables the extra validity margin.
	MinimumQuoteValiditySeconds *uint64
	Timeout                     time.Duration
	HTTPClient                  *http.Client

	// These spelling aliases keep the public Go surface tolerant of callers
	// that use the non-initialism form.  They are otherwise equivalent.
	BuilderApiKey string
	HttpClient    *http.Client
}

func (c MayanSwiftV2BridgeConfig) String() string {
	key := ""
	if c.BuilderAPIKey != "" || c.BuilderApiKey != "" {
		key = "[REDACTED]"
	}
	client := ""
	if c.HTTPClient != nil || c.HttpClient != nil {
		client = "[configured]"
	}
	minimum := "<default>"
	if c.MinimumQuoteValiditySeconds != nil {
		minimum = strconv.FormatUint(*c.MinimumQuoteValiditySeconds, 10)
	}
	return fmt.Sprintf("MayanSwiftV2BridgeConfig{BuilderEndpoint:%q ExplorerEndpoint:%q BuilderAPIKey:%q AllowUnauthenticatedBuild:%t MinimumQuoteValiditySeconds:%q Timeout:%s HTTPClient:%q}",
		c.BuilderEndpoint, c.ExplorerEndpoint, key, c.AllowUnauthenticatedBuild,
		minimum, c.Timeout, client)
}

func (c MayanSwiftV2BridgeConfig) GoString() string { return c.String() }

type normalizedBridgeConfig struct {
	builderEndpoint  *url.URL
	explorerEndpoint *url.URL
	builderAPIKey    string
	allowBuild       bool
	quoteValidity    uint64
	timeout          time.Duration
	httpClient       *http.Client
}

// MayanSwiftV2QuoteRequest selects one of the four exact native EURC or USDC
// directions.
type MayanSwiftV2QuoteRequest struct {
	SourceChainID                string `json:"sourceChainId"`
	DestinationChainID           string `json:"destinationChainId"`
	SourceTokenDeploymentID      string `json:"sourceTokenDeploymentId"`
	DestinationTokenDeploymentID string `json:"destinationTokenDeploymentId"`
	AmountIn                     string `json:"amountIn"`
	SlippageBps                  uint64 `json:"slippageBps"`
}

// MayanSwiftV2SourceSwap describes the provider-selected source-side USDC
// conversion.  intermediateTokenStandard intentionally uses provider wire
// spelling ("erc20" or "spl"), while catalog records use "spl-token".
type MayanSwiftV2SourceSwap struct {
	Required                      bool   `json:"required"`
	InputTokenDeploymentID        string `json:"inputTokenDeploymentId"`
	IntermediateTokenDeploymentID string `json:"intermediateTokenDeploymentId"`
	IntermediateTokenAddress      string `json:"intermediateTokenAddress"`
	IntermediateTokenStandard     string `json:"intermediateTokenStandard"`
	IntermediateTokenDecimals     uint8  `json:"intermediateTokenDecimals"`
	ProviderMinimumAmount         string `json:"providerMinimumAmount"`
	// Direct USDC routes have no router. These pointers intentionally omit
	// omitempty so their JSON keys are emitted as explicit null values.
	RouterKind    *string `json:"routerKind"`
	RouterAddress *string `json:"routerAddress"`
}

// MayanSwiftV2Quote is the normalized provider-signed quote.  The signature
// is retained and disclosed, but is not cryptographically verified locally.
type MayanSwiftV2Quote struct {
	QuoteKind                    string                 `json:"quoteKind"`
	ProviderID                   string                 `json:"providerId"`
	SourceChainID                string                 `json:"sourceChainId"`
	DestinationChainID           string                 `json:"destinationChainId"`
	SourceTokenDeploymentID      string                 `json:"sourceTokenDeploymentId"`
	DestinationTokenDeploymentID string                 `json:"destinationTokenDeploymentId"`
	AmountIn                     string                 `json:"amountIn"`
	ExpectedAmountOut            string                 `json:"expectedAmountOut"`
	MinimumAmountOut             string                 `json:"minimumAmountOut"`
	MinimumReceived              string                 `json:"minimumReceived"`
	Deadline                     string                 `json:"deadline"`
	SlippageBps                  uint64                 `json:"slippageBps"`
	QuoteID                      string                 `json:"quoteId"`
	ProviderSignature            string                 `json:"providerSignature"`
	SourceSwap                   MayanSwiftV2SourceSwap `json:"sourceSwap"`
	Dependencies                 []string               `json:"dependencies"`
	QuoteVerification            string                 `json:"quoteVerification"`
	RawSignedQuoteJSON           string                 `json:"rawSignedQuoteJson"`
}

// MayanSwiftV2QuoteResult is the result of a quote call.
type MayanSwiftV2QuoteResult = []MayanSwiftV2Quote

// MayanSwiftV2UnsignedTransaction is a chain-bound unsigned transaction.
// EVM fields are populated for an Ethereum source and Solana fields for a
// Solana source.  The omitted fields are excluded from JSON output.
type MayanSwiftV2UnsignedTransaction struct {
	Kind              string `json:"kind"`
	ChainID           string `json:"chainId"`
	From              string `json:"from,omitempty"`
	To                string `json:"to,omitempty"`
	Data              string `json:"data,omitempty"`
	Value             string `json:"value,omitempty"`
	FeePayer          string `json:"feePayer,omitempty"`
	TransactionBase64 string `json:"transactionBase64,omitempty"`
}

// Aliases expose the two concrete transaction names used by the other SDKs.
type MayanEvmUnsignedTransaction = MayanSwiftV2UnsignedTransaction
type MayanSolanaUnsignedTransaction = MayanSwiftV2UnsignedTransaction

// MayanSwiftV2BuildValidation states exactly what this adapter checked.
type MayanSwiftV2BuildValidation struct {
	Level                               string `json:"level"`
	QuoteSignatureLocallyVerified       bool   `json:"quoteSignatureLocallyVerified"`
	TransactionSemanticsLocallyVerified bool   `json:"transactionSemanticsLocallyVerified"`
	SettlementLocallyVerified           bool   `json:"settlementLocallyVerified"`
}

// MayanSwiftV2Allowance identifies the caller-owned ERC20 allowance needed by
// an Ethereum-source build.  The adapter never creates or sends approval data.
type MayanSwiftV2Allowance struct {
	TokenDeploymentID string `json:"tokenDeploymentId"`
	TokenAddress      string `json:"tokenAddress"`
	Owner             string `json:"owner"`
	Spender           string `json:"spender"`
	RequiredAmount    string `json:"requiredAmount"`
}

// MayanSwiftV2Build is an unsigned, structurally checked provider build.
type MayanSwiftV2Build struct {
	BuildKind            string                          `json:"buildKind"`
	ProviderID           string                          `json:"providerId"`
	Quote                MayanSwiftV2Quote               `json:"quote"`
	SourceChainID        string                          `json:"sourceChainId"`
	DestinationChainID   string                          `json:"destinationChainId"`
	Transaction          MayanSwiftV2UnsignedTransaction `json:"transaction"`
	Allowance            *MayanSwiftV2Allowance          `json:"allowance"`
	Validation           MayanSwiftV2BuildValidation     `json:"validation"`
	RawProviderBuildJSON string                          `json:"rawProviderBuildJson"`
}

type MayanSwiftV2BuildResult = MayanSwiftV2Build

// MayanSwiftV2BuildRequest supplies caller addresses for a previously
// returned quote.
type MayanSwiftV2BuildRequest struct {
	Quote              MayanSwiftV2Quote `json:"quote"`
	SwapperAddress     string            `json:"swapperAddress"`
	DestinationAddress string            `json:"destinationAddress"`
	RefundAddress      *string           `json:"refundAddress,omitempty"`
}

type MayanSwiftV2BuildUnsignedRequest = MayanSwiftV2BuildRequest

// MayanSwiftV2StatusRequest identifies a source transaction for Explorer.
type MayanSwiftV2StatusRequest struct {
	SourceChainID         string `json:"sourceChainId"`
	SourceTransactionHash string `json:"sourceTransactionHash"`
}

// MayanSwiftV2Status is a read-only provider-indexed status.
type MayanSwiftV2Status struct {
	StatusKind            string  `json:"statusKind"`
	ProviderID            string  `json:"providerId"`
	SourceChainID         string  `json:"sourceChainId"`
	SourceTransactionHash string  `json:"sourceTransactionHash"`
	State                 string  `json:"state"`
	ProviderClientStatus  string  `json:"providerClientStatus"`
	ProviderStatus        *string `json:"providerStatus"`
	StatusVerification    string  `json:"statusVerification"`
	RawProviderStatusJSON string  `json:"rawProviderStatusJson"`
}

type MayanSwiftV2StatusResult = MayanSwiftV2Status
type BridgeClient = MayanSwiftV2BridgeClient

type bridgeDirection struct {
	asset                      string
	capabilityID               string
	sourceChainID              string
	destinationChainID         string
	sourceTokenDeployment      string
	destinationTokenDeployment string
	sourceTokenAddress         string
	destinationTokenAddress    string
	sourceTokenStandard        string
	destinationTokenStandard   string
	sourceTokenName            string
	destinationTokenName       string
	sourceName                 string
	destinationName            string
	sourceProviderChainID      int
	destinationProviderChainID int
	sourceWormholeChainID      int
	destinationWormholeChainID int
	sourceTokenMint            string
	destinationTokenMint       string
	sourceUSDCDeployment       string
	sourceUSDCAddress          string
	sourceUSDCStandard         string
	swiftContract              string
	forwarderFunctionSelector  string
	dependencies               []string
	sourceSwapRequired         bool
}

type bridgeCapabilityRecord struct {
	BridgeCapabilityID           string   `json:"bridgeCapabilityId"`
	ProviderID                   string   `json:"providerId"`
	CapabilityKind               string   `json:"capabilityKind"`
	SourceChainID                string   `json:"sourceChainId"`
	DestinationChainID           string   `json:"destinationChainId"`
	SourceTokenDeploymentID      string   `json:"sourceTokenDeploymentId"`
	DestinationTokenDeploymentID string   `json:"destinationTokenDeploymentId"`
	SourceTokenAddress           string   `json:"sourceTokenAddress"`
	DestinationTokenAddress      string   `json:"destinationTokenAddress"`
	SourceTokenStandard          string   `json:"sourceTokenStandard"`
	DestinationTokenStandard     string   `json:"destinationTokenStandard"`
	SourceTokenDecimals          int      `json:"sourceTokenDecimals"`
	DestinationTokenDecimals     int      `json:"destinationTokenDecimals"`
	SourceProviderChainName      string   `json:"sourceProviderChainName"`
	DestinationProviderChainName string   `json:"destinationProviderChainName"`
	SourceProviderChainID        int      `json:"sourceProviderChainId"`
	DestinationProviderChainID   int      `json:"destinationProviderChainId"`
	SourceWormholeChainID        int      `json:"sourceWormholeChainId"`
	DestinationWormholeChainID   int      `json:"destinationWormholeChainId"`
	SourceUsdcDeploymentID       string   `json:"sourceUsdcDeploymentId"`
	SourceUsdcAddress            string   `json:"sourceUsdcAddress"`
	SourceUsdcStandard           string   `json:"sourceUsdcStandard"`
	SourceUsdcDecimals           int      `json:"sourceUsdcDecimals"`
	SwiftContract                string   `json:"swiftContract"`
	ForwarderAddress             *string  `json:"forwarderAddress"`
	ForwarderFunctionSelector    *string  `json:"forwarderFunctionSelector"`
	JupiterProgramAddress        *string  `json:"jupiterProgramAddress"`
	BuilderEndpoint              string   `json:"builderEndpoint"`
	ExplorerEndpoint             string   `json:"explorerEndpoint"`
	Dependencies                 []string `json:"dependencies"`
	Status                       string   `json:"status"`
}

// bridgeDirectionFacts resolves the complete four-field route tuple.  A
// chain-only lookup is intentionally unavailable: Ethereum<->Solana has both
// EURC and USDC capabilities and must never select one arbitrarily.
func bridgeDirectionFacts(source, destination, sourceTokenDeployment, destinationTokenDeployment string) (bridgeDirection, error) {
	if source == bridgeEthereumChainID && destination == bridgeSolanaChainID {
		isEURC := sourceTokenDeployment == bridgeEthereumEURCDeployment && destinationTokenDeployment == bridgeSolanaEURCDeployment
		isUSDC := sourceTokenDeployment == bridgeEthereumUSDCDeployment && destinationTokenDeployment == bridgeSolanaUSDCDeployment
		if !isEURC && !isUSDC {
			return bridgeDirection{}, bridgeError(BridgeUnsupportedRoute)
		}
		asset := "eurc"
		capabilityID := "bridge-mayan-swift-v2-eurc-eth-sol"
		sourceAddress, destinationAddress := bridgeEthereumEURCAddress, bridgeSolanaEURCAddress
		sourceName, destinationName := "EuroC", "EuroC"
		sourceMint, destinationMint := "", bridgeSolanaEURCAddress
		selector := bridgeEthereumEURCForwarderSel
		dependencies := bridgeBaseDependencies
		sourceSwapRequired := true
		if isUSDC {
			asset = "usdc"
			capabilityID = "bridge-mayan-swift-v2-usdc-eth-sol"
			sourceAddress, destinationAddress = bridgeEthereumUSDCAddress, bridgeSolanaUSDCAddress
			sourceName, destinationName = "USD Coin", "USD Coin"
			sourceMint, destinationMint = bridgeMayanUSDCMint, bridgeSolanaUSDCAddress
			selector = bridgeEthereumUSDCForwarderSel
			dependencies = bridgeDirectUSDCDependencies
			sourceSwapRequired = false
		}
		return bridgeDirection{
			asset: asset, capabilityID: capabilityID, sourceChainID: source, destinationChainID: destination,
			sourceTokenDeployment: sourceTokenDeployment, destinationTokenDeployment: destinationTokenDeployment,
			sourceTokenAddress: sourceAddress, destinationTokenAddress: destinationAddress,
			sourceTokenStandard: "erc20", destinationTokenStandard: "spl-token",
			sourceName: bridgeEthereumName, destinationName: bridgeSolanaName,
			sourceTokenName: sourceName, destinationTokenName: destinationName,
			sourceProviderChainID: 1, destinationProviderChainID: 0,
			sourceWormholeChainID: 2, destinationWormholeChainID: 1,
			sourceTokenMint: sourceMint, destinationTokenMint: destinationMint,
			sourceUSDCDeployment: bridgeEthereumUSDCDeployment, sourceUSDCAddress: bridgeEthereumUSDCAddress,
			sourceUSDCStandard: "erc20", swiftContract: bridgeEthereumSwiftContract,
			forwarderFunctionSelector: selector, dependencies: append([]string(nil), dependencies...),
			sourceSwapRequired: sourceSwapRequired,
		}, nil
	}
	if source == bridgeSolanaChainID && destination == bridgeEthereumChainID {
		isEURC := sourceTokenDeployment == bridgeSolanaEURCDeployment && destinationTokenDeployment == bridgeEthereumEURCDeployment
		isUSDC := sourceTokenDeployment == bridgeSolanaUSDCDeployment && destinationTokenDeployment == bridgeEthereumUSDCDeployment
		if !isEURC && !isUSDC {
			return bridgeDirection{}, bridgeError(BridgeUnsupportedRoute)
		}
		asset := "eurc"
		capabilityID := "bridge-mayan-swift-v2-eurc-sol-eth"
		sourceAddress, destinationAddress := bridgeSolanaEURCAddress, bridgeEthereumEURCAddress
		sourceName, destinationName := "EuroC", "EuroC"
		sourceMint, destinationMint := bridgeSolanaEURCAddress, ""
		dependencies := append(append([]string(nil), bridgeBaseDependencies...), "jupiter-v6-source-swap")
		sourceSwapRequired := true
		if isUSDC {
			asset = "usdc"
			capabilityID = "bridge-mayan-swift-v2-usdc-sol-eth"
			sourceAddress, destinationAddress = bridgeSolanaUSDCAddress, bridgeEthereumUSDCAddress
			sourceName, destinationName = "USD Coin", "USD Coin"
			sourceMint, destinationMint = bridgeSolanaUSDCAddress, bridgeMayanUSDCMint
			dependencies = append([]string(nil), bridgeDirectUSDCDependencies...)
			sourceSwapRequired = false
		}
		return bridgeDirection{
			asset: asset, capabilityID: capabilityID, sourceChainID: source, destinationChainID: destination,
			sourceTokenDeployment: sourceTokenDeployment, destinationTokenDeployment: destinationTokenDeployment,
			sourceTokenAddress: sourceAddress, destinationTokenAddress: destinationAddress,
			sourceTokenStandard: "spl-token", destinationTokenStandard: "erc20",
			sourceName: bridgeSolanaName, destinationName: bridgeEthereumName,
			sourceTokenName: sourceName, destinationTokenName: destinationName,
			sourceProviderChainID: 0, destinationProviderChainID: 1,
			sourceWormholeChainID: 1, destinationWormholeChainID: 2,
			sourceTokenMint: sourceMint, destinationTokenMint: destinationMint,
			sourceUSDCDeployment: bridgeSolanaUSDCDeployment, sourceUSDCAddress: bridgeSolanaUSDCAddress,
			sourceUSDCStandard: "spl-token", swiftContract: bridgeSolanaSwiftProgram,
			forwarderFunctionSelector: "", dependencies: dependencies,
			sourceSwapRequired: sourceSwapRequired,
		}, nil
	}
	return bridgeDirection{}, bridgeError(BridgeUnsupportedRoute)
}

func bridgeOptionalString(value string) *string {
	copy := value
	return &copy
}

func expectedBridgeCapability(f bridgeDirection) bridgeCapabilityRecord {
	dependencies := append([]string(nil), f.dependencies...)
	var forwarder, selector, jupiter *string
	if f.sourceChainID == bridgeEthereumChainID {
		forwarder, selector = bridgeOptionalString(bridgeEthereumForwarder), bridgeOptionalString(f.forwarderFunctionSelector)
	} else if f.asset == "eurc" {
		jupiter = bridgeOptionalString(bridgeSolanaJupiterV6)
	}
	return bridgeCapabilityRecord{
		BridgeCapabilityID: f.capabilityID, ProviderID: "mayan-swift-v2", CapabilityKind: "external-provider-dynamic",
		SourceChainID: f.sourceChainID, DestinationChainID: f.destinationChainID,
		SourceTokenDeploymentID: f.sourceTokenDeployment, DestinationTokenDeploymentID: f.destinationTokenDeployment,
		SourceTokenAddress: f.sourceTokenAddress, DestinationTokenAddress: f.destinationTokenAddress,
		SourceTokenStandard: f.sourceTokenStandard, DestinationTokenStandard: f.destinationTokenStandard,
		SourceTokenDecimals: 6, DestinationTokenDecimals: 6,
		SourceProviderChainName: f.sourceName, DestinationProviderChainName: f.destinationName,
		SourceProviderChainID: f.sourceProviderChainID, DestinationProviderChainID: f.destinationProviderChainID,
		SourceWormholeChainID: f.sourceWormholeChainID, DestinationWormholeChainID: f.destinationWormholeChainID,
		SourceUsdcDeploymentID: f.sourceUSDCDeployment, SourceUsdcAddress: f.sourceUSDCAddress,
		SourceUsdcStandard: f.sourceUSDCStandard, SourceUsdcDecimals: 6,
		SwiftContract: f.swiftContract, ForwarderAddress: forwarder,
		ForwarderFunctionSelector: selector, JupiterProgramAddress: jupiter,
		BuilderEndpoint: bridgeDefaultBuilderEndpoint, ExplorerEndpoint: bridgeDefaultExplorerEndpoint,
		Dependencies: dependencies, Status: "active",
	}
}

func bridgeCapabilityFor(f bridgeDirection) (bridgeCapabilityRecord, error) {
	var records []bridgeCapabilityRecord
	if err := json.Unmarshal([]byte(bridgeCapabilitiesJSON), &records); err != nil {
		return bridgeCapabilityRecord{}, bridgeError(BridgeUnsupportedRoute)
	}
	for _, record := range records {
		if record.BridgeCapabilityID == f.capabilityID &&
			record.SourceChainID == f.sourceChainID && record.DestinationChainID == f.destinationChainID &&
			record.SourceTokenDeploymentID == f.sourceTokenDeployment && record.DestinationTokenDeploymentID == f.destinationTokenDeployment {
			return record, nil
		}
	}
	return bridgeCapabilityRecord{}, bridgeError(BridgeUnsupportedRoute)
}

func validateBridgeCapability(f bridgeDirection) error {
	capability, err := bridgeCapabilityFor(f)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(capability, expectedBridgeCapability(f)) {
		return bridgeError(BridgeUnsupportedRoute)
	}
	checkDeployment := func(id, chain, address, standard string) bool {
		deployment, ok := TokenDeploymentByID(id)
		if !ok || string(deployment.ChainID) != chain || deployment.Decimals != 6 || string(deployment.Standard) != standard || deployment.Status != TokenStatusActive || deployment.Address == nil {
			return false
		}
		if chain == bridgeEthereumChainID {
			return strings.EqualFold(*deployment.Address, address)
		}
		return *deployment.Address == address
	}
	if !checkDeployment(f.sourceTokenDeployment, f.sourceChainID, f.sourceTokenAddress, f.sourceTokenStandard) ||
		!checkDeployment(f.destinationTokenDeployment, f.destinationChainID, f.destinationTokenAddress, f.destinationTokenStandard) ||
		!checkDeployment(f.sourceUSDCDeployment, f.sourceChainID, f.sourceUSDCAddress, f.sourceUSDCStandard) {
		return bridgeError(BridgeUnsupportedRoute)
	}
	return nil
}

func validateBridgeQuoteRequest(request MayanSwiftV2QuoteRequest) (MayanSwiftV2QuoteRequest, bridgeDirection, error) {
	amount, err := normalizePositiveUint64(request.AmountIn, BridgeInvalidArgument)
	if err != nil {
		return MayanSwiftV2QuoteRequest{}, bridgeDirection{}, err
	}
	if request.SlippageBps > 500 {
		return MayanSwiftV2QuoteRequest{}, bridgeDirection{}, bridgeError(BridgeInvalidArgument)
	}
	facts, err := bridgeDirectionFacts(request.SourceChainID, request.DestinationChainID, request.SourceTokenDeploymentID, request.DestinationTokenDeploymentID)
	if err != nil {
		return MayanSwiftV2QuoteRequest{}, bridgeDirection{}, err
	}
	if err := validateBridgeCapability(facts); err != nil {
		return MayanSwiftV2QuoteRequest{}, bridgeDirection{}, err
	}
	request.AmountIn = amount
	return request, facts, nil
}

func normalizePositiveUint64(value string, code BridgeErrorCode) (string, error) {
	if value == "" || len(value) > 20 || (len(value) > 1 && value[0] == '0') {
		return "", bridgeError(code)
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return "", bridgeError(code)
		}
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil || parsed == 0 {
		return "", bridgeError(code)
	}
	return value, nil
}

func normalizeCanonicalUint64(value string, code BridgeErrorCode) (string, uint64, error) {
	if value == "" || len(value) > 20 || (len(value) > 1 && value[0] == '0') {
		return "", 0, bridgeError(code)
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return "", 0, bridgeError(code)
		}
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return "", 0, bridgeError(code)
	}
	return value, parsed, nil
}

func isEVMAddress(value string) bool {
	if len(value) != 42 || value[0] != '0' || value[1] != 'x' {
		return false
	}
	for _, character := range value[2:] {
		if !bridgeIsHexDigit(byte(character)) {
			return false
		}
	}
	return true
}

func bridgeIsZeroEVMAddress(value string) bool {
	if !isEVMAddress(value) {
		return false
	}
	for _, character := range value[2:] {
		if character != '0' {
			return false
		}
	}
	return true
}

func normalizeEVMAddress(value string, code BridgeErrorCode) (string, error) {
	if !isEVMAddress(value) || bridgeIsZeroEVMAddress(value) {
		return "", bridgeError(code)
	}
	return "0x" + strings.ToLower(value[2:]), nil
}

func bridgeIsHexDigit(value byte) bool {
	return value >= '0' && value <= '9' || value >= 'a' && value <= 'f' || value >= 'A' && value <= 'F'
}

func providerAddressEquals(value, expected string) bool {
	if isEVMAddress(value) {
		return strings.EqualFold(value, expected)
	}
	return value == expected
}

func providerWireStandard(f bridgeDirection) string {
	if f.sourceChainID == bridgeEthereumChainID {
		return "erc20"
	}
	return "spl"
}

// jsonNode retains parsed values, byte offsets, and original number lexemes.
type bridgeJSONNode struct {
	value         any
	start         int
	end           int
	objectEntries map[string]*bridgeJSONNode
	arrayItems    []*bridgeJSONNode
	rawNumber     string
}

type bridgeJSONParser struct {
	source string
	index  int
}

func parseBridgeJSON(source string) (*bridgeJSONNode, error) {
	if !utf8.ValidString(source) {
		return nil, bridgeError(BridgeProviderInvalidResponse)
	}
	parser := bridgeJSONParser{source: source}
	parser.skipWhitespace()
	root, err := parser.value(0)
	if err != nil {
		return nil, err
	}
	parser.skipWhitespace()
	if parser.index != len(source) {
		return nil, bridgeError(BridgeProviderInvalidResponse)
	}
	return root, nil
}

func (p *bridgeJSONParser) invalid() (*bridgeJSONNode, error) {
	return nil, bridgeError(BridgeProviderInvalidResponse)
}

func (p *bridgeJSONParser) value(depth int) (*bridgeJSONNode, error) {
	if depth > bridgeMaxJSONDepth || p.index >= len(p.source) {
		return p.invalid()
	}
	start := p.index
	switch p.source[p.index] {
	case '{':
		return p.object(start, depth)
	case '[':
		return p.array(start, depth)
	case '"':
		value, err := p.string()
		if err != nil {
			return nil, err
		}
		return &bridgeJSONNode{value: value, start: start, end: p.index}, nil
	case 't':
		if strings.HasPrefix(p.source[p.index:], "true") {
			p.index += 4
			return &bridgeJSONNode{value: true, start: start, end: p.index}, nil
		}
	case 'f':
		if strings.HasPrefix(p.source[p.index:], "false") {
			p.index += 5
			return &bridgeJSONNode{value: false, start: start, end: p.index}, nil
		}
	case 'n':
		if strings.HasPrefix(p.source[p.index:], "null") {
			p.index += 4
			return &bridgeJSONNode{value: nil, start: start, end: p.index}, nil
		}
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		raw, err := p.number()
		if err != nil {
			return nil, err
		}
		parsed, parseErr := strconv.ParseFloat(raw, 64)
		if parseErr != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return p.invalid()
		}
		return &bridgeJSONNode{value: json.Number(raw), rawNumber: raw, start: start, end: p.index}, nil
	}
	return p.invalid()
}

func (p *bridgeJSONParser) object(start, depth int) (*bridgeJSONNode, error) {
	p.index++
	p.skipWhitespace()
	entries := make(map[string]*bridgeJSONNode)
	if p.index < len(p.source) && p.source[p.index] == '}' {
		p.index++
		return &bridgeJSONNode{value: map[string]any{}, objectEntries: entries, start: start, end: p.index}, nil
	}
	for {
		if p.index >= len(p.source) || p.source[p.index] != '"' {
			return p.invalid()
		}
		key, err := p.string()
		if err != nil {
			return nil, err
		}
		if _, exists := entries[key]; exists {
			return p.invalid()
		}
		p.skipWhitespace()
		if p.index >= len(p.source) || p.source[p.index] != ':' {
			return p.invalid()
		}
		p.index++
		p.skipWhitespace()
		child, err := p.value(depth + 1)
		if err != nil {
			return nil, err
		}
		entries[key] = child
		p.skipWhitespace()
		if p.index >= len(p.source) {
			return p.invalid()
		}
		switch p.source[p.index] {
		case '}':
			p.index++
			value := make(map[string]any, len(entries))
			for name, item := range entries {
				value[name] = item.value
			}
			return &bridgeJSONNode{value: value, objectEntries: entries, start: start, end: p.index}, nil
		case ',':
			p.index++
			p.skipWhitespace()
		default:
			return p.invalid()
		}
	}
}

func (p *bridgeJSONParser) array(start, depth int) (*bridgeJSONNode, error) {
	p.index++
	p.skipWhitespace()
	items := make([]*bridgeJSONNode, 0)
	if p.index < len(p.source) && p.source[p.index] == ']' {
		p.index++
		return &bridgeJSONNode{value: []any{}, arrayItems: items, start: start, end: p.index}, nil
	}
	for {
		item, err := p.value(depth + 1)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
		p.skipWhitespace()
		if p.index >= len(p.source) {
			return p.invalid()
		}
		switch p.source[p.index] {
		case ']':
			p.index++
			values := make([]any, len(items))
			for i, item := range items {
				values[i] = item.value
			}
			return &bridgeJSONNode{value: values, arrayItems: items, start: start, end: p.index}, nil
		case ',':
			p.index++
			p.skipWhitespace()
		default:
			return p.invalid()
		}
	}
}

func (p *bridgeJSONParser) string() (string, error) {
	start := p.index
	p.index++
	for p.index < len(p.source) {
		character := p.source[p.index]
		switch character {
		case '"':
			p.index++
			var value string
			if err := json.Unmarshal([]byte(p.source[start:p.index]), &value); err != nil {
				return "", bridgeError(BridgeProviderInvalidResponse)
			}
			return value, nil
		case '\\':
			p.index++
			if p.index >= len(p.source) {
				return "", bridgeError(BridgeProviderInvalidResponse)
			}
			if p.source[p.index] == 'u' {
				if p.index+4 >= len(p.source) {
					return "", bridgeError(BridgeProviderInvalidResponse)
				}
				for i := p.index + 1; i <= p.index+4; i++ {
					if !bridgeIsHexDigit(p.source[i]) {
						return "", bridgeError(BridgeProviderInvalidResponse)
					}
				}
				p.index += 5
				continue
			}
			if !strings.ContainsRune("\"\\/bfnrt", rune(p.source[p.index])) {
				return "", bridgeError(BridgeProviderInvalidResponse)
			}
			p.index++
		default:
			if character < 0x20 {
				return "", bridgeError(BridgeProviderInvalidResponse)
			}
			p.index++
		}
	}
	return "", bridgeError(BridgeProviderInvalidResponse)
}

func (p *bridgeJSONParser) number() (string, error) {
	start := p.index
	if p.source[p.index] == '-' {
		p.index++
		if p.index >= len(p.source) {
			return "", bridgeError(BridgeProviderInvalidResponse)
		}
	}
	if p.source[p.index] == '0' {
		p.index++
		if p.index < len(p.source) && p.source[p.index] >= '0' && p.source[p.index] <= '9' {
			return "", bridgeError(BridgeProviderInvalidResponse)
		}
	} else {
		if p.source[p.index] < '1' || p.source[p.index] > '9' {
			return "", bridgeError(BridgeProviderInvalidResponse)
		}
		for p.index < len(p.source) && p.source[p.index] >= '0' && p.source[p.index] <= '9' {
			p.index++
		}
	}
	if p.index < len(p.source) && p.source[p.index] == '.' {
		p.index++
		fractionStart := p.index
		for p.index < len(p.source) && p.source[p.index] >= '0' && p.source[p.index] <= '9' {
			p.index++
		}
		if p.index == fractionStart {
			return "", bridgeError(BridgeProviderInvalidResponse)
		}
	}
	if p.index < len(p.source) && (p.source[p.index] == 'e' || p.source[p.index] == 'E') {
		p.index++
		if p.index < len(p.source) && (p.source[p.index] == '+' || p.source[p.index] == '-') {
			p.index++
		}
		exponentStart := p.index
		for p.index < len(p.source) && p.source[p.index] >= '0' && p.source[p.index] <= '9' {
			p.index++
		}
		if p.index == exponentStart {
			return "", bridgeError(BridgeProviderInvalidResponse)
		}
	}
	return p.source[start:p.index], nil
}

func (p *bridgeJSONParser) skipWhitespace() {
	for p.index < len(p.source) {
		switch p.source[p.index] {
		case ' ', '\n', '\r', '\t':
			p.index++
		default:
			return
		}
	}
}

func bridgeObjectValue(node *bridgeJSONNode, key string) (any, bool) {
	if node == nil || node.objectEntries == nil {
		return nil, false
	}
	child, ok := node.objectEntries[key]
	if !ok {
		return nil, false
	}
	return child.value, true
}

func bridgeObjectNode(node *bridgeJSONNode, key string) (*bridgeJSONNode, bool) {
	if node == nil || node.objectEntries == nil {
		return nil, false
	}
	child, ok := node.objectEntries[key]
	return child, ok
}

func bridgeRequiredNode(node *bridgeJSONNode, key string) (*bridgeJSONNode, error) {
	child, ok := bridgeObjectNode(node, key)
	if !ok {
		return nil, bridgeError(BridgeProviderInvalidResponse)
	}
	return child, nil
}

func bridgeProviderString(node *bridgeJSONNode, key string, allowEmpty bool) (string, error) {
	child, err := bridgeRequiredNode(node, key)
	if err != nil {
		return "", err
	}
	value, ok := child.value.(string)
	if !ok || (!allowEmpty && value == "") {
		return "", bridgeError(BridgeProviderInvalidResponse)
	}
	return value, nil
}

func bridgeProviderBool(node *bridgeJSONNode, key string) (bool, error) {
	child, err := bridgeRequiredNode(node, key)
	if err != nil {
		return false, err
	}
	value, ok := child.value.(bool)
	if !ok {
		return false, bridgeError(BridgeProviderInvalidResponse)
	}
	return value, nil
}

func bridgeProviderNumber(node *bridgeJSONNode, key string) (float64, error) {
	child, err := bridgeRequiredNode(node, key)
	if err != nil {
		return 0, err
	}
	number, ok := child.value.(json.Number)
	if !ok {
		return 0, bridgeError(BridgeProviderInvalidResponse)
	}
	value, parseErr := strconv.ParseFloat(number.String(), 64)
	if parseErr != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, bridgeError(BridgeProviderInvalidResponse)
	}
	return value, nil
}

func bridgeProviderInteger(node *bridgeJSONNode, key string) (int64, error) {
	value, err := bridgeProviderNumber(node, key)
	const maxSafeInteger = float64(1<<53 - 1)
	if err != nil || math.Trunc(value) != value || value < math.MinInt64 || value > math.MaxInt64 || value < -maxSafeInteger || value > maxSafeInteger {
		return 0, bridgeError(BridgeProviderInvalidResponse)
	}
	return int64(value), nil
}

func bridgeProviderAddress(node *bridgeJSONNode, key, expected string) (string, error) {
	value, err := bridgeProviderString(node, key, false)
	if err != nil {
		return "", err
	}
	if !providerAddressEquals(value, expected) {
		return "", bridgeError(BridgeProviderInvalidResponse)
	}
	if isEVMAddress(value) {
		return strings.ToLower(value), nil
	}
	return value, nil
}

func bridgeProviderUint64(node *bridgeJSONNode, key string, positive bool) (string, uint64, error) {
	value, err := bridgeProviderString(node, key, false)
	if err != nil {
		return "", 0, err
	}
	if positive {
		value, err = normalizePositiveUint64(value, BridgeProviderInvalidResponse)
		if err != nil {
			return "", 0, err
		}
		parsed, parseErr := strconv.ParseUint(value, 10, 64)
		if parseErr != nil {
			return "", 0, bridgeError(BridgeProviderInvalidResponse)
		}
		return value, parsed, nil
	}
	return normalizeCanonicalUint64(value, BridgeProviderInvalidResponse)
}

func bridgeProviderToken(node *bridgeJSONNode, expectedAddress, expectedStandard string, expectedChainID, expectedWormholeID int, expectedMint, expectedName string) error {
	if node == nil || node.objectEntries == nil {
		return bridgeError(BridgeProviderInvalidResponse)
	}
	contract, err := bridgeProviderString(node, "contract", false)
	if err != nil || !providerAddressEquals(contract, expectedAddress) {
		return bridgeError(BridgeProviderInvalidResponse)
	}
	mint, err := bridgeProviderString(node, "mint", true)
	if err != nil || mint != expectedMint {
		return bridgeError(BridgeProviderInvalidResponse)
	}
	realOrigin, err := bridgeProviderString(node, "realOriginContractAddress", false)
	if err != nil || !providerAddressEquals(realOrigin, expectedAddress) {
		return bridgeError(BridgeProviderInvalidResponse)
	}
	name, err := bridgeProviderString(node, "name", false)
	if err != nil || name != expectedName {
		return bridgeError(BridgeProviderInvalidResponse)
	}
	standard, err := bridgeProviderString(node, "standard", false)
	if err != nil || standard != expectedStandard {
		return bridgeError(BridgeProviderInvalidResponse)
	}
	chainID, err := bridgeProviderInteger(node, "chainId")
	if err != nil || chainID != int64(expectedChainID) {
		return bridgeError(BridgeProviderInvalidResponse)
	}
	wormholeID, err := bridgeProviderInteger(node, "wChainId")
	if err != nil || wormholeID != int64(expectedWormholeID) {
		return bridgeError(BridgeProviderInvalidResponse)
	}
	realOriginID, err := bridgeProviderInteger(node, "realOriginChainId")
	if err != nil || realOriginID != int64(expectedWormholeID) {
		return bridgeError(BridgeProviderInvalidResponse)
	}
	decimals, err := bridgeProviderInteger(node, "decimals")
	if err != nil || decimals != 6 {
		return bridgeError(BridgeProviderInvalidResponse)
	}
	return nil
}

func bridgeQuoteDeadline(deadline uint64, margin uint64, clock func() int64) error {
	now := clock()
	if now < 0 {
		return bridgeError(BridgeQuoteExpired)
	}
	nowValue := uint64(now)
	if margin > ^uint64(0)-nowValue || deadline < nowValue+margin {
		return bridgeError(BridgeQuoteExpired)
	}
	return nil
}

type validatedBridgeProviderQuote struct {
	quote    MayanSwiftV2Quote
	deadline uint64
}

func validateProviderQuote(node *bridgeJSONNode, body string, request MayanSwiftV2QuoteRequest, facts bridgeDirection, config normalizedBridgeConfig, clock func() int64) (validatedBridgeProviderQuote, error) {
	if node == nil || node.objectEntries == nil {
		return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
	}
	raw := body[node.start:node.end]
	if len(raw) > bridgeMaxRawQuoteBytes {
		return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
	}
	typ, err := bridgeProviderString(node, "type", false)
	if err != nil || typ != "SWIFT" {
		return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
	}
	version, err := bridgeProviderString(node, "swiftVersion", false)
	if err != nil || version != "V2" {
		return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
	}
	gasless, err := bridgeProviderBool(node, "gasless")
	if err != nil || gasless {
		return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
	}
	fromChain, err := bridgeProviderString(node, "fromChain", false)
	if err != nil || fromChain != facts.sourceName {
		return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
	}
	toChain, err := bridgeProviderString(node, "toChain", false)
	if err != nil || toChain != facts.destinationName {
		return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
	}
	slippage, err := bridgeProviderInteger(node, "slippageBps")
	if err != nil || slippage < 0 || slippage > 500 || uint64(slippage) != request.SlippageBps {
		return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
	}
	onlyBridging, err := bridgeProviderBool(node, "onlyBridging")
	if err != nil || onlyBridging {
		return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
	}
	effective, _, err := bridgeProviderUint64(node, "effectiveAmountIn64", true)
	if err != nil || effective != request.AmountIn {
		return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
	}
	expected, expectedValue, err := bridgeProviderUint64(node, "expectedAmountOutBaseUnits", true)
	if err != nil {
		return validatedBridgeProviderQuote{}, err
	}
	minimum, minimumValue, err := bridgeProviderUint64(node, "minAmountOutBaseUnits", true)
	if err != nil {
		return validatedBridgeProviderQuote{}, err
	}
	received, receivedValue, err := bridgeProviderUint64(node, "minReceivedBaseUnits", true)
	if err != nil || minimumValue > expectedValue || receivedValue > minimumValue {
		if err != nil {
			return validatedBridgeProviderQuote{}, err
		}
		return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
	}
	deadlineText, deadlineValue, err := bridgeProviderUint64(node, "deadline64", true)
	if err != nil {
		return validatedBridgeProviderQuote{}, err
	}
	if err := bridgeQuoteDeadline(deadlineValue, config.quoteValidity, clock); err != nil {
		return validatedBridgeProviderQuote{}, err
	}
	fromToken, err := bridgeRequiredNode(node, "fromToken")
	if err != nil {
		return validatedBridgeProviderQuote{}, err
	}
	toToken, err := bridgeRequiredNode(node, "toToken")
	if err != nil {
		return validatedBridgeProviderQuote{}, err
	}
	if err := bridgeProviderToken(fromToken, facts.sourceTokenAddress, providerWireStandard(facts), facts.sourceProviderChainID, facts.sourceWormholeChainID, facts.sourceTokenMint, facts.sourceTokenName); err != nil {
		return validatedBridgeProviderQuote{}, err
	}
	destinationStandard := "erc20"
	if facts.destinationChainID == bridgeSolanaChainID {
		destinationStandard = "spl"
	}
	if err := bridgeProviderToken(toToken, facts.destinationTokenAddress, destinationStandard, facts.destinationProviderChainID, facts.destinationWormholeChainID, facts.destinationTokenMint, facts.destinationTokenName); err != nil {
		return validatedBridgeProviderQuote{}, err
	}
	if _, err := bridgeProviderAddress(node, "swiftInputContract", facts.sourceUSDCAddress); err != nil {
		return validatedBridgeProviderQuote{}, err
	}
	inputStandard, err := bridgeProviderString(node, "swiftInputContractStandard", false)
	if err != nil || inputStandard != providerWireStandard(facts) {
		return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
	}
	inputDecimals, err := bridgeProviderInteger(node, "swiftInputDecimals")
	if err != nil || inputDecimals != 6 {
		return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
	}
	if _, err := bridgeProviderAddress(node, "swiftMayanContract", facts.swiftContract); err != nil {
		return validatedBridgeProviderQuote{}, err
	}
	middle, err := bridgeRequiredNode(node, "minMiddleAmount")
	if err != nil {
		return validatedBridgeProviderQuote{}, err
	}
	middleNumber, ok := middle.value.(json.Number)
	if !ok || middle.rawNumber == "" {
		return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
	}
	middleValue, parseErr := strconv.ParseFloat(middleNumber.String(), 64)
	if parseErr != nil || math.IsNaN(middleValue) || math.IsInf(middleValue, 0) || middleValue <= 0 {
		return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
	}
	var routerAddress, routerKind *string
	if facts.asset == "usdc" {
		if value, present := bridgeObjectValue(node, "evmSwapRouterAddress"); present && value != nil {
			return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
		}
	} else if facts.sourceChainID == bridgeEthereumChainID {
		providerRouter, routerErr := bridgeProviderString(node, "evmSwapRouterAddress", false)
		if routerErr != nil {
			return validatedBridgeProviderQuote{}, routerErr
		}
		normalizedRouter, routerErr := normalizeEVMAddress(providerRouter, BridgeProviderInvalidResponse)
		if routerErr != nil {
			return validatedBridgeProviderQuote{}, routerErr
		}
		routerAddress = bridgeOptionalString(normalizedRouter)
		routerKind = bridgeOptionalString("provider-selected-evm")
	} else {
		routerAddress = bridgeOptionalString(bridgeSolanaJupiterV6)
		routerKind = bridgeOptionalString("jupiter-v6")
		if value, present := bridgeObjectValue(node, "evmSwapRouterAddress"); present && value != nil {
			return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
		}
	}
	quoteID, err := bridgeProviderString(node, "quoteId", false)
	if err != nil || !isHexSized(quoteID, 32) {
		return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
	}
	signature, err := bridgeProviderString(node, "signature", false)
	if err != nil || !isHexSized(signature, 130) {
		return validatedBridgeProviderQuote{}, bridgeError(BridgeProviderInvalidResponse)
	}
	dependencies := append([]string(nil), facts.dependencies...)
	return validatedBridgeProviderQuote{
		quote: MayanSwiftV2Quote{
			QuoteKind: "mayan-swift-v2", ProviderID: "mayan-swift-v2",
			SourceChainID: request.SourceChainID, DestinationChainID: request.DestinationChainID,
			SourceTokenDeploymentID: request.SourceTokenDeploymentID, DestinationTokenDeploymentID: request.DestinationTokenDeploymentID,
			AmountIn: effective, ExpectedAmountOut: expected, MinimumAmountOut: minimum, MinimumReceived: received,
			Deadline: deadlineText, SlippageBps: uint64(slippage), QuoteID: strings.ToLower(quoteID), ProviderSignature: strings.ToLower(signature),
			SourceSwap: MayanSwiftV2SourceSwap{
				Required: facts.sourceSwapRequired,
				InputTokenDeploymentID: func() string {
					if facts.asset == "usdc" {
						return facts.sourceUSDCDeployment
					}
					return facts.sourceTokenDeployment
				}(),
				IntermediateTokenDeploymentID: facts.sourceUSDCDeployment, IntermediateTokenAddress: facts.sourceUSDCAddress,
				IntermediateTokenStandard: providerWireStandard(facts), IntermediateTokenDecimals: 6,
				ProviderMinimumAmount: middle.rawNumber, RouterKind: routerKind, RouterAddress: routerAddress,
			},
			Dependencies: dependencies, QuoteVerification: "provider-signed-not-locally-verified", RawSignedQuoteJSON: raw,
		},
		deadline: deadlineValue,
	}, nil
}

func isHexSized(value string, hexDigits int) bool {
	if len(value) != 2+hexDigits || value[0] != '0' || value[1] != 'x' {
		return false
	}
	for i := 2; i < len(value); i++ {
		if !bridgeIsHexDigit(value[i]) {
			return false
		}
	}
	return true
}

func cloneBridgeQuote(quote MayanSwiftV2Quote) MayanSwiftV2Quote {
	quote.Dependencies = append([]string(nil), quote.Dependencies...)
	if quote.SourceSwap.RouterKind != nil {
		quote.SourceSwap.RouterKind = bridgeOptionalString(*quote.SourceSwap.RouterKind)
	}
	if quote.SourceSwap.RouterAddress != nil {
		quote.SourceSwap.RouterAddress = bridgeOptionalString(*quote.SourceSwap.RouterAddress)
	}
	return quote
}

func bridgeQuoteEqual(left, right MayanSwiftV2Quote) bool {
	return reflect.DeepEqual(left, right)
}

func validateNormalizedBridgeQuote(quote MayanSwiftV2Quote, code BridgeErrorCode) (MayanSwiftV2Quote, bridgeDirection, error) {
	if quote.QuoteKind != "mayan-swift-v2" || quote.ProviderID != "mayan-swift-v2" || quote.QuoteVerification != "provider-signed-not-locally-verified" {
		return MayanSwiftV2Quote{}, bridgeDirection{}, bridgeError(code)
	}
	facts, err := bridgeDirectionFacts(quote.SourceChainID, quote.DestinationChainID, quote.SourceTokenDeploymentID, quote.DestinationTokenDeploymentID)
	if err != nil {
		return MayanSwiftV2Quote{}, bridgeDirection{}, bridgeError(code)
	}
	amount, err := normalizePositiveUint64(quote.AmountIn, code)
	if err != nil {
		return MayanSwiftV2Quote{}, bridgeDirection{}, err
	}
	expected, err := normalizePositiveUint64(quote.ExpectedAmountOut, code)
	if err != nil {
		return MayanSwiftV2Quote{}, bridgeDirection{}, err
	}
	minimum, err := normalizePositiveUint64(quote.MinimumAmountOut, code)
	if err != nil {
		return MayanSwiftV2Quote{}, bridgeDirection{}, err
	}
	received, err := normalizePositiveUint64(quote.MinimumReceived, code)
	if err != nil {
		return MayanSwiftV2Quote{}, bridgeDirection{}, err
	}
	parseU64 := func(value string) uint64 { parsed, _ := strconv.ParseUint(value, 10, 64); return parsed }
	if parseU64(minimum) > parseU64(expected) || parseU64(received) > parseU64(minimum) || quote.SlippageBps > 500 || !isHexSized(quote.QuoteID, 32) || !isHexSized(quote.ProviderSignature, 130) {
		return MayanSwiftV2Quote{}, bridgeDirection{}, bridgeError(code)
	}
	deadline, err := normalizePositiveUint64(quote.Deadline, code)
	if err != nil {
		return MayanSwiftV2Quote{}, bridgeDirection{}, err
	}
	wantedInputDeployment := facts.sourceTokenDeployment
	if facts.asset == "usdc" {
		wantedInputDeployment = facts.sourceUSDCDeployment
	}
	if quote.SourceSwap.Required != facts.sourceSwapRequired || quote.SourceSwap.InputTokenDeploymentID != wantedInputDeployment || quote.SourceSwap.IntermediateTokenDeploymentID != facts.sourceUSDCDeployment || quote.SourceSwap.IntermediateTokenAddress != facts.sourceUSDCAddress || quote.SourceSwap.IntermediateTokenStandard != providerWireStandard(facts) || quote.SourceSwap.IntermediateTokenDecimals != 6 || quote.SourceSwap.ProviderMinimumAmount == "" {
		return MayanSwiftV2Quote{}, bridgeDirection{}, bridgeError(code)
	}
	normalized := cloneBridgeQuote(quote)
	normalized.AmountIn, normalized.ExpectedAmountOut, normalized.MinimumAmountOut, normalized.MinimumReceived, normalized.Deadline = amount, expected, minimum, received, deadline
	normalized.QuoteID, normalized.ProviderSignature = strings.ToLower(quote.QuoteID), strings.ToLower(quote.ProviderSignature)
	if facts.asset == "usdc" {
		if quote.SourceSwap.RouterKind != nil || quote.SourceSwap.RouterAddress != nil {
			return MayanSwiftV2Quote{}, bridgeDirection{}, bridgeError(code)
		}
	} else if facts.sourceChainID == bridgeEthereumChainID {
		if quote.SourceSwap.RouterKind == nil || *quote.SourceSwap.RouterKind != "provider-selected-evm" || quote.SourceSwap.RouterAddress == nil || !isEVMAddress(*quote.SourceSwap.RouterAddress) || bridgeIsZeroEVMAddress(*quote.SourceSwap.RouterAddress) {
			return MayanSwiftV2Quote{}, bridgeDirection{}, bridgeError(code)
		}
		normalized.SourceSwap.RouterAddress = bridgeOptionalString(strings.ToLower(*quote.SourceSwap.RouterAddress))
	} else if quote.SourceSwap.RouterKind == nil || *quote.SourceSwap.RouterKind != "jupiter-v6" || quote.SourceSwap.RouterAddress == nil || *quote.SourceSwap.RouterAddress != bridgeSolanaJupiterV6 {
		return MayanSwiftV2Quote{}, bridgeDirection{}, bridgeError(code)
	}
	wantedDependencies := append([]string(nil), facts.dependencies...)
	if !reflect.DeepEqual(quote.Dependencies, wantedDependencies) || len(quote.RawSignedQuoteJSON) > bridgeMaxRawQuoteBytes || quote.RawSignedQuoteJSON == "" {
		return MayanSwiftV2Quote{}, bridgeDirection{}, bridgeError(code)
	}
	if !bridgeQuoteEqual(quote, normalized) {
		return MayanSwiftV2Quote{}, bridgeDirection{}, bridgeError(code)
	}
	return normalized, facts, nil
}

func quoteRequestBody(request MayanSwiftV2QuoteRequest, facts bridgeDirection) string {
	return fmt.Sprintf("{\"fromToken\":%s,\"fromChain\":%s,\"toToken\":%s,\"toChain\":%s,\"amountIn64\":%s,\"slippageBps\":%d,\"swift\":true,\"mctp\":false,\"fastMctp\":false,\"wormhole\":false,\"monoChain\":false,\"gasless\":false,\"fullList\":true,\"guaranteedOutput\":true,\"gasDrop\":0}",
		strconv.Quote(facts.sourceTokenAddress), strconv.Quote(facts.sourceName), strconv.Quote(facts.destinationTokenAddress), strconv.Quote(facts.destinationName), strconv.Quote(request.AmountIn), request.SlippageBps)
}

func buildRequestBody(quote MayanSwiftV2Quote, sourceChain string, swapper, destination string, refund *string) string {
	params := fmt.Sprintf("{\"swapperAddress\":%s,\"destinationAddress\":%s", strconv.Quote(swapper), strconv.Quote(destination))
	if sourceChain == bridgeEthereumChainID {
		params += ",\"signerChainId\":1"
	}
	if refund != nil {
		params += ",\"swiftRefundAddress\":" + strconv.Quote(*refund)
	}
	params += "}"
	return "{\"quote\":" + quote.RawSignedQuoteJSON + ",\"params\":" + params + "}"
}

func normalizeProviderEndpoint(value, fallback string) (*url.URL, error) {
	source := value
	if source == "" {
		source = fallback
	}
	if strings.TrimSpace(source) != source || source == "" || strings.ContainsAny(source, "?#") || !strings.Contains(source, "://") {
		return nil, bridgeError(BridgeInvalidArgument)
	}
	parsed, err := url.Parse(source)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || strings.Contains(parsed.Host, "@") {
		return nil, bridgeError(BridgeInvalidArgument)
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return nil, bridgeError(BridgeInvalidArgument)
	}
	if err := validateAuthority(parsed.Host); err != nil {
		return nil, err
	}
	hostname := strings.ToLower(parsed.Hostname())
	if parsed.Scheme == "http" && hostname != "localhost" && hostname != "127.0.0.1" && hostname != "::1" {
		return nil, bridgeError(BridgeInvalidArgument)
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	parsed.RawPath = ""
	return parsed, nil
}

func validateAuthority(authority string) error {
	if authority == "" || strings.ContainsAny(authority, " \t\r\n") {
		return bridgeError(BridgeInvalidArgument)
	}
	if authority[0] == '[' {
		close := strings.IndexByte(authority, ']')
		if close <= 1 {
			return bridgeError(BridgeInvalidArgument)
		}
		rest := authority[close+1:]
		if rest != "" {
			if rest[0] != ':' || len(rest) == 1 || !allDigits(rest[1:]) {
				return bridgeError(BridgeInvalidArgument)
			}
			if err := validatePort(rest[1:]); err != nil {
				return err
			}
		}
		return nil
	}
	if strings.Count(authority, ":") > 1 {
		return bridgeError(BridgeInvalidArgument)
	}
	if colon := strings.LastIndexByte(authority, ':'); colon >= 0 {
		if colon == 0 || colon == len(authority)-1 || !allDigits(authority[colon+1:]) {
			return bridgeError(BridgeInvalidArgument)
		}
		return validatePort(authority[colon+1:])
	}
	return nil
}

func allDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func validatePort(value string) error {
	port, err := strconv.ParseUint(value, 10, 16)
	if err != nil || port > 65535 {
		return bridgeError(BridgeInvalidArgument)
	}
	return nil
}

func bridgeEndpointPath(base *url.URL, suffix string) *url.URL {
	copy := *base
	prefix := strings.TrimRight(copy.Path, "/")
	copy.Path = prefix + "/" + strings.TrimLeft(suffix, "/")
	copy.RawPath = ""
	copy.RawQuery = ""
	copy.Fragment = ""
	return &copy
}

func normalizeBridgeConfig(config MayanSwiftV2BridgeConfig) (normalizedBridgeConfig, error) {
	builder, err := normalizeProviderEndpoint(config.BuilderEndpoint, bridgeDefaultBuilderEndpoint)
	if err != nil {
		return normalizedBridgeConfig{}, err
	}
	explorer, err := normalizeProviderEndpoint(config.ExplorerEndpoint, bridgeDefaultExplorerEndpoint)
	if err != nil {
		return normalizedBridgeConfig{}, err
	}
	key := config.BuilderAPIKey
	if config.BuilderApiKey != "" {
		if key != "" && key != config.BuilderApiKey {
			return normalizedBridgeConfig{}, bridgeError(BridgeInvalidArgument)
		}
		key = config.BuilderApiKey
	}
	for _, character := range key {
		if character < 0x20 || character == 0x7f {
			return normalizedBridgeConfig{}, bridgeError(BridgeInvalidArgument)
		}
	}
	minimum := bridgeDefaultQuoteValidity
	if config.MinimumQuoteValiditySeconds != nil {
		minimum = *config.MinimumQuoteValiditySeconds
	}
	if minimum > 300 {
		return normalizedBridgeConfig{}, bridgeError(BridgeInvalidArgument)
	}
	timeout := config.Timeout
	if timeout == 0 {
		timeout = bridgeDefaultTimeout
	}
	if timeout <= 0 {
		return normalizedBridgeConfig{}, bridgeError(BridgeInvalidArgument)
	}
	baseClient := config.HTTPClient
	if config.HttpClient != nil {
		if baseClient != nil && baseClient != config.HttpClient {
			return normalizedBridgeConfig{}, bridgeError(BridgeInvalidArgument)
		}
		baseClient = config.HttpClient
	}
	if baseClient == nil {
		baseClient = http.DefaultClient
	}
	clientCopy := *baseClient
	clientCopy.Jar = nil
	clientCopy.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	// net/http's default transport adds Accept-Encoding: gzip.  Clone a
	// standard transport so that the provider trace contains only the contract
	// headers and the caller's transport remains untouched.
	transportValue := clientCopy.Transport
	if transportValue == nil {
		transportValue = http.DefaultTransport
	}
	if transport, ok := transportValue.(*http.Transport); ok && transport != nil {
		transportCopy := transport.Clone()
		transportCopy.DisableCompression = true
		clientCopy.Transport = transportCopy
	}
	return normalizedBridgeConfig{builderEndpoint: builder, explorerEndpoint: explorer, builderAPIKey: key, allowBuild: config.AllowUnauthenticatedBuild, quoteValidity: minimum, timeout: timeout, httpClient: &clientCopy}, nil
}

// MayanSwiftV2BridgeClient is an explicit opt-in provider adapter.  It is
// independent of Client and owns no caller HTTP resources.
type MayanSwiftV2BridgeClient struct {
	config normalizedBridgeConfig
	clock  func() int64
}

// NewMayanSwiftV2BridgeClient validates configuration without doing I/O.
func NewMayanSwiftV2BridgeClient(config MayanSwiftV2BridgeConfig) (*MayanSwiftV2BridgeClient, error) {
	normalized, err := normalizeBridgeConfig(config)
	if err != nil {
		return nil, err
	}
	return &MayanSwiftV2BridgeClient{config: normalized, clock: func() int64 { return time.Now().Unix() }}, nil
}

func (c *MayanSwiftV2BridgeClient) String() string {
	if c == nil {
		return "MayanSwiftV2BridgeClient{}"
	}
	return fmt.Sprintf("MayanSwiftV2BridgeClient{BuilderEndpoint:%q ExplorerEndpoint:%q}", c.config.builderEndpoint.String(), c.config.explorerEndpoint.String())
}

func (c *MayanSwiftV2BridgeClient) GoString() string { return c.String() }

// BuilderEndpoint returns the configured endpoint without credentials.
func (c *MayanSwiftV2BridgeClient) BuilderEndpoint() string {
	if c == nil || c.config.builderEndpoint == nil {
		return ""
	}
	return c.config.builderEndpoint.String()
}

// ExplorerEndpoint returns the configured endpoint without credentials.
func (c *MayanSwiftV2BridgeClient) ExplorerEndpoint() string {
	if c == nil || c.config.explorerEndpoint == nil {
		return ""
	}
	return c.config.explorerEndpoint.String()
}

// Close is idempotent.  The client never closes an externally owned HTTP
// client or its transport.
func (c *MayanSwiftV2BridgeClient) Close() error { return nil }

type bridgeOperation uint8

const (
	bridgeQuoteOperation bridgeOperation = iota
	bridgeBuildOperation
	bridgeStatusOperation
)

type bridgeProviderResponse struct {
	text string
	root *bridgeJSONNode
}

func (c *MayanSwiftV2BridgeClient) providerJSON(ctx context.Context, endpoint *url.URL, method, body string, includeKey bool, operation bridgeOperation) (bridgeProviderResponse, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return bridgeProviderResponse{}, bridgeError(BridgeAborted)
	}
	requestContext, cancel := context.WithTimeout(ctx, c.config.timeout)
	defer cancel()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request, err := http.NewRequestWithContext(requestContext, method, endpoint.String(), reader)
	if err != nil {
		return bridgeProviderResponse{}, bridgeError(BridgeProviderTransport)
	}
	request.Header.Set("Accept", "application/json")
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if includeKey && c.config.builderAPIKey != "" {
		request.Header.Set("X-API-Key", c.config.builderAPIKey)
	}
	response, err := c.config.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return bridgeProviderResponse{}, bridgeError(BridgeAborted)
		}
		if requestContext.Err() == context.DeadlineExceeded {
			return bridgeProviderResponse{}, bridgeError(BridgeTimeout)
		}
		if requestContext.Err() == context.Canceled {
			return bridgeProviderResponse{}, bridgeError(BridgeAborted)
		}
		return bridgeProviderResponse{}, bridgeError(BridgeProviderTransport)
	}
	if response.Body != nil {
		defer response.Body.Close()
	}
	if ctx.Err() != nil {
		return bridgeProviderResponse{}, bridgeError(BridgeAborted)
	}
	if requestContext.Err() == context.DeadlineExceeded {
		return bridgeProviderResponse{}, bridgeError(BridgeTimeout)
	}
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return bridgeProviderResponse{}, bridgeError(BridgeProviderTransport)
	}
	if operation == bridgeStatusOperation && response.StatusCode == http.StatusNotFound {
		return bridgeProviderResponse{}, bridgeError(BridgeStatusNotFound)
	}
	if operation == bridgeBuildOperation && (response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden) {
		return bridgeProviderResponse{}, bridgeError(BridgeProviderAuthRequired)
	}
	if response.Body == nil {
		return bridgeProviderResponse{}, bridgeError(BridgeProviderTransport)
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusCreated {
		return bridgeProviderResponse{}, bridgeHTTPError(BridgeProviderHTTP, response.StatusCode)
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, bridgeMaxResponseBytes+1))
	if readErr != nil {
		if ctx.Err() != nil {
			return bridgeProviderResponse{}, bridgeError(BridgeAborted)
		}
		if requestContext.Err() == context.DeadlineExceeded {
			return bridgeProviderResponse{}, bridgeError(BridgeTimeout)
		}
		return bridgeProviderResponse{}, bridgeError(BridgeProviderTransport)
	}
	if ctx.Err() != nil {
		return bridgeProviderResponse{}, bridgeError(BridgeAborted)
	}
	if requestContext.Err() == context.DeadlineExceeded {
		return bridgeProviderResponse{}, bridgeError(BridgeTimeout)
	}
	if len(data) > bridgeMaxResponseBytes {
		return bridgeProviderResponse{}, bridgeError(BridgeProviderInvalidResponse)
	}
	text := string(data)
	root, parseErr := parseBridgeJSON(text)
	if parseErr != nil {
		return bridgeProviderResponse{}, parseErr
	}
	return bridgeProviderResponse{text: text, root: root}, nil
}

func bridgeBase58Encode(bytes []byte) string {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
	zeroes := 0
	for zeroes < len(bytes) && bytes[zeroes] == 0 {
		zeroes++
	}
	if zeroes == len(bytes) {
		return strings.Repeat("1", zeroes)
	}
	digits := []byte{0}
	for _, value := range bytes {
		carry := int(value)
		for i := range digits {
			current := int(digits[i])*256 + carry
			digits[i] = byte(current % 58)
			carry = current / 58
		}
		for carry > 0 {
			digits = append(digits, byte(carry%58))
			carry /= 58
		}
	}
	var result strings.Builder
	result.WriteString(strings.Repeat("1", zeroes))
	for i := len(digits) - 1; i >= 0; i-- {
		result.WriteByte(alphabet[digits[i]])
	}
	return result.String()
}

func bridgeBase58Decode(value string, expectedBytes int) ([]byte, bool) {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
	if value == "" || len(value) > expectedBytes*2 {
		return nil, false
	}
	digits := []byte{0}
	for _, character := range value {
		position := strings.IndexRune(alphabet, character)
		if position < 0 {
			return nil, false
		}
		carry := position
		for i := range digits {
			current := int(digits[i])*58 + carry
			digits[i] = byte(current % 256)
			carry = current / 256
		}
		for carry > 0 {
			digits = append(digits, byte(carry%256))
			carry /= 256
		}
	}
	zeroes := 0
	for zeroes < len(value) && value[zeroes] == '1' {
		zeroes++
	}
	allZeroDigits := len(digits) == 1 && digits[0] == 0
	length := zeroes
	if !allZeroDigits {
		length += len(digits)
	}
	result := make([]byte, length)
	if !allZeroDigits {
		for i := range digits {
			result[len(result)-1-i] = digits[i]
		}
	}
	if len(result) != expectedBytes || bridgeBase58Encode(result) != value {
		return nil, false
	}
	return result, true
}

func bridgeBase64Decode(value string) ([]byte, bool) {
	if value == "" {
		return nil, false
	}
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil || base64.StdEncoding.EncodeToString(decoded) != value {
		return nil, false
	}
	return decoded, true
}

func readBridgeShortVec(bytes []byte, index *int, maximum int) (int, bool) {
	value := 0
	shift := 0
	for count := 0; count < 5; count++ {
		if *index >= len(bytes) {
			return 0, false
		}
		byteValue := bytes[*index]
		*index++
		payload := int(byteValue & 0x7f)
		if shift >= 28 || payload > int(^uint(0)>>1)>>shift {
			return 0, false
		}
		value += payload << shift
		if byteValue&0x80 == 0 {
			if count > 0 && payload == 0 || value > maximum {
				return 0, false
			}
			return value, true
		}
		shift += 7
	}
	return 0, false
}

func bridgeReadBytes(bytes []byte, index *int, count int) ([]byte, bool) {
	if count < 0 || *index < 0 || *index+count > len(bytes) {
		return nil, false
	}
	value := bytes[*index : *index+count]
	*index += count
	return value, true
}

func bridgeAllZero(bytes []byte) bool {
	for _, value := range bytes {
		if value != 0 {
			return false
		}
	}
	return true
}

func validateSolanaWireTransaction(encoded, feePayer string) error {
	bytes, ok := bridgeBase64Decode(encoded)
	if !ok || len(bytes) == 0 || len(bytes) > bridgeMaxSolanaWireBytes {
		return bridgeError(BridgeBuildInvalid)
	}
	index := 0
	signatureCount, ok := readBridgeShortVec(bytes, &index, 1)
	if !ok || signatureCount != 1 {
		return bridgeError(BridgeBuildInvalid)
	}
	signature, ok := bridgeReadBytes(bytes, &index, 64)
	if !ok || !bridgeAllZero(signature) {
		return bridgeError(BridgeBuildInvalid)
	}
	version, ok := bridgeReadBytes(bytes, &index, 1)
	if !ok || version[0] != 0x80 {
		return bridgeError(BridgeBuildInvalid)
	}
	header, ok := bridgeReadBytes(bytes, &index, 3)
	if !ok || header[0] != 1 || header[1] != 0 {
		return bridgeError(BridgeBuildInvalid)
	}
	staticCount, ok := readBridgeShortVec(bytes, &index, 64)
	if !ok || staticCount == 0 || int(header[2]) >= staticCount {
		return bridgeError(BridgeBuildInvalid)
	}
	staticKeys, ok := bridgeReadBytes(bytes, &index, staticCount*32)
	if !ok {
		return bridgeError(BridgeBuildInvalid)
	}
	payer, payerOK := bridgeBase58Decode(feePayer, 32)
	if !payerOK || !reflect.DeepEqual(staticKeys[:32], payer) {
		return bridgeError(BridgeBuildInvalid)
	}
	if _, ok = bridgeReadBytes(bytes, &index, 32); !ok {
		return bridgeError(BridgeBuildInvalid)
	}
	instructionCount, ok := readBridgeShortVec(bytes, &index, 64)
	if !ok {
		return bridgeError(BridgeBuildInvalid)
	}
	largestAccount := -1
	for i := 0; i < instructionCount; i++ {
		program, ok := bridgeReadBytes(bytes, &index, 1)
		if !ok {
			return bridgeError(BridgeBuildInvalid)
		}
		if int(program[0]) > largestAccount {
			largestAccount = int(program[0])
		}
		accountCount, countOK := readBridgeShortVec(bytes, &index, 64)
		if !countOK {
			return bridgeError(BridgeBuildInvalid)
		}
		accounts, accountsOK := bridgeReadBytes(bytes, &index, accountCount)
		if !accountsOK {
			return bridgeError(BridgeBuildInvalid)
		}
		for _, account := range accounts {
			if int(account) > largestAccount {
				largestAccount = int(account)
			}
		}
		dataCount, dataOK := readBridgeShortVec(bytes, &index, 1024)
		if !dataOK {
			return bridgeError(BridgeBuildInvalid)
		}
		if _, dataOK = bridgeReadBytes(bytes, &index, dataCount); !dataOK {
			return bridgeError(BridgeBuildInvalid)
		}
	}
	lookupCount, ok := readBridgeShortVec(bytes, &index, 32)
	if !ok {
		return bridgeError(BridgeBuildInvalid)
	}
	loaded := 0
	for i := 0; i < lookupCount; i++ {
		if _, ok = bridgeReadBytes(bytes, &index, 32); !ok {
			return bridgeError(BridgeBuildInvalid)
		}
		writable, writableOK := readBridgeShortVec(bytes, &index, 64)
		if !writableOK {
			return bridgeError(BridgeBuildInvalid)
		}
		if _, writableOK = bridgeReadBytes(bytes, &index, writable); !writableOK {
			return bridgeError(BridgeBuildInvalid)
		}
		readonly, readonlyOK := readBridgeShortVec(bytes, &index, 64)
		if !readonlyOK {
			return bridgeError(BridgeBuildInvalid)
		}
		if _, readonlyOK = bridgeReadBytes(bytes, &index, readonly); !readonlyOK {
			return bridgeError(BridgeBuildInvalid)
		}
		loaded += writable + readonly
		if loaded > 256 {
			return bridgeError(BridgeBuildInvalid)
		}
	}
	if largestAccount >= staticCount+loaded || index != len(bytes) {
		return bridgeError(BridgeBuildInvalid)
	}
	return nil
}

func isNumericZero(value any) bool {
	switch typed := value.(type) {
	case json.Number:
		parsed, err := strconv.ParseFloat(typed.String(), 64)
		return err == nil && math.IsInf(parsed, 0) == false && math.IsNaN(parsed) == false && parsed == 0
	case string:
		if typed == "0" {
			return true
		}
		if len(typed) > 2 && typed[0] == '0' && (typed[1] == 'x' || typed[1] == 'X') {
			for _, value := range typed[2:] {
				if value != '0' {
					return false
				}
			}
			return true
		}
	}
	return false
}

func (c *MayanSwiftV2BridgeClient) QuoteExactInput(ctx context.Context, request MayanSwiftV2QuoteRequest) ([]MayanSwiftV2Quote, error) {
	normalizedRequest, facts, err := validateBridgeQuoteRequest(request)
	if err != nil {
		return nil, err
	}
	body := quoteRequestBody(normalizedRequest, facts)
	response, err := c.providerJSON(ctx, bridgeEndpointPath(c.config.builderEndpoint, "/quote"), http.MethodPost, body, false, bridgeQuoteOperation)
	if err != nil {
		return nil, err
	}
	if response.root.objectEntries == nil {
		return nil, bridgeError(BridgeProviderInvalidResponse)
	}
	success, ok := bridgeObjectValue(response.root, "success")
	if !ok || success != true {
		return nil, bridgeError(BridgeProviderInvalidResponse)
	}
	quotesNode, err := bridgeRequiredNode(response.root, "quotes")
	if err != nil || quotesNode.arrayItems == nil || len(quotesNode.arrayItems) > bridgeMaxQuotes {
		return nil, bridgeError(BridgeProviderInvalidResponse)
	}
	result := make([]MayanSwiftV2Quote, 0)
	for _, node := range quotesNode.arrayItems {
		if node == nil || node.objectEntries == nil {
			continue
		}
		typ, typOK := bridgeObjectValue(node, "type")
		version, versionOK := bridgeObjectValue(node, "swiftVersion")
		gasless, gaslessOK := bridgeObjectValue(node, "gasless")
		if typ != "SWIFT" || version != "V2" || gasless != false || !typOK || !versionOK || !gaslessOK {
			continue
		}
		validated, validateErr := validateProviderQuote(node, response.text, normalizedRequest, facts, c.config, c.clock)
		if validateErr != nil {
			return nil, validateErr
		}
		result = append(result, cloneBridgeQuote(validated.quote))
	}
	if len(result) == 0 {
		return nil, bridgeError(BridgeQuoteUnavailable)
	}
	for _, quote := range result {
		deadline, _, parseErr := normalizeCanonicalUint64(quote.Deadline, BridgeProviderInvalidResponse)
		if parseErr != nil {
			return nil, parseErr
		}
		deadlineValue, _ := strconv.ParseUint(deadline, 10, 64)
		if deadlineErr := bridgeQuoteDeadline(deadlineValue, c.config.quoteValidity, c.clock); deadlineErr != nil {
			return nil, deadlineErr
		}
	}
	return result, nil
}

func normalizeBridgeChainAddress(value, chain string, code BridgeErrorCode) (string, error) {
	if chain == bridgeEthereumChainID {
		return normalizeEVMAddress(value, code)
	}
	if _, ok := bridgeBase58Decode(value, 32); !ok {
		return "", bridgeError(code)
	}
	return value, nil
}

func isCanonicalSolanaAddress(value string) bool {
	_, ok := bridgeBase58Decode(value, 32)
	return ok
}

func rejectAddressFromOtherChain(value, expectedChain string) error {
	evm := isEVMAddress(value) && !bridgeIsZeroEVMAddress(value)
	solana := isCanonicalSolanaAddress(value)
	if expectedChain == bridgeEthereumChainID && solana || expectedChain == bridgeSolanaChainID && evm {
		return bridgeError(BridgeQuoteMismatch)
	}
	return nil
}

func validateRawQuoteForBuild(quote MayanSwiftV2Quote, request MayanSwiftV2QuoteRequest, facts bridgeDirection, config normalizedBridgeConfig, clock func() int64) (MayanSwiftV2Quote, error) {
	root, err := parseBridgeJSON(quote.RawSignedQuoteJSON)
	if err != nil || root.objectEntries == nil || root.start != 0 || root.end != len(quote.RawSignedQuoteJSON) {
		return MayanSwiftV2Quote{}, bridgeError(BridgeQuoteMismatch)
	}
	validated, err := validateProviderQuote(root, quote.RawSignedQuoteJSON, request, facts, config, clock)
	if err != nil {
		if bridgeCode(err) == BridgeQuoteExpired {
			return MayanSwiftV2Quote{}, err
		}
		return MayanSwiftV2Quote{}, bridgeError(BridgeQuoteMismatch)
	}
	if !bridgeQuoteEqual(validated.quote, quote) {
		return MayanSwiftV2Quote{}, bridgeError(BridgeQuoteMismatch)
	}
	return cloneBridgeQuote(quote), nil
}

func bridgeCode(err error) BridgeErrorCode {
	var bridgeErr *BridgeError
	if errors.As(err, &bridgeErr) && bridgeErr != nil {
		return bridgeErr.Code
	}
	return ""
}

func validateEVMBuildResult(wrapper *bridgeJSONNode, swapper string, facts bridgeDirection) (MayanSwiftV2UnsignedTransaction, error) {
	category, err := bridgeProviderString(wrapper, "chainCategory", false)
	if err != nil || category != "evm" {
		return MayanSwiftV2UnsignedTransaction{}, bridgeError(BridgeBuildInvalid)
	}
	quoteType, err := bridgeProviderString(wrapper, "quoteType", false)
	if err != nil || quoteType != "SWIFT" {
		return MayanSwiftV2UnsignedTransaction{}, bridgeError(BridgeBuildInvalid)
	}
	gasless, err := bridgeProviderBool(wrapper, "gasless")
	if err != nil || gasless {
		return MayanSwiftV2UnsignedTransaction{}, bridgeError(BridgeBuildInvalid)
	}
	transaction, err := bridgeRequiredNode(wrapper, "transaction")
	if err != nil || transaction.objectEntries == nil {
		return MayanSwiftV2UnsignedTransaction{}, bridgeError(BridgeBuildInvalid)
	}
	to, err := bridgeProviderString(transaction, "to", false)
	if err != nil || !providerAddressEquals(to, bridgeEthereumForwarder) {
		return MayanSwiftV2UnsignedTransaction{}, bridgeError(BridgeBuildInvalid)
	}
	chainID, err := bridgeProviderInteger(transaction, "chainId")
	if err != nil || chainID != 1 {
		return MayanSwiftV2UnsignedTransaction{}, bridgeError(BridgeBuildInvalid)
	}
	value, present := bridgeObjectValue(transaction, "value")
	if !present || !isNumericZero(value) {
		return MayanSwiftV2UnsignedTransaction{}, bridgeError(BridgeBuildInvalid)
	}
	data, err := bridgeProviderString(transaction, "data", false)
	if err != nil {
		return MayanSwiftV2UnsignedTransaction{}, bridgeError(BridgeBuildInvalid)
	}
	data = strings.ToLower(data)
	selector := facts.forwarderFunctionSelector
	if selector == "" {
		return MayanSwiftV2UnsignedTransaction{}, bridgeError(BridgeBuildInvalid)
	}
	minimumWords := 13
	if facts.asset == "usdc" {
		minimumWords = 10
	}
	if len(data) < 2+8+minimumWords*64 || len(data)%2 != 0 || len(data) < 2 || data[0:2] != "0x" || !strings.HasPrefix(data, selector) {
		return MayanSwiftV2UnsignedTransaction{}, bridgeError(BridgeBuildInvalid)
	}
	for i := 2; i < len(data); i++ {
		if !bridgeIsHexDigit(data[i]) {
			return MayanSwiftV2UnsignedTransaction{}, bridgeError(BridgeBuildInvalid)
		}
	}
	return MayanSwiftV2UnsignedTransaction{Kind: "evm-unsigned-transaction", ChainID: bridgeEthereumChainID, From: swapper, To: bridgeEthereumForwarder, Data: data, Value: "0"}, nil
}

func validateSolanaBuildResult(wrapper *bridgeJSONNode, swapper string) (MayanSwiftV2UnsignedTransaction, error) {
	category, err := bridgeProviderString(wrapper, "chainCategory", false)
	if err != nil || category != "svm" {
		return MayanSwiftV2UnsignedTransaction{}, bridgeError(BridgeBuildInvalid)
	}
	quoteType, err := bridgeProviderString(wrapper, "quoteType", false)
	if err != nil || quoteType != "SWIFT" {
		return MayanSwiftV2UnsignedTransaction{}, bridgeError(BridgeBuildInvalid)
	}
	if gasless, present := bridgeObjectValue(wrapper, "gasless"); present && gasless != false {
		return MayanSwiftV2UnsignedTransaction{}, bridgeError(BridgeBuildInvalid)
	}
	transactionNode, err := bridgeRequiredNode(wrapper, "transaction")
	if err != nil {
		return MayanSwiftV2UnsignedTransaction{}, bridgeError(BridgeBuildInvalid)
	}
	transaction, ok := transactionNode.value.(string)
	if !ok || validateSolanaWireTransaction(transaction, swapper) != nil {
		return MayanSwiftV2UnsignedTransaction{}, bridgeError(BridgeBuildInvalid)
	}
	return MayanSwiftV2UnsignedTransaction{Kind: "solana-v0-unsigned-transaction", ChainID: bridgeSolanaChainID, FeePayer: swapper, TransactionBase64: transaction}, nil
}

func validateBuildResponse(response bridgeProviderResponse, quote MayanSwiftV2Quote, facts bridgeDirection, swapper string) (MayanSwiftV2Build, error) {
	if response.root.objectEntries == nil {
		return MayanSwiftV2Build{}, bridgeError(BridgeBuildInvalid)
	}
	success, ok := bridgeObjectValue(response.root, "success")
	if !ok || success != true {
		return MayanSwiftV2Build{}, bridgeError(BridgeBuildInvalid)
	}
	wrapper, err := bridgeRequiredNode(response.root, "transaction")
	if err != nil || wrapper.objectEntries == nil {
		return MayanSwiftV2Build{}, bridgeError(BridgeBuildInvalid)
	}
	if signers, present := bridgeObjectValue(wrapper, "signers"); present && signers != nil {
		node, _ := bridgeObjectNode(wrapper, "signers")
		if node == nil || node.arrayItems == nil || len(node.arrayItems) != 0 {
			return MayanSwiftV2Build{}, bridgeError(BridgeBuildInvalid)
		}
	}
	if swapMessage, present := bridgeObjectValue(wrapper, "swapMessageV0Params"); present && swapMessage != nil {
		return MayanSwiftV2Build{}, bridgeError(BridgeBuildInvalid)
	}
	var transaction MayanSwiftV2UnsignedTransaction
	if facts.sourceChainID == bridgeEthereumChainID {
		transaction, err = validateEVMBuildResult(wrapper, swapper, facts)
	} else {
		transaction, err = validateSolanaBuildResult(wrapper, swapper)
	}
	if err != nil {
		return MayanSwiftV2Build{}, bridgeError(BridgeBuildInvalid)
	}
	var allowance *MayanSwiftV2Allowance
	if facts.sourceChainID == bridgeEthereumChainID {
		allowance = &MayanSwiftV2Allowance{TokenDeploymentID: facts.sourceTokenDeployment, TokenAddress: facts.sourceTokenAddress, Owner: swapper, Spender: bridgeEthereumForwarder, RequiredAmount: quote.AmountIn}
	}
	return MayanSwiftV2Build{
		BuildKind: "mayan-swift-v2-unsigned", ProviderID: "mayan-swift-v2", Quote: cloneBridgeQuote(quote),
		SourceChainID: quote.SourceChainID, DestinationChainID: quote.DestinationChainID, Transaction: transaction,
		Allowance:            allowance,
		Validation:           MayanSwiftV2BuildValidation{Level: "structural", QuoteSignatureLocallyVerified: false, TransactionSemanticsLocallyVerified: false, SettlementLocallyVerified: false},
		RawProviderBuildJSON: response.text,
	}, nil
}

func (c *MayanSwiftV2BridgeClient) BuildUnsigned(ctx context.Context, request MayanSwiftV2BuildRequest) (MayanSwiftV2Build, error) {
	quote := cloneBridgeQuote(request.Quote)
	normalizedQuote, facts, err := validateNormalizedBridgeQuote(quote, BridgeQuoteMismatch)
	if err != nil {
		return MayanSwiftV2Build{}, err
	}
	requestForQuote := MayanSwiftV2QuoteRequest{SourceChainID: normalizedQuote.SourceChainID, DestinationChainID: normalizedQuote.DestinationChainID, SourceTokenDeploymentID: normalizedQuote.SourceTokenDeploymentID, DestinationTokenDeploymentID: normalizedQuote.DestinationTokenDeploymentID, AmountIn: normalizedQuote.AmountIn, SlippageBps: normalizedQuote.SlippageBps}
	if err := validateBridgeCapability(facts); err != nil {
		return MayanSwiftV2Build{}, bridgeError(BridgeQuoteMismatch)
	}
	if err := rejectAddressFromOtherChain(request.SwapperAddress, facts.sourceChainID); err != nil {
		return MayanSwiftV2Build{}, err
	}
	swapper, err := normalizeBridgeChainAddress(request.SwapperAddress, facts.sourceChainID, BridgeInvalidArgument)
	if err != nil {
		return MayanSwiftV2Build{}, err
	}
	destination, err := normalizeBridgeChainAddress(request.DestinationAddress, facts.destinationChainID, BridgeInvalidArgument)
	if err != nil {
		return MayanSwiftV2Build{}, err
	}
	var refund *string
	if request.RefundAddress != nil {
		normalizedRefund, refundErr := normalizeBridgeChainAddress(*request.RefundAddress, facts.sourceChainID, BridgeInvalidArgument)
		if refundErr != nil {
			return MayanSwiftV2Build{}, refundErr
		}
		refund = &normalizedRefund
	}
	if c.config.builderAPIKey == "" && !c.config.allowBuild {
		return MayanSwiftV2Build{}, bridgeError(BridgeProviderAuthRequired)
	}
	validatedQuote, err := validateRawQuoteForBuild(normalizedQuote, requestForQuote, facts, c.config, c.clock)
	if err != nil {
		return MayanSwiftV2Build{}, err
	}
	body := buildRequestBody(validatedQuote, facts.sourceChainID, swapper, destination, refund)
	response, err := c.providerJSON(ctx, bridgeEndpointPath(c.config.builderEndpoint, "/build"), http.MethodPost, body, true, bridgeBuildOperation)
	if err != nil {
		return MayanSwiftV2Build{}, err
	}
	deadline, parseErr := strconv.ParseUint(validatedQuote.Deadline, 10, 64)
	if parseErr != nil {
		return MayanSwiftV2Build{}, bridgeError(BridgeQuoteExpired)
	}
	if err := bridgeQuoteDeadline(deadline, c.config.quoteValidity, c.clock); err != nil {
		return MayanSwiftV2Build{}, err
	}
	return validateBuildResponse(response, validatedQuote, facts, swapper)
}

func isEVMHash(value string) bool { return isHexSized(value, 64) }

func bridgeEscapePathSegment(value string) string {
	var result strings.Builder
	const hex = "0123456789ABCDEF"
	for i := 0; i < len(value); i++ {
		character := value[i]
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || strings.ContainsRune("-._~", rune(character)) {
			result.WriteByte(character)
		} else {
			result.WriteByte('%')
			result.WriteByte(hex[character>>4])
			result.WriteByte(hex[character&0x0f])
		}
	}
	return result.String()
}

func normalizeStatusRequest(request MayanSwiftV2StatusRequest) (MayanSwiftV2StatusRequest, error) {
	if request.SourceChainID == bridgeEthereumChainID {
		if !isEVMHash(request.SourceTransactionHash) {
			return MayanSwiftV2StatusRequest{}, bridgeError(BridgeInvalidArgument)
		}
		request.SourceTransactionHash = strings.ToLower(request.SourceTransactionHash)
		return request, nil
	}
	if request.SourceChainID == bridgeSolanaChainID {
		if !isCanonicalSolanaSignature(request.SourceTransactionHash) {
			return MayanSwiftV2StatusRequest{}, bridgeError(BridgeInvalidArgument)
		}
		return request, nil
	}
	return MayanSwiftV2StatusRequest{}, bridgeError(BridgeUnsupportedRoute)
}

func isCanonicalSolanaSignature(value string) bool {
	_, ok := bridgeBase58Decode(value, 64)
	return ok
}

func (c *MayanSwiftV2BridgeClient) GetStatus(ctx context.Context, request MayanSwiftV2StatusRequest) (MayanSwiftV2Status, error) {
	normalized, err := normalizeStatusRequest(request)
	if err != nil {
		return MayanSwiftV2Status{}, err
	}
	endpoint := bridgeEndpointPath(c.config.explorerEndpoint, "/swap/trx/"+bridgeEscapePathSegment(normalized.SourceTransactionHash))
	response, err := c.providerJSON(ctx, endpoint, http.MethodGet, "", false, bridgeStatusOperation)
	if err != nil {
		return MayanSwiftV2Status{}, err
	}
	if response.root.objectEntries == nil {
		return MayanSwiftV2Status{}, bridgeError(BridgeProviderInvalidResponse)
	}
	clientStatus, err := bridgeProviderString(response.root, "clientStatus", false)
	if err != nil || len(clientStatus) > 128 {
		return MayanSwiftV2Status{}, bridgeError(BridgeProviderInvalidResponse)
	}
	var providerStatus *string
	if value, present := bridgeObjectValue(response.root, "status"); present {
		if value != nil {
			text, ok := value.(string)
			if !ok || len(text) > 1024 {
				return MayanSwiftV2Status{}, bridgeError(BridgeProviderInvalidResponse)
			}
			providerStatus = &text
		}
	}
	state := "unknown"
	switch clientStatus {
	case "INPROGRESS":
		state = "in-progress"
	case "COMPLETED":
		state = "completed"
	case "REFUNDED":
		state = "refunded"
	}
	return MayanSwiftV2Status{StatusKind: "mayan-explorer-index", ProviderID: "mayan-swift-v2", SourceChainID: normalized.SourceChainID, SourceTransactionHash: normalized.SourceTransactionHash, State: state, ProviderClientStatus: clientStatus, ProviderStatus: providerStatus, StatusVerification: "provider-indexed-not-locally-verified", RawProviderStatusJSON: response.text}, nil
}
