# Secret-exposure response

Use this guide when an API key, access token, endpoint credential, wallet or
signing material, CI token, customer data, or other private value may have
entered a source file, log, issue, build, package, or release. Start with
private reporting and containment by the authorized credential owner, then
preserve the facts needed for maintainers to assess the SDK boundary.

## First response

1. **Report privately.** Use [GitHub private vulnerability reporting](https://github.com/elsoul/erpc-sdk/security/advisories/new)
   and do not post the value in an issue, pull request, commit, chat, or
   example. Include the language/package, version or release, location, likely
   scope, and an approximate discovery or awareness time.
2. **Contain at the issuer.** The authorized credential owner should revoke,
   disable, or rotate the credential with the issuing provider first. For a
   caller-owned RPC credential, wallet, or signing key, the caller or account
   owner follows that issuer's process; maintainers cannot rotate it on the
   owner's behalf. Do not move funds or sign a transaction as an incident
   shortcut.
3. **Preserve a minimal private timeline.** Record when the exposure was
   discovered, who was notified, which issuer action was taken, and which
   versions, artifacts, logs, or endpoints may contain it. Store sensitive
   facts only as redacted descriptions, non-secret identifiers, or a useful
   fingerprint; never copy the raw credential. Keep only necessary customer
   context under access control in the authorized private incident system, not
   in the repository.
4. **Inspect related exposure.** Check the relevant commit, branch, build,
   package, release asset, log, endpoint configuration, and access history with
   the credential owner. Keep secrets and customer data out of public
   materials; provide any additional sensitive evidence needed to reproduce the
   issue only through the private reporting channel. A provider or registry may
   need its own private report.
5. **Coordinate remediation.** Maintainers assess the SDK boundary, coordinate
   cleanup and a fix or mitigation, and decide with the authorized human
   owners whether an advisory or release update is appropriate.

## SDK-specific examples

Examples include an RPC authorization header or query token, a registry or CI
credential, a package-publishing token, an endpoint configuration containing a
secret, or caller-provided wallet and signing material. The SDK's configured
RPC and local unsigned-build paths do not give maintainers custody of caller
credentials or keys. Report the integration and sanitized request shape so the
maintainer can assess the SDK code without receiving the secret itself.

Keep public reproductions limited to sanitized request shapes, placeholder
credentials, and the smallest useful response or log excerpt. Never publish a
secret, customer data, or private endpoint query token. If a maintainer needs
more sensitive evidence to reproduce the issue, send it privately after the
report is established; public instructions must never require the secret as
evidence.

## History and release handling

Deleting a file or rewriting Git history does not revoke a credential or undo
copies that may already have been fetched, cached, mirrored, or included in an
artifact. Treat released bytes and existing tags as immutable evidence while
the authorized owners decide what follow-up is appropriate.

Force-push, history rewriting, yanking or replacing a package, changing a
repository setting, contacting a regulator, making a public disclosure, and
any live-funds action require case-specific human authorization. This guide
does not instruct anyone to take those actions. A documentation or release
change also does not publish a package.

## Scanning controls and limits

The repository runs the [OSS hygiene checker](../scripts/check-oss-hygiene.sh)
and the [Gitleaks wrapper](../scripts/run-gitleaks.sh) in its hooks and CI;
their tests and configuration are documented in
[CONTRIBUTING.md](../CONTRIBUTING.md). These tools check defined patterns and
rules with documented exclusions. A passing scan is useful evidence for the
checked content and history, but it is not proof that no secret or vulnerability
exists. Keep using private reporting when a scan, provider alert, or human
review reveals a possible exposure.

## Related documents

- [Security policy](../SECURITY.md)
- [Contributing](../CONTRIBUTING.md)
- [Governance](../GOVERNANCE.md)
- [Public compliance and evidence index](compliance/README.md)
