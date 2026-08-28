#![allow(missing_docs)]

use erpc_sdk::{ErpcClient, ErpcClientConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let api_key = std::env::var("ERPC_API_KEY")?;
    let erpc = ErpcClient::new(ErpcClientConfig::new(api_key))?;

    let slot = erpc
        .solana
        .rpc
        .get_slot(Vec::<serde_json::Value>::new())?
        .send()
        .await?;
    let chain_id = erpc.ethereum.rpc.eth_chain_id().send().await?;

    println!("slot={slot}, chain_id={chain_id}");
    erpc.close().await;
    Ok(())
}
