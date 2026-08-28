export const parseReleaseArgument = (arguments_) => {
  const values = arguments_[0] === '--' ? arguments_.slice(1) : arguments_
  if (values.length !== 1) {
    throw new Error('Usage: corepack pnpm release -- <version>')
  }

  const version = values[0].replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Release version must use stable X.Y.Z format')
  }

  return { tag: `v${version}`, version }
}
