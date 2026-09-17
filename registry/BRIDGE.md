# Bridge capability registry

This directory contains the canonical, opt-in Mayan Swift v2 capability
registry for native issued EURC and USDC between Ethereum mainnet and Solana
mainnet. It is a provider integration record. It is not a CCTP burn/mint route,
an RPC-only swap capability, a settlement guarantee, or an approval to move
funds.

The source is [`bridge-capabilities.json`](./bridge-capabilities.json), with
strict shape rules in [`bridge-capabilities.schema.json`](./bridge-capabilities.schema.json)
and semantic bindings in [`bridge-capabilities.mjs`](./bridge-capabilities.mjs).
There are exactly four directional IDs:

| Capability | Source | Destination | Source token | Destination token |
| --- | --- | --- | --- | --- |
| `bridge-mayan-swift-v2-eurc-eth-sol` | `eip155:1` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `deployment-0011` / `0x1abaea1f7c830bd89acc67ec4af516284b1bc33c` | `deployment-0013` / `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr` |
| `bridge-mayan-swift-v2-eurc-sol-eth` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `eip155:1` | `deployment-0013` / `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr` | `deployment-0011` / `0x1abaea1f7c830bd89acc67ec4af516284b1bc33c` |
| `bridge-mayan-swift-v2-usdc-eth-sol` | `eip155:1` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `deployment-0008` / `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` | `deployment-0010` / `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| `bridge-mayan-swift-v2-usdc-sol-eth` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `eip155:1` | `deployment-0010` / `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `deployment-0008` / `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` |

Every token has six decimals. Registry standards use the SDK spellings
`erc20` and `spl-token`. Mayan's provider wire spelling for a Solana token is
`spl`; the mapping is explicit and limited to the provider boundary. EURC
routes do not substitute USDC, wrapped EURC, native ETH, or native SOL. The
separate USDC rows are direct native-USDC routes and do not claim a source swap.
The provider internally converts EURC through source-chain USDC:

- Ethereum source USDC is `deployment-0008`,
  `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`.
- Solana source USDC is `deployment-0010`,
  `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.

At the provider wire boundary the Ethereum USDC name is `USD Coin` and its
provider mint metadata is
`A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM`; that mint is never used as the
Ethereum token address. Solana provider contract, mint, and origin metadata
all use the native USDC mint.

The registry records provider chain IDs Ethereum `1` and Solana `0`, and
Wormhole chain IDs Ethereum `2` and Solana `1`. Ethereum source rows bind the
Mayan Swift contract `0x40ffe85a28dc9993541449464d7529a922142960` and Forwarder
`0x337685fdab40d39bd02028545a4ffa7d287cc3e2`. The EURC selector is
`0x30dedc57`; the direct USDC selector is `0xe4269fc4`. Solana source rows bind
Swift program `mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny`. EURC Solana-origin
rows use Jupiter v6 `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`; direct USDC
rows set the Jupiter address and dependency to null.

## Runtime projection and generation

The registry `asOfDate` is `2026-09-17`. Generated runtime data is a plain
array sorted by `bridgeCapabilityId`; it omits `evidence` and per-record
`asOfDate`. Its deterministic SHA-256 content digest is:

```text
691a77498c5ff876dadc437a8265d8288ec51cbc1d44f8beacb746626bf5b98d
```

The generator renders one package-owned file per invocation. Package owners
run the command from the repository root:

```sh
node registry/generate-bridge-capabilities.mjs --write --language typescript
node registry/generate-bridge-capabilities.mjs --write --language rust
node registry/generate-bridge-capabilities.mjs --write --language python
node registry/generate-bridge-capabilities.mjs --write --language go
node registry/generate-bridge-capabilities.mjs --write --language ruby
node registry/generate-bridge-capabilities.mjs --check --language all
```

The generated constants are `BRIDGE_CAPABILITIES_JSON`,
`BRIDGE_CAPABILITIES_CONTENT_DIGEST`, and `BRIDGE_CAPABILITIES_AS_OF_DATE`.
Go uses its package-private equivalents
`bridgeCapabilitiesJSON`, `bridgeCapabilitiesContentDigest`, and
`bridgeCapabilitiesAsOfDate`. The renderer writes no arbitrary paths and does
not import an external SDK.

## Provider boundary

The adapter is an explicit `MayanSwiftV2BridgeClient` (with the idiomatic
language-specific constructor or factory). It is not attached to the default
eRPC client and does not read eRPC configuration, environment variables, API
keys, cookies, or ambient headers. Custom builder and Explorer endpoints are
base HTTPS URLs with an optional path prefix. Query strings, fragments,
userinfo, malformed authorities, and unsafe redirects are rejected. HTTP is
allowed only for an explicitly configured loopback test endpoint.

The defaults are:

```text
builder:  https://tx-builder.mayan.finance
explorer: https://explorer-api.mayan.finance/v3
```

`X-API-Key` is allowed only on `POST /build`. It is never sent to `/quote` or
the Explorer. Build without a configured provider key fails locally with
`BRIDGE_PROVIDER_AUTH_REQUIRED` unless the caller explicitly opts into
`allowUnauthenticatedBuild` for a custom no-auth builder. The adapter never
reads a process environment variable, adds a query API key, retries, follows
redirects, or forwards an eRPC authorization or cookie header. Externally
owned HTTP clients remain open when the bridge client closes.

## Quote

`quoteExactInput` accepts the exact request fields:

```js
{
  sourceChainId,
  destinationChainId,
  sourceTokenDeploymentId,
  destinationTokenDeploymentId,
  amountIn,       // positive canonical uint64 decimal string
  slippageBps     // integer 0..500
}
```

Only the four registry directions and their exact source and destination token
deployment IDs pass the local gate. The amount is snapshotted before an
asynchronous request and
the deadline safety margin is checked at completion. The closed compact JSON
body sent to the provider has this field order:

```js
{
  fromToken, fromChain, toToken, toChain, amountIn64, slippageBps,
  swift: true, mctp: false, fastMctp: false, wormhole: false,
  monoChain: false, gasless: false, fullList: true,
  guaranteedOutput: true, gasDrop: 0
}
```

The response must be a bounded JSON object with `success: true` and a
`quotes` array. SWIFT/V2/non-gasless candidates are selected in provider
order; every selected candidate is validated and returned. There is no
implicit best-rate selection. Duplicate object keys, invalid UTF-8, excessive
depth or size, more than 16 quotes, or an oversized selected quote fail
closed. Unknown signed fields are retained in the exact raw object text.

The normalized quote carries exact decimal strings for input, expected output,
minimum output, minimum received, and deadline. It carries the provider quote
ID and 65-byte signature shape, while declaring
`quoteVerification: "provider-signed-not-locally-verified"`. EURC rows expose
the required source USDC conversion, provider-selected router, and unchanged
JSON number lexeme of `minMiddleAmount` as `providerMinimumAmount`. Direct USDC
rows expose `required: false`, self-referential native-USDC intermediate token
fields, `routerKind: null`, `routerAddress: null`, and the same raw positive
provider lexeme without inventing a source swap. That provider-internal number
is not converted into base units. Solana rows use
`intermediateTokenStandard: "spl"` at this one provider-wire boundary.
Because direct USDC rows use nullable `routerKind` and `routerAddress`,
statically typed consumers must preserve explicit nulls (Rust uses `Option` and
Go uses `*string` in the package models). This source type change belongs to a
future published version and is not an unnoticed `0.8.0` patch.

## Unsigned build

`buildUnsigned` takes a previously returned quote, a source `swapperAddress`,
a destination address, and an optional same-source refund address. Addresses
are checked before I/O: EVM values are non-zero 20-byte hex normalized to
lowercase, while Solana values are canonical base58 encodings of 32 bytes.
The raw signed quote is reparsed and compared field-for-field with the supplied
quote, including route, amounts, expiry, source swap, and dependencies.

The exact outer body is:

```text
{"quote":<raw quote object unchanged>,"params":<compact params object>}
```

`params` has `swapperAddress`, `destinationAddress`, then `signerChainId: 1`
for an Ethereum source, then `swiftRefundAddress` when supplied. There is no
permit, custom payload, referrer, `/submit`, signing, approval transaction,
gasless path, cancellation builder, or refund transaction builder.

The provider response must be `{success:true,transaction:<build result>}`.
Returned validation is deliberately structural:

```js
{
  level: "structural",
  quoteSignatureLocallyVerified: false,
  transactionSemanticsLocallyVerified: false,
  settlementLocallyVerified: false
}
```

For Ethereum, the build result must identify an EVM SWIFT transaction on chain
1, use Forwarder `0x337685fdab40d39bd02028545a4ffa7d287cc3e2`, have numeric
value zero, and contain a sufficiently long calldata body beginning with the
route selector: `0x30dedc57` for EURC or `0xe4269fc4` for direct USDC. The
allowance record points the exact source token deployment at the Forwarder for
the quote input (`deployment-0011` for EURC or `deployment-0008` for USDC). No
approval call or allowance RPC is generated.

For Solana, the provider must return one canonical base64 serialized version-0
transaction. The bounded framing check requires one required signer, an
all-zero signature, version 0, and a fee payer equal to the first static key;
lookup framing, indices, and total wire size are checked. Extra signers and
any non-null `swapMessageV0Params` are rejected before the body is retained.
The transaction remains opaque: instruction, ALT, recipient, source-swap, and
settlement semantics are not locally verified.

## Indexed status

`getStatus` performs one read-only GET to
`/swap/trx/{sourceTransactionHash}` without an API key. It accepts an EVM
32-byte transaction hash or a canonical Solana base58 signature of 64 bytes.
The provider's `clientStatus` maps as follows:

| Provider value | SDK state |
| --- | --- |
| `INPROGRESS` | `in-progress` |
| `COMPLETED` | `completed` |
| `REFUNDED` | `refunded` |
| any other documented or bounded value | `unknown` |
| HTTP 404 | `BRIDGE_STATUS_NOT_FOUND` |

The result declares
`statusVerification: "provider-indexed-not-locally-verified"`. There is no
automatic polling or on-chain confirmation inference.

## Errors and traces

Bridge errors use a separate `BridgeError`/`BridgeErrorCode` family. Messages
are fixed, secret-free, and do not include endpoint URLs, API keys, raw quote
text, provider bodies, or native causes. HTTP 401/403 on build maps to
`BRIDGE_PROVIDER_AUTH_REQUIRED`; 429 and other HTTP failures map to
`BRIDGE_PROVIDER_HTTP` with an optional numeric status. Transport, timeout,
and cancellation conditions map to their dedicated fixed codes. No automatic
retry occurs.

Parity traces use uppercase methods, exact URLs, lowercase `accept`,
`content-type`, and optional `x-api-key` names, plus the actual body string or
`null`. Native transport-generated `user-agent`, `host`, and
`content-length` fields are ignored only during cross-language normalization.
`authorization` and `cookie` are always failures and cannot be hidden by
trace filtering.

## Fixtures, evidence, and parity

[`fixtures/mayan-swift-v2-cases.json`](./fixtures/mayan-swift-v2-cases.json)
is a synthetic wire fixture registry. It contains 51 cases: the original 36
case objects remain frozen, and 15 appended cases cover both direct USDC
directions plus hybrid-token, source-contract, native-token, direct-router,
normalized source-token, normalized-quote, raw-quote, selector, and
supplemental-signing-artifact rejections. Synthetic provider signatures, keys,
and addresses are test values;
they are never authenticated captures. EURC raw signed quotes retain the
`114.5000` JSON number lexeme and direct USDC quotes retain `100.0000`; tests use
these values to detect accidental reserialization or conversion.

The new USDC evidence packet is
[`evidence/mayan-swift-v2-usdc-2026-09-17.json`](./evidence/mayan-swift-v2-usdc-2026-09-17.json).
It records four bounded public quote observations and four hosted keyless build
responses with HTTP 401 on 2026-09-17T09:04Z. It contains no key or wallet
action and does not claim an authenticated build or settlement.

[`evidence/mayan-swift-v2-2026-09-16.json`](./evidence/mayan-swift-v2-2026-09-16.json)
records Rydia's primary sources, root's public quote observations, exact
provider facts, service and licensing gaps, owners and review dates. The
observations were read-only and contain no user key, private key, signing,
broadcast, or settlement proof. The external Mayan/Jupiter source exception is
limited to this explicit bridge adapter; ordinary SDK swaps remain configured
RPC and local logic.

Native captures are a separate activity owned by the five package owners.
Write the combined snapshot to `ERPC_SDK_BRIDGE_PARITY_OUTPUT` and verify it
with:

```sh
node registry/verify-bridge-parity.mjs --snapshots /path/to/bridge-native-runtime.json
```

The verifier requires exactly five executed native outputs and compares quote,
build, and status outcomes plus request traces. A canonical-reference template
is rejected as proof of native execution. Native captures and per-language
runtime files must be generated by their package owners; this registry does
not claim native parity until those captures exist and the independent gates
accept them.

The provider, auction solvers, relayers, Wormhole Guardians, and Explorer
indexer are external dependencies for direct USDC. The EURC source-swap builder
and Solana-origin Jupiter source swap are additional EURC dependencies; neither
is inherited by direct USDC. Their deployed versions, terms, SLA, security
ownership, and data rights remain open review items.
The bridge record is planning evidence and engineering input only. It does not
grant signing, secret, live-funds, publishing, regulatory filing, vulnerability
disclosure, CE, or legal authority.
