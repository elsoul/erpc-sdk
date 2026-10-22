# Codex project agents

This project uses the canonical registry at [.codex/agent-registry.json](.codex/agent-registry.json). Load only the selected persona profile in [.codex/agents](.codex/agents); never load the full roster.

## Work routing

Planning selects L1 and L2 contributors and attaches non-author gates; never dispatch L3. Implementation requires an L1-approved Task Brief naming exact owned files and acceptance criteria, then an independent gate; an author cannot self-review. Path and category routing, fallback behavior, and cross-domain Cyan gates are defined in the registry. Future assets/** and registry/** are proposed directories.

Use the current tree and branch. The active session allows at most 3 concurrent child threads, excluding the root task (4 total tasks). Pass the selected profile's explicit model and reasoning effort when spawning a fresh bounded process; a task name alone does not load a persona.

## Product guardrails

Five languages consume common data. Swap quotes/routes/build use configured RPC and local logic; no hosted Jupiter/0x dependencies. Weekly release is future work; current scripts remain human-approved. Bridging is separate research requiring exact chains, native versus wrapped addresses, proof/attestation, and relayer dependencies. No role grants push, tag, publish, live-funds, or secret authority; current or future explicit user authorization remains authoritative. An L1 approval in the Task Brief is required before L3 work; metadata is structural preflight, not proof of authorization. License, dependency, SBOM, security, and release-readiness work involves eu-oss-compliance and reads .codex/docs/eu-oss-compliance.md; review packets state applicability status, primary source and as-of date, evidence, gaps, owner, due date, and next review. EU OSS packets are planning evidence only: no self-issued legal compliance or CE certification and no standing authority for regulatory filings, public vulnerability disclosure, or live effects; honor explicit user authorization.

## Validation

Run node scripts/agent-harness.mjs check (or pnpm agent:check) and node --test scripts/agent-harness.test.mjs. See [.codex/docs/agent-workflow.md](.codex/docs/agent-workflow.md) for the short workflow pointer and [.codex/docs/eu-oss-compliance.md](.codex/docs/eu-oss-compliance.md) for the EU OSS compliance packet runbook.
