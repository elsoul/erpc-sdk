package erpc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

type goTokenCatalogSource struct {
	CatalogVersion string                    `json:"catalogVersion"`
	ManualAsOf     string                    `json:"manualAsOf"`
	ContentDigest  string                    `json:"contentDigest"`
	Assets         []goTokenAssetSource      `json:"assets"`
	Deployments    []goTokenDeploymentSource `json:"deployments"`
	Aliases        []goTokenAliasSource      `json:"aliases"`
}

type goTokenAssetSource struct {
	AssetID                  string  `json:"assetId"`
	Name                     string  `json:"name"`
	RepresentationKind       string  `json:"representationKind"`
	StableCurrency           *string `json:"stableCurrency"`
	UnderlyingAssetID        *string `json:"underlyingAssetId"`
	EconomicReferenceAssetID *string `json:"economicReferenceAssetId"`
}

type goTokenDeploymentSource struct {
	DeploymentID           string  `json:"deploymentId"`
	AssetID                string  `json:"assetId"`
	ChainID                string  `json:"chainId"`
	Symbol                 string  `json:"symbol"`
	Decimals               uint8   `json:"decimals"`
	Standard               string  `json:"standard"`
	Address                *string `json:"address"`
	Status                 string  `json:"status"`
	ReplacedByDeploymentID *string `json:"replacedByDeploymentId"`
}

type goTokenAliasSource struct {
	Namespace    string `json:"namespace"`
	Name         string `json:"name"`
	DeploymentID string `json:"deploymentId"`
}

func loadGoRegistryJSON(t *testing.T, name string, target any) {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed while locating registry fixture")
	}
	path := filepath.Join(filepath.Dir(source), "..", "..", "registry", name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read registry fixture %s: %v", name, err)
	}
	if err := json.Unmarshal(data, target); err != nil {
		t.Fatalf("decode registry fixture %s: %v", name, err)
	}
}

func TestTokenCatalogContainsCompleteGeneratedRecords(t *testing.T) {
	var source goTokenCatalogSource
	loadGoRegistryJSON(t, "token-catalog.json", &source)

	assets := TokenAssets()
	deployments := TokenDeployments()
	aliases := TokenAliases()

	if len(assets) != len(source.Assets) || len(assets) == 0 {
		t.Fatalf("asset count = %d, want non-empty source count %d", len(assets), len(source.Assets))
	}
	if len(deployments) != len(source.Deployments) || len(deployments) == 0 {
		t.Fatalf("deployment count = %d, want non-empty source count %d", len(deployments), len(source.Deployments))
	}
	if len(aliases) != len(source.Aliases) || len(aliases) == 0 {
		t.Fatalf("alias count = %d, want non-empty source count %d", len(aliases), len(source.Aliases))
	}
	if TOKEN_CATALOG_VERSION != source.CatalogVersion || TOKEN_CATALOG_AS_OF_DATE != source.ManualAsOf || TOKEN_CATALOG_CONTENT_DIGEST != source.ContentDigest {
		t.Fatalf("catalog metadata = (%s, %s, %s), want source (%s, %s, %s)", TOKEN_CATALOG_VERSION, TOKEN_CATALOG_AS_OF_DATE, TOKEN_CATALOG_CONTENT_DIGEST, source.CatalogVersion, source.ManualAsOf, source.ContentDigest)
	}
	if TOKEN_CATALOG_VERSION == "" || TOKEN_CATALOG_AS_OF_DATE == "" || TOKEN_CATALOG_CONTENT_DIGEST == "" {
		t.Fatal("catalog metadata must be generated")
	}
	for _, assetID := range []string{"asset-0001", "asset-0007"} {
		if _, ok := TokenAssetByID(assetID); !ok {
			t.Fatalf("seed asset %q is missing", assetID)
		}
	}
	for _, deploymentID := range []string{"deployment-0001", "deployment-0008"} {
		if _, ok := TokenDeploymentByID(deploymentID); !ok {
			t.Fatalf("seed deployment %q is missing", deploymentID)
		}
	}

	assetsByID := make(map[string]goTokenAssetSource, len(source.Assets))
	for _, asset := range source.Assets {
		assetsByID[asset.AssetID] = asset
	}
	deploymentsByID := make(map[string]goTokenDeploymentSource, len(source.Deployments))
	for _, deployment := range source.Deployments {
		deploymentsByID[deployment.DeploymentID] = deployment
	}

	for _, sourceAsset := range source.Assets {
		asset, ok := TokenAssetByID(sourceAsset.AssetID)
		if !ok {
			t.Fatalf("source asset %q is missing from generated records", sourceAsset.AssetID)
		}
		if asset.Name != sourceAsset.Name || string(asset.RepresentationKind) != sourceAsset.RepresentationKind ||
			tokenStringValue(asset.StableCurrency) != tokenStringValue(sourceAsset.StableCurrency) ||
			tokenStringValue(asset.UnderlyingAssetID) != tokenStringValue(sourceAsset.UnderlyingAssetID) ||
			tokenStringValue(asset.EconomicReferenceAssetID) != tokenStringValue(sourceAsset.EconomicReferenceAssetID) {
			t.Fatalf("generated asset %q differs from source: %#v vs %#v", sourceAsset.AssetID, asset, sourceAsset)
		}
	}

	for _, asset := range assets {
		if _, ok := assetsByID[asset.AssetID]; !ok {
			t.Fatalf("generated asset %q is absent from source", asset.AssetID)
		}
		got, ok := TokenAssetByID(asset.AssetID)
		if !ok || got.AssetID != asset.AssetID {
			t.Fatalf("asset %q is not addressable by ID", asset.AssetID)
		}
	}

	for _, sourceDeployment := range source.Deployments {
		deployment, ok := TokenDeploymentByID(sourceDeployment.DeploymentID)
		if !ok {
			t.Fatalf("source deployment %q is missing from generated records", sourceDeployment.DeploymentID)
		}
		if deployment.AssetID != sourceDeployment.AssetID || string(deployment.ChainID) != sourceDeployment.ChainID ||
			deployment.Symbol != sourceDeployment.Symbol || deployment.Decimals != sourceDeployment.Decimals ||
			string(deployment.Standard) != sourceDeployment.Standard ||
			tokenStringValue(deployment.Address) != tokenStringValue(sourceDeployment.Address) ||
			string(deployment.Status) != sourceDeployment.Status ||
			tokenStringValue(deployment.ReplacedByDeploymentID) != tokenStringValue(sourceDeployment.ReplacedByDeploymentID) {
			t.Fatalf("generated deployment %q differs from source: %#v vs %#v", sourceDeployment.DeploymentID, deployment, sourceDeployment)
		}
	}

	for _, deployment := range deployments {
		if _, ok := deploymentsByID[deployment.DeploymentID]; !ok {
			t.Fatalf("generated deployment %q is absent from source", deployment.DeploymentID)
		}
		got, ok := TokenDeploymentByID(deployment.DeploymentID)
		if !ok || got.DeploymentID != deployment.DeploymentID {
			t.Fatalf("deployment %q is not addressable by ID", deployment.DeploymentID)
		}

		asset, ok := TokenAssetByID(deployment.AssetID)
		if !ok {
			t.Fatalf("deployment %q references missing asset %q", deployment.DeploymentID, deployment.AssetID)
		}
		if deployment.Name != asset.Name || deployment.RepresentationKind != asset.RepresentationKind {
			t.Fatalf("deployment %q does not flatten its asset identity", deployment.DeploymentID)
		}
		if tokenStableCurrency(deployment.StableCurrency) != tokenStableCurrency(asset.StableCurrency) {
			t.Fatalf("deployment %q stable currency differs from asset", deployment.DeploymentID)
		}
		if tokenStringValue(deployment.UnderlyingAssetID) != tokenStringValue(asset.UnderlyingAssetID) {
			t.Fatalf("deployment %q underlying asset differs from asset", deployment.DeploymentID)
		}
		if tokenStringValue(deployment.EconomicReferenceAssetID) != tokenStringValue(asset.EconomicReferenceAssetID) {
			t.Fatalf("deployment %q economic reference asset differs from asset", deployment.DeploymentID)
		}
		if deployment.UnderlyingAssetID != nil {
			if _, ok := TokenAssetByID(*deployment.UnderlyingAssetID); !ok {
				t.Fatalf("deployment %q references missing underlying asset", deployment.DeploymentID)
			}
		}
		if deployment.EconomicReferenceAssetID != nil {
			if _, ok := TokenAssetByID(*deployment.EconomicReferenceAssetID); !ok {
				t.Fatalf("deployment %q references missing economic reference asset", deployment.DeploymentID)
			}
		}
		if deployment.ReplacedByDeploymentID != nil {
			if _, ok := TokenDeploymentByID(*deployment.ReplacedByDeploymentID); !ok {
				t.Fatalf("deployment %q references missing replacement", deployment.DeploymentID)
			}
		}
	}

	aliasGroups := reflect.ValueOf(TokenAliasIDs())
	groupFields := map[string]string{"ethereum": "Ethereum", "solana": "Solana", "avalancheC": "AvalancheC"}
	for _, sourceAlias := range source.Aliases {
		var alias TokenAlias
		found := false
		for _, candidate := range aliases {
			if candidate.Namespace == sourceAlias.Namespace && candidate.Name == sourceAlias.Name {
				alias = candidate
				found = true
				break
			}
		}
		if !found || alias.DeploymentID != sourceAlias.DeploymentID {
			t.Fatalf("source alias %s.%s is missing or retargeted: %#v", sourceAlias.Namespace, sourceAlias.Name, alias)
		}
		group := aliasGroups.FieldByName(groupFields[sourceAlias.Namespace])
		if !group.IsValid() {
			t.Fatalf("generated alias group %s is missing", sourceAlias.Namespace)
		}
		constant := group.FieldByName(sourceAlias.Name)
		if !constant.IsValid() || constant.Kind() != reflect.String || constant.String() != sourceAlias.DeploymentID {
			t.Fatalf("generated alias constant %s.%s does not match source deployment %q", sourceAlias.Namespace, sourceAlias.Name, sourceAlias.DeploymentID)
		}
	}

	for _, alias := range aliases {
		deployment, ok := TokenDeploymentByID(alias.DeploymentID)
		if !ok || deployment.DeploymentID != alias.DeploymentID {
			t.Fatalf("alias %s.%s references missing deployment %q", alias.Namespace, alias.Name, alias.DeploymentID)
		}
	}

	if TokenEthereumUSDC == "" || TokenSolanaUSDC == "" || TokenAvalancheCUSDC == "" {
		t.Fatal("named generated USDC IDs must be available")
	}
	if TokenEthereumETH != "deployment-0001" || TokenEthereumWETH != "deployment-0002" || TokenAvalancheCAVAX != "deployment-0003" || TokenAvalancheCWAVAX != "deployment-0004" || TokenSolanaSOL != "deployment-0005" || TokenSolanaWSOL != "deployment-0006" {
		t.Fatal("seed generated token aliases do not match the canonical IDs")
	}
	if TokenEthereumUSDC != "deployment-0008" || TokenSolanaUSDC != "deployment-0010" || TokenAvalancheCUSDC != "deployment-0009" {
		t.Fatal("named generated USDC IDs do not match the canonical aliases")
	}
}

func TestTokenCatalogFindsAmbiguousSymbolsAndPreservesIdentity(t *testing.T) {
	eure := FindTokenDeploymentsBySymbol(TokenChainEthereumMainnet, "EURe")
	if len(eure) < 2 {
		t.Fatalf("EURe deployments = %d, want at least 2", len(eure))
	}
	if eure[0].DeploymentID > eure[1].DeploymentID {
		t.Fatalf("EURe deployments are not lexically sorted: %q, %q", eure[0].DeploymentID, eure[1].DeploymentID)
	}
	hasLegacy, hasActive := false, false
	for _, deployment := range eure {
		if deployment.AssetID != eure[0].AssetID {
			continue
		}
		hasLegacy = hasLegacy || deployment.Status == TokenStatusLegacy
		hasActive = hasActive || deployment.Status == TokenStatusActive
	}
	if !hasLegacy || !hasActive {
		t.Fatalf("EURe lifecycle statuses do not retain legacy and active records: %#v", eure)
	}

	wsol := FindTokenDeploymentsBySymbol(TokenChainSolanaMainnet, "WSOL")
	if len(wsol) < 2 {
		t.Fatalf("WSOL deployments = %d, want at least 2", len(wsol))
	}
	standards := map[TokenStandard]bool{}
	for _, deployment := range wsol {
		standards[deployment.Standard] = true
	}
	if !standards[TokenStandardSPLToken] || !standards[TokenStandardSPLToken2022] {
		t.Fatalf("WSOL standards = %#v, want SPL Token and Token-2022", standards)
	}
	if TokenSolanaWSOL == "" || TokenSolanaWSOL_TOKEN_2022 == "" || TokenSolanaWSOL == TokenSolanaWSOL_TOKEN_2022 {
		t.Fatal("WSOL aliases must be distinct named deployment IDs")
	}

	eurcvEthereum := FindTokenDeploymentsBySymbol(TokenChainEthereumMainnet, "EURCV")
	eurcvSolana := FindTokenDeploymentsBySymbol(TokenChainSolanaMainnet, "EURCV")
	if len(eurcvEthereum) != 1 || len(eurcvSolana) != 1 {
		t.Fatalf("EURCV deployments = Ethereum:%d Solana:%d, want one each", len(eurcvEthereum), len(eurcvSolana))
	}
	if eurcvEthereum[0].Decimals != 18 || eurcvSolana[0].Decimals != 2 {
		t.Fatalf("EURCV seed decimals = Ethereum:%d Solana:%d, want 18 and 2", eurcvEthereum[0].Decimals, eurcvSolana[0].Decimals)
	}
	if eurcvEthereum[0].AssetID != eurcvSolana[0].AssetID {
		t.Fatal("EURCV deployments on Ethereum and Solana should share one asset identity")
	}

	for _, chainID := range []string{TokenChainEthereumMainnet, TokenChainSolanaMainnet, TokenChainAvalancheCMainnet} {
		matches := FindTokenDeploymentsBySymbol(chainID, "USDC")
		if len(matches) == 0 {
			t.Fatalf("USDC has no deployment on %s", chainID)
		}
		for _, match := range matches {
			if string(match.ChainID) != chainID || match.Symbol != "USDC" {
				t.Fatalf("USDC result has wrong chain or symbol: %#v", match)
			}
		}
	}
}

func TestTokenCatalogListsFiltersAndLifecycleRecords(t *testing.T) {
	all := ListTokenDeployments(TokenDeploymentFilter{})
	if len(all) != len(TokenDeployments()) {
		t.Fatalf("unfiltered deployments = %d, want %d", len(all), len(TokenDeployments()))
	}

	hasKind := map[TokenRepresentationKind]bool{}
	hasStatus := map[TokenStatus]bool{}
	for _, deployment := range all {
		hasKind[deployment.RepresentationKind] = true
		hasStatus[deployment.Status] = true
	}
	for _, kind := range []TokenRepresentationKind{TokenRepresentationNative, TokenRepresentationIssued, TokenRepresentationWrapped, TokenRepresentationBridged} {
		if !hasKind[kind] {
			t.Fatalf("catalog is missing representation kind %q", kind)
		}
	}
	for _, status := range []TokenStatus{TokenStatusActive, TokenStatusLegacy, TokenStatusWindingDown, TokenStatusRetired} {
		if !hasStatus[status] {
			t.Fatalf("catalog is missing lifecycle status %q", status)
		}
	}

	for _, currency := range []string{"USD", "EUR", "JPY"} {
		filtered := ListTokenDeployments(TokenDeploymentFilter{StableCurrency: currency})
		if len(filtered) == 0 {
			t.Fatalf("stable currency %s returned no deployments", currency)
		}
		for _, deployment := range filtered {
			if tokenStableCurrency(deployment.StableCurrency) != currency {
				t.Fatalf("stable currency %s returned %#v", currency, deployment)
			}
		}
	}

	solanaEUR := ListTokenDeployments(TokenDeploymentFilter{
		ChainID:        TokenChainSolanaMainnet,
		StableCurrency: "EUR",
	})
	if len(solanaEUR) == 0 {
		t.Fatal("Solana EUR filter returned no deployments")
	}
	for _, deployment := range solanaEUR {
		if string(deployment.ChainID) != TokenChainSolanaMainnet || tokenStableCurrency(deployment.StableCurrency) != "EUR" {
			t.Fatalf("Solana EUR filter returned %#v", deployment)
		}
	}

	if got := ListTokenDeployments(TokenDeploymentFilter{ChainID: "eip155:999"}); len(got) != 0 {
		t.Fatalf("unknown chain filter returned %d records", len(got))
	}
	if got := ListTokenDeployments(TokenDeploymentFilter{StableCurrency: "GBP"}); len(got) != 0 {
		t.Fatalf("unknown stable currency filter returned %d records", len(got))
	}
}

func TestTokenCatalogAddressAndNativeLookups(t *testing.T) {
	var evm, solana TokenDeployment
	var haveEVM, haveSolana bool
	for _, deployment := range TokenDeployments() {
		if deployment.Address == nil {
			continue
		}
		if !haveEVM && string(deployment.ChainID) == TokenChainEthereumMainnet {
			evm, haveEVM = deployment, true
		}
		if !haveSolana && string(deployment.ChainID) == TokenChainSolanaMainnet {
			solana, haveSolana = deployment, true
		}
	}
	if !haveEVM || !haveSolana {
		t.Fatal("catalog must contain both EVM and Solana addressed deployments")
	}

	// Uppercase the hexadecimal body while retaining the required lowercase 0x prefix.
	mixedCase := "0x" + strings.ToUpper((*evm.Address)[2:])
	got, ok := FindTokenDeploymentByAddress(TokenChainEthereumMainnet, mixedCase)
	if !ok || got.DeploymentID != evm.DeploymentID {
		t.Fatalf("mixed-case EVM address returned %#v, want %q", got, evm.DeploymentID)
	}
	if _, ok := FindTokenDeploymentByAddress(TokenChainEthereumMainnet, "0x1234"); ok {
		t.Fatal("malformed EVM address unexpectedly matched")
	}
	if _, ok := FindTokenDeploymentByAddress(TokenChainEthereumMainnet, "0X"+(*evm.Address)[2:]); ok {
		t.Fatal("uppercase EVM prefix unexpectedly matched")
	}
	if _, ok := FindTokenDeploymentByAddress(TokenChainEthereumMainnet, "0x"+strings.Repeat("0", 40)); ok {
		t.Fatal("zero EVM address unexpectedly matched")
	}

	got, ok = FindTokenDeploymentByAddress(TokenChainSolanaMainnet, *solana.Address)
	if !ok || got.DeploymentID != solana.DeploymentID {
		t.Fatalf("exact Solana address returned %#v, want %q", got, solana.DeploymentID)
	}
	mutatedAddress := *solana.Address
	last := mutatedAddress[len(mutatedAddress)-1]
	if last == '1' {
		mutatedAddress = mutatedAddress[:len(mutatedAddress)-1] + "2"
	} else {
		mutatedAddress = mutatedAddress[:len(mutatedAddress)-1] + "1"
	}
	if _, ok := FindTokenDeploymentByAddress(TokenChainSolanaMainnet, mutatedAddress); ok {
		t.Fatal("mutated Solana address unexpectedly matched")
	}

	for _, chainID := range []string{TokenChainEthereumMainnet, TokenChainSolanaMainnet, TokenChainAvalancheCMainnet} {
		native, ok := NativeTokenDeployment(chainID)
		if !ok {
			t.Fatalf("native deployment missing for %s", chainID)
		}
		if string(native.ChainID) != chainID || native.Standard != TokenStandardNative || native.Address != nil {
			t.Fatalf("invalid native deployment for %s: %#v", chainID, native)
		}
		if _, ok := FindTokenDeploymentByAddress(chainID, ""); ok {
			t.Fatalf("empty address selected native deployment for %s", chainID)
		}
	}
	if _, ok := NativeTokenDeployment("eip155:999"); ok {
		t.Fatal("unknown chain returned a native deployment")
	}
}

func TestTokenCatalogRejectsMalformedInputsAndUsesOpaqueIDs(t *testing.T) {
	if _, ok := TokenAssetByID(""); ok {
		t.Fatal("empty asset ID unexpectedly matched")
	}
	if _, ok := TokenDeploymentByID(""); ok {
		t.Fatal("empty deployment ID unexpectedly matched")
	}
	if _, ok := TokenDeploymentByID(TokenEthereumUSDC + ":extra"); ok {
		t.Fatal("modified opaque deployment ID unexpectedly matched")
	}
	if got := FindTokenDeploymentsBySymbol(TokenChainEthereumMainnet, "usdc"); len(got) != 0 {
		t.Fatalf("lowercase symbol unexpectedly matched %d records", len(got))
	}
	if got := FindTokenDeploymentsBySymbol(TokenChainEthereumMainnet, ""); len(got) != 0 {
		t.Fatal("empty symbol unexpectedly matched")
	}
	if got := FindTokenDeploymentsBySymbol("eip155:999", "USDC"); len(got) != 0 {
		t.Fatalf("unknown chain symbol lookup returned %d records", len(got))
	}
	if _, ok := FindTokenDeploymentByAddress("eip155:999", "0x1234"); ok {
		t.Fatal("unknown chain address lookup unexpectedly matched")
	}
}

func TestTokenCatalogReadsAreIndependentAcrossCalls(t *testing.T) {
	assets := TokenAssets()
	if len(assets) == 0 {
		t.Fatal("generated asset factory returned no records")
	}
	assetID := assets[0].AssetID
	if assets[0].StableCurrency != nil {
		*assets[0].StableCurrency = "MUTATED"
	}
	assets[0].AssetID = "MUTATED"

	freshAsset, ok := TokenAssetByID(assetID)
	if !ok || freshAsset.AssetID != assetID {
		t.Fatalf("asset factory leaked caller mutation: %#v", freshAsset)
	}
	if freshAsset.StableCurrency != nil && *freshAsset.StableCurrency == "MUTATED" {
		t.Fatal("asset nullable field leaked caller mutation")
	}

	deployment, ok := TokenDeploymentByID(TokenEthereumUSDC)
	if !ok {
		t.Fatal("Ethereum USDC deployment missing")
	}
	deploymentID := deployment.DeploymentID
	if deployment.Address == nil || deployment.StableCurrency == nil {
		t.Fatal("Ethereum USDC should have address and stable currency")
	}
	*deployment.Address = "MUTATED"
	*deployment.StableCurrency = "MUTATED"

	freshDeployment, ok := TokenDeploymentByID(deploymentID)
	if !ok || freshDeployment.Address == nil || freshDeployment.StableCurrency == nil {
		t.Fatal("fresh Ethereum USDC deployment is incomplete")
	}
	if *freshDeployment.Address == "MUTATED" || *freshDeployment.StableCurrency == "MUTATED" {
		t.Fatal("deployment nullable fields leaked caller mutation")
	}

	listed := ListTokenDeployments(TokenDeploymentFilter{ChainID: TokenChainEthereumMainnet})
	if len(listed) == 0 {
		t.Fatal("chain filter returned no deployments")
	}
	listed[0].DeploymentID = "MUTATED"
	if listed[0].Address != nil {
		*listed[0].Address = "MUTATED"
	}
	freshListed := ListTokenDeployments(TokenDeploymentFilter{ChainID: TokenChainEthereumMainnet})
	if len(freshListed) == 0 || freshListed[0].DeploymentID == "MUTATED" || (freshListed[0].Address != nil && *freshListed[0].Address == "MUTATED") {
		t.Fatal("list result leaked caller mutation")
	}
}

func TestTokenCatalogChainTypesComposeWithPublicAPIs(t *testing.T) {
	if matches := FindTokenDeploymentsBySymbol(TokenEthereumChainID, "USDC"); len(matches) == 0 {
		t.Fatal("generated Ethereum chain constant does not compose with symbol lookup")
	}

	deployments := TokenDeployments()
	if len(deployments) == 0 {
		t.Fatal("generated deployment factory returned no records")
	}
	native, ok := NativeTokenDeployment(deployments[0].ChainID)
	if !ok || native.ChainID != deployments[0].ChainID {
		t.Fatalf("generated deployment ChainID does not compose with native lookup: %#v", native)
	}

	filter := TokenDeploymentFilter{ChainID: TokenChainIDs()["ethereum"]}
	if got := ListTokenDeployments(filter); len(got) == 0 {
		t.Fatal("generated chain ID map value does not compose with list filter")
	}
}

func tokenStringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
