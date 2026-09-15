# EU OSS compliance evidence runbook

_As of 2026-09-15. This is an operational evidence packet, not legal advice, a compliance certification, or a CE declaration._

## Current decision status

The following facts are **UNDETERMINED** and require a named responsible human to confirm:

| Decision | Status | Confirmation needed |
| --- | --- | --- |
| CRA applicability | UNDETERMINED | Product and distribution facts |
| Company legal role | UNDETERMINED | Manufacturer, OSS steward, contributor, or another role |
| Product classification | UNDETERMINED | Product with digital elements and any applicable class |
| Support commitments | UNDETERMINED | Expected use, support period, and customer commitments |
| Compliance status | UNDETERMINED | Current evidence, gaps, owner, and due dates |

The `eu-oss-compliance` agent prepares source-backed applicability, evidence, gap, owner, and review packets. Its software role does not establish Article 24 statutory open-source software steward status. It cannot certify legal compliance or CE conformity, write source code, own product paths, file with a regulator, disclose a vulnerability publicly, or cause a live effect. Edgar routes any implementation work. Explicit human authorization remains required for filings, disclosures, releases, and other external effects.

A named responsible human must confirm the classification, reportability, support commitments, owners, and dates before those facts are treated as decided.

## Classification questions

The Commission’s open-source guidance says that free and open-source software is in CRA scope when made available on the market and supplied for distribution or use in a commercial activity; non-monetised manufacturer provision and contributions outside the contributor’s responsibility are treated differently. Commercial activity, monetisation, supply, responsibility, and the actual product arrangement therefore need evidence. Do not infer an exemption or a duty from an MIT licence, a GitHub repository, or enterprise use alone. [Commission: Cyber Resilience Act — Open source](https://digital-strategy.ec.europa.eu/en/policies/cra-open-source)

Keep these roles separate while collecting facts:

- **Manufacturer:** the party placing a product with digital elements on the market and potentially carrying manufacturer obligations.
- **Open-source software steward:** a legal person other than the manufacturer that systematically supports development on a sustained basis for specific free and open-source products intended for commercial activities, and plays a main role in those products’ viability. The Commission description does not limit this category to non-profits. A maintainer or agent must not label itself a statutory steward without a human legal-role decision. [Commission: Open source](https://digital-strategy.ec.europa.eu/en/policies/cra-open-source)
- **Non-commercial FOSS or contributor:** a project or person whose distribution, monetisation, supply, and responsibility facts may differ from those of a manufacturer or steward. Record the facts and source rather than assuming a blanket exemption.

## Dates and incident triage

The Commission reporting page, updated 2026-09-11, states that manufacturer reporting applies from **2026-09-11** and open-source software steward reporting under Article 24(3), via Article 71(2), applies from **2027-12-11**. Manufacturers must submit an early warning within 24 hours and a full notification within 72 hours of becoming aware of an actively exploited vulnerability or severe incident affecting product security. For an actively exploited vulnerability, the final report is due no later than 14 days after a corrective measure is available; for a severe incident, it is due within one month of the 72-hour notification. This is a trigger-based process, not a requirement to report every CVE. Flag the responsible human as soon as a potential trigger is identified; never wait for a weekly release and never file without authorized human context. [Commission: CRA reporting obligations](https://digital-strategy.ec.europa.eu/en/policies/cra-reporting)

The Commission’s 2026-07-27 implementation guidance says the main CRA obligations apply from **2027-12-11** and labels that guidance non-binding. Use it to plan questions and evidence, then verify current law and obtain human confirmation before making a legal claim. [Commission: CRA implementation guidance](https://digital-strategy.ec.europa.eu/en/library/commission-publishes-new-guidance-support-timely-cyber-resilience-act-implementation)

## Local evidence baseline and open gaps

This is a bounded repository preflight, not a complete audit. The EUR-Lex automated fetch was blocked in this run, so the legal text was not read end to end. The accessible Commission pages and FAQ are planning evidence; the FAQ and guidance are non-binding and require current-law verification.

| Area | Evidence checked | Gap / next owner |
| --- | --- | --- |
| Five-language inventory | `docs/RELEASING.md` names TypeScript, Rust, Python, Go, and Ruby; package manifests and the inspected pnpm, Cargo, and Ruby lockfiles are present | Human confirms the in-scope product and distribution inventory; owner/date TBD — human assignment required |
| Licences | MIT root and package `LICENSE` files and manifest licence declarations are present | Confirm licence obligations and any third-party notices for the actual distribution; owner/date TBD — human assignment required |
| SBOM / dependencies | pnpm, Cargo, and Ruby lockfiles provide dependency inputs | No SBOM generation artifact or workflow was found in the inspected paths; this was not a full audit. Record readiness work without claiming a public SBOM or universal certification; owner/date TBD — human assignment required |
| Security process | `SECURITY.md` documents a private GitHub reporting path and preview-only supported-version language | The live private-reporting setting/channel was not verified; supported-version and enterprise/support-period decision remains open; owner/date TBD — human assignment required |
| Release provenance | `docs/RELEASING.md` describes human-approved five-language tag releases; the release workflow configures `npm publish --provenance` | Configuration is not proof of a published attestation or live environment approval; owner/date TBD — human assignment required |
| Support period | Repository does not establish a CRA applicability or SDK support-period policy | Do not promise a five-year SDK policy before applicability and expected-use decisions; owner/date TBD — human assignment required |

The Commission FAQ v1.4 (2026-09-04) describes third-party due diligence in §4.4 and does not make CE-marked components universally required. Section 4.5 describes manufacturer support generally of at least five years, with a shorter expected-use exception and a possible longer period where expected use is longer. Section 5.5 repeats the steward reporting date. These points are non-binding FAQ guidance; do not promise an SDK five-year policy without an applicability decision. [Commission CRA FAQ v1.4, 2026-09-04](https://ec.europa.eu/newsroom/dae/redirection/document/123307)

## Packet procedure and required output

For each release, security event, dependency/SBOM review, or applicability change:

1. State each decision as `UNDETERMINED`, `CONFIRMED`, or `OPEN — human confirmation required`; cite the primary source and its as-of date.
2. Record the product, distribution, monetisation, responsibility, support, and incident facts that support the proposed role. Separate manufacturer, steward, and contributor hypotheses.
3. Attach local evidence and list gaps. For a potential reporting trigger, flag the responsible human immediately with the facts and time of awareness. If reportability is confirmed, use the due-date field to track the applicable 24-hour, 72-hour, and final-report milestones.
4. Name the owner, due date, and next review. Use `TBD — human assignment required` when no owner or date has been assigned.
5. Send implementation requests through Edgar with the existing path owner and L3; this contributor does not replace them.

Normal paths keep their registry L2 and L3 owners. Unknown paths stay in fallback with El and Edgar triage; never invent an L3 owner.

Every packet must contain:

```text
Applicability status:
Company legal role:
Product classification:
Support commitments:
Compliance status:
Primary source(s) and as-of date:
Evidence:
Gaps:
Owner:
Due date:
Next review:
```

## Source limits and manual review

The primary law reference is [Regulation (EU) 2024/2847](https://eur-lex.europa.eu/eli/reg/2024/2847/oj), including Articles 2, 3, 13, 14, 24, and 71 and Annex I, Part II(1). An indexed official-law PDF excerpt indicates a commonly used machine-readable SBOM format with at least top-level dependencies. Treat SBOM capture as readiness work; do not claim that a public SBOM or certification is universally mandatory. The full statutory text was not audited in this run.

Set the next manual review marker to **2026-10-15**, or earlier when the next relevant release, security event, or applicability change occurs. This marker is deliberately manual; this setup creates no scheduled automation.
