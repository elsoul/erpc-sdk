# ERPC SDK for Go

Context-aware Go client for ERPC Solana, Ethereum, and Avalanche C/P/X-chain
JSON-RPC, indexed data, analytics, WebSocket subscriptions, price streams,
account information, usage, and Cloud APIs.

## Install

The first Go release is version `v0.3.0` from the monorepo tag
`packages/go/v0.3.0`.

```bash
go get github.com/elsoul/erpc-sdk/packages/go@v0.4.0
```

Go 1.22 or later is supported.

## Quick start

```go
package main

import (
	"context"
	"fmt"
	"os"

	erpc "github.com/elsoul/erpc-sdk/packages/go"
)

func main() {
	client, err := erpc.NewClient(erpc.Config{APIKey: os.Getenv("ERPC_API_KEY")})
	if err != nil {
		panic(err)
	}
	defer client.Close()

	slot, err := client.Solana.RPC.GetSlot(context.Background())
	if err != nil {
		panic(err)
	}
	chainID, err := client.Ethereum.RPC.ChainID(context.Background())
	if err != nil {
		panic(err)
	}
	avalancheChainID, err := client.Avalanche.RPC.ChainID(context.Background())
	if err != nil {
		panic(err)
	}
	fmt.Println(slot, chainID, avalancheChainID)
}
```

Every network method accepts `context.Context`. HTTP calls are attempted once;
transaction submission and other state-changing calls are never retried.

## Caller-owned RPC endpoints (unreleased source checkout)

Supply a complete HTTP request target for any chain. A direct endpoint can be
used without an eRPC API key; its path and query are sent unchanged. The URL
is the final RPC target: direct HTTP requests do not follow redirects.
Direct HTTP also ignores the supplied `http.Client` cookie jar; add any
intentional `Cookie` value to `RPCEndpointConfig.Headers`.

These direct RPC examples describe the unreleased source checkout and are not
included in published 0.7.0.

```go
client, err := erpc.NewClient(erpc.Config{
	EthereumRPC: &erpc.RPCEndpointConfig{
		HTTPURL: "https://node.example/customer/path?token=a%2Fb&region=eu",
	},
})
```

Subscriptions require a separate complete WebSocket target. Endpoint-scoped
headers apply only to that chain's direct HTTP requests.

```go
// import "net/http"

client, err := erpc.NewClient(erpc.Config{
	SolanaRPC: &erpc.RPCEndpointConfig{
		HTTPURL:      "https://solana.example/rpc",
		WebSocketURL: "wss://solana.example/socket",
		Headers:      http.Header{"Authorization": {"Bearer node-token"}},
	},
})
```

For Solana transaction v1 options, response fields, and large base64
transaction forwarding, see the [Solana transaction v1 guide](https://github.com/elsoul/erpc-sdk/blob/main/packages/typescript/docs/solana-v1.md).

## Generic, typed, and batch requests

Typed common methods coexist with generic access to every method in the public
catalog:

```go
var health string
err := client.Solana.RPC.Raw(ctx, "getHealth", []any{}, &health)

request := erpc.NewRequest[uint64](client.Solana.RPC.RPCNamespace, "getSlot", []any{})
slot, err := request.Send(ctx)
```

A batch is sent as one intact request and results are returned in caller order:

```go
results, err := client.Ethereum.RPC.Batch(ctx, []erpc.BatchCall{
	{Method: "eth_chainId", Params: []any{}},
	{Method: "eth_blockNumber", Params: []any{}},
})
```

The SDK rejects batches over 256 calls, mixed Solana heavy/standard batches,
and leader-method batches locally.

## Subscriptions and price streams

```go
heads, err := client.Ethereum.Subscriptions.Subscribe(ctx, "newHeads")
if err != nil {
	return err
}
var header map[string]any
if err := heads.Next(ctx, &header); err != nil {
	return err
}
_, err = heads.Unsubscribe(ctx)
```

`PriceClient.StreamPriceUpdates` returns an SSE stream. Call `Next` for each
event and `Close` when the stream is no longer needed.

## Namespaces

| Namespace | Purpose |
| --- | --- |
| `client.Solana.RPC` | Standard Solana JSON-RPC |
| `client.Solana.DAS` | Indexed assets and tokens |
| `client.Solana.History` | Address transactions and transfers |
| `client.Solana.Leaders` | Leader slots and validator information |
| `client.Solana.Analytics` | Epoch, slot, program, and TPS analytics |
| `client.Solana.Subscriptions` | Enhanced WebSocket subscriptions |
| `client.Ethereum.RPC` | Standard Ethereum JSON-RPC |
| `client.Ethereum.Subscriptions` | Ethereum WebSocket subscriptions |
| `client.Avalanche.RPC` | Avalanche C-Chain EVM-compatible JSON-RPC |
| `client.Avalanche.Subscriptions` | Avalanche C-Chain WebSocket subscriptions |
| `client.Avalanche.AVAX` | C-Chain AVAX atomic transaction API |
| `client.Avalanche.XChain` | X-Chain API |
| `client.Avalanche.PChain` | P-Chain API |
| `client.Avalanche.ProposerVM` | P-Chain proposer VM API |
| `client.Avalanche.Info` | Network upgrade information |
| `client.Avalanche.Index` | C/P/X block and X transaction indexes |
| `client.Price` | Price metadata, updates, and streams |
| `client.Account` | Token balance |
| `client.Usage` | Masked monthly API-key usage |

`Config.AvalancheEndpoint` defaults to `https://ava-rpc.erpc.global` and can be
overridden independently. The SDK uses its `/ava` HTTP route and `/ava-ws`
WebSocket route. Native calls use short catalog names with `Request`; the SDK
restores the wire prefix and routes Index calls to explicit chain/container
paths. Native and Index batches are rejected locally. Use `Raw` with an exact
wire method for forward compatibility.

```go
var pHeight json.RawMessage
err := client.Avalanche.PChain.Request(ctx, "getHeight", nil, &pHeight)
var indexedTx json.RawMessage
err = client.Avalanche.Index.XChainTransactions.Request(
	ctx, "getContainerByID", map[string]any{"id": transactionID}, &indexedTx,
)
```

Create a separate `CloudClient` with a scoped access token for catalog, credit,
resource, and usage APIs. Refresh credentials are not accepted or retained.

## Offline token catalog

The package includes a generated, offline catalog for the supported Ethereum,
Solana, and Avalanche C-Chain deployments. It contains the complete asset and
deployment records, including native tokens, wrapped tokens, bridged assets,
replacement status, decimals, and chain-specific addresses. Catalog lookups do
not create a client, require an API key, or make a network request.

```go
usdc, ok := erpc.TokenDeploymentByID(erpc.TokenEthereumUSDC)
if !ok {
	panic("Ethereum USDC is not in the catalog")
}

fmt.Println(usdc.Symbol, usdc.Decimals, usdc.Address)

eur := erpc.ListTokenDeployments(erpc.TokenDeploymentFilter{
	ChainID:        erpc.TokenChainSolanaMainnet,
	StableCurrency: "EUR",
})
fmt.Println(len(eur))
```

The canonical source and update evidence live in the
[token catalog registry README](https://github.com/elsoul/erpc-sdk/blob/main/registry/README.md).

## Offline DEX and pool catalog

The source tree also contains a generated, network-free catalog of four DEX
deployments, four pool definitions, three native-to-wrapped relationships,
and chain-qualified aliases. The records keep opaque IDs, chain IDs, token
deployment IDs, pool or program addresses, adapter kinds, and lifecycle
status together. Lookups return independent values, so mutating a returned
record cannot change a later lookup.

```go
pool, ok := erpc.GetPoolDefinition(erpc.PoolEthereumUNISWAP_V2_USDC_WETH)
if !ok {
	panic("Ethereum WETH/USDC pool is not in the catalog")
}

matches := erpc.FindPoolDefinitionsByPair(
	erpc.TokenChainSolanaMainnet,
	erpc.TokenSolanaWSOL,
	erpc.TokenSolanaEURC,
)
fmt.Println(pool.Address, len(matches))
```

Use `GetDexDeployment`, `GetPoolDefinition`, `FindPoolDefinitionByAddress`,
`FindPoolDefinitionsByPair`, `ListPoolDefinitions`, and
`GetNativeWrapDefinition` for the six catalog lookup operations. Solana pool
records are available for deterministic lookup and pair discovery; their CLMM
adapters do not produce quotes in this release.

## Offline token rankings

The package includes a generated ranking snapshot with metadata for the metric,
observation date, digest, source IDs, and per-chain coverage. Ranking reads are
offline and return a copy of the rows for an exact chain ID; empty and unknown
chain IDs return an empty result. A snapshot using
`onchain-total-supply-value-native` ranks total token supply multiplied by a
direct native pool price. It is distinct from circulating market cap, and a
`partial` snapshot reports its unranked deployments in coverage. The bundled
snapshot may be `unconfigured` until reviewed ranking observations are
promoted.

```go
rows := erpc.ListTokenRankings(erpc.TokenChainEthereumMainnet)
metadata := erpc.TokenRankingMetadata()
fmt.Println(len(rows), metadata.Status, metadata.ContentDigest)
```

Catalog growth does not grant quote capability. The quote boundary is a
handwritten reviewed allowlist covering the exact Ethereum Uniswap V2
USDC/WETH pool and Avalanche LFJ legacy WAVAX/USDC pool, including their
factory, token addresses and decimals, ERC-20 standards, adapter, and fee.

## RPC-only swap quotes

`Client.Swap.QuoteExactInput` reads a consistent snapshot from the configured
Ethereum or Avalanche C-Chain RPC and calculates an exact-input quote locally.
It uses the two catalogued EVM constant-product pools and returns decimal
strings for token amounts and block quantities. No hosted routing or market
data API is used.

```go
quote, err := client.Swap.QuoteExactInput(ctx, erpc.ExactInputQuoteRequest{
	ChainID:                 erpc.TokenChainEthereumMainnet,
	PoolDefinitionID:        erpc.PoolEthereumUNISWAP_V2_USDC_WETH,
	InputTokenDeploymentID:  erpc.TokenEthereumWETH,
	OutputTokenDeploymentID: erpc.TokenEthereumUSDC,
	AmountIn:                "1000000000000000000",
})
if err != nil {
	panic(err)
}
fmt.Println(quote.AmountOut, quote.Snapshot.BlockNumber)
```

The quote path validates the reviewed catalog binding, factory and pool
identities, ordered token addresses, EIP-1898 block selectors, ABI widths,
freshness, and uint256 arithmetic before returning. It reads `eth_chainId`, two latest block
headers, two code values, five `eth_call` values, and one snapshot-block
reread. It only returns a quote; transaction building, signing, broadcasting,
native wrapping, routing, and bridging are separate capabilities.

The reviewed DEX and swap exports described above are included in published
0.7.0. Quote capability remains limited to the reviewed Ethereum Uniswap V2
USDC/WETH and Avalanche LFJ legacy WAVAX/USDC pools; catalog growth does not
grant quote capability.

## License

MIT
