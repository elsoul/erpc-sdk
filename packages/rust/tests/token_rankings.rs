#![allow(missing_docs)]

use std::{env, fs, path::Path};

use erpc_sdk::{
    TOKEN_CHAIN_IDS, TOKEN_RANKINGS, TOKEN_RANKINGS_METADATA, TokenRanking, list_token_rankings,
};
use serde_json::{Value, json};

fn canonical_decimal(value: &str, allow_zero: bool) -> bool {
    !value.is_empty()
        && (allow_zero || value != "0")
        && (value == "0" || !value.starts_with('0'))
        && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn runtime_ranking(ranking: &TokenRanking) -> Value {
    json!({
        "rank": ranking.rank,
        "chainId": ranking.chain_id,
        "deploymentIds": ranking.deployment_ids,
        "metric": ranking.metric,
        "valueNumerator": ranking.value_numerator,
        "valueDenominator": ranking.value_denominator,
        "quoteCurrency": ranking.quote_currency,
        "quoteDeploymentId": ranking.quote_deployment_id,
        "observedAt": ranking.observed_at,
        "sourceId": ranking.source_id,
        "sourceAssetId": ranking.source_asset_id,
    })
}

fn runtime_metadata() -> Value {
    json!({
        "schemaVersion": TOKEN_RANKINGS_METADATA.schema_version,
        "metric": TOKEN_RANKINGS_METADATA.metric,
        "asOf": TOKEN_RANKINGS_METADATA.as_of,
        "contentDigest": TOKEN_RANKINGS_METADATA.content_digest,
        "status": TOKEN_RANKINGS_METADATA.status,
        "coverage": TOKEN_RANKINGS_METADATA.coverage.iter().map(|coverage| json!({
            "chainId": coverage.chain_id,
            "totalDeployments": coverage.total_deployments,
            "rankedDeployments": coverage.ranked_deployments,
            "unrankedDeployments": coverage.unranked_deployments,
            "observedAt": coverage.observed_at,
        })).collect::<Vec<_>>(),
        "sourceIds": TOKEN_RANKINGS_METADATA.source_ids,
    })
}

#[test]
fn generated_rankings_expose_schema_safe_immutable_data() {
    assert_eq!(TOKEN_RANKINGS_METADATA.schema_version, 1);
    assert!(TOKEN_RANKINGS_METADATA.content_digest.len() == 64);
    assert!(
        TOKEN_RANKINGS_METADATA
            .content_digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    );
    assert!(matches!(
        TOKEN_RANKINGS_METADATA.status,
        "unconfigured" | "complete" | "partial"
    ));
    assert!(TOKEN_RANKINGS_METADATA.metric.is_none_or(|metric| matches!(
        metric,
        "onchain-total-supply-value-native" | "global-circulating-market-cap-usd"
    )));
    assert!(
        TOKEN_RANKINGS_METADATA
            .as_of
            .is_none_or(|as_of| !as_of.is_empty())
    );

    for coverage in TOKEN_RANKINGS_METADATA.coverage {
        assert!(!coverage.chain_id.is_empty());
        assert!(
            coverage.ranked_deployments + coverage.unranked_deployments
                <= coverage.total_deployments
        );
    }
    for ranking in TOKEN_RANKINGS {
        assert!(ranking.rank > 0);
        assert!(!ranking.chain_id.is_empty());
        assert!(!ranking.deployment_ids.is_empty());
        assert!(canonical_decimal(ranking.value_numerator, true));
        assert!(canonical_decimal(ranking.value_denominator, false));
        assert!(matches!(ranking.quote_currency, "native" | "USD"));
        assert!(!ranking.observed_at.is_empty());
        assert!(!ranking.source_id.is_empty());
    }
}

#[test]
fn list_rankings_is_offline_exact_and_growth_safe() {
    for (_, chain_id) in TOKEN_CHAIN_IDS {
        let expected: Vec<_> = TOKEN_RANKINGS
            .iter()
            .filter(|ranking| ranking.chain_id == *chain_id)
            .map(runtime_ranking)
            .collect();
        let actual: Vec<_> = list_token_rankings(chain_id)
            .into_iter()
            .map(runtime_ranking)
            .collect();
        assert_eq!(actual, expected);
    }

    for chain_id in ["", "unknown:chain", "constructor", "toString", "__proto__"] {
        assert!(list_token_rankings(chain_id).is_empty());
    }
}

#[test]
fn captures_native_ranking_parity_when_requested() {
    let Some(output) = env::var_os("ERPC_SDK_RANKING_PARITY_OUTPUT") else {
        return;
    };

    let behavior_inputs: Vec<&str> = TOKEN_CHAIN_IDS
        .iter()
        .map(|(_, chain_id)| *chain_id)
        .chain(["", "unknown:chain", "constructor", "toString", "__proto__"])
        .collect();
    let behavior = behavior_inputs
        .into_iter()
        .map(|chain_id| {
            let rows = list_token_rankings(chain_id)
                .into_iter()
                .map(runtime_ranking)
                .collect::<Vec<_>>();
            (chain_id.to_owned(), Value::Array(rows))
        })
        .collect::<serde_json::Map<_, _>>();
    let snapshot = json!({
        "snapshotVersion": 1,
        "snapshotKind": "native-runtime",
        "language": "rust",
        "runtime": format!("rust-cargo-test-erpc-sdk-{}", env!("CARGO_PKG_VERSION")),
        "metadata": runtime_metadata(),
        "records": TOKEN_RANKINGS.iter().map(runtime_ranking).collect::<Vec<_>>(),
        "behavior": behavior,
    });

    let output = Path::new(&output);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).expect("parity output directory");
    }
    let mut encoded = serde_json::to_vec_pretty(&snapshot).expect("parity snapshot serializes");
    encoded.push(b'\n');
    fs::write(output, encoded).expect("parity snapshot write");
}
