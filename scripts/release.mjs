import { spawnSync } from 'node:child_process'

const requested = process.argv[2]
if (!requested) {
  throw new Error('Usage: corepack pnpm release -- <version>')
}
const version = requested.replace(/^v/, '')
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('Release version must use stable X.Y.Z format')
}
const tag = `v${version}`

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed`)
  }
  return result
}

run(process.execPath, ['scripts/verify-release.mjs', tag])

const status = run('git', ['status', '--porcelain'], { capture: true })
if (status.stdout.trim()) {
  throw new Error('Release requires a clean working tree')
}
const branch = run('git', ['branch', '--show-current'], { capture: true })
  .stdout.trim()
if (branch !== 'main') throw new Error('Release tags must be created from main')

run('git', ['fetch', '--prune', 'origin', 'main'])
const head = run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout.trim()
const remoteHead = run('git', ['rev-parse', 'origin/main'], {
  capture: true,
}).stdout.trim()
if (head !== remoteHead) {
  throw new Error('Local main must exactly match origin/main')
}

const localTag = run('git', ['rev-parse', '--verify', `refs/tags/${tag}`], {
  allowFailure: true,
  capture: true,
})
if (localTag.status === 0) throw new Error(`Local tag ${tag} already exists`)
const remoteTag = run(
  'git',
  ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`],
  { allowFailure: true, capture: true },
)
if (remoteTag.status === 0) throw new Error(`Remote tag ${tag} already exists`)
if (remoteTag.status !== 2) throw new Error('Unable to inspect remote tags')

run('corepack', ['pnpm', 'release:check'])
run('git', ['tag', '-a', tag, '-m', `ERPC SDK ${version}`])
run('git', ['push', 'origin', `refs/tags/${tag}`])

console.log(
  `${tag} was pushed. The protected release workflow will publish both packages.`,
)
