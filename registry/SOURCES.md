# Token catalog sources

As of 2026-09-15, the catalog is a bounded implementation seed selected from issuer, protocol, and primary project sources. The source packet and receipt captures are persisted in [`evidence/token-catalog-2026-09-15.json`](./evidence/token-catalog-2026-09-15.json). The packet records the consulted URL, selected field, method, network identity, block or slot, observed result, and remaining gap. Marketing or regulatory language is not an SDK endorsement.

## Source index

| Source area | Primary URL(s) | Selected facts or role |
| --- | --- | --- |
| Ethereum native / WETH | <https://ethereum.org/whitepaper/>; <https://github.com/gnosis/canonical-weth> | ETH native identity and WETH address/decimals |
| Avalanche native / WAVAX | <https://build.avax.network/docs/primary-network>; <https://build.avax.network/academy/blockchain/x402-payment-infrastructure/04-x402-on-avalanche/02-network-setup> | AVAX native identity and WAVAX address/decimals |
| Solana native / wrapped SOL | <https://solana.com/docs/tokens/basics/sync-native> | SOL native identity, classic WSOL, and Token-2022 distinction |
| Circle | <https://developers.circle.com/stablecoins/usdc-contract-addresses>; <https://developers.circle.com/stablecoins/eurc-contract-addresses> | USDC and EURC Ethereum, Avalanche, and Solana deployments |
| Tether | <https://tether.to/en/supported-protocols/> | USDT, EURT, protocol deployment facts; EURT lifecycle note |
| Avalanche USDC.e | <https://support.avax.network/en/articles/8857127-usdc-cctp-faq>; <https://help.circle.com/support/en/usdc-on-avalanche-vs-usdc-e?id=kb_article_view&sysparm_article=KB0010587> | Bridged USDC.e relation and legacy lifecycle |
| Sky / Maker | <https://github.com/sky-ecosystem/developerguides/blob/master/dai/dsr-integration-guide/dsr-integration-guide.md>; <https://github.com/sky-ecosystem/spells-mainnet/blob/master/src/test/addresses_mainnet.sol>; <https://developers.skyeco.com/guides/skylink/usds-ethereum-solana-bridge/> | DAI, USDS, and Solana bridged USDS relation |
| PayPal / Paxos | <https://www.paypal.com/uk/cshelp/article/what-is-paypal-usd-pyusd-help1005>; <https://docs.paxos.com/guides/stablecoin/pyusd/mainnet>; <https://docs.paxos.com/guides/stablecoin/usdg/mainnet>; <https://docs.sandbox.paxos.com/guides/stablecoin/usdp/mainnet>; <https://support.paxos.com/articles/3639591263-pax-dollar-usdp> | PayPal USD (PYUSD), USDG, and USDP deployments and decimals; PayPal USD display-name correction |
| Ethena | <https://docs.ethena.fi/api-documentation/overview> | USDe Ethereum deployment |
| Aave / GHO | <https://raw.githubusercontent.com/aave-dao/aave-address-book/main/tokenlist.json>; <https://www.aave.com/help/gho-stablecoin/bridging-gho> | GHO and Avalanche CCIP relation |
| First Digital | <https://www.firstdigitallabs.com/fdusd> | FDUSD Ethereum and Solana deployments |
| Ripple | <https://docs.ripple.com/products/stablecoin/overview/token-addresses> | RLUSD Ethereum deployment |
| Agora | <https://docs.agora.finance/developer/contract-deployments> | AUSD Ethereum, Avalanche, and Solana deployments |
| Jupiter | <https://docs.jup.ag/user-docs/earn/jupusd>; <https://developers.jup.ag/docs/guides/how-to-get-token-information> | JupUSD and JUP Solana deployments |
| JPYC | <https://github.com/jpycoin> | Funds-transfer JPYC Ethereum and Avalanche deployments |
| SG Forge | <https://www.sgforge.com/wp-content/uploads/2025/10/EURCV-White-Paper_iXBRL_202510.html> | EURCV Ethereum and Solana deployments; differing decimals |
| AllUnity | <https://allunity.com/eurau> | EURAU Ethereum and Solana deployments |
| Schuman | <https://schuman.io/smart-contracts/> | EUROP Ethereum, Avalanche, and Solana deployments |
| GMO / Z.com | <https://stablecoin.z.com/multi-chain-gyen-and-zusd/>; <https://support.stablecoin.z.com/hc/en-us/articles/60491926674585-GYEN-and-ZUSD-Wind-down-How-to-Redeem-Before-the-November-11-2026-Deadline> | GYEN and ZUSD deployments and 2026-11-11 wind-down |
| Angle | <https://angle.money/>; <https://developers.angle.money/overview/smart-contracts/mainnet-contracts> | EURA Ethereum deployment and 2027-03-01 wind-down note |
| STASIS | <https://github.com/STASISNET/STASIS-EURS-token-smart-contract> | EURS Ethereum deployment and decimals |
| Monerium | <https://docs.monerium.com/contracts-v2/>; <https://docs.monerium.com/tokens/> | EURe v1/v2 deployments, legacy support, replacement relation |
| Uniswap | <https://developers.uniswap.org/docs/ecosystem/governance/technical-reference> | UNI Ethereum deployment |
| Chainlink | <https://docs.chain.link/resources/link-token-contracts> | LINK Ethereum deployment |
| LFJ | <https://docs.lfj.gg/lfj-dex/contracts> | JOE Avalanche deployment |

## Mayan Swift v2 native USDC source packet (2026-09-17)

The separate [`mayan-swift-v2-usdc-2026-09-17.json`](./evidence/mayan-swift-v2-usdc-2026-09-17.json)
packet records the reviewed native USDC bindings and bounded provider
observations. It adds only Ethereum mainnet and Solana mainnet directions:
`deployment-0008` (`0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`) and
`deployment-0010` (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`). The
Ethereum provider mint `A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM` is
provider metadata; it is not an Ethereum token address. Solana provider
contract, mint, and origin metadata use the native USDC mint.

| Source | As of | Selected fact or role |
| --- | --- | --- |
| <https://developers.circle.com/stablecoins/usdc-contract-addresses> | 2026-09-17 | Native USDC Ethereum and Solana deployment facts |
| <https://docs.mayan.finance/integration/quote-api> | 2026-09-17 | Closed quote/build request and response fields |
| <https://docs.mayan.finance/architecture/swift> | 2026-09-17 | Swift solver, relayer, and messaging context |
| <https://github.com/mayan-finance/swap-sdk/tree/c4c98031aaad9264d17630d7b4de0cb18688cf78> | 2026-09-17 | Pinned public SDK and address observations; no source copied |
| <https://github.com/mayan-finance/tx-builder/tree/e966f16a155cd9091b02ef5d9b91c3f837c228ad> | 2026-09-17 | Pinned builder envelope and direct selector observations |

Rydia's bounded public observations at 2026-09-17T09:04Z returned HTTP 200
for all four exact EURC/USDC Swift V2 non-gasless quote directions. Four
hosted keyless build observations returned HTTP 401 `UNAUTHORIZED`; no
authenticated build or settlement evidence was captured, and the deployed
provider revision is unknown. The direct USDC routes therefore keep the six
dependencies `mayan-hosted-quote-api`, `mayan-hosted-transaction-builder`,
`swift-auction-solvers`, `relayers`, `wormhole-guardian-messaging`, and
`mayan-explorer-indexer`; the EURC source-swap builder and Jupiter dependency
are not inherited. This is engineering evidence, not a publication or legal
clearance claim.

## Discovery and ranking source packet (2026-09-16)

The bounded primary-source index for the default RPC discovery and ranking
implementation is [`evidence/discovery-ranking-sources-2026-09-16.json`](./evidence/discovery-ranking-sources-2026-09-16.json).
It records the pinned protocol refs, official license notice observations,
layout and ABI fact roles, non-reuse boundaries, RPC bytecode distinction, and
the prior EU OSS planning decisions. It is engineering source evidence only;
it does not add canonical records or assert a clean integration run, source
commit, counts, digest, live workflow success, legal clearance, or CE status.

## Populated local integration evidence (2026-09-16)

The source checkout was then captured from commit
`5ef97abd66f40a2db77a4f85595cf64d1032f7c8` (tree
`0e85ceaf0ab954d5bd1b8f48088c1a5b8e25bc39`) with plain bounded RPC
collection. The local review admitted 5 token candidates and 8 pool
candidates, produced 11 ranking records, and retained 54 explicit unranked
rows. The token, DEX, and ranking candidate digests are
`5a7ed7f57a8cfaed87c46512586da8123e94fae80f1ce18ebb3861ccb95a9f70`,
`a0268a45d2b037ab8ea35aad1c45366d2582cbc9b10681ded590b56e07b011c8`, and
`f8ae479007fa782995aaaf6aa1c414ba1b6a10a92b7abe481b055293a91ac01c`.

The factual review and hashes are in
[`evidence/discovery-ranking-review-2026-09-16.json`](./evidence/discovery-ranking-review-2026-09-16.json),
with raw receipts in
[`evidence/discovery-receipts-2026-09-16.json`](./evidence/discovery-receipts-2026-09-16.json),
[`evidence/ranking-receipts-2026-09-16.json`](./evidence/ranking-receipts-2026-09-16.json),
and [`evidence/pool-observations-2026-09-16.json`](./evidence/pool-observations-2026-09-16.json).
Execution origin is `local`; GitHub run IDs are absent, so this is not Actions
promotion provenance. The source snapshot remains partial and the final
independent/native/remote gates remain pending.

## Runtime source-check behavior

The source-checkout discovery implementation is bounded and reads only the
configured Ethereum, Avalanche C-Chain, and Solana RPC endpoints described in
[`discovery-config.json`](./discovery-config.json). It verifies address facts
before producing proposals. Newly observed tokens deliberately remain
`unclassified`, use their address as the name and symbol, and leave
`stableCurrency`, `underlyingAssetId`, and `economicReferenceAssetId` as
`null` until a later source review assigns those fields. Existing public IDs
and aliases are append-only; an outage does not retire a record.

The ranking source uses the native total-supply × direct-native-pool-price
metric in exact rational native atomic units. This is not circulating market
capitalization. Partial coverage and unranked reasons remain explicit. The
optional global USD market-cap metric is disabled by default and requires
rights-cleared address mappings; no vendor market-cap dataset is redistributed
by the runtime. The default path uses original RPC facts and independent SDK
arithmetic rather than an external vendor data feed.

## Network and RPC evidence

When ranking captures are run, they use original RPC facts only. EVM ranking
anchors are finalized EIP-1898 blocks; Ethereum permits the reviewed
1,800-second finalized age window, while Avalanche uses 120 seconds. Solana
captures use finalized `minContextSlot` reads with a bounded 64-slot spread and
retain every related
account context slot. The approved ranking source IDs and floors are recorded
in [`ranking-config.json`](./ranking-config.json). A ranking receipt is an
engineering observation, not a claim of complete market coverage.

The root packet [`/private/tmp/erpc-token-root-rpc-evidence.json`](./evidence/token-catalog-2026-09-15.json) contains 17 detailed pinned receipts. The all-RPC packet [`/private/tmp/erpc-token-all-rpc-evidence.json`](./evidence/token-catalog-2026-09-15.json) contains 57 independently checked contract or mint rows with zero failures plus three native units. Both packets, their SHA-256 hashes, and their captured JSON are copied into the persisted evidence file.

The observed network identities are Ethereum `eip155:1`, Avalanche C-Chain `eip155:43114`, and Solana `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. EVM checks used `eth_getCode`, `decimals()`, `symbol()`, and `chainId` at pinned blocks; Solana checks used `getAccountInfo` with token-program and decimals parsing plus `getGenesisHash`. Additional observations used Ethereum block `0x18c7852`, Avalanche block `0x5aee016`, and Solana slot `447257739`.

The captured rows intentionally preserve network-specific decimals: EURCV is 18 on Ethereum and 2 on Solana Token-2022; FDUSD is 18 on Ethereum and 6 on Solana; USDP is 18 on Ethereum and 6 on Solana Token-2022. Native units have no fake address.

## Native parity receipt

On 2026-09-15, the compiled TypeScript, Rust, Python, Go, and Ruby package exports were captured and checked with [`verify-token-parity.mjs`](./verify-token-parity.mjs). That historical catalog digest is `62879dfe8bb49a154d2a1bff356321e5dbe78d8cef0cd3409ef2b22cfd3445a4`; each language supplied 39 assets, 60 deployments, 60 aliases, and 338 public-API query rows. The populated 2026-09-16 snapshot has 44 assets, 65 deployments, and 65 aliases; the recorded five-language token, DEX, and ranking parity captures pass, while remote CI remains pending.

The capture corrected `asset-0015` from `Pax Dollar (PYUSD)` to `PayPal USD (PYUSD)` using <https://www.paypal.com/uk/cshelp/article/what-is-paypal-usd-pyusd-help1005>. Existing addresses and decimals were unchanged.

## Open source planning evidence

This is an engineering packet, not legal advice or a certification. Applicability, company legal role, product classification, support commitments, and compliance status are all `UNDETERMINED`. No blanket data-license clearance is asserted. The consulted planning sources are:

- <https://digital-strategy.ec.europa.eu/en/policies/cra-open-source>
- <https://eur-lex.europa.eu/legal-content/EN-FR/ALL/?uri=CELEX%3A01996L0009-20190606>
- <https://github.com/aave-dao/aave-address-book>
- <https://github.com/sky-ecosystem/spells-mainnet>

The Aave address book MIT notice was inspected for selected source facts only. Sky facts were selected without copying third-party code, logos, prose, or a bulk database; STASIS root licensing and code-usage rights remain unestablished. Most issuer website terms remain unreviewed. Engineering owner is Root/Rydia, legal owner is a TBD human assignment, and the next manual review is 2026-10-15 or earlier on a material event.

## Gaps

The following are deliberately outside the closed evidence set: USDT.e and DAI.e Avalanche exact addresses and lifecycle, LFRAX/frxUSD migrations, EUROe exact deployment provenance, EURI issuer address provenance, JPYC Prepaid, Solana USDe, Avalanche PYUSD/RLUSD, and USD1/USD0/crvUSD/LUSD/TUSD/USDD/USDtb. No ranking or complete stablecoin coverage should be inferred from this list.
