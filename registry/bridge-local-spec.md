# Mayan Swift v2 local unsigned construction contract

Status: L1-approved implementation contract, 2026-09-17. This document is the
shared source for the five language ports. It describes local preparation and
unsigned construction; it does not add signing, custody, submission,
broadcast, settlement, or a new bridge route.

Revision 2026-09-24: the shared fixture now carries synthetic Steiner F1–F7
regressions. The five positive prepare cases and five positive build cases from
the 2026-09-17 oracle retain their original bytes; the new rows are rejection
contracts and one same-slot ALT active-prefix positive control. The 2026-09-17
oracle observations remain historical evidence and are not reclassified as
fresh live proof.

The published `0.8.0` bridge remains the native EURC adapter. The two native
USDC rows are present in the canonical source checkout but remain unreleased.
Hosted `buildUnsigned` and its DTO are unchanged. Local construction is an
explicit pair of operations:

```text
prepareSourceSwap(context) -> sourceSwapPlan
buildLocalUnsigned(context + sourceSwapPlan) -> unsigned build
```

There is no fallback from local construction to the hosted `/build` endpoint.

## Reviewed route bindings

Only these four canonical routes are accepted. Route lookup always matches the
source and destination chain IDs together with both token deployment IDs.

| Capability | Source deployment | Destination deployment | Source token | Destination token | Auction mode |
| --- | --- | --- | --- | --- | --- |
| `bridge-mayan-swift-v2-eurc-eth-sol` | `deployment-0011` | `deployment-0013` | Ethereum EURC `0x1abaea1f7c830bd89acc67ec4af516284b1bc33c` | Solana EURC `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr` | 2 |
| `bridge-mayan-swift-v2-eurc-sol-eth` | `deployment-0013` | `deployment-0011` | Solana EURC `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr` | Ethereum EURC `0x1abaea1f7c830bd89acc67ec4af516284b1bc33c` | 2 |
| `bridge-mayan-swift-v2-usdc-eth-sol` | `deployment-0008` | `deployment-0010` | Ethereum USDC `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` | Solana USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 3 |
| `bridge-mayan-swift-v2-usdc-sol-eth` | `deployment-0010` | `deployment-0008` | Solana USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | Ethereum USDC `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` | 3 |

The Ethereum Swift contract is
`0x40ffe85a28dc9993541449464d7529a922142960`; the Solana Swift V2 program is
`mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny`. Ethereum uses Forwarder
`0x337685fdab40d39bd02028545a4ffa7d287cc3e2`; EURC uses selector
`0x30dedc57`, and USDC uses `0xe4269fc4`. The provider wire standard for a
Solana token is `spl`; the registry standard is `spl-token`.

## Inputs and normalization

The local context has exactly these keys:

```text
quote, swapperAddress, destinationAddress, orderNonce
```

`orderNonce` is a caller-supplied, fresh, lowercase `0x` plus 32-hex-digit
value. It is 16 public random bytes used for order uniqueness and is never a
private key. EVM addresses are normalized to lowercase non-zero 20-byte hex;
Solana addresses are canonical 32-byte base58. `quote` is the existing hosted
normalized quote, with its exact `rawSignedQuoteJson` retained. Production
parsing rejects any provider `memoHex`; the oracle sets `memoHex` only on a
cloned quote to reproduce `quoteId[16] || orderNonce[16]` as `random32`.

The raw quote must satisfy the existing Swift V2 boundary and these local
construction fields:

- `type` is `SWIFT`, `swiftVersion` is `V2`, `gasless` is false,
  `onlyBridging` is false, `gasDrop` is zero, `referrerBps` and `protocolBps`
  are zero, and `swiftWrapAndLock` is absent or false.
- `swiftAuctionMode` is exactly 2 or 3 and is preserved in all hashes, ABI
  fields, and Solana init bytes. EURC references use 2; native-USDC references
  use 3. Mode 3 requires equal expected and minimum destination output.
- Custom payload, memo, referrers, custom refund, permits, approval batches,
  Token-2022, Jito, separate swap transactions, extra caller instructions,
  unsupported chains, and unsupported tokens fail before provider or RPC I/O.
- Amounts, minima, and deadlines are canonical positive decimal strings bounded
  to uint64 where the DTO requires base units. Relayer fees are canonical uint64
  decimal strings and may be zero. The original
  quote DTO is not rewritten by local construction.

`minimumIntermediateAmount` is exact `effectiveAmountIn64` for direct USDC.
For EURC, parse the raw positive plain-decimal `minMiddleAmount` lexeme and
floor to six decimals. The exact decimal result is the encoded amount. Also
calculate the pinned JS conversion with binary64 mantissa/exponent arithmetic:
correctly rounded IEEE754 conversion, exact multiplication by 10^7, nearest
integer with positive ties upward, then integer division by 10. Reject the
build if the results differ. `1.00000099` is a required rejection vector
(exact floor 1000000, pinned conversion 1000001). Exponents, nonfinite values,
underflow-to-zero, overflow, malformed forms, and contradictory direct-USDC
`minMiddleAmount` values are rejected before I/O. Destination minima use the
canonical `minAmountOutBaseUnits` string and the same decimal compatibility
check; never derive it through a floating-point token amount.

All raw and normalized quote binding checks run before source-swap or RPC I/O.
The raw `evmSwapRouterAddress`, token, amount, destination-minimum, signature,
and slippage fields must agree with the reviewed route and normalized quote.
`evmSwapRouterCalldata` is a provider hint and need not be byte-equal to a
refreshed source-swap response; the shared malformed-calldata vector rejects
only an empty `0x` payload before I/O. A valid refreshed response is checked by
its own bounded router, token, and amount bindings.

## Plan DTO

The plan has this exact key set and stable order:

```text
planKind, providerId, capabilityId, sourceChainId, destinationChainId,
sourceTokenDeploymentId, destinationTokenDeploymentId, quoteId,
rawQuoteSha256, orderNonce, swapperAddress, destinationAddress, orderHash,
quoteBindingHash, minimumIntermediateAmount, sourceSwap, planHash
```

Values are:

- `planKind: "mayan-swift-v2-local-source-swap"` and
  `providerId: "mayan-swift-v2"`;
- route and quote fields copied from the exact four-field capability match;
- `rawQuoteSha256` as lowercase SHA-256 of the exact UTF-8 raw quote bytes;
- `orderHash` as lowercase `0x`-prefixed Keccak-256 of the 272-byte Swift V2
  order preimage below;
- `quoteBindingHash` and `planHash` as lowercase unprefixed SHA-256 values;
- normalized public addresses and the caller nonce;
- `sourceSwap` from the closed union below.

### Source-swap union

Direct USDC uses exactly `{ "kind": "none" }`. It makes no source-swap HTTP
request and does not inherit the EURC source-swap builder or Jupiter dependency.

Ethereum-source EURC uses:

```text
kind, routerAddress, calldata, rawResponseSha256, rawProviderSourceSwapJson
```

`kind` is `evm-router`; the router address and calldata are normalized hex,
`rawResponseSha256` hashes the exact source-swap response body, and
`rawProviderSourceSwapJson` retains that exact body. The response must contain
the validated router address and bounded non-empty calldata; it cannot provide
an alternate transaction or recipient.

Solana-source EURC uses:

```text
kind, instructions, addressLookupTableAddresses,
rawResponseSha256, rawProviderSourceSwapJson
```

`kind` is `solana-jupiter-v6`. Each instruction has exactly
`programId, accounts, dataBase64`, and each account has exactly
`pubkey, isSigner, isWritable`. The plan ALT list contains provider ALTs only;
the local builder prepends the fixed Mayan ALT and deduplicates the final list
in first-seen order. The semantic instruction order is compute, setup, direct
Jupiter; Swift init is added by the local builder.

The source response is validated as a route, not by program-ID presence alone.
The recognized Jupiter V6 instruction is `route_v2` with discriminator
`bb64facc31c4af14`. Its source amount, output protection, source/destination
mints, trader and state ATAs, and account coupling must match the quote and
plan. The observed route shape is:

- `computeBudgetInstructions`: at most two instructions, each with zero
  accounts; tag `02` has a four-byte little-endian unit limit no greater than
  `1400000`, and tag `03` has an eight-byte little-endian micro-lamport price
  no greater than `100000`;
- `setupInstructions`: only associated-token-account creation for the state
  USDC ATA and optional trader USDC ATA, with the exact derived accounts,
  swapper payer, and six canonical account metas; idempotent data is `01` and
  legacy creation data is empty;
- `swapInstruction`: Jupiter V6 `route_v2`, with the exact account positions
  for the state destination ATA and source/output mints, a swapper-only signer,
  and route data whose input amount and minimum output satisfy the quote;
- `cleanupInstruction`, `tokenLedgerInstruction`, and `otherInstructions`
  are null/empty. Unknown supplemental instructions and unexpected writable
  user accounts fail closed.

The reviewed route labels `Whirlpool` (Orca) and `Raydium` may be accepted only
when all of the same route-v2 account/data checks pass. Unknown AMM labels,
instruction discriminators, account layouts, or output destinations fail
closed. Harmless response metadata such as timing, simulation slot, and quote
reports is never promoted to the plan; any field that would execute is checked
or rejected.

The common route-v2 account frame is fixed before ports begin. Accounts 0, 1,
and 2 are respectively the swapper signer/read-only, trader EURC ATA writable,
and trader USDC ATA writable. Accounts 3 and 4 are the EURC and USDC mints,
read-only; accounts 5 and 6 are the two canonical SPL Token program entries,
read-only; account 7 is the state USDC ATA writable; account 8 is the event
authority `D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf`, read-only; and account
9 is the Jupiter program, read-only. The remaining accounts must match the
reviewed DEX layout and are bounded; a program-ID-only check is insufficient.
The current observed Orca/Whirlpool frame has 22 accounts, DEX program at
account 10 `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`, and pool at account 13
`ArisQNcbjXPJD7RgPRvysatX3xcfHPTbcTkfD8kDoZ9i`. The reviewed Raydium CLMM
variant has 25 accounts, DEX program at account 10
`CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`, and pool at account 13
`2zVV22uNWdJNmkXpj5vCrMzwHGBoJdsyV7qACh29sK1w` from the pinned source route
vector. Ports may
accept these two exact layouts only after checking the full account list,
instruction bytes, route-plan mints/amounts, and destination coupling. The
Orca data vector is 40 bytes with tail `000001000000110010270001` from byte
offset 28; the Raydium vector is 39 bytes with tail
`0000010000001a10270001`. Unknown DEX programs, pools, lengths, or route
variants fail closed.

The DEX label is read from `quoteResponse.raw.routePlan[0].swapInfo.label` in
the provider response. A top-level route-plan or label alone is not a route
approval. For the approved observed frames, account 0 must equal the swapper
and be the only signer; account 1 is the trader EURC ATA, account 2 the trader
USDC ATA, account 7 the state USDC ATA, and the route data must encode the exact
input amount and protected output. Both Orca and Raydium variants remain
bounded source-swap observations; they do not imply a complete Jupiter or DEX
support guarantee.

The local Solana EURC implementation accepts only the reviewed account frames.
On-chain Whirlpool tick-array movement can make a fresh valid quote fail the
full-tuple guard with `BRIDGE_LOCAL_PLAN_INVALID`; retry alone is not
guaranteed to resolve that bounded limitation. This is a runtime support
boundary, not permission to discover or admit a new DEX frame.

The tuple is closed over every account position and flag. The source swapper
is the only signer, its payer flag is read-only, the trader EURC and USDC ATAs
are writable non-signers, and the ATA owner meta at position 2 is a read-only
non-signer. The state ATA, event authority, Jupiter entry, DEX program, pool,
configuration, vault, tick-array, oracle, and remaining reviewed accounts must
match the pinned Orca 22-account or Raydium 25-account tuple, including each
`isSigner` and `isWritable` flag. Dynamic payer, state, and derived ATA values
are recomputed from the current order and swapper; the reviewed pool/config/
vault/tick/oracle addresses remain pinned. A recognized label or program ID
without the full tuple is rejected.

Jupiter's quoted output threshold may be below Swift's `amountInMin`. Preserve
the exact Jupiter route and do not rewrite its slippage to force equality; the
following Swift init in the same atomic transaction protects the exact
intermediate amount. A `simulationError: null` field alone is not proof of that
protection or of settlement.

## Hash and order preimage contract

Canonical JSON is recursive key-sorted compact UTF-8 JSON. Arrays retain order;
objects sort keys by code-unit order; strings use JSON escaping; numbers are
finite JSON numbers only; SHA-256 digests are lowercase hex.

`quoteBindingHash` hashes this exact object:

```json
{
  "capabilityId": "...",
  "destinationAddress": "...",
  "destinationChainId": "...",
  "destinationTokenDeploymentId": "...",
  "orderNonce": "0x...",
  "quoteId": "0x...",
  "rawQuoteSha256": "...",
  "sourceChainId": "...",
  "sourceTokenDeploymentId": "...",
  "swapperAddress": "..."
}
```

`planHash` hashes the exact object `{ "quoteBindingHash": "...",
"sourceSwap": <normalized sourceSwap> }`. `rawProviderSourceSwapJson` is
excluded from the plan hash, while its `rawResponseSha256` remains included.

The Swift V2 order preimage is exactly 272 bytes, big-endian for uint16/uint64:

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 1 | default payload type `1` |
| 1 | 32 | trader, Wormhole-native encoding of refund address or swapper |
| 33 | 2 | source Wormhole chain ID |
| 35 | 32 | source USDC token, Wormhole-native encoding |
| 67 | 32 | destination address, Wormhole-native encoding |
| 99 | 2 | destination Wormhole chain ID |
| 101 | 32 | destination token, Wormhole-native encoding |
| 133 | 8 | canonical destination minimum (`minAmountOutBaseUnits`) |
| 141 | 8 | gas drop, zero |
| 149 | 8 | cancel relayer fee |
| 157 | 8 | refund relayer fee |
| 165 | 8 | deadline |
| 173 | 32 | default referrer bytes, all zero |
| 205 | 1 | referrer BPS, zero |
| 206 | 1 | Mayan protocol BPS, zero |
| 207 | 1 | exact auction mode, 2 or 3 |
| 208 | 32 | `quoteId` 16 bytes followed by `orderNonce` 16 bytes |
| 240 | 32 | default custom-payload hash bytes, all zero |

`orderHash` is Keccak-256 of these exact bytes. No signature or subgroup
validation is implied by this hash.

## Local build DTO

The local build has this exact key set:

```text
buildKind, providerId, capabilityId, quote, sourceChainId,
destinationChainId, sourceSwapPlan, transaction, allowance,
construction, validation
```

`buildKind` is `mayan-swift-v2-local-unsigned`. `quote` is unchanged from the
validated hosted quote. `transaction` uses the existing EVM or Solana unsigned
envelope shape. `allowance` is the exact source-token requirement for
Ethereum-source routes and null for Solana-source routes.

`construction` has exactly:

```text
mode, referenceCommit, orderNonce, orderHash, minimumIntermediateAmount,
effectiveDependencies, sourceRpcEvidence
```

Effective dependencies remove `mayan-hosted-transaction-builder`, retain the
other original dependencies in their original order, and append exactly
`configured-ethereum-rpc` or `configured-solana-rpc` for the source chain.
EURC retains its hosted source-swap service and Solana-origin Jupiter only where
applicable. The original quote dependency array remains unchanged.

`validation` has exactly:

```json
{
  "level": "local-structural",
  "quoteSignatureLocallyVerified": false,
  "planBindingLocallyVerified": true,
  "transactionBytesLocallyConstructed": true,
  "settlementLocallyVerified": false
}
```

These are consistency and construction labels. RPC code/address checks are not
a security audit; provider signatures, remote swap semantics, and settlement
remain unverified.

## RPC and source-swap transport

Mayan source-swap HTTP is anonymous, bounded, and read-only. Source RPC calls
use only the explicitly configured endpoint and its explicitly configured
headers; those RPC credentials never flow to Mayan. Neither path uses a public
fallback or ambient redirect, and direct USDC performs no source-swap request.

The deterministic RPC trace uses JSON key order `jsonrpc,id,method,params`,
`jsonrpc: "2.0"`, numeric `id: 1`, and response ID `1`:

Every configured source-RPC request carries lowercase `accept: application/json`
and `content-type: application/json`, followed only by headers explicitly
configured for that source RPC. These headers are part of the frozen trace;
RPC credentials and ERPC authorization never flow to Mayan source-swap HTTP.

1. EVM: `eth_chainId` with `[]`, then `eth_getCode` with `[address,"latest"]`
   in Forwarder, Swift, then EURC-router order. Record
   `rpcChainId: "0x1"` and non-empty code hashes.
2. Solana: `getGenesisHash` with `[]`, `getLatestBlockhash` with
   `{ "commitment": "confirmed" }`, then `getMultipleAccounts` with the fixed
   Mayan ALT followed by deduplicated provider ALTs and
   `{ "encoding": "base64", "commitment": "confirmed", "minContextSlot": <safe JSON number> }`.
   Require the account context slot to be at least the blockhash context slot.

Every JSON-RPC request is emitted with the exact prefix
`{"jsonrpc":"2.0","id":1,"method":` and the closed key order
`jsonrpc,id,method,params`. Requests remain fixed in the shared fixture traces.
The local transport validates each selected response envelope before promoting
its result: response `jsonrpc` must be `"2.0"`, response `id` must be numeric
`1`, and malformed, missing, null, string, or wrong IDs fail immediately. A
response body whose parsed depth exceeds 32 or whose streamed bytes exceed 1 MiB
also fails before the next RPC is issued. The response-envelope mutation
descriptor changes only the selected response envelope or body framing; it
never changes the outgoing request trace or the response `result`.

Blockhash context-slot and last-valid-height failures therefore carry only the
genesis and blockhash request prefix. Account-context-slot failures occur on the
following account request and carry all three Solana RPC requests.

Streaming limits apply while reading the body, including timeout and abort
through body completion. Incomplete bodies are disposed before the sanitized
error is returned. Solana slots and block heights are safe non-negative JSON
integers; negative, unsafe, fractional, or string values are rejected.

Frozen configured RPC URLs include an explicit trailing `/` when the endpoint
has an empty path; this preserves the direct transport's canonical URL bytes.

`sourceRpcEvidence` contains no endpoint or header values:

```text
EVM: {kind:"evm", rpcChainId:"0x1", code:[{address,keccak256}]}
Solana: {kind:"solana", genesisHash, blockhashContextSlot,
         accountContextSlot, recentBlockhash, lastValidBlockHeight,
         lookupTables:[{address,dataSha256}]}
```

Slots and heights are canonical decimal strings. EVM code hashes are lowercase
`0x` plus 64 hex digits; ALT data hashes are lowercase 64-hex SHA-256 values.
This evidence records identity and consistency observations and does not imply
contract or account audit.

ALT decoding requires the type discriminator, executable flag, lookup-table
owner, deactivation `u64.MAX`, authority option/layout, and address data
length. If `lastExtendedSlot == accountContextSlot`, only the active prefix
with indexes below `lastExtendedStartIndex` may be used. A same-slot active
prefix is a valid positive boundary. Inactive entries are valid table metadata
but must be omitted from compiled lookups. The reviewed Raydium boundary
regression supplies both ALT tables with only same-slot inactive entries; after
omission it reaches the calibrated 1257-byte static message and rejects with
`BRIDGE_LOCAL_BUILD_INVALID` at the existing 1232-byte limit. Future extensions,
malformed metadata, and owner or executable mismatches fail with the sanitized
RPC-invalid error.

The local source-swap GET uses `/get-swap/evm` or `/get-swap/solana` under the
configured source-swap endpoint with the exact allowlisted query order captured
in the local fixture. The raw response body, request trace, and SHA-256 are
frozen. Time and simulation metadata are not included in DTO hashes.

## EVM construction

Build `createOrderWithToken` calldata with discriminator `0xa3a30834`, then
wrap it in Forwarder `forwardERC20` for direct USDC or
`swapAndForwardERC20` for EURC. Use value `0`, Ethereum chain `1`, exact
source amount, exact six-decimal intermediate minimum, Swift target,
destination, deadline, fees, mode, and `random32`. Permit is zero and payload
is empty. The router response cannot supply a transaction, recipient, or
override. Return the exact allowance requirement without approving.

## Solana construction

Derive the Swift state PDA from `["STATE_SOURCE", orderHash, u16LE(2)]` and
derive native Solana ATAs with the ZIP215-compatible public-point predicate.
Direct USDC uses proxy-wrapped state ATA creation, SPL transfer, Swift init,
and an optional bounded compute instruction. EURC uses proxy-wrapped ATA setup,
direct Jupiter route-v2, then proxy-wrapped Swift init. Keep Jupiter and Swift
init in one atomic v0 transaction.

Swift init is 198 bytes with discriminator `204c290c27a284db`; it carries exact
minimum intermediate amount, amount-out minimum, destination, deadline, fees,
auction mode, and random bytes. The fee payer is the only signer. Compile with
a fresh configured-RPC blockhash and validated ALTs, zero placeholder
signatures, and total serialized size at most 1232 bytes. Reject extra
signers, separate messages, unexpected writable user accounts, cleanup, and
unsupported instructions.

The local implementation does not claim that a provider `simulationError:null`
proves success. The exact destination ATA and following init must remain in one
transaction. Underfill safeguards require a separate reviewed proof; they do
not establish end-to-end settlement.

### Final-size boundary vector

The `build-solana-final-size-cap` case uses a separately rebound Raydium CLMM
`route_v2` response: 25 accounts, pool
`2zVV22uNWdJNmkXpj5vCrMzwHGBoJdsyV7qACh29sK1w`, provider ALT
`CzGXBtzCo3SfE1y9erkwa7t7ffT7q3GskAeAp9o3JV3S`, and quoted output
`114832183`, above the Swift minimum `114758249`. Its swapper, trader ATAs,
state PDA, and source request are derived from that fixture quote and nonce;
they are not copied from the live response's wallet or state. The mocked
`getMultipleAccounts` response returns two valid empty active ALTs (56-byte
metadata, deactivation `u64::MAX`, last-extended fields zero). The reviewed
Orca route remains a valid 1191-byte no-ALT construction. The rebound Raydium
route serializes to 1257 bytes without address compression and therefore
returns `BRIDGE_LOCAL_BUILD_INVALID` against the 1232-byte limit. The boundary
descriptor denotes this measured oversized result; it is not a DTO field and
does not require an artificial 1233-byte transaction.

## Shared local fixture and oracle

`fixtures/mayan-swift-v2-local-build-cases.json` is a synthetic, source-backed
fixture. It contains 42 prepare cases and 45 build cases: seven prepare
positives (including two credential-boundary controls), six build positives,
74 closed rejection rows, and one
same-slot ALT active-prefix positive control. The original 39 case IDs and ten
positive byte oracles are retained byte-for-byte. The fixture has deterministic
digest `4a9960ad4d0fcc0865f4afcd5e5403d81823f57a64bbc48039113e568b050c35`.
It carries rich
raw quotes, exact source-swap response bodies, raw ALT/blockhash RPC mocks,
deterministic public addresses/nonces, and rejection cases covering route,
quote, nonce, plan replay, source-swap bytes/program/accounts/signers/amounts,
RPC identity/failure/malformed accounts/ALT/blockhash, timeout/abort, size and
fee caps, and direct-USDC zero-I/O.
The existing hosted fixture remains byte-identical and is referenced only by
its frozen SHA-256 `3c414e362b518a3845e365c3c7c6f78e43984aae396be19817ddb53bb0da6283`
and semantic 51-case digest
`843748ff68a12d32b0fee400093b9f25eed0f8100bc4082de5d693a9cd6db53a`.

`reference-mayan-local-build.mjs` loads only the pinned official
`@mayanfinance/swap-sdk` 15.2.2 from a caller-supplied temporary reference
directory. It may perform bounded anonymous quote/source-swap/read-RPC capture
for fixture creation, or replay frozen responses. It never calls `/build`,
reads keys, signs, simulates, submits, or broadcasts. It sets `memoHex` only on
an oracle quote clone; production quote parsing never sees that field.

`prepare-eurc-credential-forwarding` and
`prepare-eurc-hosted-build-forbidden` are positive boundary controls retained
under their historical IDs. They execute the same valid Ethereum EURC source
GET and return the same plan bytes as the canonical prepare case while carrying
`builderApiKey: "synthetic-builder-api-key"`, unused
`builderEndpoint: "https://unused-builder.invalid"`, and a distinct configured
source-RPC authorization header. The source trace remains anonymous and there
are zero RPC or hosted-build requests.

The oracle output is evidence of the pinned SDK's byte construction, not proof
of the ERPC implementation, provider authorization, or settlement. Native
package captures must call the native public methods and report actual runtime
outputs; a canonical expected snapshot is not a native capture.

The local fixture envelope has exactly these keys:

```text
schemaVersion, fixtureKind, capabilityAsOfDate, capabilityDigest,
hostedFixtureSha256, hostedFixtureSemanticSha256, localFixtureDigest, referenceCommit,
officialSdkVersion, oracle, quotes, sourceSwapMocks, rpcMocks, cases
```

`oracle` contains the test-only `memoHex` clone values and never enters a
production quote. `quotes` contains five rich raw provider quote records,
including the quote-bound Raydium route used for the size boundary.
Each record has `quoteId`, `capabilityId`, `rawQuoteJson`,
`rawQuoteSha256`, and the normalized hosted quote; the raw quote does not
contain the oracle-only `memoHex`. `sourceSwapMocks` contains exact
anonymous GET request/response bodies for EURC routes. `rpcMocks` contains exact
JSON-RPC request/response bodies for the configured source endpoint. RPC mock
IDs are numeric `1` in the frozen fixture even though a live web3 client may
choose another request ID; replay matching ignores only that transport ID and
returns the checked request ID.

Each case has exactly:

```text
caseId, method, source, capabilityId, quoteId, context,
sourceSwapMockIds, rpcMockIds, sourceSwapPlanRef, expected, httpTrace,
rpcTrace, mutation, config
```

`method` is `prepareSourceSwap` or `buildLocalUnsigned`; `source` is
`synthetic`; `context` has exactly `quoteRef`, `swapperAddress`,
`destinationAddress`, and `orderNonce`. Build cases set `sourceSwapPlanRef` to
the prepare case ID; prepare cases set it to null. Positive cases carry complete
`expected` plans/builds and exact request traces. Negative cases carry an
explicit closed `mutation` or transport descriptor, an expected fixed error,
and zero or the specified bounded I/O trace. No package test may select a
mutation by case-name magic.

Rejection cases use a closed, test-only descriptor. The descriptor is either
`{kind:"transport",event:<event>}`, `{kind:"boundary",path:"solana.finalTransactionBytes",value:"1233"}`,
or `{kind:<set-kind>,path:<path>,value:<scalar>}`. Set kinds are
`context-set`, `quote-normalized-set`, `quote-raw-set`,
`source-swap-response-set`, `rpc-response-set`, `rpc-envelope-set`, `plan-set`,
and `config-set`.
The accepted paths are frozen to the corresponding input families: route and
address fields for `context-set`; route, amount, deadline, quote ID, and
source-swap fields for `quote-normalized-set`; raw Swift mode, decimal,
contract, feature, memo, gas, and priority fields for `quote-raw-set`; router
or route-v2 program/account/amount fields for `source-swap-response-set`;
`eth_chainId.result`, `eth_getCode.result`, `getGenesisHash.result`,
`getLatestBlockhash.value.blockhash`, safe slot/height fields, ALT owner and
executable flags, or `getMultipleAccounts.value[0]`/`.data[0]` for
`rpc-response-set`; response `jsonrpc`, `version`, `id`, `depth`, and `size`
for `rpc-envelope-set`; plan nonce/hash/minimum/source-swap fields
for `plan-set`; and the three local-build endpoint fields for `config-set`.
Transport events are `source-swap-timeout`, `source-swap-abort`,
`rpc-transport-error`, `rpc-timeout`, and `rpc-abort`. A descriptor is data for fixture runners; no
runner may branch on case IDs.

`rpc-envelope-set` is a closed descriptor with exactly
`{kind,path,value}`. `jsonrpc` and `version` target `response.jsonrpc`, `id`
targets `response.id`, and `depth` and `size` describe the bounded response
body mutation. Outgoing request bytes remain canonical; the response `result`
remains the frozen fixture oracle. Envelope and transport regressions use only the
sanitized `BRIDGE_SOURCE_RPC_INVALID_RESPONSE`, `BRIDGE_TIMEOUT`, or
`BRIDGE_ABORTED` codes; no endpoint, header, body, or native cause is exposed.

The 2026-09-24 synthetic rows cover the Steiner findings: signer and ATA-owner
flags; complete Orca and Raydium pool/config/vault/tick/oracle tuples; ALT
type/owner/executable/deactivation/authority/layout/start-index and future
extension checks and the calibrated inactive-entry size boundary; raw
destination-minimum and normalized quote binding,
signature/router/provider-minimum/slippage mismatches; RPC envelope ID/version,
depth/size and safe slot/height checks; and full response-body transport limits.

ALT diagnostic vector table:

| Case | Valid source buffer | Isolated change | Expected result |
| --- | --- | --- | --- |
| `build-usdc-solana-alt-type-discriminator` | fixed populated ALT | u32 LE offset 0 → tag `2` | RPC-invalid |
| `build-usdc-solana-alt-deactivated` | fixed populated ALT | u64 LE offset 4 → deactivation `0` | RPC-invalid |
| `build-usdc-solana-alt-authority-layout` | fixed populated ALT | option byte offset 21 → invalid tag `2` | RPC-invalid |
| `build-usdc-solana-alt-future-extension` | fixed populated ALT | u64 LE offset 12 → context slot + 1 | RPC-invalid |
| `build-usdc-solana-alt-start-index-out-of-range` | fixed populated ALT | start byte offset 20 → `255` | RPC-invalid |
| `build-eurc-solana-raydium-same-slot-inactive-index` | populated Orca/Raydium ALTs | both extension slots → account context, start byte → `0` | inactive entries omitted; calibrated 1257-byte local-build-invalid |

The local fixture's deterministic content digest is SHA-256 of the canonical
JSON projection `{ "quotes": <quotes>, "sourceSwapMocks": <sourceSwapMocks>,
"rpcMocks": <rpcMocks>, "cases": <cases> }`; it excludes the envelope,
`oracle` metadata, and the digest field itself. Native snapshot envelopes carry
this value as `localFixtureDigest` alongside the frozen hosted fixture digest.

The native parity snapshot keeps `snapshotKind: "bridge-native-runtime"`, moves
to `snapshotVersion: 2`, and adds `hostedFixtureDigest` and
`localFixtureDigest`. Its behavior keys are `quote`, `build`, `status`,
`prepareSourceSwap`, and `buildLocalUnsigned`. All five languages must provide
actual native outputs for all five behavior keys; a canonical expected object or
fixture-driver label is not execution evidence.

The verifier and CI require snapshot version 2 by default. Version 1 contains
only hosted behavior and is rejected unless the caller explicitly opts in with
the CLI `--allow-legacy-v1` flag or the exported `verifySnapshots` option
`{allowLegacyV1: true}`. Legacy opt-in does not establish local parity.

## Error and boundary contract

Local implementations mirror these fixed, secret-free errors:

| Code | Message |
| --- | --- |
| `BRIDGE_LOCAL_RPC_REQUIRED` | `Bridge local source RPC is required` |
| `BRIDGE_SOURCE_RPC_TRANSPORT` | `Bridge source RPC transport failed` |
| `BRIDGE_SOURCE_RPC_INVALID_RESPONSE` | `Bridge source RPC response is invalid` |
| `BRIDGE_LOCAL_PLAN_INVALID` | `Bridge local source-swap plan is invalid` |
| `BRIDGE_LOCAL_BUILD_INVALID` | `Bridge local unsigned build is invalid` |

Existing invalid-argument, quote-mismatch, quote-expired, timeout, abort, and
provider error meanings remain unchanged. No error exposes endpoint URLs,
headers, response bodies, keys, or native causes.
