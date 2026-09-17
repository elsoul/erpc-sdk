# Signing and broadcasting reviewed transactions

`@elsoul/erpc-sdk` does not own a wallet. Its `ErpcClient` configuration has no
private-key, wallet, or signer field, and importing the package performs no
network request. The swap and Mayan bridge APIs return unsigned transaction
envelopes. Your application owns the approval screen, account selection,
allowance changes, nonce and fee policy, key custody, signing, broadcast, and
confirmation policy.

The `from`, `sender`, `swapperAddress`, and `feePayer` values in an envelope are
public addresses. They identify the account that must sign; they do not grant
the SDK signing authority. An eRPC API key, a direct-RPC header, and a Mayan
builder key authenticate services. They are separate from a wallet private
key.

This page shows two small application integrations. The EVM example uses
`ethers` 6 and the Solana example uses `@solana/web3.js` 1.x. Those libraries
are optional consumer dependencies; they are not runtime dependencies of
`@elsoul/erpc-sdk`. The functions below are application helpers, not exports
from the SDK.

## Transaction boundary

For an EVM DEX route, `prepareExactInputSwap` supplies
`prepared.transaction`. For a Mayan route, `buildUnsigned` supplies
`built.transaction`. Review the complete envelope and any allowance record
before passing the `EvmUnsignedEnvelope` or
`MayanSolanaUnsignedTransaction` to the helpers below. `EvmUnsignedEnvelope`
accepts both the public DEX preparation transaction (whose chain ID is a
runtime string) and a narrowed Mayan EVM transaction; the helpers still enforce
Ethereum mainnet at runtime.

The helpers take an already reviewed envelope and do nothing until the caller
invokes them. The EVM helper uses the same selected RPC URL for the external
provider's nonce, fee, and gas reads and for the ERPC transport, then broadcasts
signed bytes through ERPC. The Mayan or DEX build that produced the envelope
has already happened in the caller's flow. The Solana helper checks the cluster
identity, signs a v0 transaction, and sends base64 bytes through ERPC. Neither
helper submits a private key to ERPC or uses a wallet-owned send method.

The sequence is:

1. Obtain a fresh unsigned envelope from the SDK and review its chain, target,
   calldata, amount, recipient, allowance, and expiry.
2. Select one RPC URL and independently verify its network identity.
3. Let the caller's wallet or hardware signer approve and sign the reviewed
   bytes.
4. Broadcast the serialized signed bytes through the intended ERPC method.
5. Track the returned transaction identifier (hash or signature) separately. An accepted RPC
   response is not proof of confirmation or settlement.

## Initialized helpers

The following module is complete TypeScript. It reads credentials only when an
exported `...AfterReview` function is explicitly called. Replace the
environment and keypair-file setup with the caller's secret manager or wallet
adapter; never commit a private key, seed, or funded recipient to source.

```ts
import { readFile } from 'node:fs/promises'

import {
  createErpcClient,
  TOKEN_CHAIN_IDS,
  type ExactInputSwapPreparation,
  type MayanEvmUnsignedTransaction,
  type MayanSolanaUnsignedTransaction,
} from '@elsoul/erpc-sdk'
import { JsonRpcProvider, Wallet } from 'ethers'
import { Keypair, VersionedTransaction } from '@solana/web3.js'

const ETHEREUM_CHAIN_ID = TOKEN_CHAIN_IDS.ethereumMainnet
const SOLANA_CHAIN_ID = TOKEN_CHAIN_IDS.solanaMainnet
const SOLANA_MAINNET_GENESIS_HASH =
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

type EvmSigningInput = {
  readonly rpcUrl: string
  readonly privateKey: string
}

type SolanaSigningInput = {
  readonly rpcUrl: string
  readonly keypairFile: string
}

export type EvmUnsignedEnvelope =
  | MayanEvmUnsignedTransaction
  | ExactInputSwapPreparation['transaction']

const requiredText = (value: string, label: string): string => {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`${label} is required`)
  return normalized
}

export const requiredEnvironment = (name: string): string => {
  const value = process.env[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} is required`)
  }
  return value.trim()
}

export const signAndBroadcastEvm = async (
  envelope: EvmUnsignedEnvelope,
  input: EvmSigningInput,
): Promise<string> => {
  const rpcUrl = requiredText(input.rpcUrl, 'Ethereum RPC URL')
  const privateKey = requiredText(input.privateKey, 'Wallet private key')
  if (
    envelope.kind !== 'evm-unsigned-transaction' ||
    envelope.chainId !== ETHEREUM_CHAIN_ID
  ) {
    throw new Error('The envelope is not an Ethereum mainnet transaction')
  }

  const provider = new JsonRpcProvider(rpcUrl)
  const erpc = createErpcClient({
    ethereumRpc: { httpUrl: rpcUrl },
  })
  try {
    const providerNetwork = await provider.getNetwork()
    if (providerNetwork.chainId !== 1n) {
      throw new Error('The external EVM RPC is not Ethereum mainnet')
    }
    const erpcChainId = await erpc.ethereum.rpc.eth_chainId().send()
    if (BigInt(erpcChainId) !== 1n) {
      throw new Error('The ERPC Ethereum RPC is not Ethereum mainnet')
    }

    let wallet: Wallet
    try {
      wallet = new Wallet(privateKey, provider)
    } catch {
      throw new Error('The supplied wallet private key is invalid')
    }
    const walletAddress = await wallet.getAddress()
    if (walletAddress.toLowerCase() !== envelope.from.toLowerCase()) {
      throw new Error('The wallet address does not match the envelope sender')
    }

    // The envelope uses a decimal string. Keep the conversion explicit and
    // let ethers encode the same value in the signed transaction.
    const value = BigInt(envelope.value)
    const nonce = await provider.getTransactionCount(walletAddress, 'pending')
    const feeData = await provider.getFeeData()
    const feeFields =
      feeData.maxFeePerGas !== null && feeData.maxPriorityFeePerGas !== null
        ? {
            maxFeePerGas: feeData.maxFeePerGas,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
          }
        : feeData.gasPrice !== null
          ? { gasPrice: feeData.gasPrice }
          : null
    if (feeFields === null) throw new Error('The EVM RPC returned no fee data')

    const unsigned = {
      chainId: 1,
      nonce,
      from: walletAddress,
      to: envelope.to,
      data: envelope.data,
      value,
      ...feeFields,
    }
    const gasLimit = await provider.estimateGas(unsigned)
    const signed = await wallet.signTransaction({ ...unsigned, gasLimit })

    // Broadcast only through the selected ERPC transport. This call performs
    // the JSON-RPC request; the external Wallet performed the signing above.
    return await erpc.ethereum.rpc.eth_sendRawTransaction(
      signed as `0x${string}`,
    ).send()
  } finally {
    erpc.close()
    provider.destroy()
  }
}

const loadSolanaKeypair = async (keypairFile: string): Promise<Keypair> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(keypairFile, 'utf8'))
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      parsed.some(
        (value) =>
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > 255,
      )
    ) {
      throw new Error('invalid keypair bytes')
    }
    return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]))
  } catch {
    // Keep filesystem and parser details, including key material, out of the
    // application error and logs.
    throw new Error('The Solana keypair file is unreadable or invalid')
  }
}

export const signAndBroadcastSolana = async (
  envelope: MayanSolanaUnsignedTransaction,
  input: SolanaSigningInput,
): Promise<string> => {
  const rpcUrl = requiredText(input.rpcUrl, 'Solana RPC URL')
  const keypairFile = requiredText(input.keypairFile, 'Solana keypair file')
  if (
    envelope.kind !== 'solana-v0-unsigned-transaction' ||
    envelope.chainId !== SOLANA_CHAIN_ID
  ) {
    throw new Error('The envelope is not a Solana mainnet v0 transaction')
  }

  const keypair = await loadSolanaKeypair(keypairFile)
  const erpc = createErpcClient({
    solanaRpc: { httpUrl: rpcUrl },
  })
  try {
    const genesisHash = await erpc.solana.rpc.getGenesisHash().send()
    if (genesisHash !== SOLANA_MAINNET_GENESIS_HASH) {
      throw new Error('The Solana RPC is not the independently confirmed mainnet')
    }

    const feePayer = keypair.publicKey.toBase58()
    if (envelope.feePayer !== feePayer) {
      throw new Error('The keypair does not match the envelope fee payer')
    }

    let transaction: VersionedTransaction
    try {
      transaction = VersionedTransaction.deserialize(
        Buffer.from(envelope.transactionBase64, 'base64'),
      )
    } catch {
      throw new Error('The Solana envelope is not a valid serialized transaction')
    }
    if (transaction.version !== 0) {
      throw new Error('The Solana envelope is not a v0 transaction')
    }
    const messageFeePayer = transaction.message.staticAccountKeys[0]?.toBase58()
    if (messageFeePayer !== feePayer) {
      throw new Error('The serialized transaction fee payer does not match the keypair')
    }

    transaction.sign([keypair])
    const signedBase64 = Buffer.from(transaction.serialize()).toString('base64')

    // Do not use a wallet-owned or web3.js connection broadcast method.
    // ERPC is the only broadcast transport in this flow.
    return await erpc.solana.rpc.sendTransaction(
      signedBase64,
      { encoding: 'base64' },
    ).send()
  } finally {
    erpc.close()
  }
}

export const signAndBroadcastEvmAfterReview = async (
  envelope: EvmUnsignedEnvelope,
): Promise<string> =>
  signAndBroadcastEvm(envelope, {
    rpcUrl: requiredEnvironment('ERPC_ETHEREUM_RPC_URL'),
    privateKey: requiredEnvironment('WALLET_PRIVATE_KEY'),
  })

export const signAndBroadcastSolanaAfterReview = async (
  envelope: MayanSolanaUnsignedTransaction,
): Promise<string> =>
  signAndBroadcastSolana(envelope, {
    rpcUrl: requiredEnvironment('ERPC_SOLANA_RPC_URL'),
    keypairFile: requiredEnvironment('SOLANA_KEYPAIR_FILE'),
  })
```

`requiredEnvironment` is an example of the boundary where the caller supplies
configuration. It does not provide a default path or secret. The Solana loader
expects the standard JSON array of 64 integer bytes produced by the caller's
wallet tooling, and never prints or returns those bytes. A browser or hardware
wallet can replace the EVM `Wallet` or Solana `Keypair` signing step with its
own sign-only operation, then keep the final ERPC broadcast call.

The EVM helper asks the selected provider for a pending nonce, fee data, and a
gas estimate before signing. Review those values and the complete transaction
again before approval. The Solana helper uses the blockhash already present in
the reviewed v0 envelope; obtain a fresh Mayan build when it is stale. Neither
helper waits for confirmation, changes an allowance, refreshes an envelope,
or interprets provider acceptance as settlement.

The `JsonRpcProvider` and `Wallet` constructors and wallet signing methods are
documented in the [ethers v6 wallet API](https://docs.ethers.org/v6/api/wallet/)
and [ethers v6 JSON-RPC provider API](https://docs.ethers.org/v6/api/providers/jsonrpc/).
`Keypair.fromSecretKey`, `VersionedTransaction.deserialize`, `sign`, and
`serialize` are documented in the [web3.js 1.x Keypair API](https://solana-foundation.github.io/solana-web3.js/v1.x/classes/Keypair.html)
and [VersionedTransaction API](https://solana-foundation.github.io/solana-web3.js/v1.x/classes/VersionedTransaction.html).
The mainnet check uses the cluster's [getGenesisHash RPC method](https://solana.com/docs/rpc/http/getgenesishash).
The full genesis hash above is distinct from the shorter CAIP-2 Solana chain
reference used by `TOKEN_CHAIN_IDS.solanaMainnet`.

## Mayan authentication and the published package boundary

Mayan documents its quote and transaction-builder API key as optional in the
[official quote API documentation](https://docs.mayan.finance/integration/quote-api#api-key)
and in the pinned [transaction-builder authentication documentation](https://github.com/mayan-finance/tx-builder/blob/e966f16a155cd9091b02ef5d9b91c3f837c228ad/README.md#authentication).
That is the provider's documented policy; it is separate from this SDK's local
guard. The SDK's `buildUnsigned` requires `builderApiKey` by default and sends
that key only to `/build`. Setting `allowUnauthenticatedBuild: true` explicitly
permits a keyless HTTP attempt at the configured endpoint, but it does not
change the provider's policy. Quote and Explorer calls do not receive this key
or an eRPC key.

A dated keyless recheck at `2026-09-17T11:27:34Z` observed HTTP 200 for all
four EURC/USDC quote directions. Default builds made no network call because
the local guard stopped them. Explicit anonymous builds reached the hosted
`/build` endpoint and each returned HTTP 401. The provider deployment revision
was unknown, so this is a bounded observation rather than a universal or
permanent key requirement. There was no authenticated build or settlement
evidence.

The published TypeScript `0.8.0` bridge API covers issued EURC between
Ethereum and Solana. Native USDC direct routes are a source-tree addition and
remain unreleased; do not assume they are available from the `0.8.0` package.
