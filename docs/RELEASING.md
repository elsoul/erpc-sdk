# Releasing `@elsoul/erpc-sdk`

Releases are human-approved and published from GitHub Actions. A merge to
`main` never publishes a package.

## Package identity

- npm package: [`@elsoul/erpc-sdk`](https://www.npmjs.com/package/@elsoul/erpc-sdk)
- GitHub repository: [`elsoul/erpc-sdk`](https://github.com/elsoul/erpc-sdk)
- release workflow: `.github/workflows/release.yml`
- GitHub Environment: `npm`

## One-time bootstrap

Trusted publishing is configured from an existing package's npm settings. If
the package does not exist yet, a human maintainer performs the first public
publish after inspecting the package:

The workspace root is intentionally private and cannot be published. Run the
final command from `packages/typescript` exactly as shown.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm test
corepack pnpm build
corepack pnpm pack:check
cd packages/typescript
npm publish --access public
```

`prepublishOnly` repeats the typecheck, unit tests, build, and package entry-point
inspection before npm accepts the publish.

Use interactive npm authentication or a short-lived granular credential with
the required organization permission and 2FA policy. Never commit npm
credentials or add a long-lived publishing token to GitHub Actions.

## Configure npm Trusted Publishing

After the first package version exists, open its npm settings and configure a
GitHub Actions trusted publisher with these exact values:

| Setting | Value |
| --- | --- |
| Organization or user | `elsoul` |
| Repository | `erpc-sdk` |
| Workflow filename | `release.yml` |
| Environment | `npm` |
| Allowed action | `npm publish` |

The workflow filename is only the filename, not `.github/workflows/release.yml`.
All values are case-sensitive.

Once the OIDC release succeeds, set npm publishing access to require 2FA and
disallow traditional tokens. Revoke any bootstrap publishing credential that
is no longer required.

## Configure the GitHub Environment

Create an environment named `npm` and configure:

- required human reviewers;
- prevention of self-review when the team policy requires two people;
- deployment limited to protected release tags;
- no `NPM_TOKEN` secret.

The release job cannot start until the environment approval succeeds.

## Publish a new version

1. Update `packages/typescript/package.json` to the new version.
2. Run `corepack pnpm install` to synchronize the lockfile.
3. Run the complete local validation suite.
4. Merge the reviewed version change.
5. A human creates a GitHub Release whose tag is exactly `v<package-version>`.
6. Approve the `npm` environment deployment.
7. Verify the package version and provenance on npm.

The workflow fails before publication when the tag does not match
`package.json`, the repository identity is wrong, or that version already
exists in the npm registry.

## Recovery

npm package versions are immutable. Fix a failed or incorrect release with a
new patch version. Do not reuse a published version number.
