package erpc

import "strings"

// TokenChainEthereumMainnet is the CAIP-2 identifier for Ethereum mainnet.
const TokenChainEthereumMainnet = "eip155:1"

// TokenChainSolanaMainnet is the genesis-hash CAIP-2 identifier for Solana mainnet.
const TokenChainSolanaMainnet = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"

// TokenChainAvalancheCMainnet is the CAIP-2 identifier for Avalanche C-Chain mainnet.
const TokenChainAvalancheCMainnet = "eip155:43114"

// TokenDeploymentFilter selects deployments by chain and, optionally, stable
// currency. Empty fields leave the corresponding dimension unfiltered.
type TokenDeploymentFilter struct {
	ChainID        string
	StableCurrency string
}

// TokenAssetByID returns the asset with the exact opaque asset ID.
func TokenAssetByID(id string) (TokenAsset, bool) {
	if id == "" {
		return TokenAsset{}, false
	}
	for _, asset := range TokenAssets() {
		if asset.AssetID == id {
			return asset, true
		}
	}
	return TokenAsset{}, false
}

// TokenDeploymentByID returns the deployment with the exact opaque deployment
// ID.
func TokenDeploymentByID(id string) (TokenDeployment, bool) {
	if id == "" {
		return TokenDeployment{}, false
	}
	for _, deployment := range TokenDeployments() {
		if deployment.DeploymentID == id {
			return deployment, true
		}
	}
	return TokenDeployment{}, false
}

// ListTokenDeployments returns every deployment, optionally filtered by chain
// and stable currency. All lifecycle statuses remain visible. Returned values
// and nullable pointer fields are independent from future catalog reads.
func ListTokenDeployments(filter TokenDeploymentFilter) []TokenDeployment {
	if filter.ChainID != "" && !isKnownTokenChain(filter.ChainID) {
		return []TokenDeployment{}
	}
	if filter.StableCurrency != "" && !isKnownStableCurrency(filter.StableCurrency) {
		return []TokenDeployment{}
	}

	deployments := TokenDeployments()
	result := make([]TokenDeployment, 0, len(deployments))
	for _, deployment := range deployments {
		if filter.ChainID != "" && string(deployment.ChainID) != filter.ChainID {
			continue
		}
		if filter.StableCurrency != "" && tokenStableCurrency(deployment.StableCurrency) != filter.StableCurrency {
			continue
		}
		result = append(result, deployment)
	}
	return result
}

// FindTokenDeploymentsBySymbol returns all exact-case symbol matches on a
// known chain, ordered lexically by deployment ID.
func FindTokenDeploymentsBySymbol(chainID, symbol string) []TokenDeployment {
	if !isKnownTokenChain(chainID) || symbol == "" {
		return []TokenDeployment{}
	}

	deployments := TokenDeployments()
	result := make([]TokenDeployment, 0)
	for _, deployment := range deployments {
		if string(deployment.ChainID) == chainID && deployment.Symbol == symbol {
			result = append(result, deployment)
		}
	}
	if len(result) < 2 {
		return result
	}
	// The canonical generator currently emits deployment IDs in order. Sort
	// here as part of the public contract so callers do not depend on source
	// ordering if the registry is regrouped later.
	for i := 1; i < len(result); i++ {
		for j := i; j > 0 && result[j].DeploymentID < result[j-1].DeploymentID; j-- {
			result[j], result[j-1] = result[j-1], result[j]
		}
	}
	return result
}

// FindTokenDeploymentByAddress returns the non-native deployment at address.
// EVM addresses must be 0x-prefixed, 20-byte ASCII hexadecimal strings and
// are matched case-insensitively. Solana addresses are matched exactly.
func FindTokenDeploymentByAddress(chainID, address string) (TokenDeployment, bool) {
	if !isKnownTokenChain(chainID) || address == "" {
		return TokenDeployment{}, false
	}

	if isEVMTokenChain(chainID) {
		if !isValidEVMAddress(address) || isZeroEVMAddress(address) {
			return TokenDeployment{}, false
		}
	} else if address == "" {
		return TokenDeployment{}, false
	}

	for _, deployment := range TokenDeployments() {
		if string(deployment.ChainID) != chainID || deployment.Address == nil {
			continue
		}
		if isEVMTokenChain(chainID) {
			if strings.EqualFold(*deployment.Address, address) {
				return deployment, true
			}
		} else if *deployment.Address == address {
			return deployment, true
		}
	}
	return TokenDeployment{}, false
}

// NativeTokenDeployment returns the known chain's native deployment. Native
// deployments have no address and therefore cannot be selected by address
// lookup.
func NativeTokenDeployment(chainID string) (TokenDeployment, bool) {
	if !isKnownTokenChain(chainID) {
		return TokenDeployment{}, false
	}
	for _, deployment := range TokenDeployments() {
		if string(deployment.ChainID) == chainID &&
			deployment.Standard == TokenStandardNative && deployment.Address == nil {
			return deployment, true
		}
	}
	return TokenDeployment{}, false
}

func isKnownTokenChain(chainID string) bool {
	switch chainID {
	case TokenChainEthereumMainnet, TokenChainSolanaMainnet, TokenChainAvalancheCMainnet:
		return true
	default:
		return false
	}
}

func isEVMTokenChain(chainID string) bool {
	return chainID == TokenChainEthereumMainnet || chainID == TokenChainAvalancheCMainnet
}

func isKnownStableCurrency(currency string) bool {
	switch currency {
	case "USD", "EUR", "JPY":
		return true
	default:
		return false
	}
}

func tokenStableCurrency(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func isValidEVMAddress(address string) bool {
	if len(address) != 42 || address[0] != '0' || address[1] != 'x' {
		return false
	}
	for index := 2; index < len(address); index++ {
		character := address[index]
		if !((character >= '0' && character <= '9') ||
			(character >= 'a' && character <= 'f') ||
			(character >= 'A' && character <= 'F')) {
			return false
		}
	}
	return true
}

func isZeroEVMAddress(address string) bool {
	if !isValidEVMAddress(address) {
		return false
	}
	for index := 2; index < len(address); index++ {
		if address[index] != '0' {
			return false
		}
	}
	return true
}
