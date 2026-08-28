import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const typescriptSolana = await readFile(
  new URL('packages/typescript/src/rpc/solana.ts', root),
  'utf8',
)
const typescriptEthereum = await readFile(
  new URL('packages/typescript/src/rpc/ethereum.ts', root),
  'utf8',
)
const typescriptSubscriptions = await readFile(
  new URL('packages/typescript/src/subscriptions.ts', root),
  'utf8',
)
const rustSolana = await readFile(
  new URL('packages/rust/src/solana.rs', root),
  'utf8',
)
const rustEthereum = await readFile(
  new URL('packages/rust/src/ethereum.rs', root),
  'utf8',
)

const quotedValues = (body) =>
  [...body.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1])

const typescriptCatalog = (source, name) => {
  const body = source.match(
    new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`),
  )?.[1]
  if (!body) throw new Error(`Unable to read TypeScript catalog ${name}`)
  return quotedValues(body)
}

const rustCatalog = (source, name) => {
  const body = source.match(
    new RegExp(`pub const ${name}:[^=]+=\\s*&\\[([\\s\\S]*?)\\];`),
  )?.[1]
  if (!body) throw new Error(`Unable to read Rust catalog ${name}`)
  return quotedValues(body)
}

const catalogs = [
  ['ETHEREUM_RPC_METHODS', typescriptEthereum, rustEthereum],
  ['ETHEREUM_SUBSCRIPTION_METHODS', typescriptEthereum, rustEthereum],
  ['SOLANA_RPC_METHODS', typescriptSolana, rustSolana],
  ['SOLANA_DAS_METHODS', typescriptSolana, rustSolana],
  ['SOLANA_HISTORY_METHODS', typescriptSolana, rustSolana],
  ['SOLANA_LEADER_METHODS', typescriptSolana, rustSolana],
  ['SOLANA_ANALYTICS_METHODS', typescriptSolana, rustSolana],
  [
    'SOLANA_ENHANCED_SUBSCRIPTION_METHODS',
    typescriptSubscriptions,
    rustSolana,
  ],
]

for (const [name, typescript, rust] of catalogs) {
  const expected = typescriptCatalog(typescript, name)
  const actual = rustCatalog(rust, name)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${name} differs between TypeScript and Rust:\n` +
        `TypeScript: ${expected.join(', ')}\nRust: ${actual.join(', ')}`,
    )
  }
}

console.log(`Verified ${catalogs.length} TypeScript and Rust method catalogs.`)
