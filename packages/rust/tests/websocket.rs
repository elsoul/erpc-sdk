#![allow(missing_docs)]

use erpc_sdk::{ErpcClient, ErpcClientConfig};
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
