# Public compliance and release evidence

As of **2026-10-25** (Europe/Amsterdam). This is a dated evidence index for
consumers and contributors. It is planning evidence, not legal advice, a
conformity assessment, a CE declaration, or a certification. The repository
does not issue its own CRA compliance conclusion.

## Decision status

| Required field | Status | Boundary |
| --- | --- | --- |
| Applicability status | **UNDETERMINED** | Commercial supply, monetisation, responsibility, and product arrangement require a responsible human assessment. |
| Company legal role | **UNDETERMINED** | Manufacturer, statutory open-source software steward, contributor, or another role has not been decided. |
| Product classification | **UNDETERMINED** | The distributed product or component and its intended purpose need factual assessment. |
| Support commitments | **CONFIRMED / OPEN** | `SECURITY.md` records confirmed operational response and fix targets, payment-neutral priority, equal public fix availability, latest-published-version-per-language scope, and separately agreed backports. Fixed support duration, expected-use basis, and contract-specific terms remain open for human confirmation. |
| Compliance status | **UNDETERMINED** | The evidence below does not establish legal conformity, CE marking, or certification. |
| Primary sources and as-of date | Official law excerpts and current Commission/ENISA pages checked **2026-10-25** | Source limits and the distinction between law, guidance, and repository evidence are recorded below. |

The primary legal reference is [Regulation (EU) 2024/2847](https://eur-lex.europa.eu/eli/reg/2024/2847/oj),
including Articles 2, 3, 13, 14, 24, 69, and 71 and the relevant annexes. The
consolidated [EUR-Lex document](https://eur-lex.europa.eu/eli/reg/2024/2847/2024-11-20/eng)
and official indexed excerpts were checked on 2026-10-25; a direct full-text
open was limited by a JavaScript challenge, so this was not an end-to-end
statutory audit. The [Commission open-source guidance](https://digital-strategy.ec.europa.eu/en/policies/cra-open-source)
was updated 2026-10-15. The [Commission reporting page](https://digital-strategy.ec.europa.eu/en/policies/cra-reporting)
was checked 2026-10-25, and the [ENISA SRP FAQ](https://www.enisa.europa.eu/topics/product-security/vulnerability-services/eu-incident-response-and-cyber-crisis-management/single-reporting-platform-srp/frequently-asked-questions)
was updated 2026-10-15. Commission implementation guidance dated
2026-07-27 is non-binding.

## Confirmed operational evidence

The human-confirmed operating facts recorded on **2026-10-25** are that
ELSOUL LABO B.V. operates the repository, its public website is
<https://labo.elsoul.nl>, and `labo@elsoul.nl` is for general inquiries only.
The SDK is free and supports configured RPC URLs from other providers; any
charges are for ERPC services, while the SDK itself is free. The company
continues SDK development, releases, and vulnerability fixes. Ordinary
inquiries prioritize enterprise users, with free-user support also planned and
no ordinary-inquiry SLA stated.

The [security policy](../../SECURITY.md) records the confirmed operational
response and remediation targets, payment-neutral security priority, equal
public fix availability for free and paid users, and latest-published-version
scope for each language package. These facts are intended practice, not proof
of achieved response performance, completed review, a guaranteed SLA, a fixed
support duration, or a formal ISMS approval. Public SDK documentation approval
is separate from formal company ISMS approval; no ISMS effective date,
signature, or approval-register entry is asserted here. Suspected
vulnerabilities use the existing [GitHub private reporting channel](https://github.com/elsoul/erpc-sdk/security/advisories/new).

### Conditional reporting context

These dates are source-backed planning context, not a classification or an
instruction to file. A responsible human must determine whether a relevant
role and trigger apply and must authorize any contact with an authority.

- Commission material states that manufacturer Article 14 reporting applies
  from **2026-09-11**. If that duty applies, early warning and notification are
  assessed from awareness, with stated outer limits of 24 and 72 hours.
- Current ENISA guidance states that statutory open-source software steward
  Article 24(3) reporting applies from **2027-12-11**, within its narrower
  scope, using the same warning and notification timing once applicable.
- Final-report timing is conditional on the applicable duty and event: up to
  14 days after a corrective or mitigating measure for an actively exploited
  vulnerability, or one month after the 72-hour notification for a severe
  incident. Preserve awareness time and escalate a potential trigger promptly;
  the company operating targets do not defer a potentially applicable legal
  reporting clock, and this page does not create a public response SLA.

## Evidence index

All dates in this table refer to the repository and release observations checked
on **2026-10-25**, unless a linked source states its own date.

| Evidence | Location | As of | Status / limits |
| --- | --- | --- | --- |
| Five-language package and bounded release inventory | [README package table](../../README.md), [TypeScript manifest](../../packages/typescript/package.json), [Rust manifest](../../packages/rust/Cargo.toml), [Python manifest](../../packages/python/pyproject.toml), [Go module](../../packages/go/go.mod), [Ruby gemspec](../../packages/ruby/erpc-sdk.gemspec) | 2026-10-25 | All five packages are published at `0.11.0` (Go module `v0.11.0`); the bounded matrix does not establish universal API, signing, provider, swap, or bridge parity. |
| Component licenses and notices | [Root MIT license](../../LICENSE), [NOTICE](../../NOTICE), [TypeScript notices](../../packages/typescript/THIRD_PARTY_NOTICES.md), [Rust notices](../../packages/rust/THIRD_PARTY_NOTICES.md), [Python notices](../../packages/python/THIRD_PARTY_NOTICES.md), [Go notices](../../packages/go/THIRD_PARTY_NOTICES.md), [Ruby notices](../../packages/ruby/THIRD_PARTY_NOTICES.md), with each package's linked `LICENSES/` files | 2026-10-25 | Root SDK source is MIT. Rust `0.11.0` declares MIT AND Apache-2.0; the four non-Rust packages declare MIT AND Apache-2.0 AND BSD-3-Clause. These are component records, not a complete legal audit or a blanket MIT-only distribution. |
| Dependency inventory inputs | [pnpm lockfile](../../pnpm-lock.yaml), [Cargo lockfile](../../Cargo.lock), [Go module files](../../packages/go/go.mod), [Go sums](../../packages/go/go.sum), [Ruby lockfile](../../packages/ruby/Gemfile.lock), [Python manifest](../../packages/python/pyproject.toml) | 2026-10-25 | Manifests and lockfiles are useful inputs. They are not a complete distribution SBOM and do not prove that every bundled, generated, transitive, or build component was captured. |
| Private reporting and repository controls | [Security policy](../../SECURITY.md), [hygiene checker](../../scripts/check-oss-hygiene.sh), [Gitleaks wrapper](../../scripts/run-gitleaks.sh), [CI workflow](../../.github/workflows/ci.yml) | 2026-10-25 | Private reporting, secret scanning, and push protection were observed enabled. Dependabot security updates were observed disabled. Pattern scanners and settings observations do not prove absence of secrets or vulnerabilities. |
| Confirmed operator, product, and monetisation facts | [Governance](../../GOVERNANCE.md), [Security policy](../../SECURITY.md) | 2026-10-25 | ELSOUL LABO B.V., the public website, general-inquiry boundary, free SDK with configured alternative-provider RPC URLs, ERPC service charges, continuing maintenance, and planned ordinary support are confirmed company facts. They do not decide legal role, CRA applicability, product class, or a fixed support duration. |
| Confirmed security response and version scope | [Security policy](../../SECURITY.md) | 2026-10-25 | Operational acknowledgment, triage, remediation-goal, monthly-review, payment-neutrality, equal-public-fix, and latest-published-version-per-language practice is confirmed; targets are not a guaranteed SLA or legal clock, and older-version backports require separate agreement. |
| Published release and package proofs | [non-rust-v0.11.0 release](https://github.com/elsoul/erpc-sdk/releases/tag/non-rust-v0.11.0), [release-set proof manifest](https://github.com/elsoul/erpc-sdk/releases/download/non-rust-v0.11.0/release-set-proof-manifest.json), [npm proof](https://github.com/elsoul/erpc-sdk/releases/download/non-rust-v0.11.0/npm-proof.json), [PyPI proof](https://github.com/elsoul/erpc-sdk/releases/download/non-rust-v0.11.0/pypi-proof.json), [RubyGems proof](https://github.com/elsoul/erpc-sdk/releases/download/non-rust-v0.11.0/rubygems-proof.json), [Rust proof](https://github.com/elsoul/erpc-sdk/releases/download/non-rust-v0.11.0/rust-proof.json), [Go proof](https://github.com/elsoul/erpc-sdk/releases/download/non-rust-v0.11.0/go-proof.json), [tag proof](https://github.com/elsoul/erpc-sdk/releases/download/non-rust-v0.11.0/tag-proof.json), [Go inventory](https://github.com/elsoul/erpc-sdk/releases/download/non-rust-v0.11.0/go-inventory.json) | 2026-10-25 observation of the 2026-10-24 release | The release has 13 observed assets: four non-Rust archives, six JSON receipts, the proof manifest, Go inventory, and release body. It has no SBOM, minisign file, standalone checksum file, or universal artifact signature. Receipt fields have package-specific scope; they are not legal proof. |
| Product and release boundaries | [README scope](../../README.md), [release body](https://github.com/elsoul/erpc-sdk/releases/download/non-rust-v0.11.0/release-body.md), [bridge capability guide](../../registry/BRIDGE.md) | 2026-10-25 | The release describes common data across five SDKs, configured-RPC and local swap quote/route/build logic, and no hosted Jupiter or 0x dependency. Bridge integrations have separate provider dependencies and bounded reviewed routes; the published `0.11.0` package guides cover Mayan adapter/local unsigned construction, while the new chain read matrix does not expand bridge capabilities. |
| Release process and authority | [Release procedures](../../docs/RELEASING.md), [contribution policy](../../CONTRIBUTING.md), [verification guide](../verify-release.md) | 2026-10-25 | Human approval remains required. The release procedures contain historical candidate passages; use the current release evidence and README for public status. Weekly release work is future work. |

## License and release interpretation

The release body records that the four non-Rust `0.11.0` packages use the
aggregate expression `MIT AND Apache-2.0 AND BSD-3-Clause`, while the reused
Rust `0.11.0` crate retains `MIT AND Apache-2.0`. Read the exact component
notices and license files linked above for the package being distributed.

The proof manifest records receipt and workflow metadata. The package-specific
proofs record the scope of npm, PyPI, RubyGems, Rust, Go, and tag observations;
they do not turn every artifact into a universally signed artifact. The
[release verification guide](../verify-release.md) explains which digest field
belongs to each package and how Go's module evidence differs from a raw archive
hash.

A complete distribution SBOM, an all-language reproducible-build result, and
universal artifact-signature coverage have not been verified for this release.
Dependency manifests and lockfiles are inventory inputs. SBOM generation,
dependency-review coverage, expanded signing, and reproducibility experiments
are separate future work with a human owner still required.

## Open evidence and review register

| Gap or decision | Owner | Due date | Next review / closure evidence |
| --- | --- | --- | --- |
| Legal applicability, company role, and product class | Responsible company human — **TBD — human assignment required** | **TBD — human assignment required** | Manual checkpoint proposed for 2026-11-25, or earlier on a distribution or monetisation change; record the factual decision privately. |
| Support duration, expected-use basis, and contract-specific terms | Responsible company human — **TBD — human assignment required** | **TBD — human assignment required** | 2026-11-25 manual checkpoint or the next relevant release; human-confirmed support-period and contract records if adopted. |
| Incident authority and reporting readiness | Company security process for immediate escalation; regulatory authority and reportability decision — **TBD — human assignment required** | Immediate escalation for a potential live trigger; planning date **TBD — human assignment required** | Private operational owner/contact route, awareness timestamp, role/reportability decision, and deadline tracker. |
| Complete distribution SBOM | Release/security owner; accountable human **TBD — human assignment required** | **TBD — human assignment required** | Artifact-bound machine-readable inventories with scope, coverage, retention, and publication decision. |
| Dependency-review coverage | Language and release owners; accountable human **TBD — human assignment required** | **TBD — human assignment required** | Dated coverage and findings with exceptions and owners; secret scanning is not a dependency review. |
| Signature and reproducibility coverage | Release engineering owner; accountable human **TBD — human assignment required** | **TBD — human assignment required** | Independently checked per-artifact provenance/signature and build-comparison results. |
| Stale release/candidate passages | Existing release-document owners | Before relying on those passages as current evidence | Approved correction or explicit historical label; no package republish implied. |

Review this page manually on **2026-11-25** or earlier when a release,
security event, distribution or monetisation change, support commitment, or
official source update makes the evidence stale. No automation or regulatory
filing is created by this page.
