# Security policy

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/elsoul/erpc-sdk/security/advisories/new)
for suspected vulnerabilities. The private reporting channel was observed as
enabled on 2026-10-25; channel availability is a repository setting and can
change. Do not open a public issue for a suspected vulnerability, exposed
credential, customer data, or exploitable implementation detail.

Please include enough context for maintainers to reproduce the issue safely:

- language, package name, and version;
- runtime, operating system, and relevant configuration;
- impact, affected operation, and whether exploitation is suspected or was
  observed (include the approximate awareness time when known);
- a minimal reproduction, sanitized request/response or logs, and a suggested
  mitigation if available; and
- the release, commit, dependency, or external service involved, when known.

Redact API keys, access tokens, wallet or signing material, customer and victim
identifiers, private endpoints, and endpoint query tokens from the initial
report and all public channels. Never send a real secret as proof. If
unredacted or otherwise sensitive exploit evidence is necessary to reproduce
the issue, provide it only through the private channel and only with the
appropriate owner context; maintainers can request further private evidence
through that channel.

## Scope and service boundaries

This policy covers the five SDK packages, their shared catalogs and generated
common data, transport and unsigned-build logic, dependencies as integrated by
this repository, repository tooling, and released package or proof artifacts.
The SDK's configured RPC, local swap logic, and separate bridge-provider
boundaries are part of the report context where the SDK integration is affected.

Third-party nodes, RPC endpoints, bridge providers, registries, and other
external services may have their own reporting process. Their involvement does
not by itself discard a report about the SDK boundary. Describe the smallest
sanitized interaction that demonstrates the SDK impact and let the relevant
service owner handle its separate process.

## Triage and disclosure

Maintainers triage reports privately, assess affected packages and versions,
and coordinate a fix or mitigation and an advisory when appropriate. Severity
and exploitation determine vulnerability priority; payment does not. Public
OSS security fixes are made available to free and paid users at the same time.
Please allow coordination before publishing exploit details.

The operating targets for this process are:

- Aim to acknowledge a report within five Dutch business days, Monday through
  Friday excluding Dutch public holidays, using the Europe/Amsterdam calendar.
- Critical or actively exploited vulnerabilities receive immediate assessment.
- For other reports, assign severity, an owner, and a response deadline within
  seven calendar days from detection.
- Fix goals measured from detection are 14 calendar days for Critical, 30 for
  High, and 90 for Medium. Low has no fixed fix deadline and receives monthly
  review.

These are operational targets, not guaranteed service levels or legal reporting
deadlines. If a target cannot be met, the existing private exception-approval
process records the reason, mitigation, owner, and expiry. A mitigation is not
a completed fix, and an exception does not reset the detection or awareness
time. Private monthly review covers open vulnerabilities, Low items, overdue
work, status, priorities, and exception expiry.

If a report may involve active exploitation or a severe product-security
incident, preserve the original awareness time and escalate it immediately to
the responsible company human through the private process. Whether a legal
reporting duty or role applies remains an open company decision; see the
[public evidence index](docs/compliance/README.md). The operating targets do
not defer any potentially applicable legal reporting clock. This page does not
authorize a filing, public disclosure, repository-setting change, or release
action.

## Supported versions

Standard security fixes cover the latest published version of each language
package. Older-version backports require a separate agreement. This policy
does not define a fixed support duration, an LTS commitment, or a guaranteed
response time.

Observed published versions on 2026-10-25:

| Language | Package | Version | Note |
| --- | --- | --- | --- |
| TypeScript | `@elsoul/erpc-sdk` | `0.11.0` | Published |
| Rust | `erpc-sdk` | `0.11.0` | Immutable published crate reused from 2026-10-23 |
| Python | `erpc-sdk` | `0.11.0` | Published |
| Go | `github.com/elsoul/erpc-sdk/packages/go` | `v0.11.0` | Published module tag |
| Ruby | `erpc-sdk` | `0.11.0` | Published |

Availability and publication evidence do not establish a durable support
period or enterprise support term. Package-specific scope remains subject to
the policy above.

## Related guidance

- [Secret-exposure response](docs/secret-exposure-response.md) explains private
  containment and credential-owner actions.
- [Public compliance and release evidence](docs/compliance/README.md) records
  dated evidence and unresolved human decisions.
- [Release verification guide](docs/verify-release.md) describes read-only
  checks for the current published artifacts.
