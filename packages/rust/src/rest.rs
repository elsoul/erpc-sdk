use std::time::Duration;

use reqwest::{Client, Response, header::HeaderMap};
use serde::de::DeserializeOwned;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{ErpcError, Result, error::timeout};

pub(crate) type Query = Vec<(String, String)>;

#[derive(Clone)]
pub(crate) struct RestTransport {
    api_key: String,
    endpoint: Url,
    headers: HeaderMap,
    timeout: Duration,
    client: Client,
}

impl RestTransport {
    pub fn new(
        api_key: String,
        endpoint: Url,
        headers: HeaderMap,
        timeout: Duration,
        client: Client,
    ) -> Self {
        Self {
            api_key,
            endpoint,
            headers,
            timeout,
            client,
        }
    }

    pub fn url(&self, path: &str, query: &Query) -> Url {
        let mut url = self.endpoint.clone();
        let base = url.path().trim_end_matches('/');
        url.set_path(&format!("{base}/{}", path.trim_start_matches('/')));
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter());
        }
        url
    }

    pub async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: Query,
        cancellation: Option<&CancellationToken>,
    ) -> Result<T> {
        let response = self.get_response(path, query, cancellation).await?;
        let body = response
            .text()
            .await
            .map_err(|_| ErpcError::Transport("Unable to read ERPC response".to_owned()))?;
        serde_json::from_str(&body)
            .map_err(|_| ErpcError::InvalidResponse("ERPC returned malformed JSON".to_owned()))
    }

    pub async fn get_response(
        &self,
        path: &str,
        query: Query,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Response> {
        let url = self.url(path, &query);
        let request = self
            .client
            .get(url)
            .headers(self.headers.clone())
            .bearer_auth(&self.api_key)
            .header(reqwest::header::ACCEPT, "application/json")
            .send();

        let result = if let Some(cancellation) = cancellation {
            tokio::select! {
                () = cancellation.cancelled() => return Err(ErpcError::Aborted),
                result = tokio::time::timeout(self.timeout, request) => result,
            }
        } else {
            tokio::time::timeout(self.timeout, request).await
        };
        let response = result
            .map_err(|_| timeout(self.timeout))?
            .map_err(|_| ErpcError::Transport("Unable to reach ERPC".to_owned()))?;
        if !response.status().is_success() {
            return Err(ErpcError::Http {
                status: response.status().as_u16(),
            });
        }
        Ok(response)
    }
}
