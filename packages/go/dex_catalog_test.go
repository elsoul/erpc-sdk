package erpc

import (
	"strings"
	"testing"
)

type goDexCatalogSource struct {
	CatalogVersion        string                  `json:"catalogVersion"`
	ManualAsOf            string                  `json:"manualAsOf"`
	ContentDigest         string                  `json:"contentDigest"`
	DexDeployments        []goDexDeploymentSource `json:"dexDeployments"`
	PoolDefinitions       []goPoolSource          `json:"poolDefinitions"`
	NativeWrapDefinitions []goWrapSource          `json:"nativeWrapDefinitions"`
	Aliases               []goDexAliasSource      `json:"aliases"`
}

type goDexDeploymentSource struct {
	DexDeploymentID           string  `json:"dexDeploymentId"`
	ProtocolID                string  `json:"protocolId"`
	Name                      string  `json:"name"`
	ChainID                   string  `json:"chainId"`
	ProgramAddress            string  `json:"programAddress"`
	AdapterKind               string  `json:"adapterKind"`
	Status                    string  `json:"status"`
	ReplacedByDexDeploymentID *string `json:"replacedByDexDeploymentId"`
}

type goPoolSource struct {
	PoolDefinitionID           string        `json:"poolDefinitionId"`
	DexDeploymentID            string        `json:"dexDeploymentId"`
	ChainID                    string        `json:"chainId"`
	Address                    string        `json:"address"`
	Token0DeploymentID         string        `json:"token0DeploymentId"`
	Token1DeploymentID         string        `json:"token1DeploymentId"`
	Adapter                    goPoolAdapter `json:"adapter"`
	Status                     string        `json:"status"`
	ReplacedByPoolDefinitionID *string       `json:"replacedByPoolDefinitionId"`
}

type goPoolAdapter struct {
	Kind           string  `json:"kind"`
	FeeNumerator   *string `json:"feeNumerator"`
	FeeDenominator *string `json:"feeDenominator"`
}

type goWrapSource struct {
	NativeWrapDefinitionID   string `json:"nativeWrapDefinitionId"`
	ChainID                  string `json:"chainId"`
	NativeTokenDeploymentID  string `json:"nativeTokenDeploymentId"`
	WrappedTokenDeploymentID string `json:"wrappedTokenDeploymentId"`
	Status                   string `json:"status"`
}

type goDexAliasSource struct {
	Namespace        string  `json:"namespace"`
	Name             string  `json:"name"`
	DexDeploymentID  *string `json:"dexDeploymentId"`
	PoolDefinitionID *string `json:"poolDefinitionId"`
}

func TestDexCatalogRecordsAndAliases(t *testing.T) {
	var source goDexCatalogSource
	loadGoRegistryJSON(t, "dex-catalog.json", &source)

	if len(DexDeployments()) != len(source.DexDeployments) || len(DexDeployments()) == 0 {
		t.Fatalf("DEX deployment count = %d, want non-empty source count %d", len(DexDeployments()), len(source.DexDeployments))
	}
	if len(PoolDefinitions()) != len(source.PoolDefinitions) || len(PoolDefinitions()) == 0 {
		t.Fatalf("pool definition count = %d, want non-empty source count %d", len(PoolDefinitions()), len(source.PoolDefinitions))
	}
	if len(NativeWrapDefinitions()) != len(source.NativeWrapDefinitions) || len(NativeWrapDefinitions()) == 0 {
		t.Fatalf("native wrap count = %d, want non-empty source count %d", len(NativeWrapDefinitions()), len(source.NativeWrapDefinitions))
	}
	if len(DexAliases()) != len(source.Aliases) || len(DexAliases()) == 0 {
		t.Fatalf("alias count = %d, want non-empty source count %d", len(DexAliases()), len(source.Aliases))
	}
	if DexCatalogVersion != source.CatalogVersion || DexCatalogAsOfDate != source.ManualAsOf || DexCatalogContentDigest != source.ContentDigest {
		t.Fatalf("DEX catalog metadata = (%s, %s, %s), want source (%s, %s, %s)", DexCatalogVersion, DexCatalogAsOfDate, DexCatalogContentDigest, source.CatalogVersion, source.ManualAsOf, source.ContentDigest)
	}
	if DexCatalogVersion == "" || DexCatalogAsOfDate == "" || DexCatalogContentDigest == "" {
		t.Fatal("DEX catalog metadata must be generated")
	}
	for _, id := range []string{"dex-deployment-0001", "dex-deployment-0003"} {
		if _, ok := GetDexDeployment(id); !ok {
			t.Fatalf("seed DEX deployment %q is missing", id)
		}
	}
	for _, id := range []string{"pool-0001", "pool-0003"} {
		if _, ok := GetPoolDefinition(id); !ok {
			t.Fatalf("seed pool %q is missing", id)
		}
	}
	for _, id := range []string{"deployment-0001", "deployment-0003"} {
		if _, ok := GetNativeWrapDefinition(id); !ok {
			t.Fatalf("seed native wrap for deployment %q is missing", id)
		}
	}

	dexByID := make(map[string]goDexDeploymentSource, len(source.DexDeployments))
	for _, value := range source.DexDeployments {
		dexByID[value.DexDeploymentID] = value
	}
	poolByID := make(map[string]goPoolSource, len(source.PoolDefinitions))
	for _, value := range source.PoolDefinitions {
		poolByID[value.PoolDefinitionID] = value
	}
	wrapByID := make(map[string]goWrapSource, len(source.NativeWrapDefinitions))
	for _, value := range source.NativeWrapDefinitions {
		wrapByID[value.NativeWrapDefinitionID] = value
	}

	for _, expected := range source.DexDeployments {
		actual, ok := GetDexDeployment(expected.DexDeploymentID)
		if !ok || actual.DexDeploymentID != expected.DexDeploymentID || actual.ProtocolID != expected.ProtocolID || actual.Name != expected.Name || actual.ChainID != expected.ChainID || actual.ProgramAddress != expected.ProgramAddress || actual.AdapterKind != expected.AdapterKind || actual.Status != expected.Status || dexStringPointerValue(actual.ReplacedByDexDeploymentID) != dexStringPointerValue(expected.ReplacedByDexDeploymentID) {
			t.Fatalf("generated DEX %q differs from source: %#v vs %#v", expected.DexDeploymentID, actual, expected)
		}
	}
	for _, expected := range source.PoolDefinitions {
		actual, ok := GetPoolDefinition(expected.PoolDefinitionID)
		if !ok || actual.PoolDefinitionID != expected.PoolDefinitionID || actual.DexDeploymentID != expected.DexDeploymentID || actual.ChainID != expected.ChainID || actual.Address != expected.Address || actual.Token0DeploymentID != expected.Token0DeploymentID || actual.Token1DeploymentID != expected.Token1DeploymentID || actual.Adapter.Kind != expected.Adapter.Kind || dexStringPointerValue(actual.Adapter.FeeNumerator) != dexStringPointerValue(expected.Adapter.FeeNumerator) || dexStringPointerValue(actual.Adapter.FeeDenominator) != dexStringPointerValue(expected.Adapter.FeeDenominator) || actual.Status != expected.Status || dexStringPointerValue(actual.ReplacedByPoolDefinitionID) != dexStringPointerValue(expected.ReplacedByPoolDefinitionID) {
			t.Fatalf("generated pool %q differs from source: %#v vs %#v", expected.PoolDefinitionID, actual, expected)
		}
	}
	for _, expected := range source.NativeWrapDefinitions {
		actual, ok := GetNativeWrapDefinition(expected.NativeTokenDeploymentID)
		if !ok || actual.NativeWrapDefinitionID != expected.NativeWrapDefinitionID || actual.ChainID != expected.ChainID || actual.NativeTokenDeploymentID != expected.NativeTokenDeploymentID || actual.WrappedTokenDeploymentID != expected.WrappedTokenDeploymentID || actual.Status != expected.Status {
			t.Fatalf("generated native wrap %q differs from source: %#v vs %#v", expected.NativeWrapDefinitionID, actual, expected)
		}
	}

	for _, deployment := range DexDeployments() {
		if _, ok := dexByID[deployment.DexDeploymentID]; !ok {
			t.Fatalf("generated DEX %q is absent from source", deployment.DexDeploymentID)
		}
		got, ok := GetDexDeployment(deployment.DexDeploymentID)
		if !ok || got.DexDeploymentID != deployment.DexDeploymentID {
			t.Fatalf("DEX %q is not addressable by ID", deployment.DexDeploymentID)
		}
	}
	for _, pool := range PoolDefinitions() {
		if _, ok := poolByID[pool.PoolDefinitionID]; !ok {
			t.Fatalf("generated pool %q is absent from source", pool.PoolDefinitionID)
		}
		got, ok := GetPoolDefinition(pool.PoolDefinitionID)
		if !ok || got.PoolDefinitionID != pool.PoolDefinitionID {
			t.Fatalf("pool %q is not addressable by ID", pool.PoolDefinitionID)
		}
	}
	if _, ok := GetDexDeployment("dex-unknown"); ok {
		t.Fatal("unknown DEX unexpectedly matched")
	}
	if _, ok := GetPoolDefinition("pool-unknown"); ok {
		t.Fatal("unknown pool unexpectedly matched")
	}
	for _, definition := range NativeWrapDefinitions() {
		if _, ok := wrapByID[definition.NativeWrapDefinitionID]; !ok {
			t.Fatalf("generated native wrap %q is absent from source", definition.NativeWrapDefinitionID)
		}
	}
	for _, expected := range source.Aliases {
		found := false
		for _, actual := range DexAliases() {
			if actual.Namespace == expected.Namespace && actual.Name == expected.Name {
				found = true
				if dexStringPointerValue(actual.DexDeploymentID) != dexStringPointerValue(expected.DexDeploymentID) || dexStringPointerValue(actual.PoolDefinitionID) != dexStringPointerValue(expected.PoolDefinitionID) {
					t.Fatalf("generated alias %s.%s differs from source: %#v vs %#v", expected.Namespace, expected.Name, actual, expected)
				}
				break
			}
		}
		if !found {
			t.Fatalf("source alias %s.%s is absent from generated records", expected.Namespace, expected.Name)
		}
	}

	if DexEthereumUNISWAP_V2 != "dex-deployment-0001" ||
		PoolEthereumUNISWAP_V2_USDC_WETH != "pool-0001" ||
		DexAvalancheCLFJ_LEGACY != "dex-deployment-0002" ||
		PoolAvalancheCLFJ_LEGACY_WAVAX_USDC != "pool-0002" {
		t.Fatal("generated chain-qualified aliases do not match the catalog")
	}
	if DexSolanaORCA_WHIRLPOOLS != "dex-deployment-0003" || PoolSolanaORCA_WHIRLPOOLS_WSOL_EURC != "pool-0003" ||
		DexSolanaRAYDIUM_CLMM != "dex-deployment-0004" || PoolSolanaRAYDIUM_CLMM_WSOL_EURC != "pool-0004" {
		t.Fatal("generated Solana aliases do not match the catalog")
	}
}

func TestDexCatalogLookupsNormalizeAddressesAndPairs(t *testing.T) {
	pool, ok := GetPoolDefinition("pool-0001")
	if !ok {
		t.Fatal("missing Ethereum pool")
	}
	mixedCase := "0x" + strings.ToUpper(pool.Address[2:])
	got, ok := FindPoolDefinitionByAddress(TokenChainEthereumMainnet, mixedCase)
	if !ok || got.PoolDefinitionID != pool.PoolDefinitionID {
		t.Fatalf("mixed-case address returned %#v", got)
	}
	if _, ok := FindPoolDefinitionByAddress(TokenChainEthereumMainnet, "0x1234"); ok {
		t.Fatal("malformed EVM address unexpectedly matched")
	}
	if _, ok := FindPoolDefinitionByAddress(TokenChainEthereumMainnet, "0x"+strings.Repeat("0", 40)); ok {
		t.Fatal("zero EVM address unexpectedly matched")
	}

	forward := FindPoolDefinitionsByPair(TokenChainEthereumMainnet, "deployment-0002", "deployment-0008")
	reverse := FindPoolDefinitionsByPair(TokenChainEthereumMainnet, "deployment-0008", "deployment-0002")
	if len(forward) == 0 || len(reverse) == 0 || !containsGoPoolID(forward, "pool-0001") || !containsGoPoolID(reverse, "pool-0001") {
		t.Fatalf("unordered Ethereum pair lookup = %#v / %#v", forward, reverse)
	}
	solana := FindPoolDefinitionsByPair(TokenChainSolanaMainnet, "deployment-0013", "deployment-0006")
	if len(solana) < 2 || !containsGoPoolID(solana, "pool-0003") || !containsGoPoolID(solana, "pool-0004") {
		t.Fatalf("unordered Solana pair lookup = %#v", solana)
	}
	if got := FindPoolDefinitionsByPair("unknown:chain", "deployment-0002", "deployment-0008"); len(got) != 0 {
		t.Fatalf("unknown chain pair lookup = %#v", got)
	}

	filtered := ListPoolDefinitions(PoolDefinitionFilter{ChainID: TokenChainSolanaMainnet, TokenDeploymentID: "deployment-0006"})
	if len(filtered) < 2 || !containsGoPoolID(filtered, "pool-0003") || !containsGoPoolID(filtered, "pool-0004") {
		t.Fatalf("filtered Solana pools = %#v", filtered)
	}
	filtered = ListPoolDefinitions(PoolDefinitionFilter{AdapterKind: "evm-constant-product-v2"})
	if len(filtered) < 2 || !containsGoPoolID(filtered, "pool-0001") || !containsGoPoolID(filtered, "pool-0002") {
		t.Fatalf("filtered EVM pools = %#v", filtered)
	}

	wrap, ok := GetNativeWrapDefinition("deployment-0001")
	if !ok || wrap.NativeWrapDefinitionID != "native-wrap-0001" || wrap.WrappedTokenDeploymentID != "deployment-0002" {
		t.Fatalf("Ethereum native wrap = %#v", wrap)
	}
	if _, ok := GetNativeWrapDefinition("native-wrap-0001"); ok {
		t.Fatal("wrap ID was accepted where native deployment ID is required")
	}
}

func TestDexCatalogLookupsReturnIndependentValues(t *testing.T) {
	first, ok := GetPoolDefinition("pool-0001")
	if !ok || first.Adapter.FeeNumerator == nil {
		t.Fatal("missing fee numerator")
	}
	*first.Adapter.FeeNumerator = "999"
	first.Address = "0x0000000000000000000000000000000000000001"
	second, ok := GetPoolDefinition("pool-0001")
	if !ok || second.Address == first.Address || second.Adapter.FeeNumerator == nil || *second.Adapter.FeeNumerator != "3" {
		t.Fatalf("catalog value was affected by caller mutation: %#v", second)
	}

	list := ListPoolDefinitions(PoolDefinitionFilter{})
	if len(list) == 0 || list[0].Adapter.FeeNumerator == nil {
		t.Fatal("unfiltered pool list is empty")
	}
	*list[0].Adapter.FeeNumerator = "100"
	listAgain := ListPoolDefinitions(PoolDefinitionFilter{})
	if listAgain[0].Adapter.FeeNumerator == nil || *listAgain[0].Adapter.FeeNumerator != "3" {
		t.Fatal("pool list mutation affected a later read")
	}
}

func dexStringPointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func containsGoPoolID(values []PoolDefinition, id string) bool {
	for _, value := range values {
		if value.PoolDefinitionID == id {
			return true
		}
	}
	return false
}
