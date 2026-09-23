# ERPC SDK for Go

Context-aware Go client for ERPC Solana, Ethereum, and Avalanche C/P/X-chain
JSON-RPC, indexed data, analytics, WebSocket subscriptions, price streams,
account information, usage, and Cloud APIs.

## Install

```bash
go get github.com/elsoul/erpc-sdk/packages/go@v0.8.0
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

## Caller-owned RPC endpoints (introduced in 0.8.0)

Supply a complete HTTP request target for any chain. A direct endpoint can be
used without an eRPC API key; its path and query are sent unchanged. The URL
is the final RPC target: direct HTTP requests do not follow redirects.
Direct HTTP also ignores the supplied `http.Client` cookie jar; add any
intentional `Cookie` value to `RPCEndpointConfig.Headers`.

Caller-owned direct endpoint overrides were introduced in `0.8.0` and require
that package when installed from a registry. The published `0.7.0` package
does not include them; check the package version badge and the [latest GitHub
release](https://github.com/elsoul/erpc-sdk/releases/latest) for live
publication status.

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
`0.7.0`. Quote capability remains limited to the reviewed Ethereum Uniswap V2
USDC/WETH and Avalanche LFJ legacy WAVAX/USDC pools; catalog growth does not
grant quote capability.

## Unsigned EVM swap preparation and simulation (introduced in 0.8.0)

The `0.8.0` API's `Client.Swap.PrepareExactInputSwap` obtains a fresh quote through the selected
Ethereum or Avalanche RPC, checks the reviewed router, factory, and wrapped
token at the quote block, and returns unsigned
`swapExactTokensForTokens(uint256,uint256,address[],address,uint256)` calldata.
`SimulateExactInputSwap` performs the same preparation, checks the input-token
allowance, and makes one final `eth_call` at the pinned block. Preparation uses
16 RPC requests and successful simulation uses 19. All amounts, the deadline,
and transaction value are canonical decimal strings; calldata is lowercase ABI
hex.

```go
import (
	"strconv"
	"time"
)

preparation, err := client.Swap.PrepareExactInputSwap(ctx, erpc.PrepareExactInputSwapRequest{
	ChainID:                 erpc.TokenChainEthereumMainnet,
	PoolDefinitionID:        erpc.PoolEthereumUNISWAP_V2_USDC_WETH,
	InputTokenDeploymentID:  erpc.TokenEthereumWETH,
	OutputTokenDeploymentID: erpc.TokenEthereumUSDC,
	AmountIn:                "1000000000000000000",
	Sender:                  "0x1111111111111111111111111111111111111111",
	Recipient:               "0x2222222222222222222222222222222222222222",
	SlippageBps:             uint64(50),
	Deadline:                strconv.FormatInt(time.Now().Add(5*time.Minute).Unix(),10),
})
if err != nil {
	panic(err)
}

// Convert the chain-bound envelope to the wallet library's transaction type.
// The SDK does not sign or send it, and it does not produce approval calldata.
walletFrom := preparation.Transaction.From
walletTo := preparation.Transaction.To
walletData := preparation.Transaction.Data
walletValue := preparation.Transaction.Value
_ = walletFrom
_ = walletTo
_ = walletData
_ = walletValue
```

The preparation's `Allowance` identifies the input token, owner, reviewed
router spender, and required amount. The caller decides whether and how to
change that allowance, then controls signing and sending. This capability is
limited to the two reviewed EVM pools; it does not provide hosted Jupiter or
0x routing, native wrapping, bridging, wallet custody, or live-funds effects.

## Wallets and signing

The Go SDK has no wallet, private-key loading, or local signing API. It returns
unsigned swap and bridge data; the caller reviews it, uses an external browser,
hardware, or application signer, and supplies the resulting signed serialized
bytes to `client.Ethereum.RPC.SendRawTransaction(ctx, signedBytes)` or
`client.Solana.RPC.SendTransaction(ctx, signedBase64, map[string]any{"encoding": "base64"})`.
`PendingRequest.Send(ctx)` and these typed send methods only make the configured
RPC request; they do not perform cryptographic signing. Public `sender`, `from`,
`swapperAddress`, and `feePayer` values, eRPC API keys or direct-RPC headers,
and `BuilderAPIKey` are addresses or service credentials, not wallet signing
authority. The `BuilderAPIKey` is sent only to Mayan `/build`.

See the [common wallets and signing boundary](https://github.com/elsoul/erpc-sdk/blob/main/README.md#wallets-and-signing)
and the [TypeScript signing and broadcast guide](https://github.com/elsoul/erpc-sdk/blob/main/packages/typescript/docs/signing-and-broadcast.md)
for the shared transaction handoff and initialized external-signer examples.

## Optional Mayan Swift v2 bridge (EURC in 0.8.0; USDC source addition unreleased)

The `0.8.0` API's `NewMayanSwiftV2BridgeClient` creates a standalone, explicit opt-in adapter for
native issued EURC between Ethereum and Solana. It calls the configured Mayan
builder for quotes and unsigned source transactions, and the configured
Explorer endpoint for read-only indexed status. It does not use `Client` or
the ERPC API key, and it never signs, approves, submits, broadcasts, polls,
or claims local signature, transaction-semantics, or settlement verification.
`MayanSwiftV2BridgeConfig.MinimumQuoteValiditySeconds` is a pointer: `nil`
uses the 60-second default, while a pointer to `0` explicitly permits quotes
that are still live without an additional margin. The defaults are
`https://tx-builder.mayan.finance` for quote/build and
`https://explorer-api.mayan.finance/v3` for indexed status; set
`BuilderEndpoint` and `ExplorerEndpoint` to customize them. `BuilderAPIKey` is
a separate Mayan build-only credential; quote and status requests never receive
it or an ERPC credential.

Mayan's [official quote API key documentation](https://docs.mayan.finance/integration/quote-api#api-key)
and the [pinned transaction-builder authentication documentation](https://github.com/mayan-finance/tx-builder/blob/e966f16a155cd9091b02ef5d9b91c3f837c228ad/README.md#authentication)
describe the provider key as optional. The Go SDK's local policy requires a
builder key by default; `AllowUnauthenticatedBuild: true` explicitly permits a
keyless HTTP attempt, including against the default endpoint, while leaving
provider authentication policy unchanged. The flag does not grant server
permission; it only bypasses this local preflight guard. A dated 2026-09-17 11:27Z hosted
recheck observed quote responses with HTTP 200 and `/build` responses with HTTP
401 without a key. That observation does not establish a universal or
permanent provider requirement.

The quote-only example below intentionally supplies no builder key. For a build,
provide `BuilderAPIKey` when the provider requires it, or explicitly opt into a
keyless attempt with `AllowUnauthenticatedBuild: true` and handle the provider's
response.

```go
bridge, err := erpc.NewMayanSwiftV2BridgeClient(erpc.MayanSwiftV2BridgeConfig{
	BuilderEndpoint:           "https://tx-builder.mayan.finance",
	ExplorerEndpoint:          "https://explorer-api.mayan.finance/v3",
})
if err != nil {
	panic(err)
}
defer bridge.Close()

quotes, err := bridge.QuoteExactInput(ctx, erpc.MayanSwiftV2QuoteRequest{
	SourceChainID:                erpc.TokenChainEthereumMainnet,
	DestinationChainID:           erpc.TokenChainSolanaMainnet,
	SourceTokenDeploymentID:      "deployment-0011",
	DestinationTokenDeploymentID: "deployment-0013",
	AmountIn:                     "100000000",
	SlippageBps:                  50,
})
if err != nil {
	panic(err)
}
_ = quotes
```

The published `0.8.0` package binds both reviewed directions to the issued
EURC catalog records and discloses Mayan's internal source USDC conversion.
Solana source EURC quotes also disclose the provider's Jupiter v6 source-swap
dependency; this is provider output, not a hosted Jupiter route in the normal
swap helpers. The returned `MayanSwiftV2Build` is unsigned and structurally
checked. Ethereum builds expose the caller-owned EURC allowance requirement;
the caller controls approval policy and signing. `GetStatus` reports the
provider-indexed state and does not prove on-chain settlement.

The current source tree also contains an unreleased native USDC addition for
Ethereum mainnet (`deployment-0008`) and Solana mainnet (`deployment-0010`).
Use the exact four-field route tuple to select it. Direct USDC quotes set
`sourceSwap.required` to `false`, identify the native source USDC in the input
and intermediate fields, and emit `routerKind` and `routerAddress` as JSON
`null`. They use the direct Swift dependency set without Jupiter or hosted 0x
source-swap dependencies; Ethereum builds use selector `0xe4269fc4` and expose
an allowance for the matched USDC deployment. This addition is not included
in the published `0.8.0` package until a release explicitly includes it.

Because direct USDC router fields are nullable, Go represents
`MayanSwiftV2SourceSwap.RouterKind` and `.RouterAddress` as `*string`. The JSON
keys remain present with `null` for direct routes; existing EURC values remain
non-null. Consumers using the previous non-null source type must handle nil
pointers before using this unreleased addition.

### Local unsigned construction (unreleased)

The unreleased native EURC and USDC local path separates source-swap
preparation from unsigned transaction construction. Configure the matching
source-chain RPC under `LocalBuild`; the RPC URL and its explicit headers stay
caller-owned. `PrepareSourceSwap` makes an anonymous EURC source-swap request
when the route needs one, while direct USDC returns `{kind: "none"}` without
source-swap I/O. `BuildLocalUnsigned` validates the quote, context, plan, and
configured source RPC evidence, then constructs the unsigned EVM or Solana
transaction locally. It never falls back to the hosted `/build` endpoint.

The caller supplies public source and destination addresses and a fresh public
32-hex-digit nonce for each order. The nonce is order data, never a private
key. The SDK does not load wallets, sign, approve, submit, broadcast, or claim
settlement verification; hand the returned transaction to the caller's
external signer and chain RPC when the caller is ready.

```go
bridge, err := erpc.NewMayanSwiftV2BridgeClient(erpc.MayanSwiftV2BridgeConfig{
	LocalBuild: &erpc.MayanSwiftV2LocalBuildConfig{
		EthereumRPC: &erpc.RPCEndpointConfig{HTTPURL: "https://your-ethereum-rpc.example"},
	},
})
if err != nil {
	panic(err)
}
defer bridge.Close()

quote := quotes[0] // an existing MayanSwiftV2Quote from QuoteExactInput
localContext := erpc.MayanSwiftV2LocalContext{
	Quote:              quote,
	SwapperAddress:     "0x1111111111111111111111111111111111111111",
	DestinationAddress: "11111111111111111111111111111111",
	OrderNonce:         "0x0123456789abcdef0123456789abcdef", // fresh per order
}
plan, err := bridge.PrepareSourceSwap(ctx, localContext)
if err != nil {
	panic(err)
}
unsigned, err := bridge.BuildLocalUnsigned(ctx, erpc.MayanSwiftV2LocalBuildRequest{
	Quote:              quote,
	SwapperAddress:     localContext.SwapperAddress,
	DestinationAddress: localContext.DestinationAddress,
	OrderNonce:         localContext.OrderNonce,
	SourceSwapPlan:     plan,
})
if err != nil {
	panic(err)
}
_ = unsigned // review and pass to an external signer
```

Use an Ethereum RPC and EVM addresses for an Ethereum-source quote, or a
Solana RPC and canonical base58 addresses for a Solana-source quote. The
local build evidence records the selected chain and reviewed code/account
bytes; it does not audit contracts, authenticate the provider signature, or
prove settlement.

## License

MIT
