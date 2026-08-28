import { appendFile, readFile } from 'node:fs/promises'

const registry = process.argv[2]
if (registry !== 'npm' && registry !== 'crates') {
  throw new Error('Registry must be npm or crates')
}

const packageJson = JSON.parse(
  await readFile(
    new URL('../packages/typescript/package.json', import.meta.url),
    'utf8',
  ),
)
const version = packageJson.version
let published

if (registry === 'npm') {
  const url =
    'https://registry.npmjs.org/' + encodeURIComponent(packageJson.name)
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 404) published = false
  else if (!response.ok) {
    throw new Error(`Unable to inspect npm: HTTP ${response.status}`)
  } else {
    const metadata = await response.json()
    published = Object.hasOwn(metadata.versions ?? {}, version)
  }
} else {
  const response = await fetch(
    'https://crates.io/api/v1/crates/erpc-sdk/versions',
    {
      headers: { accept: 'application/json', 'user-agent': 'erpc-sdk-release' },
      signal: AbortSignal.timeout(15_000),
    },
  )
  if (response.status === 404) published = false
  else if (!response.ok) {
    throw new Error(`Unable to inspect crates.io: HTTP ${response.status}`)
  } else {
    const metadata = await response.json()
    published = (metadata.versions ?? []).some(
      (candidate) => candidate.num === version,
    )
  }
}

if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `published=${String(published)}\nversion=${version}\n`,
  )
}
console.log(
  `${registry} version ${version} is ${published ? 'already published' : 'available'}.`,
)
