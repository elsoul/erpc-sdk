package erpc

import (
	"strings"
	"testing"
)

func TestDexCatalogRecordsAndAliases(t *testing.T) {
	if len(DexDeployments()) != 4 {
		t.Fatalf("DEX deployment count = %d, want 4", len(DexDeployments()))
	}
	if len(PoolDefinitions()) != 4 {
		t.Fatalf("pool definition count = %d, want 4", len(PoolDefinitions()))
	}
	if len(NativeWrapDefinitions()) != 3 {
		t.Fatalf("native wrap count = %d, want 3", len(NativeWrapDefinitions()))
	}
	if len(DexAliases()) != 8 {
		t.Fatalf("alias count = %d, want 8", len(DexAliases()))
	}
	if DexCatalogVersion == "" || DexCatalogAsOfDate == "" || DexCatalogContentDigest == "" {
		t.Fatal("DEX catalog metadata must be generated")
	}

	for _, deployment := range DexDeployments() {
		got, ok := GetDexDeployment(deployment.DexDeploymentID)
		if !ok || got.DexDeploymentID != deployment.DexDeploymentID {
			t.Fatalf("DEX %q is not addressable by ID", deployment.DexDeploymentID)
		}
	}
	for _, pool := range PoolDefinitions() {
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
	if len(forward) != 1 || len(reverse) != 1 || forward[0].PoolDefinitionID != reverse[0].PoolDefinitionID {
		t.Fatalf("unordered Ethereum pair lookup = %#v / %#v", forward, reverse)
	}
	solana := FindPoolDefinitionsByPair(TokenChainSolanaMainnet, "deployment-0013", "deployment-0006")
	if len(solana) != 2 || solana[0].PoolDefinitionID != "pool-0003" || solana[1].PoolDefinitionID != "pool-0004" {
		t.Fatalf("unordered Solana pair lookup = %#v", solana)
	}
	if got := FindPoolDefinitionsByPair("unknown:chain", "deployment-0002", "deployment-0008"); len(got) != 0 {
		t.Fatalf("unknown chain pair lookup = %#v", got)
	}

	filtered := ListPoolDefinitions(PoolDefinitionFilter{ChainID: TokenChainSolanaMainnet, TokenDeploymentID: "deployment-0006"})
	if len(filtered) != 2 || filtered[0].PoolDefinitionID != "pool-0003" || filtered[1].PoolDefinitionID != "pool-0004" {
		t.Fatalf("filtered Solana pools = %#v", filtered)
	}
	filtered = ListPoolDefinitions(PoolDefinitionFilter{AdapterKind: "evm-constant-product-v2"})
	if len(filtered) != 2 || filtered[0].PoolDefinitionID != "pool-0001" || filtered[1].PoolDefinitionID != "pool-0002" {
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
