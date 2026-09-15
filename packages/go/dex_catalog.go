package erpc

import "strings"

// DexNamespace identifies the source namespace used by a generated alias.
// The value is also the namespace key in DexChainIDs.
type DexNamespace string

const (
	DexNamespaceEthereum   DexNamespace = "ethereum"
	DexNamespaceSolana     DexNamespace = "solana"
	DexNamespaceAvalancheC DexNamespace = "avalancheC"
)

// PoolDefinitionFilter selects catalogued pools by exact optional fields.
// Empty fields leave the corresponding dimension unfiltered.
type PoolDefinitionFilter struct {
	ChainID           string
	TokenDeploymentID string
	AdapterKind       string
}

// GetDexDeployment returns a fresh copy of a DEX deployment by opaque ID.
// All lifecycle statuses remain visible in the returned record.
func GetDexDeployment(id string) (DexDeployment, bool) {
	if id == "" {
		return DexDeployment{}, false
	}
	for _, deployment := range DexDeployments() {
		if deployment.DexDeploymentID == id {
			return copyDexDeployment(deployment), true
		}
	}
	return DexDeployment{}, false
}

// GetPoolDefinition returns a fresh copy of a pool definition by opaque ID.
func GetPoolDefinition(id string) (PoolDefinition, bool) {
	if id == "" {
		return PoolDefinition{}, false
	}
	for _, pool := range PoolDefinitions() {
		if pool.PoolDefinitionID == id {
			return copyPoolDefinition(pool), true
		}
	}
	return PoolDefinition{}, false
}

// FindPoolDefinitionByAddress returns the pool bound to an exact chain and
// address. EVM addresses are matched case-insensitively; Solana addresses are
// matched byte-for-byte as their canonical base58 text.
func FindPoolDefinitionByAddress(chainID, address string) (PoolDefinition, bool) {
	if !isKnownDexChain(chainID) || address == "" {
		return PoolDefinition{}, false
	}
	normalized := address
	if isEVMChain(chainID) {
		var ok bool
		normalized, ok = normalizeDexEVMAddress(address)
		if !ok {
			return PoolDefinition{}, false
		}
	}
	for _, pool := range PoolDefinitions() {
		if pool.ChainID != chainID {
			continue
		}
		candidate := pool.Address
		if isEVMChain(chainID) {
			candidate, _ = normalizeDexEVMAddress(candidate)
		}
		if candidate == normalized {
			return copyPoolDefinition(pool), true
		}
	}
	return PoolDefinition{}, false
}

// FindPoolDefinitionsByPair returns all pools for an unordered token pair.
// Results are ordered by opaque pool ID and are independent from future
// catalog reads, including nullable adapter fields.
func FindPoolDefinitionsByPair(chainID, tokenAID, tokenBID string) []PoolDefinition {
	if !isKnownDexChain(chainID) || tokenAID == "" || tokenBID == "" || tokenAID == tokenBID {
		return []PoolDefinition{}
	}
	left, right := tokenAID, tokenBID
	if right < left {
		left, right = right, left
	}
	result := make([]PoolDefinition, 0)
	for _, pool := range PoolDefinitions() {
		if pool.ChainID != chainID {
			continue
		}
		poolLeft, poolRight := pool.Token0DeploymentID, pool.Token1DeploymentID
		if poolRight < poolLeft {
			poolLeft, poolRight = poolRight, poolLeft
		}
		if poolLeft == left && poolRight == right {
			result = append(result, copyPoolDefinition(pool))
		}
	}
	for index := 1; index < len(result); index++ {
		for cursor := index; cursor > 0 && result[cursor].PoolDefinitionID < result[cursor-1].PoolDefinitionID; cursor-- {
			result[cursor], result[cursor-1] = result[cursor-1], result[cursor]
		}
	}
	return result
}

// ListPoolDefinitions lists pools using exact optional filters. Unknown
// chains, token IDs, and adapter kinds simply produce an empty list.
func ListPoolDefinitions(filter PoolDefinitionFilter) []PoolDefinition {
	if filter.ChainID != "" && !isKnownDexChain(filter.ChainID) {
		return []PoolDefinition{}
	}
	if filter.TokenDeploymentID != "" && !isKnownTokenDeploymentID(filter.TokenDeploymentID) {
		return []PoolDefinition{}
	}
	if filter.AdapterKind != "" && !isKnownAdapterKind(filter.AdapterKind) {
		return []PoolDefinition{}
	}
	result := make([]PoolDefinition, 0)
	for _, pool := range PoolDefinitions() {
		if filter.ChainID != "" && pool.ChainID != filter.ChainID {
			continue
		}
		if filter.TokenDeploymentID != "" &&
			pool.Token0DeploymentID != filter.TokenDeploymentID &&
			pool.Token1DeploymentID != filter.TokenDeploymentID {
			continue
		}
		if filter.AdapterKind != "" && pool.Adapter.Kind != filter.AdapterKind {
			continue
		}
		result = append(result, copyPoolDefinition(pool))
	}
	for index := 1; index < len(result); index++ {
		for cursor := index; cursor > 0 && result[cursor].PoolDefinitionID < result[cursor-1].PoolDefinitionID; cursor-- {
			result[cursor], result[cursor-1] = result[cursor-1], result[cursor]
		}
	}
	return result
}

// GetNativeWrapDefinition returns the chain-bound native-to-wrapped mapping
// for a native token deployment ID. A wrap definition ID is not accepted.
func GetNativeWrapDefinition(nativeTokenDeploymentID string) (NativeWrapDefinition, bool) {
	if nativeTokenDeploymentID == "" {
		return NativeWrapDefinition{}, false
	}
	for _, definition := range NativeWrapDefinitions() {
		if definition.NativeTokenDeploymentID == nativeTokenDeploymentID {
			return definition, true
		}
	}
	return NativeWrapDefinition{}, false
}

func copyDexDeployment(value DexDeployment) DexDeployment {
	value.ReplacedByDexDeploymentID = copyDexString(value.ReplacedByDexDeploymentID)
	return value
}

func copyPoolDefinition(value PoolDefinition) PoolDefinition {
	value.Adapter.FeeNumerator = copyDexString(value.Adapter.FeeNumerator)
	value.Adapter.FeeDenominator = copyDexString(value.Adapter.FeeDenominator)
	value.ReplacedByPoolDefinitionID = copyDexString(value.ReplacedByPoolDefinitionID)
	return value
}

func copyDexString(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func isKnownDexChain(chainID string) bool {
	ids := DexChainIDs()
	return chainID == ids["ethereum"] || chainID == ids["solana"] || chainID == ids["avalancheC"]
}

func isEVMChain(chainID string) bool {
	ids := DexChainIDs()
	return chainID == ids["ethereum"] || chainID == ids["avalancheC"]
}

func normalizeDexEVMAddress(address string) (string, bool) {
	if len(address) != 42 || address[0] != '0' || address[1] != 'x' {
		return "", false
	}
	for index := 2; index < len(address); index++ {
		character := address[index]
		if !((character >= '0' && character <= '9') ||
			(character >= 'a' && character <= 'f') ||
			(character >= 'A' && character <= 'F')) {
			return "", false
		}
	}
	if strings.Trim(address[2:], "0") == "" {
		return "", false
	}
	return strings.ToLower(address), true
}

func isKnownTokenDeploymentID(id string) bool {
	_, ok := TokenDeploymentByID(id)
	return ok
}

func isKnownAdapterKind(kind string) bool {
	for _, pool := range PoolDefinitions() {
		if pool.Adapter.Kind == kind {
			return true
		}
	}
	return false
}
