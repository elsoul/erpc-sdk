use std::{collections::HashMap, sync::Arc, time::Duration};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio::sync::{Mutex, broadcast, mpsc, oneshot};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{
    ErpcError, JsonRpcErrorObject, Result,
    error::{invalid_response, rpc_error_with_secrets, timeout},
};

/// JSON-RPC subscription identifier.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(untagged)]
pub enum SubscriptionId {
    /// Numeric identifier used by Solana subscriptions.
    Number(u64),
    /// String identifier used by Ethereum subscriptions.
    String(String),
}

/// One JSON-RPC notification received over WebSocket.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct RpcNotification {
    /// JSON-RPC protocol version.
    pub jsonrpc: String,
    /// Wire-compatible notification method.
    pub method: String,
    /// Notification parameters.
    pub params: Value,
}

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>>;

pub(crate) struct WebSocketJsonRpcTransport {
    connection_url: Url,
    public_endpoint: String,
    redaction_secrets: Vec<String>,
    timeout: Duration,
    next_id: std::sync::atomic::AtomicU64,
    outbound: Mutex<Option<mpsc::UnboundedSender<Message>>>,
    pending: PendingMap,
    notifications: broadcast::Sender<RpcNotification>,
    configured: bool,
    namespace: String,
}

impl WebSocketJsonRpcTransport {
    pub fn new(connection_url: Url, timeout: Duration) -> Self {
        let credential = connection_url
            .query_pairs()
            .find_map(|(key, value)| (key == "api-key").then(|| value.into_owned()))
            .unwrap_or_default();
        let redaction_secrets = (!credential.is_empty())
            .then_some(vec![credential])
            .unwrap_or_default();
        Self::from_parts(
            connection_url,
            redaction_secrets,
            timeout,
            "subscriptions",
            true,
        )
    }

    pub(crate) fn new_direct(
        connection_url: Url,
        redaction_secrets: Vec<String>,
        timeout: Duration,
        namespace: impl Into<String>,
    ) -> Self {
        Self::from_parts(connection_url, redaction_secrets, timeout, namespace, true)
    }

    pub(crate) fn unavailable(namespace: impl Into<String>, timeout: Duration) -> Self {
        Self::from_parts(
            Url::parse("ws://127.0.0.1/").expect("static unavailable endpoint"),
            Vec::new(),
            timeout,
            namespace,
            false,
        )
    }

    fn from_parts(
        connection_url: Url,
        redaction_secrets: Vec<String>,
        timeout: Duration,
        namespace: impl Into<String>,
        configured: bool,
    ) -> Self {
        let mut public = connection_url.clone();
        public.set_query(None);
        public.set_fragment(None);
        let public_endpoint = if configured {
            public.to_string()
        } else {
            String::new()
        };
        let (notifications, _) = broadcast::channel(256);
        Self {
            connection_url,
            public_endpoint,
            redaction_secrets,
            timeout,
            next_id: std::sync::atomic::AtomicU64::new(1),
            outbound: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            notifications,
            configured,
            namespace: namespace.into(),
        }
    }

    pub fn endpoint(&self) -> &str {
        &self.public_endpoint
    }

    async fn connect(&self) -> Result<mpsc::UnboundedSender<Message>> {
        self.ensure_configured()?;
        let mut outbound = self.outbound.lock().await;
        if let Some(sender) = outbound.as_ref() {
            if !sender.is_closed() {
                return Ok(sender.clone());
            }
        }
        let connection =
            tokio::time::timeout(self.timeout, connect_async(self.connection_url.as_str()))
                .await
                .map_err(|_| timeout(self.timeout))?
                .map_err(|_| {
                    ErpcError::Transport("Unable to connect to ERPC WebSocket".to_owned())
                })?;
        let (mut sink, mut stream) = connection.0.split();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        *outbound = Some(sender.clone());

        let pending_for_writer = Arc::clone(&self.pending);
        tokio::spawn(async move {
            while let Some(message) = receiver.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
            let mut pending = pending_for_writer.lock().await;
            for (_, response) in pending.drain() {
                let _ = response.send(Err(ErpcError::Transport(
                    "ERPC WebSocket connection closed".to_owned(),
                )));
            }
        });

        let pending_for_reader = Arc::clone(&self.pending);
        let notifications = self.notifications.clone();
        let redaction_secrets = self.redaction_secrets.clone();
        tokio::spawn(async move {
            while let Some(message) = stream.next().await {
                let Ok(message) = message else { break };
                let text = match message {
                    Message::Text(text) => text.to_string(),
                    Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if let Value::Array(values) = value {
                    for value in values {
                        dispatch(
                            value,
                            &pending_for_reader,
                            &notifications,
                            &redaction_secrets,
                        )
                        .await;
                    }
                } else {
                    dispatch(
                        value,
                        &pending_for_reader,
                        &notifications,
                        &redaction_secrets,
                    )
                    .await;
                }
            }
            let mut pending = pending_for_reader.lock().await;
            for (_, response) in pending.drain() {
                let _ = response.send(Err(ErpcError::Transport(
                    "ERPC WebSocket connection closed".to_owned(),
                )));
            }
        });
        Ok(sender)
    }

    pub async fn request<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
        cancellation: Option<&CancellationToken>,
    ) -> Result<T> {
        let sender = self.connect().await?;
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let text = serde_json::to_string(&request)
            .map_err(|_| ErpcError::Config("RPC parameters could not be serialized".to_owned()))?;
        let (response_sender, response_receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, response_sender);
        if sender.send(Message::Text(text.into())).is_err() {
            self.pending.lock().await.remove(&id);
            return Err(ErpcError::Transport(
                "Unable to send ERPC WebSocket request".to_owned(),
            ));
        }
        let response = if let Some(cancellation) = cancellation {
            tokio::select! {
                () = cancellation.cancelled() => {
                    self.pending.lock().await.remove(&id);
                    return Err(ErpcError::Aborted);
                }
                response = tokio::time::timeout(self.timeout, response_receiver) => response,
            }
        } else {
            tokio::time::timeout(self.timeout, response_receiver).await
        };
        let value = response
            .map_err(|_| timeout(self.timeout))?
            .map_err(|_| ErpcError::Transport("ERPC WebSocket connection closed".to_owned()))??;
        serde_json::from_value(value)
            .map_err(|_| invalid_response("ERPC returned an unexpected result shape"))
    }

    pub fn subscribe_notifications(&self) -> broadcast::Receiver<RpcNotification> {
        self.notifications.subscribe()
    }

    pub async fn close(&self) {
        if let Some(sender) = self.outbound.lock().await.take() {
            let _ = sender.send(Message::Close(None));
        }
    }

    fn ensure_configured(&self) -> Result<()> {
        if self.configured {
            Ok(())
        } else {
            Err(ErpcError::NotConfigured(self.namespace.clone()))
        }
    }
}

async fn dispatch(
    value: Value,
    pending: &PendingMap,
    notifications: &broadcast::Sender<RpcNotification>,
    redaction_secrets: &[String],
) {
    let Some(object) = value.as_object() else {
        return;
    };
    if let Some(id) = object.get("id").and_then(Value::as_u64) {
        let Some(response) = pending.lock().await.remove(&id) else {
            return;
        };
        if let Some(error) = object.get("error") {
            let result = serde_json::from_value::<JsonRpcErrorObject>(error.clone()).map_or_else(
                |_| Err(invalid_response("ERPC returned an invalid RPC error")),
                |error| Err(rpc_error_with_secrets(error, redaction_secrets)),
            );
            let _ = response.send(result);
        } else if let Some(result) = object.get("result") {
            let _ = response.send(Ok(result.clone()));
        } else {
            let _ = response.send(Err(invalid_response("ERPC returned an invalid response")));
        }
        return;
    }
    if object.get("jsonrpc").and_then(Value::as_str) == Some("2.0")
        && object.get("method").and_then(Value::as_str).is_some()
        && object.contains_key("params")
    {
        let notification = RpcNotification {
            jsonrpc: "2.0".to_owned(),
            method: object["method"].as_str().unwrap_or_default().to_owned(),
            params: object["params"].clone(),
        };
        let _ = notifications.send(notification);
    }
}

/// Active subscription with typed notification retrieval and idempotent unsubscribe.
pub struct RpcSubscription {
    /// Server subscription identifier.
    pub id: SubscriptionId,
    transport: Arc<WebSocketJsonRpcTransport>,
    unsubscribe_method: String,
    receiver: Mutex<broadcast::Receiver<RpcNotification>>,
    closed: std::sync::atomic::AtomicBool,
}

impl RpcSubscription {
    pub(crate) fn new(
        id: SubscriptionId,
        transport: Arc<WebSocketJsonRpcTransport>,
        unsubscribe_method: impl Into<String>,
        receiver: broadcast::Receiver<RpcNotification>,
    ) -> Self {
        Self {
            id,
            transport,
            unsubscribe_method: unsubscribe_method.into(),
            receiver: Mutex::new(receiver),
            closed: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Waits for the next matching notification and deserializes its `result`.
    pub async fn next<T: DeserializeOwned>(&self) -> Result<T> {
        loop {
            let notification = self.receiver.lock().await.recv().await.map_err(|_| {
                ErpcError::Transport("ERPC WebSocket notification stream closed".to_owned())
            })?;
            let Some(params) = notification.params.as_object() else {
                continue;
            };
            let Some(subscription) = params.get("subscription") else {
                continue;
            };
            let Ok(subscription) = serde_json::from_value::<SubscriptionId>(subscription.clone())
            else {
                continue;
            };
            if subscription != self.id {
                continue;
            }
            let result = params
                .get("result")
                .cloned()
                .ok_or_else(|| invalid_response("ERPC returned an invalid notification"))?;
            return serde_json::from_value(result)
                .map_err(|_| invalid_response("ERPC returned an unexpected result shape"));
        }
    }

    /// Unsubscribes. Calls after a successful unsubscribe return `true`.
    pub async fn unsubscribe(&self) -> Result<bool> {
        if self.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Ok(true);
        }
        let result: bool = self
            .transport
            .request(&self.unsubscribe_method, serde_json::json!([self.id]), None)
            .await?;
        if result {
            self.closed
                .store(true, std::sync::atomic::Ordering::Release);
        }
        Ok(result)
    }
}
