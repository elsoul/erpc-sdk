package erpc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"testing"
)

type goRankingSource struct {
	Metadata goRankingMetadataSource `json:"metadata"`
	Records  []goRankingRecordSource `json:"records"`
}

type goRankingMetadataSource struct {
	SchemaVersion int                       `json:"schemaVersion"`
	Metric        *string                   `json:"metric"`
	AsOf          *string                   `json:"asOf"`
	ContentDigest string                    `json:"contentDigest"`
	Status        string                    `json:"status"`
	Coverage      []goRankingCoverageSource `json:"coverage"`
	SourceIDs     []string                  `json:"sourceIds"`
}

type goRankingCoverageSource struct {
	ChainID             string  `json:"chainId"`
	TotalDeployments    int     `json:"totalDeployments"`
	RankedDeployments   int     `json:"rankedDeployments"`
	UnrankedDeployments int     `json:"unrankedDeployments"`
	ObservedAt          *string `json:"observedAt"`
}

type goRankingRecordSource struct {
	Rank              int      `json:"rank"`
	ChainID           string   `json:"chainId"`
	DeploymentIDs     []string `json:"deploymentIds"`
	Metric            string   `json:"metric"`
	ValueNumerator    string   `json:"valueNumerator"`
	ValueDenominator  string   `json:"valueDenominator"`
	QuoteCurrency     string   `json:"quoteCurrency"`
	QuoteDeploymentID *string  `json:"quoteDeploymentId"`
	ObservedAt        string   `json:"observedAt"`
	SourceID          string   `json:"sourceId"`
	SourceAssetID     *string  `json:"sourceAssetId"`
}

var (
	goRankingNonNegativeDecimal = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
	goRankingPositiveDecimal    = regexp.MustCompile(`^[1-9][0-9]*$`)
)

func rankingRowJSON(row TokenRanking) map[string]any {
	return map[string]any{
		"rank":              row.Rank,
		"chainId":           row.ChainID,
		"deploymentIds":     append([]string(nil), row.DeploymentIDs...),
		"metric":            row.Metric,
		"valueNumerator":    row.ValueNumerator,
		"valueDenominator":  row.ValueDenominator,
		"quoteCurrency":     row.QuoteCurrency,
		"quoteDeploymentId": tokenRankingPointerValue(row.QuoteDeploymentID),
		"observedAt":        row.ObservedAt,
		"sourceId":          row.SourceID,
		"sourceAssetId":     tokenRankingPointerValue(row.SourceAssetID),
	}
}

func rankingMetadataJSON(metadata TokenRankingSnapshotMetadata) map[string]any {
	coverage := make([]map[string]any, 0, len(metadata.Coverage))
	for _, value := range metadata.Coverage {
		coverage = append(coverage, map[string]any{
			"chainId":             value.ChainID,
			"totalDeployments":    value.TotalDeployments,
			"rankedDeployments":   value.RankedDeployments,
			"unrankedDeployments": value.UnrankedDeployments,
			"observedAt":          tokenRankingPointerValue(value.ObservedAt),
		})
	}
	var sourceIDs []string
	if metadata.SourceIDs != nil {
		sourceIDs = make([]string, len(metadata.SourceIDs))
		copy(sourceIDs, metadata.SourceIDs)
	}
	return map[string]any{
		"schemaVersion": metadata.SchemaVersion,
		"metric":        tokenRankingPointerValue(metadata.Metric),
		"asOf":          tokenRankingPointerValue(metadata.AsOf),
		"contentDigest": metadata.ContentDigest,
		"status":        metadata.Status,
		"coverage":      coverage,
		"sourceIds":     sourceIDs,
	}
}

func tokenRankingPointerValue(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func allPublicTokenRankingRows() []TokenRanking {
	result := make([]TokenRanking, 0)
	for _, chainID := range TokenChainIDs() {
		result = append(result, ListTokenRankings(chainID)...)
	}
	sort.SliceStable(result, func(left, right int) bool {
		if result[left].ChainID != result[right].ChainID {
			return result[left].ChainID < result[right].ChainID
		}
		return result[left].Rank < result[right].Rank
	})
	return result
}

func TestTokenRankingsExposeExactSchemaAndCanonicalSnapshot(t *testing.T) {
	var source goRankingSource
	loadGoRegistryJSON(t, "token-rankings.json", &source)

	metadata := TokenRankingMetadata()
	if metadata.SchemaVersion != source.Metadata.SchemaVersion || metadata.ContentDigest != source.Metadata.ContentDigest || metadata.Status != source.Metadata.Status {
		t.Fatalf("ranking metadata scalar fields = %#v, want source %#v", rankingMetadataJSON(metadata), source.Metadata)
	}
	if tokenRankingPointerValue(metadata.Metric) != tokenRankingPointerValue(source.Metadata.Metric) || tokenRankingPointerValue(metadata.AsOf) != tokenRankingPointerValue(source.Metadata.AsOf) {
		t.Fatalf("ranking metadata metric/asOf = (%v, %v), want (%v, %v)", tokenRankingPointerValue(metadata.Metric), tokenRankingPointerValue(metadata.AsOf), tokenRankingPointerValue(source.Metadata.Metric), tokenRankingPointerValue(source.Metadata.AsOf))
	}
	if len(metadata.Coverage) != len(source.Metadata.Coverage) || len(metadata.SourceIDs) != len(source.Metadata.SourceIDs) {
		t.Fatalf("ranking metadata nested lengths = (%d, %d), want (%d, %d)", len(metadata.Coverage), len(metadata.SourceIDs), len(source.Metadata.Coverage), len(source.Metadata.SourceIDs))
	}
	if metadata.Coverage == nil || metadata.SourceIDs == nil {
		t.Fatalf("ranking metadata arrays must preserve empty arrays: %#v", metadata)
	}
	for index, expected := range source.Metadata.Coverage {
		actual := metadata.Coverage[index]
		if actual.ChainID != expected.ChainID || actual.TotalDeployments != expected.TotalDeployments || actual.RankedDeployments != expected.RankedDeployments || actual.UnrankedDeployments != expected.UnrankedDeployments || tokenRankingPointerValue(actual.ObservedAt) != tokenRankingPointerValue(expected.ObservedAt) {
			t.Fatalf("ranking coverage[%d] = %#v, want %#v", index, actual, expected)
		}
	}
	for index, expected := range source.Metadata.SourceIDs {
		if metadata.SourceIDs[index] != expected {
			t.Fatalf("ranking source ID[%d] = %q, want %q", index, metadata.SourceIDs[index], expected)
		}
	}

	if TokenRankingsSchemaVersion != source.Metadata.SchemaVersion || TokenRankingsContentDigest != source.Metadata.ContentDigest || TokenRankingsStatus != source.Metadata.Status {
		t.Fatalf("ranking constants do not match source metadata")
	}
	if TokenRankingsMetric != stringPointerOrEmpty(source.Metadata.Metric) || TokenRankingsAsOf != stringPointerOrEmpty(source.Metadata.AsOf) {
		t.Fatalf("ranking optional constants do not match source metadata")
	}

	rows := allPublicTokenRankingRows()
	if len(rows) != len(source.Records) {
		t.Fatalf("public ranking row count = %d, want source count %d", len(rows), len(source.Records))
	}
	rowKeys := []string{"chainId", "deploymentIds", "metric", "observedAt", "quoteCurrency", "quoteDeploymentId", "rank", "sourceAssetId", "sourceId", "valueDenominator", "valueNumerator"}
	for index, expected := range source.Records {
		actual := rows[index]
		if got := rankingRowJSON(actual); !sameJSONKeys(got, rowKeys) {
			t.Fatalf("ranking row %d keys = %#v, want %v", index, sortedJSONKeys(got), rowKeys)
		}
		want := map[string]any{
			"rank":              expected.Rank,
			"chainId":           expected.ChainID,
			"deploymentIds":     expected.DeploymentIDs,
			"metric":            expected.Metric,
			"valueNumerator":    expected.ValueNumerator,
			"valueDenominator":  expected.ValueDenominator,
			"quoteCurrency":     expected.QuoteCurrency,
			"quoteDeploymentId": tokenRankingPointerValue(expected.QuoteDeploymentID),
			"observedAt":        expected.ObservedAt,
			"sourceId":          expected.SourceID,
			"sourceAssetId":     tokenRankingPointerValue(expected.SourceAssetID),
		}
		mustSameJSON(t, rankingRowJSON(actual), want)
		if actual.Rank <= 0 || actual.ChainID == "" || len(actual.DeploymentIDs) == 0 || actual.SourceID == "" || actual.ObservedAt == "" {
			t.Fatalf("ranking row %d has missing required values: %#v", index, actual)
		}
		if !goRankingNonNegativeDecimal.MatchString(actual.ValueNumerator) || !goRankingPositiveDecimal.MatchString(actual.ValueDenominator) {
			t.Fatalf("ranking row %d has non-canonical rational: %#v", index, actual)
		}
		if actual.QuoteCurrency != "native" && actual.QuoteCurrency != "USD" {
			t.Fatalf("ranking row %d has unknown quote currency %q", index, actual.QuoteCurrency)
		}
	}

	metadataKeys := []string{"asOf", "contentDigest", "coverage", "metric", "schemaVersion", "sourceIds", "status"}
	if got := rankingMetadataJSON(metadata); !sameJSONKeys(got, metadataKeys) {
		t.Fatalf("ranking metadata keys = %#v, want %v", sortedJSONKeys(got), metadataKeys)
	}
	if len(metadata.Coverage) > 0 {
		for _, coverage := range metadata.Coverage {
			if coverage.RankedDeployments < 0 || coverage.UnrankedDeployments < 0 || coverage.RankedDeployments+coverage.UnrankedDeployments > coverage.TotalDeployments {
				t.Fatalf("invalid ranking coverage: %#v", coverage)
			}
		}
	}
	nativeQuotes := map[string]string{
		TokenChainEthereumMainnet:   "deployment-0001",
		TokenChainAvalancheCMainnet: "deployment-0003",
		TokenChainSolanaMainnet:     "deployment-0005",
	}
	for index, row := range rows {
		switch row.Metric {
		case "onchain-total-supply-value-native":
			if len(row.DeploymentIDs) != 1 || row.QuoteCurrency != "native" || row.SourceAssetID != nil || row.QuoteDeploymentID == nil || *row.QuoteDeploymentID != nativeQuotes[row.ChainID] {
				t.Fatalf("native ranking row %d has invalid quote projection: %#v", index, row)
			}
		case "global-circulating-market-cap-usd":
			if row.QuoteCurrency != "USD" || row.QuoteDeploymentID != nil || row.SourceAssetID == nil || *row.SourceAssetID == "" {
				t.Fatalf("global ranking row %d has invalid quote projection: %#v", index, row)
			}
		default:
			t.Fatalf("ranking row %d has unknown metric %q", index, row.Metric)
		}
	}
}

func TestListTokenRankingsIsExactOfflineLookupAndReturnsIndependentNestedValues(t *testing.T) {
	allRows := allPublicTokenRankingRows()
	for _, chainID := range []string{TokenChainEthereumMainnet, TokenChainSolanaMainnet, TokenChainAvalancheCMainnet} {
		got := ListTokenRankings(chainID)
		want := make([]TokenRanking, 0)
		for _, row := range allRows {
			if row.ChainID == chainID {
				want = append(want, row)
			}
		}
		if len(got) != len(want) {
			t.Fatalf("rankings for %s = %d, want %d", chainID, len(got), len(want))
		}
		for index := range got {
			mustSameJSON(t, rankingRowJSON(got[index]), rankingRowJSON(want[index]))
		}
		if len(got) == 0 {
			continue
		}
		got[0].DeploymentIDs[0] = "mutated"
		if got[0].QuoteDeploymentID != nil {
			*got[0].QuoteDeploymentID = "mutated"
		}
		if got[0].SourceAssetID != nil {
			*got[0].SourceAssetID = "mutated"
		}
		fresh := ListTokenRankings(chainID)
		if len(fresh) == 0 || fresh[0].DeploymentIDs[0] == "mutated" || (fresh[0].QuoteDeploymentID != nil && *fresh[0].QuoteDeploymentID == "mutated") || (fresh[0].SourceAssetID != nil && *fresh[0].SourceAssetID == "mutated") {
			t.Fatalf("ranking row nested values leaked caller mutation for %s", chainID)
		}
	}

	for _, chainID := range []string{"", "unknown:chain", "constructor", "toString", "__proto__"} {
		got := ListTokenRankings(chainID)
		if got == nil || len(got) != 0 {
			t.Fatalf("invalid ranking query %q = %#v, want non-nil empty result", chainID, got)
		}
	}

	first := TokenRankingMetadata()
	if len(first.Coverage) > 0 {
		first.Coverage[0].ChainID = "mutated"
		if first.Coverage[0].ObservedAt != nil {
			*first.Coverage[0].ObservedAt = "mutated"
		}
	}
	if len(first.SourceIDs) > 0 {
		first.SourceIDs[0] = "mutated"
	}
	second := TokenRankingMetadata()
	if len(second.Coverage) > 0 && (second.Coverage[0].ChainID == "mutated" || (second.Coverage[0].ObservedAt != nil && *second.Coverage[0].ObservedAt == "mutated")) {
		t.Fatal("ranking metadata coverage leaked caller mutation")
	}
	if len(second.SourceIDs) > 0 && second.SourceIDs[0] == "mutated" {
		t.Fatal("ranking metadata source IDs leaked caller mutation")
	}
}

func TestTokenRankingParityCapture(t *testing.T) {
	outputPath := os.Getenv("ERPC_SDK_RANKING_PARITY_OUTPUT")
	if outputPath == "" {
		return
	}

	chainIDs := TokenChainIDs()
	behaviorInputs := []string{chainIDs["ethereum"], chainIDs["solana"], chainIDs["avalancheC"], "", "unknown:chain", "constructor", "toString", "__proto__"}
	behavior := make(map[string]any, len(behaviorInputs))
	for _, chainID := range behaviorInputs {
		rows := ListTokenRankings(chainID)
		encoded := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			encoded = append(encoded, rankingRowJSON(row))
		}
		behavior[chainID] = encoded
	}
	records := make([]map[string]any, 0)
	for _, row := range allPublicTokenRankingRows() {
		records = append(records, rankingRowJSON(row))
	}
	snapshot := map[string]any{
		"snapshotVersion": 1,
		"snapshotKind":    "native-runtime",
		"language":        "go",
		"runtime":         "go-native-runtime-" + runtime.Version() + "-" + runtime.GOOS + "-" + runtime.GOARCH + "-github.com/elsoul/erpc-sdk/packages/go",
		"metadata":        rankingMetadataJSON(TokenRankingMetadata()),
		"records":         records,
		"behavior":        behavior,
	}
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		t.Fatalf("create ranking parity output directory: %v", err)
	}
	if err := os.WriteFile(outputPath, append(data, '\n'), 0o644); err != nil {
		t.Fatalf("write ranking parity output: %v", err)
	}
}

func stringPointerOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func sortedJSONKeys(value map[string]any) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func sameJSONKeys(value map[string]any, expected []string) bool {
	actual := sortedJSONKeys(value)
	want := append([]string(nil), expected...)
	sort.Strings(want)
	if len(actual) != len(want) {
		return false
	}
	for index := range actual {
		if actual[index] != want[index] {
			return false
		}
	}
	return true
}
