# Solana transaction v1 with ERPC

_As of 2026-09-15._

Solana's `txv1` feature gate activated on mainnet at the start of epoch 1035,
at approximately 01:00 UTC on September 15, 2026. The v1 full serialized
transaction limit is now 4096 bytes, while legacy and v0 remain 1232 bytes.
See the [Solana larger transaction sizes update](https://solana.com/upgrades/larger-transaction-sizes),
the [SIMD-0385 transaction v1 proposal](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0385-transaction-v1.md),
and the [cross-language transaction-v1 examples](https://github.com/solana-foundation/transaction-v1-examples).

This SDK is a generic JSON-RPC forwarder. It does not build, sign, decode, or
silently rewrite transactions. The examples below show the parameters to pass
through the five ERPC SDKs.

## Reading v1 transactions and blocks

Pass the JSON integer `1` as `maxSupportedTransactionVersion` when the caller
can decode v1. This field declares the highest transaction version the reader
supports; it is not a version filter or a request to return version 1. Raising
it to `1` leaves legacy and v0 responses unchanged. Omitting it or passing `0`
remains the caller's choice and can make a v1 `getTransaction` fail with
JSON-RPC error `-32015`; one v1 transaction can make a `getBlock` request fail
as well. The SDK preserves the option exactly and does not inject `1`, retry,
or fall back to another request. A server `-32015` is surfaced once as an
SDK-native error with its numeric code and optional data preserved: TypeScript
uses `ErpcJsonRpcError.rpcCode`/`.data`, Python uses
`ErpcJsonRpcError.rpc_code`/`.data`, Rust uses
`ErpcError::JsonRpc { code, data, .. }`, Go uses `*erpc.Error.Code`/`.Data`,
and Ruby uses `ERPC::JsonRpcError#code`/`#data`.

The parameter is part of each method's second positional parameter, so all
other options can be sent at the same time.

### TypeScript

```ts
const transaction = await erpc.solana.rpc
  .getTransaction(signature, {
    commitment: 'finalized',
    encoding: 'jsonParsed',
    maxSupportedTransactionVersion: 1,
  })
  .send()

const block = await erpc.solana.rpc
  .getBlock(slot, {
    commitment: 'finalized',
    encoding: 'jsonParsed',
    maxSupportedTransactionVersion: 1,
    rewards: true,
    transactionDetails: 'full',
  })
  .send()
```

### Rust

The Rust client accepts any serializable positional parameter value.

```rust
use serde_json::json;

let transaction = erpc.solana.rpc.get_transaction(json!([
    signature,
    {
        "commitment": "finalized",
        "encoding": "jsonParsed",
        "maxSupportedTransactionVersion": 1,
    },
]))?.send().await?;

let block = erpc.solana.rpc.get_block(json!([
    slot,
    {
        "commitment": "finalized",
        "encoding": "jsonParsed",
        "maxSupportedTransactionVersion": 1,
        "rewards": true,
        "transactionDetails": "full",
    },
]))?.send().await?;
```

### Python

```python
transaction = await erpc.solana.rpc.get_transaction(
    signature,
    {
        "commitment": "finalized",
        "encoding": "jsonParsed",
        "maxSupportedTransactionVersion": 1,
    },
).send()

block = await erpc.solana.rpc.get_block(
    slot,
    {
        "commitment": "finalized",
        "encoding": "jsonParsed",
        "maxSupportedTransactionVersion": 1,
        "rewards": True,
        "transactionDetails": "full",
    },
).send()
```

### Go

`GetTransaction` is a typed helper in the Go SDK. `getBlock` is shown with
the namespace's raw `Request` so the complete options object is visible and
forwarded unchanged.

```go
transaction, err := client.Solana.RPC.GetTransaction(ctx, signature, map[string]any{
	"commitment":                     "finalized",
	"encoding":                       "jsonParsed",
	"maxSupportedTransactionVersion": 1,
})
if err != nil {
	return err
}

var block json.RawMessage
err = client.Solana.RPC.Request(ctx, "getBlock", []any{
	slot,
	map[string]any{
		"commitment":                     "finalized",
		"encoding":                       "jsonParsed",
		"maxSupportedTransactionVersion": 1,
		"rewards":                        true,
		"transactionDetails":             "full",
	},
}, &block)
if err != nil {
	return err
}
```

### Ruby

```ruby
transaction = erpc.solana.rpc.get_transaction(signature, {
  "commitment" => "finalized",
  "encoding" => "jsonParsed",
  "maxSupportedTransactionVersion" => 1
}).send

block = erpc.solana.rpc.get_block(slot, {
  "commitment" => "finalized",
  "encoding" => "jsonParsed",
  "maxSupportedTransactionVersion" => 1,
  "rewards" => true,
  "transactionDetails" => "full"
}).send
```

The standard RPC response shape is documented in [Solana RPC JSON
structures](https://solana.com/docs/rpc/json-structures). For a v1 response,
read resource values at `transaction.message.transactionConfig`:

```json
{
  "computeUnitLimit": 30000,
  "loadedAccountsDataSizeLimit": 200000,
  "heapSize": null,
  "priorityFee": null
}
```

`transactionConfig` belongs to the message, not to the RPC request config. It
is present for v1 and absent entirely for legacy and v0; unrelated response
fields remain available through this SDK. For v1, compute-unit and loaded-data
limits default to zero when omitted, heap defaults to 32 KiB, and
`priorityFee` is a total in lamports rather than micro-lamports per compute
unit. A numeric `priorityFee` is likewise a total lamport amount (for example,
`5000`), not a per-CU price. ComputeBudget instructions are no-ops for v1. Do
not infer the v1 resource values by scanning them.

The v1 format has no address lookup tables. It permits up to 64 unique inline
accounts, 64 top-level instructions, and 12 signatures. The 4096-byte limit
includes the complete serialized transaction, including its signatures. The
[Anza versioned transaction source and full-size tests](https://github.com/anza-xyz/solana-sdk/blob/master/transaction/src/versioned/mod.rs)
and SIMD-0385 specify the wire format and constraints.

An encoded response remains opaque: the SDK returns the base64 string or
`[string, "base64"]` tuple and does not decode the v1 `0x81` prefix. Use a
decoder that explicitly understands v1 before reading the message config.

## Sending and simulating

For a transaction larger than 1232 bytes, pass the exact serialized base64
string with `encoding: 'base64'` to both calls:

```ts
const simulated = await erpc.solana.rpc
  .simulateTransaction(serializedBase64, { encoding: 'base64' })
  .send()
const signature = await erpc.solana.rpc
  .sendTransaction(serializedBase64, { encoding: 'base64' })
  .send()
```

Base58 remains capped at 1232 bytes. The SDK forwards the string and options;
the caller must supply a valid, signed transaction. A wallet or builder must
set v1 compute-unit and loaded-account data limits explicitly, and should
check its actual signing support before constructing v1. If the wallet does
not support v1, use a valid v0 transaction only when it fits its limits.

When a wallet signs, inspect `supportedTransactionVersions` on the exact
Wallet Standard feature being used: `solana:signTransaction` or
`solana:signAndSendTransaction`. Require that feature to advertise `1`; do not
infer support from a different feature or from a union of unrelated wallet
features. If an RPC node stores v1 through an older Agave release, message
config can be lost; use Agave RPC 4.2.2 or later, as described in the [Solana
upgrade operator notes](https://solana.com/upgrades/larger-transaction-sizes).

## Optional `blockSubscribe`

Only use [`blockSubscribe`](https://solana.com/docs/rpc/websocket/blocksubscribe)
after verifying that the selected endpoint supports it. ERPC does not promise
server support for this WebSocket method. On an endpoint that does support it,
send `maxSupportedTransactionVersion: 1` as an integer in the subscription
config and preserve the rest of the config:

```ts
const subscription = await erpc.solana.subscriptions.rawSubscribe(
  'blockSubscribe',
  [
    { mentionsAccountOrProgram: programAddress },
    {
      commitment: 'confirmed',
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 1,
      transactionDetails: 'full',
    },
  ],
  'blockUnsubscribe',
  (value: unknown) => {
    const notification = value as {
      value?: { block?: unknown; err?: unknown }
    }
    const result = notification.value
    if (result?.block === null && result.err !== undefined) {
      console.error('block notification failed', result.err)
      return
    }
    console.log(result?.block)
  },
)
```

Treat `block: null` together with an error as a failed notification, not as an
empty block.

## Future planning

This transaction format work does not add a swap builder or bridge. Keep
canonical token identities independent of transaction version. A future RPC
and local swap builder should make the transaction format and wallet support
explicit, check full serialized size, signature/account/instruction caps, and
simulate budgets that include token-account creation and wrap-route
instructions. More bytes do not make a later precompiled swap instruction
consume the actual output of an earlier instruction; a verified on-chain
router/CPI design must enforce final `minOut` against the actual
intermediate-output composition.

The larger limit improves single-chain composition. It does not provide
cross-chain atomicity or a native EURC ETH-to-SOL bridge by itself; bridge
work remains separate proof, attestation, and relayer research. Weekly
maintenance should reverify protocol capabilities and fixtures. No schedule or
release changes are implied by this guide.
