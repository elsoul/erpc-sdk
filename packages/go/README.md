# ERPC SDK for Go

Context-aware Go client for ERPC Solana and Ethereum JSON-RPC, indexed data,
analytics, WebSocket subscriptions, price streams, account information, usage,
and Cloud APIs.

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
	fmt.Println(slot, chainID)
}
```

Every network method accepts `context.Context`. HTTP calls are attempted once;
transaction submission and other state-changing calls are never retried.

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
| `client.Price` | Price metadata, updates, and streams |
| `client.Account` | Token balance |
| `client.Usage` | Masked monthly API-key usage |

Create a separate `CloudClient` with a scoped access token for catalog, credit,
resource, and usage APIs. Refresh credentials are not accepted or retained.

## License

MIT
