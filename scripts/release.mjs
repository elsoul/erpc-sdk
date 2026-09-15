import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseReleaseArgument } from './release-version.mjs'

export const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url))

/**
 * Run a release command with the same capture/status contract as the original
 * CLI runner. Keeping this function injectable lets the release checks be
 * exercised with a fake git process without creating tags or contacting a
 * remote.
 */
export const defaultRunner = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed`)
  }
  return result
}

const invoke = (runner, command, args, options = {}) => {
  const result = runner(command, args, {
    cwd: REPOSITORY_ROOT,
    ...options,
  })
  if (result?.error && !options.allowFailure) throw result.error
  if ((result?.status ?? 0) !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed`)
  }
  return result ?? { status: 0, stdout: '', stderr: '' }
}

const output = result => String(result?.stdout ?? '').trim()

const gitOutput = (runner, args, options = {}) =>
  output(invoke(runner, 'git', args, { capture: true, ...options }))

const ensureCleanMainAtSha = (runner, expectedSha) => {
  const status = gitOutput(runner, ['status', '--porcelain'])
  if (status) throw new Error('Release requires a clean working tree')

  const branch = gitOutput(runner, ['branch', '--show-current'])
  if (branch !== 'main') throw new Error('Release tags must be created from main')

  const head = gitOutput(runner, ['rev-parse', 'HEAD'])
  if (expectedSha !== undefined && head !== expectedSha) {
    throw new Error(
      `Release source changed during validation: expected ${expectedSha}, found ${head}`,
    )
  }

  return head
}

const assertTagsAbsent = (runner, tags) => {
  for (const releaseTag of tags) {
    const localTag = invoke(
      runner,
      'git',
      ['rev-parse', '--verify', `refs/tags/${releaseTag}`],
      { allowFailure: true, capture: true },
    )
    if (localTag.status === 0) {
      throw new Error(`Local tag ${releaseTag} already exists`)
    }

    const remoteTag = invoke(
      runner,
      'git',
      ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${releaseTag}`],
      { allowFailure: true, capture: true },
    )
    if (remoteTag.status === 0) {
      throw new Error(`Remote tag ${releaseTag} already exists`)
    }
    if (remoteTag.status !== 2) throw new Error('Unable to inspect remote tags')
  }
}

export async function runRelease(args = process.argv.slice(2), runner = defaultRunner) {
  const { goTag, tag, version } = parseReleaseArgument(args)
  const tags = [tag, goTag]

  // Freeze a clean main checkout before identity verification. A fetch or any
  // other concurrent checkout change must never move the source being tagged.
  const sourceBeforeVerify = ensureCleanMainAtSha(runner)
  invoke(runner, process.execPath, ['scripts/verify-release.mjs', tag])

  invoke(runner, 'git', ['fetch', '--prune', 'origin', 'main'])
  const headAfterInitialFetch = gitOutput(runner, ['rev-parse', 'HEAD'])
  if (headAfterInitialFetch !== sourceBeforeVerify) {
    throw new Error(
      `Release source changed before validation: expected ${sourceBeforeVerify}, found ${headAfterInitialFetch}`,
    )
  }
  const initialFrozenSha = sourceBeforeVerify
  const remoteHead = gitOutput(runner, ['rev-parse', 'origin/main'])
  if (initialFrozenSha !== remoteHead) {
    throw new Error('Local main must exactly match origin/main')
  }

  assertTagsAbsent(runner, tags)

  // This is intentionally the long-running step. The source and release tags
  // are checked again below so a moving checkout cannot be released.
  invoke(runner, 'corepack', ['pnpm', 'release:check'])

  ensureCleanMainAtSha(runner, initialFrozenSha)
  invoke(runner, 'git', ['fetch', '--prune', 'origin', 'main'])
  const fetchedRemoteHead = gitOutput(runner, ['rev-parse', 'origin/main'])
  if (fetchedRemoteHead !== initialFrozenSha) {
    throw new Error(
      `origin/main changed during validation: expected ${initialFrozenSha}, found ${fetchedRemoteHead}`,
    )
  }

  // Recheck immediately before tag creation. Both tags must be absent in the
  // same final validation window; the push below remains one atomic operation.
  assertTagsAbsent(runner, tags)

  invoke(runner, 'git', [
    'tag',
    '-a',
    tag,
    '-m',
    `ERPC SDK ${version}`,
    initialFrozenSha,
  ])
  invoke(runner, 'git', [
    'tag',
    '-a',
    goTag,
    '-m',
    `ERPC Go SDK ${version}`,
    initialFrozenSha,
  ])
  invoke(runner, 'git', [
    'push',
    '--atomic',
    'origin',
    `refs/tags/${tag}`,
    `refs/tags/${goTag}`,
  ])

  console.log(
    `${tag} and ${goTag} were pushed. Tags pushed; inspect the release workflow to confirm publication.`,
  )
  return {
    goTag,
    tag,
    version,
    sourceSha: initialFrozenSha,
    frozenHead: initialFrozenSha,
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null

if (invokedPath !== null && import.meta.url === invokedPath) {
  runRelease().catch(error => {
    process.stderr.write(`release: ${error.message}\n`)
    process.exitCode = 1
  })
}
