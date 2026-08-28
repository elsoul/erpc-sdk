use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{Result, rest::RestTransport};

/// ERPC account plan returned by the token balance API.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ErpcPlan {
    /// Business plan.
    Business,
    /// Developer plan.
    Developer,
    /// Free plan.
    Free,
    /// Pro plan.
    Pro,
}

/// Current account token balance.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct TokenBalance {
    /// Maximum token balance.
    pub max_tokens: u64,
    /// Next refill time, when applicable.
    pub next_refill_at: Option<String>,
    /// Current plan.
    pub plan: ErpcPlan,
    /// Remaining tokens.
    pub remaining_tokens: u64,
}

/// Account and token-balance API.
#[derive(Clone)]
pub struct AccountClient {
    transport: RestTransport,
}

impl AccountClient {
    pub(crate) const fn new(transport: RestTransport) -> Self {
        Self { transport }
    }

    /// Gets the current token balance.
    pub async fn get_token_balance(&self) -> Result<TokenBalance> {
        self.get_token_balance_with(None).await
    }

    /// Gets the current token balance with cancellation.
    pub async fn get_token_balance_with(
        &self,
        cancellation: Option<&CancellationToken>,
    ) -> Result<TokenBalance> {
        self.transport
            .get("/v3/erpc/token-balance", Vec::new(), cancellation)
            .await
    }
}
