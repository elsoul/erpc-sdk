# Discovery and ranking integration review

Date: 2026-09-16  
Status: **partial local review**  
Source commit: `5ef97abd66f40a2db77a4f85595cf64d1032f7c8`  
Source tree: `0e85ceaf0ab954d5bd1b8f48088c1a5b8e25bc39`

The plain default collector completed a bounded three-chain run from the
frozen source checkout. It used local execution provenance only:
`origin=local`, with no GitHub run ID or attempt. This is review evidence and
is not Actions promotion provenance.

## Result

The candidate added 5 unclassified token deployments and 8 pool definitions,
within the per-run caps. The resulting catalogs contain 44 assets, 65 token
deployments, 65 token aliases, 12 pools, 16 DEX aliases, and the original 3
native-wrap definitions. Existing records, IDs, aliases, and native-wrap
bindings were preserved by strict append-only replay.

| Output | Digest | Status / count |
| --- | --- | --- |
| Token catalog | `5a7ed7f57a8cfaed87c46512586da8123e94fae80f1ce18ebb3861ccb95a9f70` | 44 assets, 65 deployments, 65 aliases |
| DEX catalog | `a0268a45d2b037ab8ea35aad1c45366d2582cbc9b10681ded590b56e07b011c8` | 4 DEX deployments, 12 pools, 16 aliases |
| Ranking snapshot | `f8ae479007fa782995aaaf6aa1c414ba1b6a10a92b7abe481b055293a91ac01c` | 11 records, 54 unranked, `partial` |
| Candidate output set after deterministic normalization | `9664c12f7d824047d85e5bce9d822dd35a9baec324475785cbf43526b906b413` | 5 tokens, 8 pools, 11 ranking records |

Discovery returned `partial` status with 615 receipts and 722 replayed
proposals. Deferred candidates were retained with explicit reasons:
201 below the native-liquidity floor, 676 dependency or token-cap deferred,
150 not-direct-native-pair, and 20 pool-cap deferred. Native admission uses
10 ETH, 100 AVAX, and 100 SOL floors in native atomic units, with direct WETH,
WAVAX, and classic WSOL pairs only.

Pool monitoring returned `complete` with 12 healthy observations. Ranking
collection returned `partial` across the three configured sources. The
ranking metric is `onchain-total-supply-value-native`: total supply multiplied
by the direct native-pool price as an exact rational in native atomic units.
It is explicitly not circulating market capitalization. Coverage was:

| Chain | Deployments | Ranked | Unranked | Observation |
| --- | ---: | ---: | ---: | --- |
| `eip155:1` | 31 | 5 | 26 | `2026-09-16T12:25:59Z` |
| `eip155:43114` | 15 | 5 | 10 | `2026-09-16T12:39:02Z` |
| `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | 19 | 1 | 18 | `2026-09-16T12:39:03Z` |

Unranked reasons were 5 `excluded-native`, 41 `unavailable`, and 8
`unsupported`. The optional global USD metric remains disabled and its rights
status is `UNDETERMINED`.

## Evidence and validation

- Raw discovery receipts: [`discovery-receipts-2026-09-16.json`](./discovery-receipts-2026-09-16.json), 10,206,687 bytes, SHA-256 `0178b9095c108cab26e5972d7e2173a4313cbaf5d7a4159baf764e54dc3998bd`.
- Raw ranking receipts: [`ranking-receipts-2026-09-16.json`](./ranking-receipts-2026-09-16.json), 699,054 bytes, SHA-256 `395e760a31b2a8fcba1f521a02e3f608e4e3ef03d4e9decbef3e5718869284af`.
- Raw pool observations: [`pool-observations-2026-09-16.json`](./pool-observations-2026-09-16.json), 1,116,761 bytes, SHA-256 `429d7b8548fc0b62daa37ef0eb406392b91571c2c17deeb53867b2f36b7e0c56`.
- Strict replay of the returned observation twice produced identical candidate digests, files, and discovery state.
- The original F collector candidate output digest was
  `d47fbf1ae90ce405acbd9614b5e1521da96478fbe29a4bdbbac9c981c19615b8`.
  Replaying that unchanged raw observation against the F baseline after the
  bound date and formatter fixes produced normalized digest
  `9664c12f7d824047d85e5bce9d822dd35a9baec324475785cbf43526b906b413`.
  The three raw receipt files and their hashes below were not rewritten.
- Standalone discovery admissions selected the same 5 token and 8 pool IDs as the M2 candidate.
- Pool observations validated and replayed against the candidate token and DEX catalogs.
- The shared quote fixture adds one vector for newly admitted DAI/WETH pool
  `discovered-pool-a7f9e600a86951f40472ff779fae467db8a6bbbc6076356058f427e97d4ae429`;
  it returns `SWAP_UNSUPPORTED_TOKEN` with the exact message
  `Swap token is unsupported for the selected pool` before any RPC call.
  Existing fixture vectors remain unchanged.

The source index and rights boundary are recorded in
[`discovery-ranking-sources-2026-09-16.json`](./discovery-ranking-sources-2026-09-16.json).
Applicability, company legal role, product classification, support
commitments, compliance, and data rights remain `UNDETERMINED`. This packet
does not make a CE claim, legal certification, or broad vendor-data rights
claim.

The five new token deployments and eight new pools carry `asOfDate:
2026-09-16`, derived from the latest valid timestamp in the bound discovery
transcript. Historical records retain their prior dates. The normalized
generated files were rendered with `gofmt` from Go 1.22.12 and `rustfmt`
1.8.0-stable; implementation file hashes and formatter versions are recorded
in the JSON packet.

The recorded native token, DEX, and ranking parity captures pass for this
populated snapshot: 44 assets, 65 deployments, 65 aliases, 4 DEX deployments,
12 pools, 16 DEX aliases, and 11 ranking records. Remote CI and the final
independent gate remain pending.
`ERPC_ENABLE_AUTOMATIC_DATA_MERGE` and `ERPC_ENABLE_AUTOMATIC_RELEASE` remain
`OFF`; no settings, merge, tag, publication, or release action was performed.
