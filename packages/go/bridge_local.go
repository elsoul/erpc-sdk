package erpc

// This file contains the explicit Mayan Swift v2 local unsigned-construction
// path. It is deliberately separate from the hosted provider adapter: local
// builds use only caller-configured source RPC and anonymous read-only
// source-swap data, never the hosted /build endpoint.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"net/http"
	"net/url"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"

	"filippo.io/edwards25519"
	"golang.org/x/crypto/sha3"
)

const (
	localMayanReferenceCommit         = "c4c98031aaad9264d17630d7b4de0cb18688cf78"
	localMayanOracleSDKVersion        = "15_2_2"
	localSourceSwapEndpoint           = "https://price-api.mayan.finance/v3"
	localEthereumForwarderProvider    = "0x337685fdaB40D39bd02028545a4FfA7D287cC3E2"
	localSolanaTokenProgram           = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
	localSolanaAssociatedTokenProgram = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
	localSolanaSystemProgram          = "11111111111111111111111111111111"
	localSolanaSysvarRent             = "SysvarRent111111111111111111111111111111111"
	localSolanaComputeBudgetProgram   = "ComputeBudget111111111111111111111111111111"
	localSolanaCPIProxyProgram        = "D8C8iW6zmoKg5TRr8nQ7h14TMWqQX8FiBdj2ju5MF3wa"
	localSolanaAnchorEventAuthority   = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf"
	localSolanaFeeManagerProgram      = "5VtQHnhs2pfVEr68qQsbTRwKh4JV5GTu9mBHgHFxpHeQ"
	localSolanaMainnetGenesis         = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
	localSolanaMayanLookupTable       = "Ff3yi1meWQQ19VPZMzGg6H8JQQeRudiV7QtVtyzJyoht"
	localSolanaLookupTableOwner       = "AddressLookupTab1e1111111111111111111111111"
	localSolanaRouteV2Discriminator   = "bb64facc31c4af14"
	localSolanaWhirlpoolTail          = "000001000000110010270001"
	localSolanaRaydiumTail            = "0000010000001a10270001"
	localSolanaWhirlpoolProgram       = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
	localSolanaWhirlpoolPool          = "ArisQNcbjXPJD7RgPRvysatX3xcfHPTbcTkfD8kDoZ9i"
	localSolanaRaydiumProgram         = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
	localSolanaRaydiumPool            = "2zVV22uNWdJNmkXpj5vCrMzwHGBoJdsyV7qACh29sK1w"
	localSolanaInitOrderDiscriminator = "204c290c27a284db"
	localEVMSourceSwapSelector        = "0x3f0bde25"
	localMaxRouterCalldataBytes       = 16 * 1024
	localMaxSolanaSwapAccounts        = 64
	localMaxSolanaSwapDataBytes       = 4096
	localMaxLookupTables              = 8
	localMaxLookupTableAddresses      = 256
	localMaxSolanaTransactionBytes    = 1232
	localMaxLocalResponseBytes        = 1024 * 1024
	localMaxJSONDepth                 = 32
)

// MayanSwiftV2LocalBuildConfig configures anonymous source-swap preparation
// and the caller-owned source-chain RPC used for local unsigned builds.
type MayanSwiftV2LocalBuildConfig struct {
	SourceSwapEndpoint string             `json:"sourceSwapEndpoint,omitempty"`
	EthereumRPC        *RPCEndpointConfig `json:"ethereumRpc,omitempty"`
	SolanaRPC          *RPCEndpointConfig `json:"solanaRpc,omitempty"`
}

// MayanSwiftV2LocalContext is the complete caller-supplied local order
// context. orderNonce is public entropy supplied by the caller, never a key.
type MayanSwiftV2LocalContext struct {
	Quote              MayanSwiftV2Quote `json:"quote"`
	SwapperAddress     string            `json:"swapperAddress"`
	DestinationAddress string            `json:"destinationAddress"`
	OrderNonce         string            `json:"orderNonce"`
}

type MayanSwiftV2LocalSourceSwapInstructionAccount struct {
	Pubkey     string `json:"pubkey"`
	IsSigner   bool   `json:"isSigner"`
	IsWritable bool   `json:"isWritable"`
}

type MayanSwiftV2LocalSourceSwapInstruction struct {
	ProgramID  string                                          `json:"programId"`
	Accounts   []MayanSwiftV2LocalSourceSwapInstructionAccount `json:"accounts"`
	DataBase64 string                                          `json:"dataBase64"`
}

// MayanSwiftV2LocalSourceSwapPlan is the closed source-swap union. Optional
// fields are omitted for the direct-USDC none variant.
type MayanSwiftV2LocalSourceSwapPlan struct {
	Kind                        string                                   `json:"kind"`
	RouterAddress               string                                   `json:"routerAddress,omitempty"`
	Calldata                    string                                   `json:"calldata,omitempty"`
	Instructions                []MayanSwiftV2LocalSourceSwapInstruction `json:"instructions,omitempty"`
	AddressLookupTableAddresses []string                                 `json:"addressLookupTableAddresses,omitempty"`
	RawResponseSHA256           string                                   `json:"rawResponseSha256,omitempty"`
	RawProviderSourceSwapJSON   string                                   `json:"rawProviderSourceSwapJson,omitempty"`
}

type MayanSwiftV2LocalSourceSwapNone struct {
	Kind string `json:"kind"`
}

type MayanSwiftV2LocalSourceSwapEVMRouter struct {
	Kind                      string `json:"kind"`
	RouterAddress             string `json:"routerAddress"`
	Calldata                  string `json:"calldata"`
	RawResponseSHA256         string `json:"rawResponseSha256"`
	RawProviderSourceSwapJSON string `json:"rawProviderSourceSwapJson"`
}

// MayanSwiftV2LocalSourceSwapEvmRouter is the idiomatic Go spelling kept
// alongside the EVM acronym spelling for callers following the cross-language
// API names.
type MayanSwiftV2LocalSourceSwapEvmRouter = MayanSwiftV2LocalSourceSwapEVMRouter

type MayanSwiftV2LocalSourceSwapSolanaJupiter struct {
	Kind                        string                                   `json:"kind"`
	Instructions                []MayanSwiftV2LocalSourceSwapInstruction `json:"instructions"`
	AddressLookupTableAddresses []string                                 `json:"addressLookupTableAddresses"`
	RawResponseSHA256           string                                   `json:"rawResponseSha256"`
	RawProviderSourceSwapJSON   string                                   `json:"rawProviderSourceSwapJson"`
}

type MayanSwiftV2SourceSwapPlan struct {
	PlanKind                     string                          `json:"planKind"`
	ProviderID                   string                          `json:"providerId"`
	CapabilityID                 string                          `json:"capabilityId"`
	SourceChainID                string                          `json:"sourceChainId"`
	DestinationChainID           string                          `json:"destinationChainId"`
	SourceTokenDeploymentID      string                          `json:"sourceTokenDeploymentId"`
	DestinationTokenDeploymentID string                          `json:"destinationTokenDeploymentId"`
	QuoteID                      string                          `json:"quoteId"`
	RawQuoteSHA256               string                          `json:"rawQuoteSha256"`
	OrderNonce                   string                          `json:"orderNonce"`
	SwapperAddress               string                          `json:"swapperAddress"`
	DestinationAddress           string                          `json:"destinationAddress"`
	OrderHash                    string                          `json:"orderHash"`
	QuoteBindingHash             string                          `json:"quoteBindingHash"`
	MinimumIntermediateAmount    string                          `json:"minimumIntermediateAmount"`
	SourceSwap                   MayanSwiftV2LocalSourceSwapPlan `json:"sourceSwap"`
	PlanHash                     string                          `json:"planHash"`
}

type MayanSwiftV2LocalBuildRequest struct {
	Quote              MayanSwiftV2Quote          `json:"quote"`
	SwapperAddress     string                     `json:"swapperAddress"`
	DestinationAddress string                     `json:"destinationAddress"`
	OrderNonce         string                     `json:"orderNonce"`
	SourceSwapPlan     MayanSwiftV2SourceSwapPlan `json:"sourceSwapPlan"`
}

type MayanSwiftV2LocalEVMCodeEvidence struct {
	Address   string `json:"address"`
	Keccak256 string `json:"keccak256"`
}

// MayanSwiftV2LocalEvmCodeEvidence is the idiomatic Go spelling kept
// alongside the EVM acronym spelling for callers following the wire contract.
type MayanSwiftV2LocalEvmCodeEvidence = MayanSwiftV2LocalEVMCodeEvidence

// MayanSwiftV2LocalSourceRPCEvidence uses one nullable-field envelope so the
// EVM and Solana JSON projections retain their exact field sets.
type MayanSwiftV2LocalSourceRPCEvidence struct {
	Kind                 string                                 `json:"kind"`
	RPCChainID           string                                 `json:"rpcChainId,omitempty"`
	Code                 []MayanSwiftV2LocalEVMCodeEvidence     `json:"code,omitempty"`
	GenesisHash          string                                 `json:"genesisHash,omitempty"`
	BlockhashContextSlot string                                 `json:"blockhashContextSlot,omitempty"`
	AccountContextSlot   string                                 `json:"accountContextSlot,omitempty"`
	RecentBlockhash      string                                 `json:"recentBlockhash,omitempty"`
	LastValidBlockHeight string                                 `json:"lastValidBlockHeight,omitempty"`
	LookupTables         []MayanSwiftV2LocalLookupTableEvidence `json:"lookupTables,omitempty"`
}

// These aliases expose the per-chain names used by the other SDKs while the
// Go wire representation remains one nullable-field envelope.
type MayanSwiftV2LocalEvmRpcEvidence = MayanSwiftV2LocalSourceRPCEvidence
type MayanSwiftV2LocalSolanaRpcEvidence = MayanSwiftV2LocalSourceRPCEvidence
type MayanSwiftV2LocalSourceRpcEvidence = MayanSwiftV2LocalSourceRPCEvidence

type MayanSwiftV2LocalLookupTableEvidence struct {
	Address    string `json:"address"`
	DataSHA256 string `json:"dataSha256"`
}

type MayanSwiftV2LocalConstruction struct {
	Mode                      string                             `json:"mode"`
	ReferenceCommit           string                             `json:"referenceCommit"`
	OrderNonce                string                             `json:"orderNonce"`
	OrderHash                 string                             `json:"orderHash"`
	MinimumIntermediateAmount string                             `json:"minimumIntermediateAmount"`
	EffectiveDependencies     []string                           `json:"effectiveDependencies"`
	SourceRPCEvidence         MayanSwiftV2LocalSourceRPCEvidence `json:"sourceRpcEvidence"`
}

type MayanSwiftV2LocalBuildValidation struct {
	Level                              string `json:"level"`
	QuoteSignatureLocallyVerified      bool   `json:"quoteSignatureLocallyVerified"`
	PlanBindingLocallyVerified         bool   `json:"planBindingLocallyVerified"`
	TransactionBytesLocallyConstructed bool   `json:"transactionBytesLocallyConstructed"`
	SettlementLocallyVerified          bool   `json:"settlementLocallyVerified"`
}

type MayanSwiftV2LocalBuild struct {
	BuildKind          string                           `json:"buildKind"`
	ProviderID         string                           `json:"providerId"`
	CapabilityID       string                           `json:"capabilityId"`
	Quote              MayanSwiftV2Quote                `json:"quote"`
	SourceChainID      string                           `json:"sourceChainId"`
	DestinationChainID string                           `json:"destinationChainId"`
	SourceSwapPlan     MayanSwiftV2SourceSwapPlan       `json:"sourceSwapPlan"`
	Transaction        MayanSwiftV2UnsignedTransaction  `json:"transaction"`
	Allowance          *MayanSwiftV2Allowance           `json:"allowance"`
	Construction       MayanSwiftV2LocalConstruction    `json:"construction"`
	Validation         MayanSwiftV2LocalBuildValidation `json:"validation"`
}

type mayanSwiftV2LocalRuntime struct {
	client *MayanSwiftV2BridgeClient
	clock  func() int64
}

type localParsedQuote struct {
	raw                       *bridgeJSONNode
	rawFromTokenContract      string
	minimumIntermediateAmount string
	mode                      uint8
	cancelFee                 uint64
	refundFee                 uint64
	submitFee                 uint64
}

type localSolanaLookupTable struct {
	Address   string
	Addresses [][]byte
}

type localSourceRPCResult struct {
	Evidence        MayanSwiftV2LocalSourceRPCEvidence
	LookupTables    []localSolanaLookupTable
	RecentBlockhash string
}

type localRPCConfig struct {
	Endpoint *url.URL
	Headers  http.Header
}

type localKeyMeta struct {
	Signer   bool
	Writable bool
	Invoked  bool
}

type localCompiledInstruction struct {
	ProgramIDIndex uint8
	AccountIndexes []uint8
	Data           []byte
}

type localAddressTableLookup struct {
	AccountKey      string
	WritableIndexes []uint8
	ReadonlyIndexes []uint8
}

func normalizeMayanSwiftV2LocalBuildConfig(config *MayanSwiftV2LocalBuildConfig) (*MayanSwiftV2LocalBuildConfig, error) {
	if config == nil {
		return nil, nil
	}
	copyConfig := *config
	if copyConfig.SourceSwapEndpoint == "" {
		copyConfig.SourceSwapEndpoint = localSourceSwapEndpoint
	}
	cloneEndpoint := func(endpoint *RPCEndpointConfig) *RPCEndpointConfig {
		if endpoint == nil {
			return nil
		}
		result := &RPCEndpointConfig{HTTPURL: endpoint.HTTPURL, WebSocketURL: endpoint.WebSocketURL}
		result.Headers = endpoint.Headers.Clone()
		return result
	}
	copyConfig.EthereumRPC = cloneEndpoint(config.EthereumRPC)
	copyConfig.SolanaRPC = cloneEndpoint(config.SolanaRPC)
	return &copyConfig, nil
}

func localError(code BridgeErrorCode) error { return bridgeError(code) }

func localBytesToHex(value []byte) string { return hex.EncodeToString(value) }

func localSHA256Hex(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func localKeccakHex(value []byte) string {
	hash := sha3.NewLegacyKeccak256()
	_, _ = hash.Write(value)
	return hex.EncodeToString(hash.Sum(nil))
}

func localConcat(parts ...[]byte) []byte {
	total := 0
	for _, part := range parts {
		total += len(part)
	}
	result := make([]byte, 0, total)
	for _, part := range parts {
		result = append(result, part...)
	}
	return result
}

func localHexToBytes(value string) ([]byte, error) {
	source := value
	if strings.HasPrefix(source, "0x") {
		source = source[2:]
	}
	if len(source)%2 != 0 {
		return nil, errors.New("hex")
	}
	result, err := hex.DecodeString(source)
	if err != nil {
		return nil, err
	}
	return result, nil
}

func localNormalizeEVMAddress(value string) (string, error) {
	return normalizeEVMAddress(value, BridgeLocalPlanInvalid)
}

func localCanonicalSolanaAddress(value string) (string, []byte, error) {
	bytes, ok := bridgeBase58Decode(value, 32)
	if !ok || bridgeBase58Encode(bytes) != value {
		return "", nil, localError(BridgeLocalPlanInvalid)
	}
	return value, bytes, nil
}

func localProviderStandard(chain string) string {
	if chain == bridgeEthereumChainID {
		return "erc20"
	}
	return "spl"
}

func localUint64String(value string, positive bool) (string, uint64, error) {
	if positive {
		normalized, err := normalizePositiveUint64(value, BridgeLocalPlanInvalid)
		if err != nil {
			return "", 0, err
		}
		parsed, parseErr := strconv.ParseUint(normalized, 10, 64)
		if parseErr != nil {
			return "", 0, localError(BridgeLocalPlanInvalid)
		}
		return normalized, parsed, nil
	}
	return normalizeCanonicalUint64(value, BridgeLocalPlanInvalid)
}

func localWordUint(value uint64) []byte {
	word := make([]byte, 32)
	binary.BigEndian.PutUint64(word[24:], value)
	return word
}

func localWordBigUint(value *big.Int) ([]byte, error) {
	if value == nil || value.Sign() < 0 || value.BitLen() > 256 {
		return nil, errors.New("uint256")
	}
	word := make([]byte, 32)
	value.FillBytes(word)
	return word, nil
}

func localWordAddress(value string) ([]byte, error) {
	normalized, err := localNormalizeEVMAddress(value)
	if err != nil {
		return nil, err
	}
	bytes, err := localHexToBytes(normalized)
	if err != nil || len(bytes) != 20 {
		return nil, errors.New("address")
	}
	return localConcat(make([]byte, 12), bytes), nil
}

func localWordBytes32(value []byte) ([]byte, error) {
	if len(value) != 32 {
		return nil, errors.New("bytes32")
	}
	return append([]byte(nil), value...), nil
}

func localPad32(value []byte) []byte {
	length := ((len(value) + 31) / 32) * 32
	result := make([]byte, length)
	copy(result, value)
	return result
}

func localEncodeABIBytes(value []byte) []byte {
	return localConcat(localWordUint(uint64(len(value))), localPad32(value))
}

func localEncodeABIWithDynamics(head, dynamics [][]byte) []byte {
	offset := uint64((len(head) + len(dynamics)) * 32)
	result := make([]byte, 0)
	for _, word := range head {
		result = append(result, word...)
	}
	for _, value := range dynamics {
		result = append(result, localWordUint(offset)...)
		offset += uint64(32 + len(localPad32(value)))
	}
	for _, value := range dynamics {
		result = append(result, localEncodeABIBytes(value)...)
	}
	return result
}

func localNativeAddressBytes(value, chain string) ([]byte, error) {
	if chain == bridgeEthereumChainID {
		return localWordAddress(value)
	}
	_, bytes, err := localCanonicalSolanaAddress(value)
	return bytes, err
}

func localStableJSON(value any) ([]byte, error) {
	switch typed := value.(type) {
	case nil:
		return []byte("null"), nil
	case string:
		return json.Marshal(typed)
	case bool:
		if typed {
			return []byte("true"), nil
		}
		return []byte("false"), nil
	case json.Number:
		if typed.String() == "" {
			return nil, errors.New("number")
		}
		parsed, err := strconv.ParseFloat(typed.String(), 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return nil, errors.New("number")
		}
		return []byte(typed.String()), nil
	case int:
		return []byte(strconv.FormatInt(int64(typed), 10)), nil
	case int8:
		return []byte(strconv.FormatInt(int64(typed), 10)), nil
	case int16:
		return []byte(strconv.FormatInt(int64(typed), 10)), nil
	case int32:
		return []byte(strconv.FormatInt(int64(typed), 10)), nil
	case int64:
		return []byte(strconv.FormatInt(typed, 10)), nil
	case uint:
		return []byte(strconv.FormatUint(uint64(typed), 10)), nil
	case uint8:
		return []byte(strconv.FormatUint(uint64(typed), 10)), nil
	case uint16:
		return []byte(strconv.FormatUint(uint64(typed), 10)), nil
	case uint32:
		return []byte(strconv.FormatUint(uint64(typed), 10)), nil
	case uint64:
		return []byte(strconv.FormatUint(typed, 10)), nil
	case []byte:
		return nil, errors.New("bytes")
	case []any:
		parts := make([][]byte, len(typed))
		for index, child := range typed {
			encoded, err := localStableJSON(child)
			if err != nil {
				return nil, err
			}
			parts[index] = encoded
		}
		return localConcat([]byte{'['}, bytesJoin(parts), []byte{']'}), nil
	case []string:
		parts := make([][]byte, len(typed))
		for index, child := range typed {
			encoded, err := localStableJSON(child)
			if err != nil {
				return nil, err
			}
			parts[index] = encoded
		}
		return localConcat([]byte{'['}, bytesJoin(parts), []byte{']'}), nil
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := make([][]byte, 0, len(keys))
		for _, key := range keys {
			encodedKey, err := json.Marshal(key)
			if err != nil {
				return nil, err
			}
			encodedValue, err := localStableJSON(typed[key])
			if err != nil {
				return nil, err
			}
			parts = append(parts, localConcat(encodedKey, []byte{':'}, encodedValue))
		}
		return localConcat([]byte{'{'}, bytesJoin(parts), []byte{'}'}), nil
	default:
		return nil, fmt.Errorf("unsupported stable JSON type %T", value)
	}
}

func bytesJoin(parts [][]byte) []byte {
	if len(parts) == 0 {
		return nil
	}
	total := 0
	for _, part := range parts {
		total += len(part)
	}
	result := make([]byte, 0, total+len(parts)-1)
	for index, part := range parts {
		if index > 0 {
			result = append(result, ',')
		}
		result = append(result, part...)
	}
	return result
}

func localStableHash(value any) (string, error) {
	encoded, err := localStableJSON(value)
	if err != nil {
		return "", err
	}
	return localSHA256Hex(encoded), nil
}

func localStrictClone[T any](value T) (T, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		var zero T
		return zero, err
	}
	var clone T
	if err := json.Unmarshal(encoded, &clone); err != nil {
		var zero T
		return zero, err
	}
	return clone, nil
}

func localParsePlainDecimal(value string) (*big.Int, error) {
	if value == "" || (len(value) > 1 && value[0] == '0' && value[1] != '.') {
		return nil, errors.New("decimal")
	}
	separator := strings.IndexByte(value, '.')
	integerPart, fractionalPart := value, ""
	if separator >= 0 {
		integerPart, fractionalPart = value[:separator], value[separator+1:]
		if fractionalPart == "" {
			return nil, errors.New("decimal")
		}
	}
	if integerPart == "" {
		return nil, errors.New("decimal")
	}
	for _, character := range integerPart {
		if character < '0' || character > '9' {
			return nil, errors.New("decimal")
		}
	}
	for _, character := range fractionalPart {
		if character < '0' || character > '9' {
			return nil, errors.New("decimal")
		}
	}
	kept := fractionalPart
	if len(kept) > 6 {
		kept = kept[:6]
	}
	kept += strings.Repeat("0", 6-len(kept))
	integer, ok := new(big.Int).SetString(integerPart, 10)
	if !ok {
		return nil, errors.New("decimal")
	}
	result := new(big.Int).Mul(integer, big.NewInt(1_000_000))
	if kept != "" {
		fraction, ok := new(big.Int).SetString(kept, 10)
		if !ok {
			return nil, errors.New("decimal")
		}
		result.Add(result, fraction)
	}
	if result.Sign() <= 0 || result.BitLen() > 64 {
		return nil, errors.New("decimal")
	}
	return result, nil
}

func localBinary64RoundedDecimalUnits(value string) (*big.Int, error) {
	number, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 {
		return nil, errors.New("decimal")
	}
	bits := math.Float64bits(number)
	exponent := int((bits >> 52) & 0x7ff)
	fraction := bits & ((uint64(1) << 52) - 1)
	mantissa := fraction
	binaryExponent := -1074
	if exponent != 0 {
		mantissa |= uint64(1) << 52
		binaryExponent = exponent - 1023 - 52
	}
	numerator := new(big.Int).Mul(new(big.Int).SetUint64(mantissa), big.NewInt(10_000_000))
	denominator := big.NewInt(1)
	if binaryExponent >= 0 {
		numerator.Lsh(numerator, uint(binaryExponent))
	} else {
		denominator.Lsh(denominator, uint(-binaryExponent))
	}
	quotient, remainder := new(big.Int), new(big.Int)
	quotient.QuoRem(numerator, denominator, remainder)
	if new(big.Int).Lsh(new(big.Int).Set(remainder), 1).Cmp(denominator) >= 0 {
		quotient.Add(quotient, big.NewInt(1))
	}
	result := quotient.Quo(quotient, big.NewInt(10))
	if result.Sign() <= 0 || result.BitLen() > 64 {
		return nil, errors.New("decimal")
	}
	return result, nil
}

func localExactIntermediateAmount(raw string, direct bool, amount string) (string, error) {
	exact, err := localParsePlainDecimal(raw)
	if err != nil {
		return "", err
	}
	if direct {
		parsed, parseErr := strconv.ParseUint(amount, 10, 64)
		if parseErr != nil || exact.Cmp(new(big.Int).SetUint64(parsed)) != 0 {
			return "", errors.New("decimal")
		}
		return exact.String(), nil
	}
	compatibility, err := localBinary64RoundedDecimalUnits(raw)
	if err != nil || compatibility.Cmp(exact) != 0 {
		return "", errors.New("decimal")
	}
	return exact.String(), nil
}

// localDecimalUnits validates a provider decimal lexeme against the exact
// six-decimal base-unit representation used by the normalized quote.  The
// binary64 check mirrors the pinned provider conversion so a decimal that is
// exact after truncation but rounds differently through float64 is rejected.
func localDecimalUnits(raw, canonical string) error {
	exact, err := localParsePlainDecimal(raw)
	if err != nil {
		return err
	}
	units, parseErr := strconv.ParseUint(canonical, 10, 64)
	if parseErr != nil || units == 0 || exact.Cmp(new(big.Int).SetUint64(units)) != 0 {
		return errors.New("decimal")
	}
	compatibility, compatErr := localBinary64RoundedDecimalUnits(raw)
	if compatErr != nil || compatibility.Cmp(new(big.Int).SetUint64(units)) != 0 {
		return errors.New("decimal")
	}
	return nil
}

func localValidateDestinationMinimumCompatibility(value string) error {
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil || parsed == 0 {
		return errors.New("minimum")
	}
	whole := parsed / 1_000_000
	fraction := parsed % 1_000_000
	decimal := fmt.Sprintf("%d.%06d", whole, fraction)
	return localDecimalUnits(decimal, value)
}

func localRawNumberZero(value any) bool {
	switch typed := value.(type) {
	case json.Number:
		parsed, err := strconv.ParseFloat(typed.String(), 64)
		return err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0) && parsed == 0
	case string:
		return typed == "0"
	default:
		return false
	}
}

func localObjectValue(node *bridgeJSONNode, key string) (any, bool) {
	return bridgeObjectValue(node, key)
}

func localRequiredNode(node *bridgeJSONNode, key string) (*bridgeJSONNode, error) {
	child, ok := bridgeObjectNode(node, key)
	if !ok {
		return nil, errors.New("required")
	}
	return child, nil
}

func localExactObjectKeys(node *bridgeJSONNode, expected ...string) bool {
	if node == nil || node.objectEntries == nil || len(node.objectEntries) != len(expected) {
		return false
	}
	allowed := make(map[string]struct{}, len(expected))
	for _, key := range expected {
		allowed[key] = struct{}{}
	}
	for key := range node.objectEntries {
		if _, ok := allowed[key]; !ok {
			return false
		}
	}
	return true
}

func localString(node *bridgeJSONNode, key string, allowEmpty bool) (string, error) {
	return bridgeProviderString(node, key, allowEmpty)
}

func localBool(node *bridgeJSONNode, key string) (bool, error) {
	return bridgeProviderBool(node, key)
}

func localInteger(node *bridgeJSONNode, key string) (int64, error) {
	return bridgeProviderInteger(node, key)
}

func localRawUint64(node *bridgeJSONNode, key string, required bool) (uint64, error) {
	value, present := localObjectValue(node, key)
	if !present && !required {
		return 0, nil
	}
	text, ok := value.(string)
	if !ok {
		return 0, errors.New("uint64")
	}
	_, parsed, err := localUint64String(text, false)
	return parsed, err
}

func localRawNumberLexeme(node *bridgeJSONNode, key string, required bool) (string, error) {
	child, present := bridgeObjectNode(node, key)
	if !present {
		if required {
			return "", errors.New("number")
		}
		return "", nil
	}
	if child == nil || child.rawNumber == "" {
		return "", errors.New("number")
	}
	return child.rawNumber, nil
}

func localProviderAddress(node *bridgeJSONNode, key, expected string) (string, error) {
	value, err := bridgeProviderString(node, key, false)
	if err != nil || !providerAddressEquals(value, expected) {
		return "", errors.New("address")
	}
	if isEVMAddress(value) {
		return strings.ToLower(value), nil
	}
	return value, nil
}

func localProviderToken(node *bridgeJSONNode, facts bridgeDirection, source bool) error {
	if node == nil || node.objectEntries == nil {
		return errors.New("token")
	}
	address, standard, chainID, wormholeID, mint, name := facts.destinationTokenAddress, localProviderStandard(facts.destinationChainID), facts.destinationProviderChainID, facts.destinationWormholeChainID, facts.destinationTokenMint, facts.destinationTokenName
	if source {
		address, standard, chainID, wormholeID, mint, name = facts.sourceTokenAddress, localProviderStandard(facts.sourceChainID), facts.sourceProviderChainID, facts.sourceWormholeChainID, facts.sourceTokenMint, facts.sourceTokenName
	}
	contract, err := localString(node, "contract", false)
	if err != nil || !providerAddressEquals(contract, address) {
		return errors.New("token")
	}
	providerMint, err := localString(node, "mint", true)
	if err != nil || providerMint != mint {
		return errors.New("token")
	}
	origin, err := localString(node, "realOriginContractAddress", false)
	if err != nil || !providerAddressEquals(origin, address) {
		return errors.New("token")
	}
	providerName, err := localString(node, "name", false)
	if err != nil || providerName != name {
		return errors.New("token")
	}
	providerStandardValue, err := localString(node, "standard", false)
	if err != nil || providerStandardValue != standard {
		return errors.New("token")
	}
	chain, err := localInteger(node, "chainId")
	if err != nil || chain != int64(chainID) {
		return errors.New("token")
	}
	wormhole, err := localInteger(node, "wChainId")
	if err != nil || wormhole != int64(wormholeID) {
		return errors.New("token")
	}
	originChain, err := localInteger(node, "realOriginChainId")
	if err != nil || originChain != int64(wormholeID) {
		return errors.New("token")
	}
	decimals, err := localInteger(node, "decimals")
	if err != nil || decimals != 6 {
		return errors.New("token")
	}
	return nil
}

func localValidateRawQuote(quote MayanSwiftV2Quote, facts bridgeDirection) (localParsedQuote, error) {
	root, err := parseBridgeJSON(quote.RawSignedQuoteJSON)
	if err != nil || root == nil || root.objectEntries == nil || root.start != 0 || len(quote.RawSignedQuoteJSON) > localMaxLocalResponseBytes {
		return localParsedQuote{}, errors.New("quote")
	}
	fromToken, err := localRequiredNode(root, "fromToken")
	if err != nil {
		return localParsedQuote{}, err
	}
	toToken, err := localRequiredNode(root, "toToken")
	if err != nil {
		return localParsedQuote{}, err
	}
	if err := localProviderToken(fromToken, facts, true); err != nil {
		return localParsedQuote{}, err
	}
	if err := localProviderToken(toToken, facts, false); err != nil {
		return localParsedQuote{}, err
	}
	typ, err := localString(root, "type", false)
	if err != nil || typ != "SWIFT" {
		return localParsedQuote{}, errors.New("quote")
	}
	version, err := localString(root, "swiftVersion", false)
	if err != nil || version != "V2" {
		return localParsedQuote{}, errors.New("quote")
	}
	gasless, err := localBool(root, "gasless")
	if err != nil || gasless {
		return localParsedQuote{}, errors.New("quote")
	}
	onlyBridging, err := localBool(root, "onlyBridging")
	if err != nil || onlyBridging {
		return localParsedQuote{}, errors.New("quote")
	}
	if wrap, present := localObjectValue(root, "swiftWrapAndLock"); present && wrap != false {
		return localParsedQuote{}, errors.New("quote")
	}
	fromChain, err := localString(root, "fromChain", false)
	if err != nil || fromChain != facts.sourceName {
		return localParsedQuote{}, errors.New("quote")
	}
	toChain, err := localString(root, "toChain", false)
	if err != nil || toChain != facts.destinationName {
		return localParsedQuote{}, errors.New("quote")
	}
	slippageValue, err := localInteger(root, "slippageBps")
	if err != nil || slippageValue < 0 || uint64(slippageValue) != quote.SlippageBps {
		return localParsedQuote{}, errors.New("quote")
	}
	validateRawDecimal := func(key, canonical string) error {
		lexeme, lexemeErr := localRawNumberLexeme(root, key, true)
		if lexemeErr != nil {
			return lexemeErr
		}
		return localDecimalUnits(lexeme, canonical)
	}
	if err := validateRawDecimal("effectiveAmountIn", quote.AmountIn); err != nil {
		return localParsedQuote{}, err
	}
	effective, err := localString(root, "effectiveAmountIn64", false)
	if err != nil || effective != quote.AmountIn {
		return localParsedQuote{}, errors.New("quote")
	}
	expected, err := localString(root, "expectedAmountOutBaseUnits", false)
	if err != nil || expected != quote.ExpectedAmountOut {
		return localParsedQuote{}, errors.New("quote")
	}
	minimum, err := localString(root, "minAmountOutBaseUnits", false)
	if err != nil || minimum != quote.MinimumAmountOut {
		return localParsedQuote{}, errors.New("quote")
	}
	received, err := localString(root, "minReceivedBaseUnits", false)
	if err != nil || received != quote.MinimumReceived {
		return localParsedQuote{}, errors.New("quote")
	}
	deadline, err := localString(root, "deadline64", false)
	if err != nil || deadline != quote.Deadline {
		return localParsedQuote{}, errors.New("quote")
	}
	quoteID, err := localString(root, "quoteId", false)
	if err != nil || !strings.EqualFold(quoteID, quote.QuoteID) {
		return localParsedQuote{}, errors.New("quote")
	}
	signature, err := localString(root, "signature", false)
	if err != nil || !strings.EqualFold(signature, quote.ProviderSignature) {
		return localParsedQuote{}, errors.New("quote")
	}
	if err := validateRawDecimal("expectedAmountOut", quote.ExpectedAmountOut); err != nil {
		return localParsedQuote{}, err
	}
	if err := validateRawDecimal("minAmountOut", quote.MinimumAmountOut); err != nil {
		return localParsedQuote{}, err
	}
	if err := validateRawDecimal("minReceived", quote.MinimumReceived); err != nil {
		return localParsedQuote{}, err
	}
	swiftInput, err := localProviderAddress(root, "swiftInputContract", facts.sourceUSDCAddress)
	if err != nil || swiftInput != facts.sourceUSDCAddress {
		return localParsedQuote{}, errors.New("quote")
	}
	inputStandard, err := localString(root, "swiftInputContractStandard", false)
	if err != nil || inputStandard != localProviderStandard(facts.sourceChainID) {
		return localParsedQuote{}, errors.New("quote")
	}
	inputDecimals, err := localInteger(root, "swiftInputDecimals")
	if err != nil || inputDecimals != 6 {
		return localParsedQuote{}, errors.New("quote")
	}
	if _, err := localProviderAddress(root, "swiftMayanContract", facts.swiftContract); err != nil {
		return localParsedQuote{}, errors.New("quote")
	}
	if value, present := localObjectValue(root, "referrerBps"); !present || !localRawNumberZero(value) {
		return localParsedQuote{}, errors.New("quote")
	}
	if value, present := localObjectValue(root, "protocolBps"); !present || !localRawNumberZero(value) {
		return localParsedQuote{}, errors.New("quote")
	}
	if value, present := localObjectValue(root, "gasDrop"); !present || !localRawNumberZero(value) {
		return localParsedQuote{}, errors.New("quote")
	}
	modeValue, err := localInteger(root, "swiftAuctionMode")
	if err != nil || (modeValue != 2 && modeValue != 3) || modeValue != int64(func() uint8 {
		if facts.asset == "usdc" {
			return 3
		}
		return 2
	}()) {
		return localParsedQuote{}, errors.New("mode")
	}
	if modeValue == 3 && (expected != minimum || minimum != received) {
		return localParsedQuote{}, errors.New("guaranteed output")
	}
	if value, present := localObjectValue(root, "suggestedPriorityFee"); present {
		if err := localSafeRawInteger(value, 0, 100_000); err != nil {
			return localParsedQuote{}, errors.New("priority fee")
		}
	}
	for _, key := range []string{"customPayload", "memoHex", "referrer", "referrerAddress", "swiftRefundAddress", "permit", "approval", "approvalBatch", "separateSwapTx", "jito", "extraInstructions"} {
		if value, present := localObjectValue(root, key); present && value != nil && value != false && value != "" {
			return localParsedQuote{}, errors.New("forbidden")
		}
	}
	middle, err := localRequiredNode(root, "minMiddleAmount")
	if err != nil || middle.rawNumber == "" {
		return localParsedQuote{}, errors.New("minimum")
	}
	minimumIntermediate, err := localExactIntermediateAmount(middle.rawNumber, facts.asset == "usdc", quote.AmountIn)
	if err != nil {
		return localParsedQuote{}, err
	}
	if quote.SourceSwap.ProviderMinimumAmount != middle.rawNumber {
		return localParsedQuote{}, errors.New("provider minimum")
	}
	rawRouter, rawRouterPresent := localObjectValue(root, "evmSwapRouterAddress")
	rawCalldata, rawCalldataPresent := localObjectValue(root, "evmSwapRouterCalldata")
	if facts.asset != "usdc" && facts.sourceChainID == bridgeEthereumChainID {
		if !rawRouterPresent {
			return localParsedQuote{}, errors.New("router")
		}
		routerText, ok := rawRouter.(string)
		if !ok {
			return localParsedQuote{}, errors.New("router")
		}
		router, routerErr := localNormalizeEVMAddress(routerText)
		if routerErr != nil || quote.SourceSwap.RouterKind == nil || *quote.SourceSwap.RouterKind != "provider-selected-evm" || quote.SourceSwap.RouterAddress == nil || router != *quote.SourceSwap.RouterAddress {
			return localParsedQuote{}, errors.New("router")
		}
		if rawCalldataPresent && rawCalldata != nil {
			calldataText, ok := rawCalldata.(string)
			if !ok {
				return localParsedQuote{}, errors.New("router calldata")
			}
			calldata, calldataErr := localCanonicalHexBytes(calldataText, false)
			if calldataErr != nil || len(calldata) > localMaxRouterCalldataBytes {
				return localParsedQuote{}, errors.New("router calldata")
			}
		}
	} else {
		if rawRouterPresent && rawRouter != nil {
			return localParsedQuote{}, errors.New("router")
		}
		if rawCalldataPresent && rawCalldata != nil {
			return localParsedQuote{}, errors.New("router calldata")
		}
	}
	cancelFee, err := localRawUint64(root, "cancelRelayerFee64", true)
	if err != nil {
		return localParsedQuote{}, err
	}
	refundFee, err := localRawUint64(root, "refundRelayerFee64", true)
	if err != nil {
		return localParsedQuote{}, err
	}
	submitFee, err := localRawUint64(root, "submitRelayerFee64", true)
	if err != nil {
		return localParsedQuote{}, err
	}
	return localParsedQuote{raw: root, rawFromTokenContract: func() string {
		value, _ := localString(fromToken, "contract", false)
		return value
	}(), minimumIntermediateAmount: minimumIntermediate, mode: uint8(modeValue), cancelFee: cancelFee, refundFee: refundFee, submitFee: submitFee}, nil
}

func localValidateRouteQuote(quote MayanSwiftV2Quote, quoteValidity uint64, clock func() int64) (MayanSwiftV2Quote, bridgeDirection, localParsedQuote, error) {
	normalized, facts, err := validateNormalizedBridgeQuote(quote, BridgeLocalPlanInvalid)
	if err != nil {
		return MayanSwiftV2Quote{}, bridgeDirection{}, localParsedQuote{}, err
	}
	if err := validateBridgeCapability(facts); err != nil {
		return MayanSwiftV2Quote{}, bridgeDirection{}, localParsedQuote{}, localError(BridgeLocalPlanInvalid)
	}
	rawRoot, rawErr := parseBridgeJSON(normalized.RawSignedQuoteJSON)
	if rawErr != nil || rawRoot == nil || rawRoot.objectEntries == nil {
		return MayanSwiftV2Quote{}, bridgeDirection{}, localParsedQuote{}, localError(BridgeLocalPlanInvalid)
	}
	hosted, hostedErr := validateProviderQuote(rawRoot, normalized.RawSignedQuoteJSON, MayanSwiftV2QuoteRequest{
		SourceChainID: normalized.SourceChainID, DestinationChainID: normalized.DestinationChainID,
		SourceTokenDeploymentID: normalized.SourceTokenDeploymentID, DestinationTokenDeploymentID: normalized.DestinationTokenDeploymentID,
		AmountIn: normalized.AmountIn, SlippageBps: normalized.SlippageBps,
	}, facts, normalizedBridgeConfig{quoteValidity: quoteValidity}, clock)
	if hostedErr != nil {
		if bridgeCode(hostedErr) == BridgeQuoteExpired {
			return MayanSwiftV2Quote{}, bridgeDirection{}, localParsedQuote{}, hostedErr
		}
		return MayanSwiftV2Quote{}, bridgeDirection{}, localParsedQuote{}, localError(BridgeLocalPlanInvalid)
	}
	// The hosted validator normalizes the parsed object span, while the local
	// plan deliberately retains the caller's exact raw bytes (including any
	// surrounding whitespace) for hashing and replay binding.
	hostedQuote := hosted.quote
	hostedQuote.RawSignedQuoteJSON = normalized.RawSignedQuoteJSON
	if !bridgeQuoteEqual(hostedQuote, normalized) {
		return MayanSwiftV2Quote{}, bridgeDirection{}, localParsedQuote{}, localError(BridgeLocalPlanInvalid)
	}
	parsed, err := localValidateRawQuote(normalized, facts)
	if err != nil {
		return MayanSwiftV2Quote{}, bridgeDirection{}, localParsedQuote{}, localError(BridgeLocalPlanInvalid)
	}
	return normalized, facts, parsed, nil
}

func localNormalizeContextAddresses(context MayanSwiftV2LocalContext, facts bridgeDirection) (MayanSwiftV2LocalContext, error) {
	normalized := context
	if facts.sourceChainID == bridgeEthereumChainID {
		address, err := localNormalizeEVMAddress(context.SwapperAddress)
		if err != nil {
			return MayanSwiftV2LocalContext{}, err
		}
		normalized.SwapperAddress = address
	} else {
		address, _, err := localCanonicalSolanaAddress(context.SwapperAddress)
		if err != nil {
			return MayanSwiftV2LocalContext{}, err
		}
		normalized.SwapperAddress = address
	}
	if facts.destinationChainID == bridgeEthereumChainID {
		address, err := localNormalizeEVMAddress(context.DestinationAddress)
		if err != nil {
			return MayanSwiftV2LocalContext{}, err
		}
		normalized.DestinationAddress = address
	} else {
		address, _, err := localCanonicalSolanaAddress(context.DestinationAddress)
		if err != nil {
			return MayanSwiftV2LocalContext{}, err
		}
		normalized.DestinationAddress = address
	}
	if len(context.OrderNonce) != 34 || !strings.HasPrefix(context.OrderNonce, "0x") {
		return MayanSwiftV2LocalContext{}, errors.New("nonce")
	}
	for _, character := range context.OrderNonce[2:] {
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')) {
			return MayanSwiftV2LocalContext{}, errors.New("nonce")
		}
	}
	return normalized, nil
}

func localQuoteBindingHash(facts bridgeDirection, quote MayanSwiftV2Quote, rawQuoteSHA256, orderNonce, swapperAddress, destinationAddress string) (string, error) {
	return localStableHash(map[string]any{
		"capabilityId":                 facts.capabilityID,
		"destinationAddress":           destinationAddress,
		"destinationChainId":           facts.destinationChainID,
		"destinationTokenDeploymentId": facts.destinationTokenDeployment,
		"orderNonce":                   orderNonce,
		"quoteId":                      quote.QuoteID,
		"rawQuoteSha256":               rawQuoteSHA256,
		"sourceChainId":                facts.sourceChainID,
		"sourceTokenDeploymentId":      facts.sourceTokenDeployment,
		"swapperAddress":               swapperAddress,
	})
}

func localSourceSwapPlanProjection(plan MayanSwiftV2LocalSourceSwapPlan) map[string]any {
	if plan.Kind == "none" {
		return map[string]any{"kind": "none"}
	}
	if plan.Kind == "evm-router" {
		return map[string]any{
			"kind":              plan.Kind,
			"routerAddress":     plan.RouterAddress,
			"calldata":          plan.Calldata,
			"rawResponseSha256": plan.RawResponseSHA256,
		}
	}
	instructions := make([]any, len(plan.Instructions))
	for index, instruction := range plan.Instructions {
		accounts := make([]any, len(instruction.Accounts))
		for accountIndex, account := range instruction.Accounts {
			accounts[accountIndex] = map[string]any{
				"pubkey":     account.Pubkey,
				"isSigner":   account.IsSigner,
				"isWritable": account.IsWritable,
			}
		}
		instructions[index] = map[string]any{
			"programId":  instruction.ProgramID,
			"accounts":   accounts,
			"dataBase64": instruction.DataBase64,
		}
	}
	return map[string]any{
		"kind":                        plan.Kind,
		"instructions":                instructions,
		"addressLookupTableAddresses": append([]string(nil), plan.AddressLookupTableAddresses...),
		"rawResponseSha256":           plan.RawResponseSHA256,
	}
}

func localPlanHash(binding string, sourceSwap MayanSwiftV2LocalSourceSwapPlan) (string, error) {
	return localStableHash(map[string]any{
		"quoteBindingHash": binding,
		"sourceSwap":       localSourceSwapPlanProjection(sourceSwap),
	})
}

func localSwiftRandom(quoteID, orderNonce string) ([]byte, error) {
	quoteBytes, err := localHexToBytes(quoteID)
	if err != nil || len(quoteBytes) != 16 {
		return nil, errors.New("random")
	}
	nonceBytes, err := localHexToBytes(orderNonce)
	if err != nil || len(nonceBytes) != 16 {
		return nil, errors.New("random")
	}
	return localConcat(quoteBytes, nonceBytes), nil
}

func localWriteUint16BE(value uint16) []byte {
	result := make([]byte, 2)
	binary.BigEndian.PutUint16(result, value)
	return result
}

func localWriteUint16LE(value uint16) []byte {
	result := make([]byte, 2)
	binary.LittleEndian.PutUint16(result, value)
	return result
}

func localWriteUint64BE(value uint64) []byte {
	result := make([]byte, 8)
	binary.BigEndian.PutUint64(result, value)
	return result
}

func localWriteUint64LE(value uint64) []byte {
	result := make([]byte, 8)
	binary.LittleEndian.PutUint64(result, value)
	return result
}

func localOrderPreimage(quote MayanSwiftV2Quote, facts bridgeDirection, swapperAddress, destinationAddress, orderNonce string, cancelFee, refundFee uint64, mode uint8) ([]byte, error) {
	destinationMinimum, err := strconv.ParseUint(quote.MinimumAmountOut, 10, 64)
	if err != nil || destinationMinimum == 0 {
		return nil, errors.New("order")
	}
	swapper, err := localNativeAddressBytes(swapperAddress, facts.sourceChainID)
	if err != nil {
		return nil, err
	}
	sourceToken, err := localNativeAddressBytes(facts.sourceUSDCAddress, facts.sourceChainID)
	if err != nil {
		return nil, err
	}
	destination, err := localNativeAddressBytes(destinationAddress, facts.destinationChainID)
	if err != nil {
		return nil, err
	}
	destinationToken, err := localNativeAddressBytes(facts.destinationTokenAddress, facts.destinationChainID)
	if err != nil {
		return nil, err
	}
	deadline, err := strconv.ParseUint(quote.Deadline, 10, 64)
	if err != nil || deadline == 0 {
		return nil, errors.New("order")
	}
	random, err := localSwiftRandom(quote.QuoteID, orderNonce)
	if err != nil {
		return nil, err
	}
	parts := [][]byte{
		{1}, swapper, localWriteUint16BE(uint16(facts.sourceWormholeChainID)), sourceToken,
		destination, localWriteUint16BE(uint16(facts.destinationWormholeChainID)), destinationToken,
		localWriteUint64BE(destinationMinimum), localWriteUint64BE(0), localWriteUint64BE(cancelFee),
		localWriteUint64BE(refundFee), localWriteUint64BE(deadline), make([]byte, 32), {0, 0, mode}, random,
		make([]byte, 32),
	}
	result := localConcat(parts...)
	if len(result) != 272 {
		return nil, errors.New("order")
	}
	return result, nil
}

func localOrderHash(quote MayanSwiftV2Quote, facts bridgeDirection, swapperAddress, destinationAddress, orderNonce string, cancelFee, refundFee uint64, mode uint8) (string, error) {
	preimage, err := localOrderPreimage(quote, facts, swapperAddress, destinationAddress, orderNonce, cancelFee, refundFee, mode)
	if err != nil {
		return "", err
	}
	return "0x" + localKeccakHex(preimage), nil
}

func localIsOnCurveZIP215(value []byte) bool {
	if len(value) != 32 {
		return false
	}
	_, err := new(edwards25519.Point).SetBytes(value)
	return err == nil
}

func localFindProgramAddress(seeds [][]byte, programID string) (string, uint8, error) {
	if len(seeds) > 16 {
		return "", 0, errors.New("pda")
	}
	for _, seed := range seeds {
		if len(seed) > 32 {
			return "", 0, errors.New("pda")
		}
	}
	program, ok := bridgeBase58Decode(programID, 32)
	if !ok {
		return "", 0, errors.New("pda")
	}
	suffix := []byte("ProgramDerivedAddress")
	for bump := 255; bump >= 0; bump-- {
		hash := sha256.New()
		for _, seed := range seeds {
			_, _ = hash.Write(seed)
		}
		_, _ = hash.Write([]byte{byte(bump)})
		_, _ = hash.Write(program)
		_, _ = hash.Write(suffix)
		candidate := hash.Sum(nil)
		if !localIsOnCurveZIP215(candidate) {
			return bridgeBase58Encode(candidate), uint8(bump), nil
		}
	}
	return "", 0, errors.New("pda")
}

func localAssociatedTokenAddress(owner, mint string, allowOwnerOffCurve bool) (string, error) {
	ownerAddress, ownerBytes, err := localCanonicalSolanaAddress(owner)
	if err != nil || ownerAddress == "" {
		return "", errors.New("ata")
	}
	_, mintBytes, err := localCanonicalSolanaAddress(mint)
	if err != nil {
		return "", errors.New("ata")
	}
	if !allowOwnerOffCurve && !localIsOnCurveZIP215(ownerBytes) {
		return "", errors.New("ata")
	}
	address, _, err := localFindProgramAddress([][]byte{ownerBytes, mustBase58Bytes(localSolanaTokenProgram), mintBytes}, localSolanaAssociatedTokenProgram)
	return address, err
}

func mustBase58Bytes(value string) []byte {
	bytes, _ := bridgeBase58Decode(value, 32)
	return bytes
}

func localBase64Decode(value string, maximum int, allowEmpty bool) ([]byte, error) {
	if value == "" && allowEmpty {
		return []byte{}, nil
	}
	if value == "" || len(value) > maximum*2 || len(value)%4 != 0 {
		return nil, errors.New("base64")
	}
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(decoded) > maximum || base64.StdEncoding.EncodeToString(decoded) != value {
		return nil, errors.New("base64")
	}
	return decoded, nil
}

func localCanonicalHexBytes(value string, allowEmpty bool) ([]byte, error) {
	if !strings.HasPrefix(value, "0x") {
		return nil, errors.New("hex")
	}
	bytes, err := localHexToBytes(value)
	if err != nil || (!allowEmpty && len(bytes) == 0) {
		return nil, errors.New("hex")
	}
	for _, character := range value[2:] {
		if !bridgeIsHexDigit(byte(character)) {
			return nil, errors.New("hex")
		}
	}
	return bytes, nil
}

func localInstructionFromNode(node *bridgeJSONNode) (MayanSwiftV2LocalSourceSwapInstruction, error) {
	if !localExactObjectKeys(node, "programId", "accounts", "data") {
		return MayanSwiftV2LocalSourceSwapInstruction{}, errors.New("instruction")
	}
	programValue, err := localString(node, "programId", false)
	if err != nil {
		return MayanSwiftV2LocalSourceSwapInstruction{}, err
	}
	program, _, err := localCanonicalSolanaAddress(programValue)
	if err != nil {
		return MayanSwiftV2LocalSourceSwapInstruction{}, err
	}
	accountsNode, err := localRequiredNode(node, "accounts")
	if err != nil || accountsNode.arrayItems == nil || len(accountsNode.arrayItems) > localMaxSolanaSwapAccounts {
		return MayanSwiftV2LocalSourceSwapInstruction{}, errors.New("instruction")
	}
	accounts := make([]MayanSwiftV2LocalSourceSwapInstructionAccount, len(accountsNode.arrayItems))
	for index, accountNode := range accountsNode.arrayItems {
		if !localExactObjectKeys(accountNode, "pubkey", "isSigner", "isWritable") {
			return MayanSwiftV2LocalSourceSwapInstruction{}, errors.New("account")
		}
		pubkey, err := localString(accountNode, "pubkey", false)
		if err != nil {
			return MayanSwiftV2LocalSourceSwapInstruction{}, err
		}
		canonical, _, err := localCanonicalSolanaAddress(pubkey)
		if err != nil {
			return MayanSwiftV2LocalSourceSwapInstruction{}, err
		}
		isSigner, err := localBool(accountNode, "isSigner")
		if err != nil {
			return MayanSwiftV2LocalSourceSwapInstruction{}, err
		}
		isWritable, err := localBool(accountNode, "isWritable")
		if err != nil {
			return MayanSwiftV2LocalSourceSwapInstruction{}, err
		}
		accounts[index] = MayanSwiftV2LocalSourceSwapInstructionAccount{Pubkey: canonical, IsSigner: isSigner, IsWritable: isWritable}
	}
	data, err := localString(node, "data", true)
	if err != nil {
		return MayanSwiftV2LocalSourceSwapInstruction{}, err
	}
	if _, err := localBase64Decode(data, localMaxSolanaSwapDataBytes, true); err != nil {
		return MayanSwiftV2LocalSourceSwapInstruction{}, err
	}
	return MayanSwiftV2LocalSourceSwapInstruction{ProgramID: program, Accounts: accounts, DataBase64: data}, nil
}

func localInstructionAccount(instruction MayanSwiftV2LocalSourceSwapInstruction, index int) (MayanSwiftV2LocalSourceSwapInstructionAccount, error) {
	if index < 0 || index >= len(instruction.Accounts) {
		return MayanSwiftV2LocalSourceSwapInstructionAccount{}, errors.New("account")
	}
	return instruction.Accounts[index], nil
}

func localAssertInstructionAccount(account MayanSwiftV2LocalSourceSwapInstructionAccount, pubkey string, signer, writable bool) error {
	if account.Pubkey != pubkey || account.IsSigner != signer || account.IsWritable != writable {
		return errors.New("account")
	}
	return nil
}

func localValidateComputeInstructions(instructions []MayanSwiftV2LocalSourceSwapInstruction) error {
	if len(instructions) > 2 {
		return errors.New("compute")
	}
	seen := make(map[byte]struct{}, len(instructions))
	for _, instruction := range instructions {
		if instruction.ProgramID != localSolanaComputeBudgetProgram || len(instruction.Accounts) != 0 {
			return errors.New("compute")
		}
		data, err := localBase64Decode(instruction.DataBase64, localMaxSolanaSwapDataBytes, true)
		if err != nil || len(data) == 0 {
			return errors.New("compute")
		}
		tag := data[0]
		if tag != 2 && tag != 3 {
			return errors.New("compute")
		}
		if _, exists := seen[tag]; exists {
			return errors.New("compute")
		}
		seen[tag] = struct{}{}
		if tag == 2 {
			if len(data) != 5 || binary.LittleEndian.Uint32(data[1:]) > 1_400_000 {
				return errors.New("compute")
			}
		} else if len(data) != 9 || binary.LittleEndian.Uint64(data[1:]) > 100_000 {
			return errors.New("compute")
		}
	}
	return nil
}

func localValidateATASetup(instructions []MayanSwiftV2LocalSourceSwapInstruction, swapper, state, sourceUSDC string) error {
	if len(instructions) == 0 || len(instructions) > 2 {
		return errors.New("setup")
	}
	seenOwners := make(map[string]struct{}, len(instructions))
	for _, instruction := range instructions {
		if instruction.ProgramID != localSolanaAssociatedTokenProgram || len(instruction.Accounts) != 6 {
			return errors.New("setup")
		}
		payer, _ := localInstructionAccount(instruction, 0)
		if err := localAssertInstructionAccount(payer, swapper, true, true); err != nil {
			return err
		}
		owner, _ := localInstructionAccount(instruction, 2)
		if (owner.Pubkey != swapper && owner.Pubkey != state) || owner.IsSigner || owner.IsWritable {
			return errors.New("setup")
		}
		if _, exists := seenOwners[owner.Pubkey]; exists {
			return errors.New("setup")
		}
		seenOwners[owner.Pubkey] = struct{}{}
		allowOffCurve := owner.Pubkey == state
		expectedATA, err := localAssociatedTokenAddress(owner.Pubkey, sourceUSDC, allowOffCurve)
		if err != nil {
			return err
		}
		checks := []struct {
			index    int
			pubkey   string
			signer   bool
			writable bool
		}{
			{1, expectedATA, false, true},
			{3, sourceUSDC, false, false},
			{4, localSolanaSystemProgram, false, false},
			{5, localSolanaTokenProgram, false, false},
		}
		for _, check := range checks {
			account, _ := localInstructionAccount(instruction, check.index)
			if err := localAssertInstructionAccount(account, check.pubkey, check.signer, check.writable); err != nil {
				return err
			}
		}
		data, err := localBase64Decode(instruction.DataBase64, localMaxSolanaSwapDataBytes, true)
		if err != nil || len(data) != 0 && (len(data) != 1 || data[0] != 1) {
			return errors.New("setup")
		}
	}
	if _, ok := seenOwners[state]; !ok {
		return errors.New("setup")
	}
	return nil
}

func localArrayNode(node *bridgeJSONNode, index int) (*bridgeJSONNode, error) {
	if node == nil || node.arrayItems == nil || index < 0 || index >= len(node.arrayItems) {
		return nil, errors.New("array")
	}
	return node.arrayItems[index], nil
}

func localValidateJupiterInstruction(instruction MayanSwiftV2LocalSourceSwapInstruction, facts bridgeDirection, quote MayanSwiftV2Quote, stateTokenAccount, swapper, minimumIntermediate string, sourceRoot *bridgeJSONNode) error {
	if instruction.ProgramID != bridgeSolanaJupiterV6 || len(instruction.Accounts) < 8 || len(instruction.Accounts) > localMaxSolanaSwapAccounts {
		return errors.New("jupiter")
	}
	data, err := localBase64Decode(instruction.DataBase64, localMaxSolanaSwapDataBytes, true)
	if err != nil || len(data) < 8 || localBytesToHex(data[:8]) != localSolanaRouteV2Discriminator {
		return errors.New("jupiter")
	}
	quoteResponse, err := localRequiredNode(sourceRoot, "quoteResponse")
	if err != nil || quoteResponse.objectEntries == nil {
		return errors.New("jupiter")
	}
	quoteResponseRaw, err := localRequiredNode(quoteResponse, "raw")
	if err != nil || quoteResponseRaw.objectEntries == nil {
		return errors.New("jupiter")
	}
	routePlan, err := localRequiredNode(quoteResponseRaw, "routePlan")
	if err != nil || routePlan.arrayItems == nil || len(routePlan.arrayItems) != 1 {
		return errors.New("jupiter")
	}
	routeEntry, err := localArrayNode(routePlan, 0)
	if err != nil {
		return err
	}
	swapInfo, err := localRequiredNode(routeEntry, "swapInfo")
	if err != nil || swapInfo.objectEntries == nil {
		return errors.New("jupiter")
	}
	quoteInput, err := localString(quoteResponse, "inputMint", false)
	if err != nil || !providerAddressEquals(quoteInput, facts.sourceTokenAddress) {
		return errors.New("jupiter")
	}
	quoteOutput, err := localString(quoteResponse, "outputMint", false)
	if err != nil || !providerAddressEquals(quoteOutput, facts.sourceUSDCAddress) {
		return errors.New("jupiter")
	}
	rawInput, err := localString(quoteResponseRaw, "inputMint", false)
	if err != nil || !providerAddressEquals(rawInput, facts.sourceTokenAddress) {
		return errors.New("jupiter")
	}
	rawOutput, err := localString(quoteResponseRaw, "outputMint", false)
	if err != nil || !providerAddressEquals(rawOutput, facts.sourceUSDCAddress) {
		return errors.New("jupiter")
	}
	swapInput, err := localString(swapInfo, "inputMint", false)
	if err != nil || !providerAddressEquals(swapInput, facts.sourceTokenAddress) {
		return errors.New("jupiter")
	}
	swapOutput, err := localString(swapInfo, "outputMint", false)
	if err != nil || !providerAddressEquals(swapOutput, facts.sourceUSDCAddress) {
		return errors.New("jupiter")
	}
	inAmount, err := localString(swapInfo, "inAmount", false)
	if err != nil {
		return errors.New("jupiter")
	}
	outAmount, err := localString(swapInfo, "outAmount", false)
	if err != nil {
		return errors.New("jupiter")
	}
	_, inputValue, err := localUint64String(inAmount, true)
	if err != nil {
		return errors.New("jupiter")
	}
	_, outputValue, err := localUint64String(outAmount, true)
	if err != nil {
		return errors.New("jupiter")
	}
	quoteAmount, err := strconv.ParseUint(quote.AmountIn, 10, 64)
	if err != nil {
		return errors.New("jupiter")
	}
	minimumValue, err := strconv.ParseUint(minimumIntermediate, 10, 64)
	if err != nil || inputValue != quoteAmount || outputValue < minimumValue {
		return errors.New("jupiter")
	}
	label, err := localString(swapInfo, "label", false)
	if err != nil {
		return errors.New("jupiter")
	}
	var expectedTail string
	var expectedCount int
	var expectedDex, expectedPool string
	switch label {
	case "Whirlpool":
		expectedTail, expectedCount, expectedDex, expectedPool = localSolanaWhirlpoolTail, 22, localSolanaWhirlpoolProgram, localSolanaWhirlpoolPool
	case "Raydium CLMM":
		expectedTail, expectedCount, expectedDex, expectedPool = localSolanaRaydiumTail, 25, localSolanaRaydiumProgram, localSolanaRaydiumPool
	default:
		return errors.New("jupiter")
	}
	tailBytes, err := localHexToBytes(expectedTail)
	if err != nil || len(data) != 28+len(tailBytes) || localBytesToHex(data[28:]) != expectedTail {
		return errors.New("jupiter")
	}
	if len(instruction.Accounts) != expectedCount {
		return errors.New("jupiter")
	}
	dex, err := localInstructionAccount(instruction, 10)
	if err != nil {
		return err
	}
	if err := localAssertInstructionAccount(dex, expectedDex, false, false); err != nil {
		return err
	}
	pool, err := localInstructionAccount(instruction, 13)
	if err != nil {
		return err
	}
	if err := localAssertInstructionAccount(pool, expectedPool, false, true); err != nil {
		return err
	}
	ammKey, err := localString(swapInfo, "ammKey", false)
	if err != nil || ammKey != expectedPool {
		return errors.New("jupiter")
	}
	if len(data) < 28 {
		return errors.New("jupiter")
	}
	inputAmount := binary.LittleEndian.Uint64(data[8:16])
	quotedOutput := binary.LittleEndian.Uint64(data[16:24])
	slippageBPS := binary.LittleEndian.Uint16(data[24:26])
	platformBPS := binary.LittleEndian.Uint16(data[26:28])
	if inputAmount != quoteAmount || quotedOutput < minimumValue || platformBPS != 0 || slippageBPS > 10_000 {
		return errors.New("jupiter")
	}
	traderEURC, err := localAssociatedTokenAddress(swapper, facts.sourceTokenAddress, false)
	if err != nil {
		return err
	}
	traderUSDC, err := localAssociatedTokenAddress(swapper, facts.sourceUSDCAddress, false)
	if err != nil {
		return err
	}
	expected := make([]MayanSwiftV2LocalSourceSwapInstructionAccount, 0, expectedCount)
	appendExpected := func(pubkey string, signer, writable bool) {
		expected = append(expected, MayanSwiftV2LocalSourceSwapInstructionAccount{Pubkey: pubkey, IsSigner: signer, IsWritable: writable})
	}
	appendExpected(swapper, true, false)
	appendExpected(traderEURC, false, true)
	appendExpected(traderUSDC, false, true)
	appendExpected(facts.sourceTokenAddress, false, false)
	appendExpected(facts.sourceUSDCAddress, false, false)
	appendExpected(localSolanaTokenProgram, false, false)
	appendExpected(localSolanaTokenProgram, false, false)
	appendExpected(stateTokenAccount, false, true)
	appendExpected(localSolanaAnchorEventAuthority, false, false)
	appendExpected(bridgeSolanaJupiterV6, false, false)
	if label == "Whirlpool" {
		appendExpected(localSolanaWhirlpoolProgram, false, false)
		appendExpected(localSolanaTokenProgram, false, false)
		appendExpected(swapper, false, false)
		appendExpected(localSolanaWhirlpoolPool, false, true)
		appendExpected(traderUSDC, false, true)
		appendExpected("6i68TM44UYSawGAS4Bx1vX31Af7QNZaRNBLUbc4r8exB", false, true)
		appendExpected(traderEURC, false, true)
		appendExpected("8aq9zUXe37KLtXSaEYt7oq65oNAJiu1my2kRNMRPhTD5", false, true)
		appendExpected("7qscKXFXCd1WQinZJvSDLsGLTTEwjmd88a871pz2V3Ja", false, true)
		appendExpected("CaohZGaBaLmXyFQ4cLc83wGZTET7Mt9xMtUqR9EGaMHF", false, true)
		appendExpected("7Mr4WYMiGPAXkyt9ePsHHmV6ust3U6dHwBmyfMRiHPA7", false, true)
		appendExpected("9BjNZYSCZ3ac3XUYVKte4YYtmBGd7ATKfRshTGN99NxQ", false, false)
	} else {
		appendExpected(localSolanaRaydiumProgram, false, false)
		appendExpected(swapper, false, false)
		appendExpected("9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x", false, false)
		appendExpected(localSolanaRaydiumPool, false, true)
		appendExpected(traderEURC, false, true)
		appendExpected(traderUSDC, false, true)
		appendExpected("GFwsANMCPK8W3WhqTnwVP8JiwHaAr3cNDe5TJqgHHSPe", false, true)
		appendExpected("ECw2X1TYbsrqFgdiYApNpn2ggznbj8pL5tREpY9Fb8jY", false, true)
		appendExpected("2UQncszfVU7igwDiGN3jq2sUKzziLxDZqNsJEXzEob5x", false, true)
		appendExpected(localSolanaTokenProgram, false, false)
		appendExpected("BVvv13QAQjPYKTWrpX7wQbhBAu3pbWwTb8P9SAqgRNKQ", false, true)
		appendExpected("4HSR9WBSHgw7n5V8WGYYhLW8g92RPSrgnf2CHzbeQrrr", false, true)
		appendExpected("HssFpWsQcNbJXBro1NVWCFAYEh8jp6NJV2nyFhE1zMGj", false, true)
		appendExpected("DKcmVcrXuiF5FZre6h8GqurR2sKChUGBakxdTX7dSDw9", false, true)
		appendExpected(bridgeSolanaJupiterV6, false, false)
	}
	if len(expected) != len(instruction.Accounts) {
		return errors.New("jupiter")
	}
	for index, want := range expected {
		if err := localAssertInstructionAccount(instruction.Accounts[index], want.Pubkey, want.IsSigner, want.IsWritable); err != nil {
			return err
		}
	}
	return nil
}

func localWrapCPIProxy(instruction MayanSwiftV2LocalSourceSwapInstruction) MayanSwiftV2LocalSourceSwapInstruction {
	accounts := make([]MayanSwiftV2LocalSourceSwapInstructionAccount, 0, len(instruction.Accounts)+1)
	accounts = append(accounts, MayanSwiftV2LocalSourceSwapInstructionAccount{Pubkey: instruction.ProgramID})
	accounts = append(accounts, instruction.Accounts...)
	return MayanSwiftV2LocalSourceSwapInstruction{ProgramID: localSolanaCPIProxyProgram, Accounts: accounts, DataBase64: instruction.DataBase64}
}

func localValidateSourceSwapEnvelope(quote MayanSwiftV2Quote, facts bridgeDirection, root *bridgeJSONNode, stateAddress, stateTokenAccount, swapper, minimumIntermediate string) (MayanSwiftV2LocalSourceSwapPlan, error) {
	if facts.asset == "usdc" {
		return MayanSwiftV2LocalSourceSwapPlan{}, errors.New("direct source swap")
	}
	if facts.sourceChainID == bridgeEthereumChainID {
		if !localExactObjectKeys(root, "swapRouterAddress", "swapRouterCalldata") {
			return MayanSwiftV2LocalSourceSwapPlan{}, errors.New("source swap")
		}
		routerValue, err := localString(root, "swapRouterAddress", false)
		if err != nil {
			return MayanSwiftV2LocalSourceSwapPlan{}, err
		}
		router, err := localNormalizeEVMAddress(routerValue)
		if err != nil {
			return MayanSwiftV2LocalSourceSwapPlan{}, err
		}
		if quote.SourceSwap.RouterAddress == nil || *quote.SourceSwap.RouterAddress != router || quote.SourceSwap.RouterKind == nil || *quote.SourceSwap.RouterKind != "provider-selected-evm" {
			return MayanSwiftV2LocalSourceSwapPlan{}, errors.New("source swap")
		}
		calldataValue, err := localString(root, "swapRouterCalldata", false)
		if err != nil {
			return MayanSwiftV2LocalSourceSwapPlan{}, err
		}
		calldata, err := localCanonicalHexBytes(calldataValue, false)
		if err != nil || len(calldata) > localMaxRouterCalldataBytes || !strings.HasPrefix(strings.ToLower(calldataValue), localEVMSourceSwapSelector) {
			return MayanSwiftV2LocalSourceSwapPlan{}, errors.New("source swap")
		}
		return MayanSwiftV2LocalSourceSwapPlan{Kind: "evm-router", RouterAddress: router, Calldata: "0x" + localBytesToHex(calldata), RawResponseSHA256: "", RawProviderSourceSwapJSON: ""}, nil
	}
	if value, present := localObjectValue(root, "tokenLedgerInstruction"); present && value != nil {
		return MayanSwiftV2LocalSourceSwapPlan{}, errors.New("source swap")
	}
	computeNode, err := localRequiredNode(root, "computeBudgetInstructions")
	if err != nil || computeNode.arrayItems == nil {
		return MayanSwiftV2LocalSourceSwapPlan{}, errors.New("source swap")
	}
	setupNode, err := localRequiredNode(root, "setupInstructions")
	if err != nil || setupNode.arrayItems == nil {
		return MayanSwiftV2LocalSourceSwapPlan{}, errors.New("source swap")
	}
	swapNode, err := localRequiredNode(root, "swapInstruction")
	if err != nil {
		return MayanSwiftV2LocalSourceSwapPlan{}, errors.New("source swap")
	}
	if value, present := localObjectValue(root, "cleanupInstruction"); present && value != nil {
		return MayanSwiftV2LocalSourceSwapPlan{}, errors.New("source swap")
	}
	otherNode, err := localRequiredNode(root, "otherInstructions")
	if err != nil || otherNode.arrayItems == nil || len(otherNode.arrayItems) != 0 {
		return MayanSwiftV2LocalSourceSwapPlan{}, errors.New("source swap")
	}
	if value, present := localObjectValue(root, "simulationError"); present && value != nil {
		return MayanSwiftV2LocalSourceSwapPlan{}, errors.New("source swap")
	}
	if value, present := localObjectValue(root, "separateSwapTx"); present && value != false {
		return MayanSwiftV2LocalSourceSwapPlan{}, errors.New("source swap")
	}
	if value, present := localObjectValue(root, "jito"); present && value != false && value != nil {
		return MayanSwiftV2LocalSourceSwapPlan{}, errors.New("source swap")
	}
	compute := make([]MayanSwiftV2LocalSourceSwapInstruction, len(computeNode.arrayItems))
	for index, node := range computeNode.arrayItems {
		compute[index], err = localInstructionFromNode(node)
		if err != nil {
			return MayanSwiftV2LocalSourceSwapPlan{}, err
		}
	}
	setup := make([]MayanSwiftV2LocalSourceSwapInstruction, len(setupNode.arrayItems))
	for index, node := range setupNode.arrayItems {
		setup[index], err = localInstructionFromNode(node)
		if err != nil {
			return MayanSwiftV2LocalSourceSwapPlan{}, err
		}
	}
	swap, err := localInstructionFromNode(swapNode)
	if err != nil {
		return MayanSwiftV2LocalSourceSwapPlan{}, err
	}
	if err := localValidateComputeInstructions(compute); err != nil {
		return MayanSwiftV2LocalSourceSwapPlan{}, err
	}
	if err := localValidateATASetup(setup, swapper, stateAddress, facts.sourceUSDCAddress); err != nil {
		return MayanSwiftV2LocalSourceSwapPlan{}, err
	}
	if err := localValidateJupiterInstruction(swap, facts, quote, stateTokenAccount, swapper, minimumIntermediate, root); err != nil {
		return MayanSwiftV2LocalSourceSwapPlan{}, err
	}
	altNode, err := localRequiredNode(root, "addressLookupTableAddresses")
	if err != nil || altNode.arrayItems == nil || len(altNode.arrayItems) > localMaxLookupTables {
		return MayanSwiftV2LocalSourceSwapPlan{}, errors.New("source swap")
	}
	alts := make([]string, len(altNode.arrayItems))
	for index, item := range altNode.arrayItems {
		value, itemErr := item.value.(string)
		if !itemErr {
			return MayanSwiftV2LocalSourceSwapPlan{}, errors.New("source swap")
		}
		canonical, _, addressErr := localCanonicalSolanaAddress(value)
		if addressErr != nil {
			return MayanSwiftV2LocalSourceSwapPlan{}, addressErr
		}
		alts[index] = canonical
	}
	if value, present := localObjectValue(root, "prioritizationFeeLamports"); present {
		if err := localSafeRawInteger(value, 0, math.MaxInt64); err != nil {
			return MayanSwiftV2LocalSourceSwapPlan{}, errors.New("source swap")
		}
	}
	if value, present := localObjectValue(root, "computeUnitLimit"); present {
		if err := localSafeRawInteger(value, 0, 1_400_000); err != nil {
			return MayanSwiftV2LocalSourceSwapPlan{}, errors.New("source swap")
		}
	}
	instructions := make([]MayanSwiftV2LocalSourceSwapInstruction, 0, len(compute)+len(setup)+1)
	instructions = append(instructions, compute...)
	instructions = append(instructions, setup...)
	instructions = append(instructions, swap)
	return MayanSwiftV2LocalSourceSwapPlan{Kind: "solana-jupiter-v6", Instructions: instructions, AddressLookupTableAddresses: alts, RawResponseSHA256: "", RawProviderSourceSwapJSON: ""}, nil
}

func localSafeRawInteger(value any, minimum, maximum int64) error {
	number, ok := value.(json.Number)
	if !ok {
		return errors.New("integer")
	}
	parsed, err := strconv.ParseInt(number.String(), 10, 64)
	if err != nil || parsed < minimum || parsed > maximum || strings.ContainsAny(number.String(), ".eE") {
		return errors.New("integer")
	}
	return nil
}

func localEndpointURL(value string) (*url.URL, error) {
	if value == "" {
		value = localSourceSwapEndpoint
	}
	if strings.TrimSpace(value) != value || value == "" || strings.ContainsAny(value, "?#") || !strings.Contains(value, "://") {
		return nil, errors.New("endpoint")
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("endpoint")
	}
	host := strings.ToLower(parsed.Hostname())
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "https" && !(scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1")) {
		return nil, errors.New("endpoint")
	}
	parsed.Scheme = scheme
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	parsed.RawPath = ""
	return parsed, nil
}

func localRPCConfigFor(runtime *mayanSwiftV2LocalRuntime, facts bridgeDirection) (localRPCConfig, error) {
	if runtime == nil || runtime.client == nil || runtime.client.config.localBuild == nil {
		return localRPCConfig{}, localError(BridgeLocalRPCRequired)
	}
	var endpoint *RPCEndpointConfig
	if facts.sourceChainID == bridgeEthereumChainID {
		endpoint = runtime.client.config.localBuild.EthereumRPC
	} else {
		endpoint = runtime.client.config.localBuild.SolanaRPC
	}
	if endpoint == nil || endpoint.HTTPURL == "" {
		return localRPCConfig{}, localError(BridgeLocalRPCRequired)
	}
	parsed, err := url.Parse(endpoint.HTTPURL)
	if err != nil || parsed.Host == "" || parsed.User != nil || (strings.ToLower(parsed.Scheme) != "http" && strings.ToLower(parsed.Scheme) != "https") {
		return localRPCConfig{}, localError(BridgeSourceRPCInvalidResponse)
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	parsed.RawPath = ""
	headers := endpoint.Headers.Clone()
	if headers == nil {
		headers = make(http.Header)
	}
	return localRPCConfig{Endpoint: parsed, Headers: headers}, nil
}

func localQueryEscape(value string) string {
	return url.QueryEscape(value)
}

func localSourceSwapURL(base *url.URL, chain string, params [][2]string) *url.URL {
	copyURL := *base
	prefix := strings.TrimRight(copyURL.Path, "/")
	copyURL.Path = prefix + "/get-swap/" + chain
	copyURL.RawPath = ""
	parts := make([]string, len(params))
	for index, pair := range params {
		parts[index] = localQueryEscape(pair[0]) + "=" + localQueryEscape(pair[1])
	}
	copyURL.RawQuery = strings.Join(parts, "&")
	return &copyURL
}

func localHTTPResponseBody(ctx context.Context, response *http.Response, timeout time.Duration, maxBytes int) (string, error) {
	if response == nil || response.Body == nil {
		return "", errors.New("response")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, int64(maxBytes)+1))
	if err != nil {
		if ctx != nil && ctx.Err() != nil {
			if ctx.Err() == context.DeadlineExceeded {
				return "", bridgeError(BridgeTimeout)
			}
			return "", bridgeError(BridgeAborted)
		}
		_ = timeout
		return "", errors.New("body")
	}
	if len(data) > maxBytes {
		return "", errors.New("body")
	}
	return string(data), nil
}

func localFetchSourceSwap(ctx context.Context, runtime *mayanSwiftV2LocalRuntime, endpoint *url.URL) (string, *bridgeJSONNode, error) {
	if runtime == nil || runtime.client == nil || runtime.client.config.httpClient == nil {
		return "", nil, localError(BridgeProviderTransport)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	requestContext, cancel := context.WithTimeout(ctx, runtime.client.config.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return "", nil, localError(BridgeProviderTransport)
	}
	request.Header.Set("Accept", "application/json")
	response, err := runtime.client.config.httpClient.Do(request)
	if err != nil {
		var bridgeErr *BridgeError
		if errors.As(err, &bridgeErr) && bridgeErr != nil {
			return "", nil, bridgeErr
		}
		if ctx.Err() != nil {
			if ctx.Err() == context.DeadlineExceeded {
				return "", nil, bridgeError(BridgeTimeout)
			}
			return "", nil, bridgeError(BridgeAborted)
		}
		if requestContext.Err() == context.DeadlineExceeded {
			return "", nil, bridgeError(BridgeTimeout)
		}
		if requestContext.Err() == context.Canceled {
			return "", nil, bridgeError(BridgeAborted)
		}
		return "", nil, localError(BridgeProviderTransport)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.Body != nil {
			_ = response.Body.Close()
		}
		return "", nil, bridgeHTTPError(BridgeProviderHTTP, response.StatusCode)
	}
	body, err := localHTTPResponseBody(requestContext, response, runtime.client.config.timeout, localMaxLocalResponseBytes)
	if err != nil {
		if bridgeCode(err) != "" {
			return "", nil, err
		}
		return "", nil, localError(BridgeProviderInvalidResponse)
	}
	root, err := parseBridgeJSON(body)
	if err != nil || root == nil || root.objectEntries == nil {
		return "", nil, localError(BridgeProviderInvalidResponse)
	}
	return body, root, nil
}

func localQuoteDeadlineValid(clock func() int64, deadline uint64, margin uint64) error {
	if clock == nil {
		clock = func() int64 { return time.Now().Unix() }
	}
	now := clock()
	if now < 0 || margin > ^uint64(0)-uint64(now) || deadline < uint64(now)+margin {
		return bridgeError(BridgeQuoteExpired)
	}
	return nil
}

func localPrepareSourceSwap(ctx context.Context, runtime *mayanSwiftV2LocalRuntime, contextValue MayanSwiftV2LocalContext) (MayanSwiftV2SourceSwapPlan, error) {
	if runtime == nil || runtime.client == nil {
		return MayanSwiftV2SourceSwapPlan{}, localError(BridgeLocalPlanInvalid)
	}
	quote, facts, parsed, err := localValidateRouteQuote(contextValue.Quote, runtime.client.config.quoteValidity, runtime.clock)
	if err != nil {
		return MayanSwiftV2SourceSwapPlan{}, err
	}
	normalizedContext, err := localNormalizeContextAddresses(contextValue, facts)
	if err != nil {
		return MayanSwiftV2SourceSwapPlan{}, localError(BridgeLocalPlanInvalid)
	}
	deadline, err := strconv.ParseUint(quote.Deadline, 10, 64)
	if err != nil {
		return MayanSwiftV2SourceSwapPlan{}, localError(BridgeLocalPlanInvalid)
	}
	if err := localValidateDestinationMinimumCompatibility(quote.MinimumAmountOut); err != nil {
		return MayanSwiftV2SourceSwapPlan{}, localError(BridgeLocalPlanInvalid)
	}
	if err := localQuoteDeadlineValid(runtime.clock, deadline, runtime.client.config.quoteValidity); err != nil {
		return MayanSwiftV2SourceSwapPlan{}, err
	}
	rawQuoteSHA256 := localSHA256Hex([]byte(quote.RawSignedQuoteJSON))
	orderHash, err := localOrderHash(quote, facts, normalizedContext.SwapperAddress, normalizedContext.DestinationAddress, normalizedContext.OrderNonce, parsed.cancelFee, parsed.refundFee, parsed.mode)
	if err != nil {
		return MayanSwiftV2SourceSwapPlan{}, localError(BridgeLocalPlanInvalid)
	}
	binding, err := localQuoteBindingHash(facts, quote, rawQuoteSHA256, normalizedContext.OrderNonce, normalizedContext.SwapperAddress, normalizedContext.DestinationAddress)
	if err != nil {
		return MayanSwiftV2SourceSwapPlan{}, localError(BridgeLocalPlanInvalid)
	}
	sourceSwap := MayanSwiftV2LocalSourceSwapPlan{Kind: "none"}
	if facts.asset != "usdc" {
		sourceSwapEndpoint := ""
		if runtime.client.config.localBuild != nil {
			sourceSwapEndpoint = runtime.client.config.localBuild.SourceSwapEndpoint
		}
		endpoint, err := localEndpointURL(sourceSwapEndpoint)
		if err != nil {
			return MayanSwiftV2SourceSwapPlan{}, localError(BridgeLocalPlanInvalid)
		}
		var sourceURL *url.URL
		if facts.sourceChainID == bridgeEthereumChainID {
			sourceURL = localSourceSwapURL(endpoint, "evm", [][2]string{
				{"forwarderAddress", localEthereumForwarderProvider},
				{"slippageBps", strconv.FormatUint(quote.SlippageBps, 10)},
				{"fromToken", parsed.rawFromTokenContract},
				{"middleToken", facts.sourceUSDCAddress},
				{"chainName", facts.sourceName},
				{"amountIn64", quote.AmountIn},
				{"sdkVersion", localMayanOracleSDKVersion},
			})
		} else {
			minimumLexeme := ""
			middleNode, middleErr := localRequiredNode(parsed.raw, "minMiddleAmount")
			if middleErr != nil {
				return MayanSwiftV2SourceSwapPlan{}, localError(BridgeLocalPlanInvalid)
			}
			minimumLexeme = middleNode.rawNumber
			minimumValue, parseErr := strconv.ParseFloat(minimumLexeme, 64)
			if parseErr != nil || math.IsNaN(minimumValue) || math.IsInf(minimumValue, 0) || minimumValue <= 0 {
				return MayanSwiftV2SourceSwapPlan{}, localError(BridgeLocalPlanInvalid)
			}
			state, _, stateErr := localFindProgramAddress([][]byte{[]byte("STATE_SOURCE"), mustLocalHexBytes(orderHash), localWriteUint16LE(2)}, bridgeSolanaSwiftProgram)
			if stateErr != nil {
				return MayanSwiftV2SourceSwapPlan{}, localError(BridgeLocalPlanInvalid)
			}
			sourceURL = localSourceSwapURL(endpoint, "solana", [][2]string{
				{"minMiddleAmount", strconv.FormatFloat(minimumValue, 'g', -1, 64)},
				{"middleToken", facts.sourceUSDCAddress},
				{"userWallet", normalizedContext.SwapperAddress},
				{"slippageBps", strconv.FormatUint(quote.SlippageBps, 10)},
				{"fromToken", facts.sourceTokenAddress},
				{"amountIn64", quote.AmountIn},
				{"depositMode", "SWIFT"},
				{"fillMaxAccounts", "false"},
				{"chainName", facts.sourceName},
				{"userLedger", state},
				{"sdkVersion", localMayanOracleSDKVersion},
			})
		}
		body, root, fetchErr := localFetchSourceSwap(ctx, runtime, sourceURL)
		if fetchErr != nil {
			return MayanSwiftV2SourceSwapPlan{}, fetchErr
		}
		state, stateToken, stateErr := "", "", error(nil)
		if facts.sourceChainID == bridgeSolanaChainID {
			state, _, stateErr = localFindProgramAddress([][]byte{[]byte("STATE_SOURCE"), mustLocalHexBytes(orderHash), localWriteUint16LE(2)}, bridgeSolanaSwiftProgram)
			if stateErr == nil {
				stateToken, stateErr = localAssociatedTokenAddress(state, facts.sourceUSDCAddress, true)
			}
		}
		if stateErr != nil {
			return MayanSwiftV2SourceSwapPlan{}, localError(BridgeLocalPlanInvalid)
		}
		validatedSwap, validateErr := localValidateSourceSwapEnvelope(quote, facts, root, state, stateToken, normalizedContext.SwapperAddress, parsed.minimumIntermediateAmount)
		if validateErr != nil {
			return MayanSwiftV2SourceSwapPlan{}, localError(BridgeLocalPlanInvalid)
		}
		validatedSwap.RawResponseSHA256 = localSHA256Hex([]byte(body))
		validatedSwap.RawProviderSourceSwapJSON = body
		sourceSwap = validatedSwap
	}
	planHashValue, err := localPlanHash(binding, sourceSwap)
	if err != nil {
		return MayanSwiftV2SourceSwapPlan{}, localError(BridgeLocalPlanInvalid)
	}
	return MayanSwiftV2SourceSwapPlan{
		PlanKind: "mayan-swift-v2-local-source-swap", ProviderID: "mayan-swift-v2", CapabilityID: facts.capabilityID,
		SourceChainID: facts.sourceChainID, DestinationChainID: facts.destinationChainID,
		SourceTokenDeploymentID: facts.sourceTokenDeployment, DestinationTokenDeploymentID: facts.destinationTokenDeployment,
		QuoteID: quote.QuoteID, RawQuoteSHA256: rawQuoteSHA256, OrderNonce: normalizedContext.OrderNonce,
		SwapperAddress: normalizedContext.SwapperAddress, DestinationAddress: normalizedContext.DestinationAddress,
		OrderHash: orderHash, QuoteBindingHash: binding, MinimumIntermediateAmount: parsed.minimumIntermediateAmount,
		SourceSwap: sourceSwap, PlanHash: planHashValue,
	}, nil
}

func mustLocalHexBytes(value string) []byte {
	bytes, _ := localHexToBytes(value)
	return bytes
}

func localRPCRequestBody(method, params string) string {
	return `{"jsonrpc":"2.0","id":1,"method":` + strconv.Quote(method) + `,"params":` + params + `}`
}

func localRPCRequest(ctx context.Context, runtime *mayanSwiftV2LocalRuntime, config localRPCConfig, method, params string) (*bridgeJSONNode, error) {
	if runtime == nil || runtime.client == nil || runtime.client.config.httpClient == nil {
		return nil, localError(BridgeSourceRPCTransport)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	requestContext, cancel := context.WithTimeout(ctx, runtime.client.config.timeout)
	defer cancel()
	body := localRPCRequestBody(method, params)
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, config.Endpoint.String(), strings.NewReader(body))
	if err != nil {
		return nil, localError(BridgeSourceRPCInvalidResponse)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	for name, values := range config.Headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	response, err := runtime.client.config.httpClient.Do(request)
	if err != nil {
		var bridgeErr *BridgeError
		if errors.As(err, &bridgeErr) && bridgeErr != nil {
			return nil, bridgeErr
		}
		if ctx.Err() != nil {
			if ctx.Err() == context.DeadlineExceeded {
				return nil, bridgeError(BridgeTimeout)
			}
			return nil, bridgeError(BridgeAborted)
		}
		if requestContext.Err() == context.DeadlineExceeded {
			return nil, bridgeError(BridgeTimeout)
		}
		if requestContext.Err() == context.Canceled {
			return nil, bridgeError(BridgeAborted)
		}
		return nil, localError(BridgeSourceRPCTransport)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.Body != nil {
			_ = response.Body.Close()
		}
		return nil, localError(BridgeSourceRPCTransport)
	}
	responseBody, err := localHTTPResponseBody(requestContext, response, runtime.client.config.timeout, localMaxLocalResponseBytes)
	if err != nil {
		if bridgeCode(err) != "" {
			return nil, err
		}
		return nil, localError(BridgeSourceRPCInvalidResponse)
	}
	root, err := parseBridgeJSON(responseBody)
	if err != nil || root == nil || root.objectEntries == nil {
		return nil, localError(BridgeSourceRPCInvalidResponse)
	}
	jsonrpc, err := localString(root, "jsonrpc", false)
	if err != nil || jsonrpc != "2.0" {
		return nil, localError(BridgeSourceRPCInvalidResponse)
	}
	idNode, err := localRequiredNode(root, "id")
	if err != nil {
		return nil, localError(BridgeSourceRPCInvalidResponse)
	}
	idNumber, ok := idNode.value.(json.Number)
	if !ok || idNumber.String() != "1" {
		return nil, localError(BridgeSourceRPCInvalidResponse)
	}
	if value, present := localObjectValue(root, "error"); present && value != nil {
		return nil, localError(BridgeSourceRPCInvalidResponse)
	}
	if _, present := localObjectValue(root, "result"); !present {
		return nil, localError(BridgeSourceRPCInvalidResponse)
	}
	return root, nil
}

func localRPCResultNode(root *bridgeJSONNode) (*bridgeJSONNode, error) {
	return localRequiredNode(root, "result")
}

func localHexBytesFromProvider(value string) ([]byte, error) {
	bytes, err := localCanonicalHexBytes(value, true)
	if err != nil {
		return nil, err
	}
	return bytes, nil
}

func localParseRPCSlot(node *bridgeJSONNode) (uint64, error) {
	value, err := localInteger(node, "slot")
	if err != nil || value < 0 {
		return 0, errors.New("slot")
	}
	return uint64(value), nil
}

func localParseRPCAccount(node *bridgeJSONNode) (data []byte, owner string, err error) {
	if node == nil || node.objectEntries == nil {
		return nil, "", errors.New("account")
	}
	executable, executablePresent := localObjectValue(node, "executable")
	if !executablePresent || executable != false {
		return nil, "", errors.New("account")
	}
	dataNode, err := localRequiredNode(node, "data")
	if err != nil || dataNode.arrayItems == nil || len(dataNode.arrayItems) != 2 {
		return nil, "", errors.New("account")
	}
	dataValue, ok := dataNode.arrayItems[0].value.(string)
	if !ok {
		return nil, "", errors.New("account")
	}
	encodingValue, ok := dataNode.arrayItems[1].value.(string)
	if !ok || encodingValue != "base64" {
		return nil, "", errors.New("account")
	}
	data, err = localBase64Decode(dataValue, 16*1024, true)
	if err != nil {
		return nil, "", err
	}
	ownerValue, err := localString(node, "owner", false)
	if err != nil {
		return nil, "", errors.New("account")
	}
	owner, _, err = localCanonicalSolanaAddress(ownerValue)
	if err != nil {
		return nil, "", errors.New("account")
	}
	return data, owner, nil
}

func localDecodeLookupTable(address string, data []byte, owner string, accountContextSlot uint64) (localSolanaLookupTable, error) {
	if owner != localSolanaLookupTableOwner || len(data) < 56 || (len(data)-56)%32 != 0 {
		return localSolanaLookupTable{}, errors.New("ALT")
	}
	if binary.LittleEndian.Uint32(data[0:4]) != 1 {
		return localSolanaLookupTable{}, errors.New("ALT")
	}
	deactivation := binary.LittleEndian.Uint64(data[4:12])
	if deactivation != ^uint64(0) {
		return localSolanaLookupTable{}, errors.New("ALT")
	}
	lastExtendedSlot := binary.LittleEndian.Uint64(data[12:20])
	if lastExtendedSlot > accountContextSlot {
		return localSolanaLookupTable{}, errors.New("ALT")
	}
	lastExtendedStartIndex := int(data[20])
	authorityOption := data[21]
	if authorityOption != 0 && authorityOption != 1 {
		return localSolanaLookupTable{}, errors.New("ALT")
	}
	if data[54] != 0 || data[55] != 0 {
		return localSolanaLookupTable{}, errors.New("ALT")
	}
	if authorityOption == 0 && !bridgeAllZero(data[22:54]) {
		return localSolanaLookupTable{}, errors.New("ALT")
	}
	addresses := make([][]byte, 0, (len(data)-56)/32)
	for offset := 56; offset < len(data); offset += 32 {
		addresses = append(addresses, append([]byte(nil), data[offset:offset+32]...))
	}
	if len(addresses) > localMaxLookupTableAddresses || lastExtendedStartIndex > len(addresses) {
		return localSolanaLookupTable{}, errors.New("ALT")
	}
	activeCount := len(addresses)
	if lastExtendedSlot == accountContextSlot {
		activeCount = lastExtendedStartIndex
	}
	addresses = addresses[:activeCount]
	return localSolanaLookupTable{Address: address, Addresses: addresses}, nil
}

func localLookupTableContains(table localSolanaLookupTable, address string) (int, bool) {
	_, target, err := localCanonicalSolanaAddress(address)
	if err != nil {
		return 0, false
	}
	for index, candidate := range table.Addresses {
		if bytes.Equal(candidate, target) {
			return index, true
		}
	}
	return 0, false
}

func localFetchSourceRPC(ctx context.Context, runtime *mayanSwiftV2LocalRuntime, facts bridgeDirection, plan MayanSwiftV2SourceSwapPlan) (localSourceRPCResult, error) {
	config, err := localRPCConfigFor(runtime, facts)
	if err != nil {
		return localSourceRPCResult{}, err
	}
	if facts.sourceChainID == bridgeEthereumChainID {
		chainRoot, err := localRPCRequest(ctx, runtime, config, "eth_chainId", "[]")
		if err != nil {
			return localSourceRPCResult{}, err
		}
		chainResult, resultErr := localRPCResultNode(chainRoot)
		if resultErr != nil {
			return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
		}
		chainID := localScalarString(chainResult)
		if strings.ToLower(chainID) != "0x1" {
			return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
		}
		addresses := []string{bridgeEthereumForwarder, facts.swiftContract}
		if plan.SourceSwap.Kind == "evm-router" {
			addresses = append(addresses, plan.SourceSwap.RouterAddress)
		}
		code := make([]MayanSwiftV2LocalEVMCodeEvidence, 0, len(addresses))
		for _, address := range addresses {
			params := "[" + strconv.Quote(strings.ToLower(address)) + ",\"latest\"]"
			root, callErr := localRPCRequest(ctx, runtime, config, "eth_getCode", params)
			if callErr != nil {
				return localSourceRPCResult{}, callErr
			}
			result := mustLocalRPCResult(root)
			bytecode, ok := result.value.(string)
			if !ok {
				return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
			}
			bytesValue, decodeErr := localHexBytesFromProvider(bytecode)
			if decodeErr != nil || len(bytesValue) == 0 {
				return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
			}
			normalized, normalizeErr := localNormalizeEVMAddress(address)
			if normalizeErr != nil {
				return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
			}
			code = append(code, MayanSwiftV2LocalEVMCodeEvidence{Address: normalized, Keccak256: "0x" + localKeccakHex(bytesValue)})
		}
		return localSourceRPCResult{Evidence: MayanSwiftV2LocalSourceRPCEvidence{Kind: "evm", RPCChainID: "0x1", Code: code}}, nil
	}
	genesisRoot, err := localRPCRequest(ctx, runtime, config, "getGenesisHash", "[]")
	if err != nil {
		return localSourceRPCResult{}, err
	}
	genesis := localScalarString(mustLocalRPCResult(genesisRoot))
	if genesis != localSolanaMainnetGenesis {
		return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
	}
	blockhashRoot, err := localRPCRequest(ctx, runtime, config, "getLatestBlockhash", "[{\"commitment\":\"confirmed\"}]")
	if err != nil {
		return localSourceRPCResult{}, err
	}
	blockhashResult, err := localRPCResultNode(blockhashRoot)
	if err != nil || blockhashResult.objectEntries == nil {
		return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
	}
	blockhashContext, err := localRequiredNode(blockhashResult, "context")
	if err != nil {
		return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
	}
	blockhashValue, err := localRequiredNode(blockhashResult, "value")
	if err != nil {
		return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
	}
	blockhashSlot, err := localParseRPCSlot(blockhashContext)
	if err != nil {
		return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
	}
	recentBlockhash, err := localString(blockhashValue, "blockhash", false)
	if err != nil {
		return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
	}
	if _, _, err := localCanonicalSolanaAddress(recentBlockhash); err != nil {
		return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
	}
	lastValid, err := localInteger(blockhashValue, "lastValidBlockHeight")
	if err != nil || lastValid < 0 {
		return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
	}
	providerAlts := []string{}
	if plan.SourceSwap.Kind == "solana-jupiter-v6" {
		providerAlts = append(providerAlts, plan.SourceSwap.AddressLookupTableAddresses...)
	}
	altAddresses := make([]string, 0, len(providerAlts)+1)
	seen := make(map[string]struct{}, len(providerAlts)+1)
	for _, address := range append([]string{localSolanaMayanLookupTable}, providerAlts...) {
		if _, exists := seen[address]; exists {
			continue
		}
		seen[address] = struct{}{}
		altAddresses = append(altAddresses, address)
	}
	if len(altAddresses) > localMaxLookupTables {
		return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
	}
	addressJSON, _ := json.Marshal(altAddresses)
	params := "[" + string(addressJSON) + ",{\"encoding\":\"base64\",\"commitment\":\"confirmed\",\"minContextSlot\":" + strconv.FormatUint(blockhashSlot, 10) + "}]"
	accountsRoot, err := localRPCRequest(ctx, runtime, config, "getMultipleAccounts", params)
	if err != nil {
		return localSourceRPCResult{}, err
	}
	accountsResult, err := localRPCResultNode(accountsRoot)
	if err != nil || accountsResult.objectEntries == nil {
		return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
	}
	accountContext, err := localRequiredNode(accountsResult, "context")
	if err != nil {
		return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
	}
	accountValues, err := localRequiredNode(accountsResult, "value")
	if err != nil || accountValues.arrayItems == nil || len(accountValues.arrayItems) != len(altAddresses) {
		return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
	}
	accountSlot, err := localParseRPCSlot(accountContext)
	if err != nil || accountSlot < blockhashSlot {
		return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
	}
	lookupTables := make([]localSolanaLookupTable, len(altAddresses))
	evidenceTables := make([]MayanSwiftV2LocalLookupTableEvidence, len(altAddresses))
	for index, accountNode := range accountValues.arrayItems {
		data, owner, parseErr := localParseRPCAccount(accountNode)
		if parseErr != nil {
			return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
		}
		lookupTables[index], parseErr = localDecodeLookupTable(altAddresses[index], data, owner, accountSlot)
		if parseErr != nil {
			return localSourceRPCResult{}, localError(BridgeSourceRPCInvalidResponse)
		}
		evidenceTables[index] = MayanSwiftV2LocalLookupTableEvidence{Address: altAddresses[index], DataSHA256: localSHA256Hex(data)}
	}
	return localSourceRPCResult{
		Evidence: MayanSwiftV2LocalSourceRPCEvidence{
			Kind: "solana", GenesisHash: genesis, BlockhashContextSlot: strconv.FormatUint(blockhashSlot, 10),
			AccountContextSlot: strconv.FormatUint(accountSlot, 10), RecentBlockhash: recentBlockhash,
			LastValidBlockHeight: strconv.FormatInt(lastValid, 10), LookupTables: evidenceTables,
		},
		LookupTables: lookupTables, RecentBlockhash: recentBlockhash,
	}, nil
}

func mustLocalRPCResult(root *bridgeJSONNode) *bridgeJSONNode {
	result, _ := localRPCResultNode(root)
	if result == nil {
		return &bridgeJSONNode{}
	}
	return result
}

func localScalarString(node *bridgeJSONNode) string {
	if node == nil {
		return ""
	}
	value, _ := node.value.(string)
	return value
}

func localEncodeShortVec(value int) ([]byte, error) {
	if value < 0 || value > 0xffff {
		return nil, errors.New("shortvec")
	}
	result := make([]byte, 0, 3)
	current := value
	for {
		element := byte(current & 0x7f)
		current >>= 7
		if current != 0 {
			element |= 0x80
		}
		result = append(result, element)
		if current == 0 {
			return result, nil
		}
	}
}

func localMakeATAInstruction(swapper, owner, mint string, allowOwnerOffCurve bool) (MayanSwiftV2LocalSourceSwapInstruction, error) {
	ata, err := localAssociatedTokenAddress(owner, mint, allowOwnerOffCurve)
	if err != nil {
		return MayanSwiftV2LocalSourceSwapInstruction{}, err
	}
	return MayanSwiftV2LocalSourceSwapInstruction{
		ProgramID: localSolanaAssociatedTokenProgram,
		Accounts: []MayanSwiftV2LocalSourceSwapInstructionAccount{
			{Pubkey: swapper, IsSigner: true, IsWritable: true},
			{Pubkey: ata, IsWritable: true},
			{Pubkey: owner},
			{Pubkey: mint},
			{Pubkey: localSolanaSystemProgram},
			{Pubkey: localSolanaTokenProgram},
			{Pubkey: localSolanaSysvarRent},
		},
		DataBase64: base64.StdEncoding.EncodeToString([]byte{1}),
	}, nil
}

func localMakeSPLTransferInstruction(source, destination, owner string, amount uint64) MayanSwiftV2LocalSourceSwapInstruction {
	data := append([]byte{3}, localWriteUint64LE(amount)...)
	return MayanSwiftV2LocalSourceSwapInstruction{
		ProgramID: localSolanaTokenProgram,
		Accounts: []MayanSwiftV2LocalSourceSwapInstructionAccount{
			{Pubkey: source, IsWritable: true},
			{Pubkey: destination, IsWritable: true},
			{Pubkey: owner, IsSigner: true},
		},
		DataBase64: base64.StdEncoding.EncodeToString(data),
	}
}

func localMakeComputeUnitPriceInstruction(value uint64) MayanSwiftV2LocalSourceSwapInstruction {
	data := append([]byte{3}, localWriteUint64LE(value)...)
	return MayanSwiftV2LocalSourceSwapInstruction{ProgramID: localSolanaComputeBudgetProgram, DataBase64: base64.StdEncoding.EncodeToString(data)}
}

func localMakeSwiftInitInstruction(quote MayanSwiftV2Quote, facts bridgeDirection, swapper, destination, state, stateToken, minimumIntermediate string, cancelFee, refundFee, submitFee uint64, mode uint8, orderNonce string) (MayanSwiftV2LocalSourceSwapInstruction, error) {
	minimum, err := strconv.ParseUint(minimumIntermediate, 10, 64)
	if err != nil || minimum == 0 {
		return MayanSwiftV2LocalSourceSwapInstruction{}, errors.New("init")
	}
	destinationMinimum, err := strconv.ParseUint(quote.MinimumAmountOut, 10, 64)
	if err != nil || destinationMinimum == 0 {
		return MayanSwiftV2LocalSourceSwapInstruction{}, errors.New("init")
	}
	deadline, err := strconv.ParseUint(quote.Deadline, 10, 64)
	if err != nil || deadline == 0 {
		return MayanSwiftV2LocalSourceSwapInstruction{}, errors.New("init")
	}
	destinationBytes, err := localNativeAddressBytes(destination, facts.destinationChainID)
	if err != nil || len(destinationBytes) != 32 {
		return MayanSwiftV2LocalSourceSwapInstruction{}, errors.New("init")
	}
	destinationTokenBytes, err := localNativeAddressBytes(facts.destinationTokenAddress, facts.destinationChainID)
	if err != nil || len(destinationTokenBytes) != 32 {
		return MayanSwiftV2LocalSourceSwapInstruction{}, errors.New("init")
	}
	random, err := localSwiftRandom(quote.QuoteID, orderNonce)
	if err != nil {
		return MayanSwiftV2LocalSourceSwapInstruction{}, err
	}
	relayerAccount, err := localAssociatedTokenAddress(swapper, facts.sourceUSDCAddress, false)
	if err != nil {
		return MayanSwiftV2LocalSourceSwapInstruction{}, err
	}
	data := make([]byte, 198)
	discriminator, _ := localHexToBytes(localSolanaInitOrderDiscriminator)
	copy(data[0:8], discriminator)
	copy(data[8:16], localWriteUint64LE(minimum))
	data[16] = 0
	copy(data[17:25], localWriteUint64LE(submitFee))
	copy(data[25:57], destinationBytes)
	copy(data[57:59], localWriteUint16LE(uint16(facts.destinationWormholeChainID)))
	copy(data[59:91], destinationTokenBytes)
	copy(data[91:99], localWriteUint64LE(destinationMinimum))
	copy(data[99:107], localWriteUint64LE(0))
	copy(data[107:115], localWriteUint64LE(cancelFee))
	copy(data[115:123], localWriteUint64LE(refundFee))
	copy(data[123:131], localWriteUint64LE(deadline))
	copy(data[131:163], make([]byte, 32))
	data[163] = 0
	data[164] = 0
	data[165] = mode
	copy(data[166:198], random)
	return MayanSwiftV2LocalSourceSwapInstruction{
		ProgramID: bridgeSolanaSwiftProgram,
		Accounts: []MayanSwiftV2LocalSourceSwapInstructionAccount{
			{Pubkey: swapper},
			{Pubkey: swapper, IsSigner: true, IsWritable: true},
			{Pubkey: state, IsWritable: true},
			{Pubkey: stateToken, IsWritable: true},
			{Pubkey: relayerAccount, IsWritable: true},
			{Pubkey: bridgeSolanaSwiftProgram},
			{Pubkey: facts.sourceUSDCAddress},
			{Pubkey: localSolanaFeeManagerProgram},
			{Pubkey: localSolanaTokenProgram},
			{Pubkey: localSolanaSystemProgram},
		},
		DataBase64: base64.StdEncoding.EncodeToString(data),
	}, nil
}

func localBuildSolanaInstructions(quote MayanSwiftV2Quote, facts bridgeDirection, plan MayanSwiftV2SourceSwapPlan, swapper, destination, minimumIntermediate string, cancelFee, refundFee, submitFee uint64, mode uint8, orderNonce string, raw *bridgeJSONNode) ([]MayanSwiftV2LocalSourceSwapInstruction, error) {
	orderHash, err := localOrderHash(quote, facts, swapper, destination, orderNonce, cancelFee, refundFee, mode)
	if err != nil {
		return nil, err
	}
	state, _, err := localFindProgramAddress([][]byte{[]byte("STATE_SOURCE"), mustLocalHexBytes(orderHash), localWriteUint16LE(2)}, bridgeSolanaSwiftProgram)
	if err != nil {
		return nil, err
	}
	stateToken, err := localAssociatedTokenAddress(state, facts.sourceUSDCAddress, true)
	if err != nil {
		return nil, err
	}
	init, err := localMakeSwiftInitInstruction(quote, facts, swapper, destination, state, stateToken, minimumIntermediate, cancelFee, refundFee, submitFee, mode, orderNonce)
	if err != nil {
		return nil, err
	}
	if facts.asset == "usdc" {
		instructions := make([]MayanSwiftV2LocalSourceSwapInstruction, 0, 4)
		if raw != nil {
			if value, present := localObjectValue(raw, "suggestedPriorityFee"); present {
				if number, ok := value.(json.Number); ok && number.String() != "" {
					priority, parseErr := strconv.ParseUint(number.String(), 10, 64)
					if parseErr == nil && priority > 0 {
						if priority > 100_000 {
							return nil, errors.New("compute")
						}
						instructions = append(instructions, localMakeComputeUnitPriceInstruction(priority))
					}
				}
			}
		}
		stateATA, err := localMakeATAInstruction(swapper, state, facts.sourceUSDCAddress, true)
		if err != nil {
			return nil, err
		}
		traderATA, err := localAssociatedTokenAddress(swapper, facts.sourceUSDCAddress, false)
		if err != nil {
			return nil, err
		}
		instructions = append(instructions, localWrapCPIProxy(stateATA), localWrapCPIProxy(localMakeSPLTransferInstruction(traderATA, stateToken, swapper, mustLocalUint64(quote.AmountIn))), localWrapCPIProxy(init))
		return instructions, nil
	}
	if plan.SourceSwap.Kind != "solana-jupiter-v6" {
		return nil, errors.New("plan")
	}
	computeCount := 0
	for computeCount < len(plan.SourceSwap.Instructions) && plan.SourceSwap.Instructions[computeCount].ProgramID == localSolanaComputeBudgetProgram {
		computeCount++
	}
	for _, instruction := range plan.SourceSwap.Instructions[:computeCount] {
		if instruction.ProgramID != localSolanaComputeBudgetProgram {
			return nil, errors.New("source swap")
		}
	}
	remainder := plan.SourceSwap.Instructions[computeCount:]
	swapIndex := -1
	for index, instruction := range remainder {
		if instruction.ProgramID == bridgeSolanaJupiterV6 {
			swapIndex = index
			break
		}
	}
	if swapIndex < 1 || swapIndex != len(remainder)-1 {
		return nil, errors.New("source swap")
	}
	instructions := append([]MayanSwiftV2LocalSourceSwapInstruction(nil), plan.SourceSwap.Instructions[:computeCount]...)
	for _, instruction := range remainder[:swapIndex] {
		instructions = append(instructions, localWrapCPIProxy(instruction))
	}
	instructions = append(instructions, remainder[swapIndex], localWrapCPIProxy(init))
	return instructions, nil
}

func mustLocalUint64(value string) uint64 {
	parsed, _ := strconv.ParseUint(value, 10, 64)
	return parsed
}

func localBuildEVMOrderCall(quote MayanSwiftV2Quote, facts bridgeDirection, plan MayanSwiftV2SourceSwapPlan, swapper, destination, minimumIntermediate string, cancelFee, refundFee uint64, mode uint8, orderNonce string) (string, error) {
	destinationMinimum, err := strconv.ParseUint(quote.MinimumAmountOut, 10, 64)
	if err != nil || destinationMinimum == 0 {
		return "", errors.New("order")
	}
	deadline, err := strconv.ParseUint(quote.Deadline, 10, 64)
	if err != nil || deadline == 0 {
		return "", errors.New("order")
	}
	swapperBytes, err := localNativeAddressBytes(swapper, facts.sourceChainID)
	if err != nil {
		return "", err
	}
	destinationBytes, err := localNativeAddressBytes(destination, facts.destinationChainID)
	if err != nil {
		return "", err
	}
	destinationTokenBytes, err := localNativeAddressBytes(facts.destinationTokenAddress, facts.destinationChainID)
	if err != nil {
		return "", err
	}
	random, err := localSwiftRandom(quote.QuoteID, orderNonce)
	if err != nil {
		return "", err
	}
	orderWords := [][]byte{
		localWordUint(1), swapperBytes, destinationBytes, localWordUint(uint64(facts.destinationWormholeChainID)), make([]byte, 32), destinationTokenBytes,
		localWordUint(destinationMinimum), localWordUint(0), localWordUint(cancelFee), localWordUint(refundFee), localWordUint(deadline), make([]byte, 32), localWordUint(uint64(mode)), random,
	}
	amountIn, err := strconv.ParseUint(quote.AmountIn, 10, 64)
	if err != nil || amountIn == 0 {
		return "", errors.New("amount")
	}
	swiftHead := [][]byte{}
	sourceUSDCWord, err := localWordAddress(facts.sourceUSDCAddress)
	if err != nil {
		return "", err
	}
	swiftHead = append(swiftHead, sourceUSDCWord, localWordUint(amountIn))
	swiftHead = append(swiftHead, orderWords...)
	swiftCall := localConcat([]byte{0xa3, 0xa3, 0x08, 0x34}, localEncodeABIWithDynamics(swiftHead, [][]byte{{}}))
	if plan.SourceSwap.Kind == "none" {
		swiftTarget, err := localWordAddress(facts.swiftContract)
		if err != nil {
			return "", err
		}
		outerHead := [][]byte{sourceUSDCWord, localWordUint(amountIn), localWordUint(0), localWordUint(0), localWordUint(0), make([]byte, 32), make([]byte, 32), swiftTarget}
		outer := localEncodeABIWithDynamics(outerHead, [][]byte{swiftCall})
		return "0xe4269fc4" + localBytesToHex(outer), nil
	}
	if plan.SourceSwap.Kind != "evm-router" {
		return "", errors.New("plan")
	}
	routerData, err := localCanonicalHexBytes(plan.SourceSwap.Calldata, false)
	if err != nil || len(routerData) > localMaxRouterCalldataBytes {
		return "", errors.New("router")
	}
	minimum, err := strconv.ParseUint(minimumIntermediate, 10, 64)
	if err != nil || minimum == 0 {
		return "", errors.New("minimum")
	}
	routerAddress, err := localWordAddress(plan.SourceSwap.RouterAddress)
	if err != nil {
		return "", err
	}
	middleAddress, err := localWordAddress(facts.sourceUSDCAddress)
	if err != nil {
		return "", err
	}
	swiftAddress, err := localWordAddress(facts.swiftContract)
	if err != nil {
		return "", err
	}
	sourceTokenAddress, err := localWordAddress(facts.sourceTokenAddress)
	if err != nil {
		return "", err
	}
	routerOffset := uint64(13 * 32)
	swiftOffset := routerOffset + 32 + uint64(len(localPad32(routerData)))
	outerHead := [][]byte{
		sourceTokenAddress, localWordUint(amountIn), localWordUint(0), localWordUint(0), localWordUint(0), make([]byte, 32), make([]byte, 32), routerAddress, localWordUint(routerOffset), middleAddress, localWordUint(minimum), swiftAddress, localWordUint(swiftOffset),
	}
	outer := localConcat(append(append(outerHead, localEncodeABIBytes(routerData)), localEncodeABIBytes(swiftCall))...)
	return "0x30dedc57" + localBytesToHex(outer), nil
}

func localCompileSolanaV0(payer, recentBlockhash string, instructions []MayanSwiftV2LocalSourceSwapInstruction, tables []localSolanaLookupTable) (string, error) {
	keys := make([]string, 0)
	meta := make(map[string]*localKeyMeta)
	getOrInsert := func(address string) *localKeyMeta {
		if existing, ok := meta[address]; ok {
			return existing
		}
		value := &localKeyMeta{}
		meta[address] = value
		keys = append(keys, address)
		return value
	}
	payerMeta := getOrInsert(payer)
	payerMeta.Signer = true
	payerMeta.Writable = true
	for _, instruction := range instructions {
		getOrInsert(instruction.ProgramID).Invoked = true
		for _, account := range instruction.Accounts {
			value := getOrInsert(account.Pubkey)
			if account.IsSigner {
				value.Signer = true
			}
			if account.IsWritable {
				value.Writable = true
			}
		}
	}
	active := make(map[string]bool, len(keys))
	for _, key := range keys {
		active[key] = true
	}
	writableLookupKeys := make([]string, 0)
	readonlyLookupKeys := make([]string, 0)
	lookups := make([]localAddressTableLookup, 0)
	for _, table := range tables {
		writableIndexes := make([]uint8, 0)
		readonlyIndexes := make([]uint8, 0)
		for _, address := range keys {
			if !active[address] {
				continue
			}
			value := meta[address]
			if value == nil || value.Signer || value.Invoked || !value.Writable {
				continue
			}
			index, found := localLookupTableContains(table, address)
			if !found || index > 255 {
				continue
			}
			writableIndexes = append(writableIndexes, uint8(index))
			writableLookupKeys = append(writableLookupKeys, address)
			active[address] = false
		}
		for _, address := range keys {
			if !active[address] {
				continue
			}
			value := meta[address]
			if value == nil || value.Signer || value.Invoked || value.Writable {
				continue
			}
			index, found := localLookupTableContains(table, address)
			if !found || index > 255 {
				continue
			}
			readonlyIndexes = append(readonlyIndexes, uint8(index))
			readonlyLookupKeys = append(readonlyLookupKeys, address)
			active[address] = false
		}
		if len(writableIndexes) > 0 || len(readonlyIndexes) > 0 {
			lookups = append(lookups, localAddressTableLookup{AccountKey: table.Address, WritableIndexes: writableIndexes, ReadonlyIndexes: readonlyIndexes})
		}
	}
	if len(activeKeys(active)) > 256 || len(lookups) > localMaxLookupTables {
		return "", errors.New("keys")
	}
	remaining := make([]string, 0, len(keys))
	for _, key := range keys {
		if active[key] {
			remaining = append(remaining, key)
		}
	}
	writableSigners := make([]string, 0)
	readonlySigners := make([]string, 0)
	writableNonSigners := make([]string, 0)
	readonlyNonSigners := make([]string, 0)
	for _, key := range remaining {
		value := meta[key]
		if value.Signer && value.Writable {
			writableSigners = append(writableSigners, key)
		} else if value.Signer {
			readonlySigners = append(readonlySigners, key)
		} else if value.Writable {
			writableNonSigners = append(writableNonSigners, key)
		} else {
			readonlyNonSigners = append(readonlyNonSigners, key)
		}
	}
	if len(writableSigners) == 0 || writableSigners[0] != payer {
		return "", errors.New("payer")
	}
	staticKeys := append(append(append(append([]string(nil), writableSigners...), readonlySigners...), writableNonSigners...), readonlyNonSigners...)
	allKeys := append(append([]string(nil), staticKeys...), writableLookupKeys...)
	allKeys = append(allKeys, readonlyLookupKeys...)
	if len(allKeys) > 256 {
		return "", errors.New("key indexes")
	}
	keyIndexes := make(map[string]uint8, len(allKeys))
	for index, key := range allKeys {
		keyIndexes[key] = uint8(index)
	}
	compiled := make([]localCompiledInstruction, len(instructions))
	for index, instruction := range instructions {
		programIndex, ok := keyIndexes[instruction.ProgramID]
		if !ok {
			return "", errors.New("program index")
		}
		accountIndexes := make([]uint8, len(instruction.Accounts))
		for accountIndex, account := range instruction.Accounts {
			keyIndex, found := keyIndexes[account.Pubkey]
			if !found {
				return "", errors.New("account index")
			}
			accountIndexes[accountIndex] = keyIndex
		}
		data, err := localBase64Decode(instruction.DataBase64, localMaxSolanaSwapDataBytes, true)
		if err != nil {
			return "", errors.New("instruction data")
		}
		compiled[index] = localCompiledInstruction{ProgramIDIndex: programIndex, AccountIndexes: accountIndexes, Data: data}
	}
	recentHash, _, err := localCanonicalSolanaAddress(recentBlockhash)
	if err != nil {
		return "", err
	}
	staticBytes := make([]byte, 0)
	for _, key := range staticKeys {
		_, bytesValue, err := localCanonicalSolanaAddress(key)
		if err != nil {
			return "", err
		}
		staticBytes = append(staticBytes, bytesValue...)
	}
	blockhashBytes := mustBase58Bytes(recentHash)
	compiledInstructionBytes, err := localEncodeCompiledInstructions(compiled)
	if err != nil {
		return "", err
	}
	lookupBytes, err := localEncodeAddressTableLookups(lookups)
	if err != nil {
		return "", err
	}
	header := []byte{byte(len(writableSigners) + len(readonlySigners)), byte(len(readonlySigners)), byte(len(readonlyNonSigners))}
	staticCount, err := localEncodeShortVec(len(staticKeys))
	if err != nil {
		return "", err
	}
	message := localConcat([]byte{0x80}, header, staticCount, staticBytes, blockhashBytes, compiledInstructionBytes, lookupBytes)
	signatureCount := len(writableSigners) + len(readonlySigners)
	signaturePrefix, err := localEncodeShortVec(signatureCount)
	if err != nil {
		return "", err
	}
	transaction := localConcat(signaturePrefix, make([]byte, signatureCount*64), message)
	if len(transaction) > localMaxSolanaTransactionBytes {
		return "", errors.New("transaction size")
	}
	return base64.StdEncoding.EncodeToString(transaction), nil
}

func activeKeys(active map[string]bool) []string {
	result := make([]string, 0, len(active))
	for key, value := range active {
		if value {
			result = append(result, key)
		}
	}
	return result
}

func localEncodeCompiledInstructions(instructions []localCompiledInstruction) ([]byte, error) {
	prefix, err := localEncodeShortVec(len(instructions))
	if err != nil {
		return nil, err
	}
	result := append([]byte(nil), prefix...)
	for _, instruction := range instructions {
		accountCount, err := localEncodeShortVec(len(instruction.AccountIndexes))
		if err != nil {
			return nil, err
		}
		dataCount, err := localEncodeShortVec(len(instruction.Data))
		if err != nil {
			return nil, err
		}
		result = append(result, instruction.ProgramIDIndex)
		result = append(result, accountCount...)
		result = append(result, instruction.AccountIndexes...)
		result = append(result, dataCount...)
		result = append(result, instruction.Data...)
	}
	return result, nil
}

func localEncodeAddressTableLookups(lookups []localAddressTableLookup) ([]byte, error) {
	prefix, err := localEncodeShortVec(len(lookups))
	if err != nil {
		return nil, err
	}
	result := append([]byte(nil), prefix...)
	for _, lookup := range lookups {
		address, ok := bridgeBase58Decode(lookup.AccountKey, 32)
		if !ok {
			return nil, errors.New("ALT")
		}
		writableCount, err := localEncodeShortVec(len(lookup.WritableIndexes))
		if err != nil {
			return nil, err
		}
		readonlyCount, err := localEncodeShortVec(len(lookup.ReadonlyIndexes))
		if err != nil {
			return nil, err
		}
		result = append(result, address...)
		result = append(result, writableCount...)
		result = append(result, lookup.WritableIndexes...)
		result = append(result, readonlyCount...)
		result = append(result, lookup.ReadonlyIndexes...)
	}
	return result, nil
}

func localCloneSourceSwapPlan(plan MayanSwiftV2LocalSourceSwapPlan) MayanSwiftV2LocalSourceSwapPlan {
	copyPlan := plan
	copyPlan.AddressLookupTableAddresses = append([]string(nil), plan.AddressLookupTableAddresses...)
	if plan.Instructions != nil {
		copyPlan.Instructions = make([]MayanSwiftV2LocalSourceSwapInstruction, len(plan.Instructions))
		for index, instruction := range plan.Instructions {
			copyPlan.Instructions[index] = instruction
			if instruction.Accounts != nil {
				copyPlan.Instructions[index].Accounts = make([]MayanSwiftV2LocalSourceSwapInstructionAccount, len(instruction.Accounts))
				copy(copyPlan.Instructions[index].Accounts, instruction.Accounts)
			}
		}
	}
	return copyPlan
}

func localCloneSourceSwapPlanDTO(plan MayanSwiftV2SourceSwapPlan) MayanSwiftV2SourceSwapPlan {
	plan.SourceSwap = localCloneSourceSwapPlan(plan.SourceSwap)
	return plan
}

func localValidatePlan(request MayanSwiftV2LocalBuildRequest, facts bridgeDirection, parsed localParsedQuote, plan MayanSwiftV2SourceSwapPlan, rawQuoteSHA256, orderHash, binding, swapper, destination string) (MayanSwiftV2SourceSwapPlan, error) {
	if plan.PlanKind != "mayan-swift-v2-local-source-swap" || plan.ProviderID != "mayan-swift-v2" ||
		plan.CapabilityID != facts.capabilityID || plan.SourceChainID != facts.sourceChainID || plan.DestinationChainID != facts.destinationChainID ||
		plan.SourceTokenDeploymentID != facts.sourceTokenDeployment || plan.DestinationTokenDeploymentID != facts.destinationTokenDeployment ||
		plan.QuoteID != request.Quote.QuoteID || plan.RawQuoteSHA256 != rawQuoteSHA256 || plan.OrderNonce != request.OrderNonce ||
		plan.SwapperAddress != swapper || plan.DestinationAddress != destination || plan.OrderHash != orderHash || plan.QuoteBindingHash != binding ||
		plan.MinimumIntermediateAmount != parsed.minimumIntermediateAmount {
		return MayanSwiftV2SourceSwapPlan{}, errors.New("plan")
	}
	if facts.asset == "usdc" {
		if plan.SourceSwap.Kind != "none" || plan.SourceSwap.RouterAddress != "" || plan.SourceSwap.Calldata != "" || len(plan.SourceSwap.Instructions) != 0 || len(plan.SourceSwap.AddressLookupTableAddresses) != 0 || plan.SourceSwap.RawResponseSHA256 != "" || plan.SourceSwap.RawProviderSourceSwapJSON != "" {
			return MayanSwiftV2SourceSwapPlan{}, errors.New("plan")
		}
	} else {
		state, stateToken := "", ""
		var err error
		if facts.sourceChainID == bridgeSolanaChainID {
			state, _, err = localFindProgramAddress([][]byte{[]byte("STATE_SOURCE"), mustLocalHexBytes(orderHash), localWriteUint16LE(2)}, bridgeSolanaSwiftProgram)
			if err == nil {
				stateToken, err = localAssociatedTokenAddress(state, facts.sourceUSDCAddress, true)
			}
		}
		if err != nil || plan.SourceSwap.Kind == "none" {
			return MayanSwiftV2SourceSwapPlan{}, errors.New("plan")
		}
		sourceRoot, parseErr := parseBridgeJSON(plan.SourceSwap.RawProviderSourceSwapJSON)
		if parseErr != nil || sourceRoot == nil || sourceRoot.objectEntries == nil || sourceRoot.start != 0 || sourceRoot.end != len(plan.SourceSwap.RawProviderSourceSwapJSON) {
			return MayanSwiftV2SourceSwapPlan{}, errors.New("plan")
		}
		expected, validateErr := localValidateSourceSwapEnvelope(request.Quote, facts, sourceRoot, state, stateToken, swapper, parsed.minimumIntermediateAmount)
		if validateErr != nil {
			return MayanSwiftV2SourceSwapPlan{}, errors.New("plan")
		}
		if plan.SourceSwap.RawResponseSHA256 != localSHA256Hex([]byte(plan.SourceSwap.RawProviderSourceSwapJSON)) {
			return MayanSwiftV2SourceSwapPlan{}, errors.New("plan")
		}
		expected.RawResponseSHA256 = plan.SourceSwap.RawResponseSHA256
		expected.RawProviderSourceSwapJSON = plan.SourceSwap.RawProviderSourceSwapJSON
		if !reflect.DeepEqual(expected, plan.SourceSwap) {
			return MayanSwiftV2SourceSwapPlan{}, errors.New("plan")
		}
	}
	computedPlanHash, err := localPlanHash(binding, plan.SourceSwap)
	if err != nil || plan.PlanHash != computedPlanHash {
		return MayanSwiftV2SourceSwapPlan{}, errors.New("plan")
	}
	return localCloneSourceSwapPlanDTO(plan), nil
}

func localBuildDependencies(facts bridgeDirection) []string {
	dependencies := make([]string, 0, len(facts.dependencies)+1)
	for _, dependency := range facts.dependencies {
		if dependency != "mayan-hosted-transaction-builder" {
			dependencies = append(dependencies, dependency)
		}
	}
	if facts.sourceChainID == bridgeEthereumChainID {
		dependencies = append(dependencies, "configured-ethereum-rpc")
	} else {
		dependencies = append(dependencies, "configured-solana-rpc")
	}
	return dependencies
}

func localBuildLocalUnsigned(ctx context.Context, request MayanSwiftV2LocalBuildRequest, runtime *mayanSwiftV2LocalRuntime, clock func() int64) (MayanSwiftV2LocalBuild, error) {
	if runtime == nil || runtime.client == nil {
		return MayanSwiftV2LocalBuild{}, localError(BridgeLocalBuildInvalid)
	}
	quote, facts, parsed, err := localValidateRouteQuote(request.Quote, runtime.client.config.quoteValidity, clock)
	if err != nil {
		return MayanSwiftV2LocalBuild{}, localError(BridgeLocalBuildInvalid)
	}
	request.Quote = quote
	normalizedContext, err := localNormalizeContextAddresses(MayanSwiftV2LocalContext{Quote: quote, SwapperAddress: request.SwapperAddress, DestinationAddress: request.DestinationAddress, OrderNonce: request.OrderNonce}, facts)
	if err != nil {
		return MayanSwiftV2LocalBuild{}, localError(BridgeLocalBuildInvalid)
	}
	request.SwapperAddress, request.DestinationAddress, request.OrderNonce = normalizedContext.SwapperAddress, normalizedContext.DestinationAddress, normalizedContext.OrderNonce
	deadline, err := strconv.ParseUint(quote.Deadline, 10, 64)
	if err != nil {
		return MayanSwiftV2LocalBuild{}, localError(BridgeLocalBuildInvalid)
	}
	if err := localValidateDestinationMinimumCompatibility(quote.MinimumAmountOut); err != nil {
		return MayanSwiftV2LocalBuild{}, localError(BridgeLocalBuildInvalid)
	}
	if err := localQuoteDeadlineValid(clock, deadline, runtime.client.config.quoteValidity); err != nil {
		return MayanSwiftV2LocalBuild{}, err
	}
	rawQuoteSHA256 := localSHA256Hex([]byte(quote.RawSignedQuoteJSON))
	orderHash, err := localOrderHash(quote, facts, request.SwapperAddress, request.DestinationAddress, request.OrderNonce, parsed.cancelFee, parsed.refundFee, parsed.mode)
	if err != nil {
		return MayanSwiftV2LocalBuild{}, localError(BridgeLocalBuildInvalid)
	}
	binding, err := localQuoteBindingHash(facts, quote, rawQuoteSHA256, request.OrderNonce, request.SwapperAddress, request.DestinationAddress)
	if err != nil {
		return MayanSwiftV2LocalBuild{}, localError(BridgeLocalBuildInvalid)
	}
	validatedPlan, err := localValidatePlan(request, facts, parsed, request.SourceSwapPlan, rawQuoteSHA256, orderHash, binding, request.SwapperAddress, request.DestinationAddress)
	if err != nil {
		return MayanSwiftV2LocalBuild{}, localError(BridgeLocalBuildInvalid)
	}
	rpc, err := localFetchSourceRPC(ctx, runtime, facts, validatedPlan)
	if err != nil {
		return MayanSwiftV2LocalBuild{}, err
	}
	var transaction MayanSwiftV2UnsignedTransaction
	if facts.sourceChainID == bridgeEthereumChainID {
		data, buildErr := localBuildEVMOrderCall(quote, facts, validatedPlan, request.SwapperAddress, request.DestinationAddress, parsed.minimumIntermediateAmount, parsed.cancelFee, parsed.refundFee, parsed.mode, request.OrderNonce)
		if buildErr != nil {
			return MayanSwiftV2LocalBuild{}, localError(BridgeLocalBuildInvalid)
		}
		transaction = MayanSwiftV2UnsignedTransaction{Kind: "evm-unsigned-transaction", ChainID: bridgeEthereumChainID, From: request.SwapperAddress, To: bridgeEthereumForwarder, Data: data, Value: "0"}
	} else {
		instructions, buildErr := localBuildSolanaInstructions(quote, facts, validatedPlan, request.SwapperAddress, request.DestinationAddress, parsed.minimumIntermediateAmount, parsed.cancelFee, parsed.refundFee, parsed.submitFee, parsed.mode, request.OrderNonce, parsed.raw)
		if buildErr != nil || rpc.RecentBlockhash == "" {
			return MayanSwiftV2LocalBuild{}, localError(BridgeLocalBuildInvalid)
		}
		encoded, buildErr := localCompileSolanaV0(request.SwapperAddress, rpc.RecentBlockhash, instructions, rpc.LookupTables)
		if buildErr != nil {
			return MayanSwiftV2LocalBuild{}, localError(BridgeLocalBuildInvalid)
		}
		transaction = MayanSwiftV2UnsignedTransaction{Kind: "solana-v0-unsigned-transaction", ChainID: bridgeSolanaChainID, FeePayer: request.SwapperAddress, TransactionBase64: encoded}
	}
	var allowance *MayanSwiftV2Allowance
	if facts.sourceChainID == bridgeEthereumChainID {
		allowance = &MayanSwiftV2Allowance{TokenDeploymentID: facts.sourceTokenDeployment, TokenAddress: facts.sourceTokenAddress, Owner: request.SwapperAddress, Spender: bridgeEthereumForwarder, RequiredAmount: quote.AmountIn}
	}
	return MayanSwiftV2LocalBuild{
		BuildKind: "mayan-swift-v2-local-unsigned", ProviderID: "mayan-swift-v2", CapabilityID: facts.capabilityID,
		Quote: cloneBridgeQuote(quote), SourceChainID: facts.sourceChainID, DestinationChainID: facts.destinationChainID,
		SourceSwapPlan: localCloneSourceSwapPlanDTO(validatedPlan), Transaction: transaction, Allowance: allowance,
		Construction: MayanSwiftV2LocalConstruction{Mode: "local", ReferenceCommit: localMayanReferenceCommit, OrderNonce: request.OrderNonce, OrderHash: orderHash, MinimumIntermediateAmount: parsed.minimumIntermediateAmount, EffectiveDependencies: localBuildDependencies(facts), SourceRPCEvidence: rpc.Evidence},
		Validation:   MayanSwiftV2LocalBuildValidation{Level: "local-structural", QuoteSignatureLocallyVerified: false, PlanBindingLocallyVerified: true, TransactionBytesLocallyConstructed: true, SettlementLocallyVerified: false},
	}, nil
}
