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

## Network and RPC evidence

The root packet [`/private/tmp/erpc-token-root-rpc-evidence.json`](./evidence/token-catalog-2026-09-15.json) contains 17 detailed pinned receipts. The all-RPC packet [`/private/tmp/erpc-token-all-rpc-evidence.json`](./evidence/token-catalog-2026-09-15.json) contains 57 independently checked contract or mint rows with zero failures plus three native units. Both packets, their SHA-256 hashes, and their captured JSON are copied into the persisted evidence file.

The observed network identities are Ethereum `eip155:1`, Avalanche C-Chain `eip155:43114`, and Solana `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. EVM checks used `eth_getCode`, `decimals()`, `symbol()`, and `chainId` at pinned blocks; Solana checks used `getAccountInfo` with token-program and decimals parsing plus `getGenesisHash`. Additional observations used Ethereum block `0x18c7852`, Avalanche block `0x5aee016`, and Solana slot `447257739`.

The captured rows intentionally preserve network-specific decimals: EURCV is 18 on Ethereum and 2 on Solana Token-2022; FDUSD is 18 on Ethereum and 6 on Solana; USDP is 18 on Ethereum and 6 on Solana Token-2022. Native units have no fake address.

## Native parity receipt

On 2026-09-15, the compiled TypeScript, Rust, Python, Go, and Ruby package exports were captured and checked with [`verify-token-parity.mjs`](./verify-token-parity.mjs). The final catalog digest is `62879dfe8bb49a154d2a1bff356321e5dbe78d8cef0cd3409ef2b22cfd3445a4`. Each language supplied 39 assets, 60 deployments, 60 aliases, and 338 public-API query rows; every language also passed 60 compiled alias-constant checks. The exact commands, runtime versions, artifact hashes, snapshot hashes, and `status=ok` result are persisted in [`evidence/token-catalog-2026-09-15.json`](./evidence/token-catalog-2026-09-15.json) and `/private/tmp/erpc-token-native-snapshots/PROVENANCE.md`. The snapshot runtime marker is descriptive metadata; the commands and artifact hashes document the actual runs.

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
