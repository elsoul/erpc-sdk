use std::{future::Future, time::Duration};

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
    configured: bool,
    namespace: String,
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
            configured: true,
            namespace: "REST".to_owned(),
        }
    }

    pub fn unavailable(namespace: impl Into<String>, timeout: Duration, client: Client) -> Self {
        Self {
            api_key: String::new(),
            endpoint: Url::parse("http://127.0.0.1/").expect("static unavailable endpoint"),
            headers: HeaderMap::new(),
            timeout,
            client,
            configured: false,
            namespace: namespace.into(),
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
        let operation = async {
            let response = self.send(path, query).await?;
            let body = response
                .text()
                .await
                .map_err(|_| ErpcError::Transport("Unable to read ERPC response".to_owned()))?;
            serde_json::from_str(&body)
                .map_err(|_| ErpcError::InvalidResponse("ERPC returned malformed JSON".to_owned()))
        };
        self.run(operation, cancellation).await
    }

    pub async fn get_response(
        &self,
        path: &str,
        query: Query,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Response> {
        self.run(self.send(path, query), cancellation).await
    }

    async fn send(&self, path: &str, query: Query) -> Result<Response> {
        if !self.configured {
            return Err(ErpcError::NotConfigured(self.namespace.clone()));
        }
        let url = self.url(path, &query);
        let response = self
            .client
            .get(url)
            .headers(self.headers.clone())
            .bearer_auth(&self.api_key)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| ErpcError::Transport("Unable to reach ERPC".to_owned()))?;
        if !response.status().is_success() {
            return Err(ErpcError::Http {
                status: response.status().as_u16(),
            });
        }
        Ok(response)
    }

    async fn run<T>(
        &self,
        operation: impl Future<Output = Result<T>>,
        cancellation: Option<&CancellationToken>,
    ) -> Result<T> {
        let timed = tokio::time::timeout(self.timeout, operation);
        let result = if let Some(cancellation) = cancellation {
            tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(ErpcError::Aborted),
                result = timed => result,
            }
        } else {
            timed.await
        };
        result.map_err(|_| timeout(self.timeout))?
    }
}
