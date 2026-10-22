export const wrapFetch = (
  implementation: typeof globalThis.fetch,
): typeof globalThis.fetch => (input, init) => implementation(input, init)
