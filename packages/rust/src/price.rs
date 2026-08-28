use std::pin::Pin;

use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{ErpcError, Result, rest::RestTransport};

/// Binary encoding requested from the price API.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PriceEncoding {
    /// Base64 text.
    Base64,
    /// Hexadecimal text.
    Hex,
}

impl PriceEncoding {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Base64 => "base64",
            Self::Hex => "hex",
        }
    }
}

/// Asset category used to filter feed metadata.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PriceAssetType {
    /// Crypto asset.
    Crypto,
    /// Equity.
    Equity,
    /// Foreign-exchange pair.
    Fx,
    /// Metal.
    Metal,
    /// Rates instrument.
    Rates,
}

impl PriceAssetType {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Crypto => "crypto",
            Self::Equity => "equity",
            Self::Fx => "fx",
            Self::Metal => "metal",
            Self::Rates => "rates",
        }
    }
}

/// Price feed identifier and optional attributes.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PriceFeedMetadata {
    /// Optional feed attributes.
    pub attributes: Option<std::collections::HashMap<String, String>>,
    /// Feed identifier.
    pub id: String,
}

/// One published price point.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PricePoint {
    /// Confidence interval as an integer string.
    pub conf: String,
    /// Decimal exponent.
    pub expo: i32,
    /// Price as an integer string.
    pub price: String,
    /// Unix publication time.
    pub publish_time: i64,
}

/// Optional timing and slot metadata.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ParsedPriceMetadata {
    /// Previous publication time.
    pub prev_publish_time: Option<i64>,
    /// Proof availability time.
    pub proof_available_time: Option<i64>,
    /// Source slot.
    pub slot: Option<u64>,
}

/// Parsed update for one feed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ParsedPriceUpdate {
    /// Exponentially weighted moving-average price.
    pub ema_price: PricePoint,
    /// Feed identifier.
    pub id: String,
    /// Optional update metadata.
    pub metadata: Option<ParsedPriceMetadata>,
    /// Spot price.
    pub price: PricePoint,
}

/// Binary price update payload.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BinaryUpdate {
    /// Encoded update values.
    pub data: Vec<String>,
    /// Encoding returned by the service.
    pub encoding: String,
}

/// Latest or historical price updates.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PriceUpdateResponse {
    /// Binary updates.
    pub binary: BinaryUpdate,
    /// Parsed updates when requested.
    pub parsed: Option<Vec<ParsedPriceUpdate>>,
}

/// Options shared by latest, historical, and streaming price updates.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PriceUpdateOptions {
    /// Requested binary encoding.
    pub encoding: Option<PriceEncoding>,
    /// Feed identifiers. Repeated `ids[]` query keys are preserved.
    pub ids: Vec<String>,
    /// Ignore unrecognized feed identifiers.
    pub ignore_invalid_price_ids: Option<bool>,
    /// Include parsed values.
    pub parsed: Option<bool>,
}

/// Options for the server-sent-events price stream.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PriceStreamOptions {
    /// Shared update options.
    pub update: PriceUpdateOptions,
    /// Allow messages to arrive out of order.
    pub allow_unordered: Option<bool>,
    /// Return benchmark feeds only.
    pub benchmarks_only: Option<bool>,
}

/// One publisher and its stake cap.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PublisherStakeCap {
    /// Stake cap.
    pub cap: f64,
    /// Publisher identifier.
    pub publisher: String,
}

/// Parsed publisher stake cap envelope.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ParsedPublisherStakeCaps {
    /// Publisher stake caps.
    pub publisher_stake_caps: Vec<PublisherStakeCap>,
}

/// Latest publisher stake caps.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PublisherStakeCapsResponse {
    /// Binary response.
    pub binary: BinaryUpdate,
    /// Parsed response when requested.
    pub parsed: Option<Vec<ParsedPublisherStakeCaps>>,
}

/// Parsed server-sent event from the price stream.
#[derive(Clone, Debug, PartialEq)]
pub struct PriceStreamEvent {
    /// Price update carried by `data` lines.
    pub data: PriceUpdateResponse,
    /// Optional SSE event name.
    pub event: Option<String>,
    /// Optional SSE event identifier.
    pub id: Option<String>,
}

/// Boxed asynchronous stream returned by [`PriceClient::stream_price_updates`].
pub type PriceStream = Pin<Box<dyn Stream<Item = Result<PriceStreamEvent>> + Send>>;

/// Price metadata, updates, publisher caps, and streaming API.
#[derive(Clone)]
pub struct PriceClient {
    transport: RestTransport,
}

impl PriceClient {
    pub(crate) const fn new(transport: RestTransport) -> Self {
        Self { transport }
    }

    /// Searches price feed metadata.
    pub async fn get_price_feeds(
        &self,
        query_text: Option<&str>,
        asset_type: Option<PriceAssetType>,
    ) -> Result<Vec<PriceFeedMetadata>> {
        let mut query = Vec::new();
        if let Some(value) = query_text {
            query.push(("query".to_owned(), value.to_owned()));
        }
        if let Some(value) = asset_type {
            query.push(("asset_type".to_owned(), value.as_str().to_owned()));
        }
        self.transport.get("/v2/price_feeds", query, None).await
    }

    /// Gets latest price updates.
    pub async fn get_latest_price_updates(
        &self,
        options: &PriceUpdateOptions,
    ) -> Result<PriceUpdateResponse> {
        self.transport
            .get("/v2/updates/price/latest", update_query(options), None)
            .await
    }

    /// Gets price updates at a Unix publication time.
    pub async fn get_price_updates_at_timestamp(
        &self,
        publish_time: impl std::fmt::Display,
        options: &PriceUpdateOptions,
    ) -> Result<PriceUpdateResponse> {
        let path = format!("/v2/updates/price/{publish_time}");
        self.transport.get(&path, update_query(options), None).await
    }

    /// Gets latest publisher stake caps.
    pub async fn get_latest_publisher_stake_caps(
        &self,
        encoding: Option<PriceEncoding>,
        parsed: Option<bool>,
    ) -> Result<PublisherStakeCapsResponse> {
        let mut query = Vec::new();
        if let Some(value) = encoding {
            query.push(("encoding".to_owned(), value.as_str().to_owned()));
        }
        if let Some(value) = parsed {
            query.push(("parsed".to_owned(), value.to_string()));
        }
        self.transport
            .get("/v2/updates/publisher_stake_caps/latest", query, None)
            .await
    }

    /// Connects to the price server-sent-events stream.
    pub async fn stream_price_updates(
        &self,
        options: &PriceStreamOptions,
        cancellation: Option<CancellationToken>,
    ) -> Result<PriceStream> {
        let mut query = update_query(&options.update);
        if let Some(value) = options.allow_unordered {
            query.push(("allow_unordered".to_owned(), value.to_string()));
        }
        if let Some(value) = options.benchmarks_only {
            query.push(("benchmarks_only".to_owned(), value.to_string()));
        }
        let response = self
            .transport
            .get_response("/v2/updates/price/stream", query, cancellation.as_ref())
            .await?;
        let mut bytes = response.bytes_stream();
        let output = async_stream::stream! {
            let mut buffer = String::new();
            loop {
                let next = if let Some(token) = &cancellation {
                    tokio::select! {
                        () = token.cancelled() => {
                            yield Err(ErpcError::Aborted);
                            break;
                        }
                        next = bytes.next() => next,
                    }
                } else {
                    bytes.next().await
                };
                let Some(chunk) = next else { break };
                if let Ok(chunk) = chunk {
                    buffer.push_str(&String::from_utf8_lossy(&chunk));
                } else {
                    yield Err(ErpcError::Transport("Unable to read ERPC stream".to_owned()));
                    break;
                }
                while let Some((boundary, separator_length)) = sse_boundary(&buffer) {
                    let block = buffer[..boundary].to_owned();
                    buffer.drain(..boundary + separator_length);
                    match parse_sse_block(&block) {
                        Ok(Some(event)) => yield Ok(event),
                        Ok(None) => {}
                        Err(error) => {
                            yield Err(error);
                            return;
                        }
                    }
                }
            }
            if !buffer.is_empty() {
                match parse_sse_block(&buffer) {
                    Ok(Some(event)) => yield Ok(event),
                    Ok(None) => {}
                    Err(error) => yield Err(error),
                }
            }
        };
        Ok(Box::pin(output))
    }
}

fn update_query(options: &PriceUpdateOptions) -> Vec<(String, String)> {
    let mut query: Vec<_> = options
        .ids
        .iter()
        .map(|id| ("ids[]".to_owned(), id.clone()))
        .collect();
    if let Some(value) = options.encoding {
        query.push(("encoding".to_owned(), value.as_str().to_owned()));
    }
    if let Some(value) = options.parsed {
        query.push(("parsed".to_owned(), value.to_string()));
    }
    if let Some(value) = options.ignore_invalid_price_ids {
        query.push(("ignore_invalid_price_ids".to_owned(), value.to_string()));
    }
    query
}

fn sse_boundary(buffer: &str) -> Option<(usize, usize)> {
    match (buffer.find("\n\n"), buffer.find("\r\n\r\n")) {
        (Some(left), Some(right)) if left <= right => Some((left, 2)),
        (Some(_) | None, Some(right)) => Some((right, 4)),
        (Some(left), None) => Some((left, 2)),
        (None, None) => None,
    }
}

fn parse_sse_block(block: &str) -> Result<Option<PriceStreamEvent>> {
    let mut data = Vec::new();
    let mut event = None;
    let mut id = None;
    for line in block.lines() {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, raw) = line.split_once(':').unwrap_or((line, ""));
        let value = raw.strip_prefix(' ').unwrap_or(raw);
        match field {
            "data" => data.push(value),
            "event" => event = Some(value.to_owned()),
            "id" => id = Some(value.to_owned()),
            _ => {}
        }
    }
    if data.is_empty() {
        return Ok(None);
    }
    let response = serde_json::from_str(&data.join("\n")).map_err(|_| {
        ErpcError::InvalidResponse("ERPC returned malformed stream data".to_owned())
    })?;
    Ok(Some(PriceStreamEvent {
        data: response,
        event,
        id,
    }))
}
