#![allow(missing_docs)]

use erpc_sdk::{ErpcClient, ErpcClientConfig, RpcEndpointConfig};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
    },
};

#[tokio::test]
async fn ethereum_subscription_routes_notifications_and_unsubscribes() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_hdr_async(stream, |request: &Request, response: Response| {
            assert_eq!(request.uri().path(), "/eth");
            assert_eq!(request.uri().query(), Some("api-key=socket-key"));
            Ok(response)
        })
        .await
        .unwrap();

        let subscribe = socket.next().await.unwrap().unwrap();
        let Message::Text(subscribe) = subscribe else {
            panic!("expected text subscribe request");
        };
        let subscribe: Value = serde_json::from_str(&subscribe).unwrap();
        assert_eq!(subscribe["method"], "eth_subscribe");
        assert_eq!(subscribe["params"], json!(["newHeads"]));
        let id = subscribe["id"].clone();
        socket
            .send(Message::Text(
                json!({"jsonrpc": "2.0", "id": id, "result": "sub-1"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        socket
            .send(Message::Text(
                json!({
                    "jsonrpc": "2.0",
                    "method": "eth_subscription",
                    "params": {
                        "subscription": "sub-1",
                        "result": {"number": "0x2a"}
                    }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

        let unsubscribe = socket.next().await.unwrap().unwrap();
        let Message::Text(unsubscribe) = unsubscribe else {
            panic!("expected text unsubscribe request");
        };
        let unsubscribe: Value = serde_json::from_str(&unsubscribe).unwrap();
        assert_eq!(unsubscribe["method"], "eth_unsubscribe");
        assert_eq!(unsubscribe["params"], json!(["sub-1"]));
        let id = unsubscribe["id"].clone();
        socket
            .send(Message::Text(
                json!({"jsonrpc": "2.0", "id": id, "result": true})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
    });

    let client = ErpcClient::new(
        ErpcClientConfig::new("socket-key").with_endpoint(format!("http://{address}")),
    )
    .unwrap();
    assert!(
        !client
            .ethereum
            .subscriptions
            .endpoint()
            .contains("socket-key")
    );
    let subscription = client
        .ethereum
        .subscriptions
        .subscribe("newHeads", Vec::new())
        .await
        .unwrap();
    let notification: Value = subscription.next().await.unwrap();
    assert_eq!(notification, json!({"number": "0x2a"}));
    assert!(subscription.unsubscribe().await.unwrap());
    assert!(subscription.unsubscribe().await.unwrap());
    server.await.unwrap();
}

#[tokio::test]
async fn direct_websocket_preserves_target_without_http_headers() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_hdr_async(stream, |request: &Request, response: Response| {
            assert_eq!(request.uri().path(), "/customer/ws");
            assert_eq!(request.uri().query(), Some("token=a%2Fb&region=eu"));
            assert_eq!(
                request
                    .headers()
                    .get("authorization")
                    .and_then(|value| value.to_str().ok()),
                None
            );
            assert!(request.headers().get("x-node-scope").is_none());
            assert!(request.headers().get("x-global").is_none());
            Ok(response)
        })
        .await
        .unwrap();

        let subscribe = socket.next().await.unwrap().unwrap();
        let Message::Text(subscribe) = subscribe else {
            panic!("expected text subscribe request");
        };
        let subscribe: Value = serde_json::from_str(&subscribe).unwrap();
        assert_eq!(subscribe["method"], "eth_subscribe");
        let id = subscribe["id"].clone();
        socket
            .send(Message::Text(
                json!({"jsonrpc": "2.0", "id": id, "result": "direct-sub"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        socket
            .send(Message::Text(
                json!({
                    "jsonrpc": "2.0",
                    "method": "eth_subscription",
                    "params": {
                        "subscription": "direct-sub",
                        "result": {"number": "0x2a"}
                    }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

        let unsubscribe = socket.next().await.unwrap().unwrap();
        let Message::Text(unsubscribe) = unsubscribe else {
            panic!("expected text unsubscribe request");
        };
        let unsubscribe: Value = serde_json::from_str(&unsubscribe).unwrap();
        assert_eq!(unsubscribe["method"], "eth_unsubscribe");
        let id = unsubscribe["id"].clone();
        socket
            .send(Message::Text(
                json!({"jsonrpc": "2.0", "id": id, "result": true})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
    });

    let client = ErpcClient::new(
        ErpcClientConfig::new("shared-key")
            .with_header("x-global", "global-secret")
            .with_ethereum_rpc(
                RpcEndpointConfig::new(format!("http://{address}/customer/rpc"))
                    .with_websocket_url(format!("ws://{address}/customer/ws?token=a%2Fb&region=eu"))
                    .with_header("authorization", "Bearer scoped/secret")
                    .with_header("x-node-scope", "http-only"),
            ),
    )
    .unwrap();
    assert_eq!(
        client.ethereum.subscriptions.endpoint(),
        format!("ws://{address}/customer/ws")
    );
    let subscription = client
        .ethereum
        .subscriptions
        .subscribe("newHeads", Vec::new())
        .await
        .unwrap();
    let notification: Value = subscription.next().await.unwrap();
    assert_eq!(notification, json!({"number": "0x2a"}));
    assert!(subscription.unsubscribe().await.unwrap());
    server.await.unwrap();
}

#[tokio::test]
async fn direct_subscription_without_websocket_url_fails_locally_even_with_key() {
    let client = ErpcClient::new(
        ErpcClientConfig::new("shared-key")
            .with_ethereum_rpc(RpcEndpointConfig::new("https://customer.example/rpc")),
    )
    .unwrap();
    let error = client
        .ethereum
        .subscriptions
        .subscribe("newHeads", Vec::new())
        .await
        .err()
        .expect("missing direct WebSocket URL");
    assert_eq!(error.code(), erpc_sdk::ErpcErrorCode::NotConfigured);
    assert!(error.to_string().contains("ethereum.subscriptions"));
    assert!(client.ethereum.subscriptions.endpoint().is_empty());
}
