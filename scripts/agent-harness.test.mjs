import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { check, route, validate, write } from './agent-harness.mjs';

const registry = JSON.parse(fs.readFileSync(new URL('../.codex/agent-registry.json', import.meta.url)));
const brief = (target, rule) => ({ approvedBy: rule.decisionOwner, detailOwner: rule.detailOwner, implementer: rule.implementer, ownedFiles: [target], acceptanceCriteria: ['Implement and verify the bounded change.'] });
const selected = target => registry.routing.pathRules.find(rule => rule.exactPaths.includes(target) || rule.pathPrefixes.some(prefix => target.startsWith(prefix)));

test('generated outputs and strict canonical roster validate', () => { assert.equal(registry.roles.length, 20); assert.doesNotThrow(check); });
test('the generated roster has exactly 20 profiles and the 7/5/8 model-pair split', () => {
  const profiles = fs.readdirSync('.codex/agents').filter(file => file.endsWith('.toml')); assert.equal(profiles.length, 20);
  const pairs = registry.roles.reduce((counts, role) => { const pair = `${role.model}/${role.modelReasoningEffort}`; counts[pair] = (counts[pair] ?? 0) + 1; return counts; }, {});
  assert.deepEqual(pairs, { 'gpt-6-astra/max': 7, 'gpt-5.6-sol/xhigh': 5, 'gpt-5.6-luna/max': 8 });
});
test('all five package paths select exact owners and valid briefs enable only their L3', () => {
  const cases = [['typescript', 'backend-l3-pokemon-rarecoil'], ['rust', 'backend-l3-pokemon-haganeil'], ['python', 'sdk-l3-python'], ['go', 'sdk-l3-go'], ['ruby', 'sdk-l3-ruby']];
  for (const [language, owner] of cases) { const target = `packages/${language}/src/client`; const rule = selected(target); const result = route(registry, target, { taskBrief: brief(target, rule) }); assert.equal(rule.implementer, owner); assert.equal(result.actionable, true); assert.equal(result.dispatchL3, true); assert.ok(result.roles.includes(owner)); assert.equal(result.candidateImplementer, owner); assert.deepEqual(result.requiredGates, ['steiner']); }
});
test('harness, future assets, and CI route correctly', () => {
  assert.equal(route(registry, 'scripts/agent-harness.mjs', { phase: 'planning' }).roles[1], 'celes');
  for (const target of ['assets/tokens.json', 'registry/pools.json']) assert.equal(route(registry, target, { taskBrief: brief(target, selected(target)) }).candidateImplementer, 'sdk-l3-registry');
  const ci = '.github/workflows/release.yml'; assert.deepEqual(route(registry, ci, { taskBrief: brief(ci, selected(ci)) }).requiredGates, ['cyan']);
});
test('root README and ROADMAP route through the future assets registry with a Cyan gate', () => {
  for (const target of ['README.md', 'ROADMAP.md']) {
    const rule = selected(target); assert.equal(rule.id, 'future-assets-registry');
    const planning = route(registry, target, { phase: 'planning' }); assert.deepEqual(planning.roles, ['edgar', 'rydia', 'cyan']); assert.deepEqual(planning.requiredGates, ['cyan']); assert.equal(planning.dispatchL3, false);
    const required = route(registry, target); assert.equal(required.status, 'BRIEF_REQUIRED'); assert.equal(required.dispatchL3, false); assert.equal(required.candidateImplementer, 'sdk-l3-registry'); assert.deepEqual(required.roles, ['edgar', 'rydia']);
    const ready = route(registry, target, { taskBrief: brief(target, rule) }); assert.equal(ready.status, 'READY'); assert.equal(ready.actionable, true); assert.equal(ready.dispatchL3, true); assert.deepEqual(ready.requiredGates, ['cyan']); assert.deepEqual(ready.roles, ['edgar', 'rydia', 'sdk-l3-registry']);
    const invalid = route(registry, target, { taskBrief: { ...brief(target, rule), approvedBy: 'luida' } }); assert.equal(invalid.status, 'BRIEF_INVALID'); assert.equal(invalid.actionable, false); assert.equal(invalid.dispatchL3, false); assert.deepEqual(invalid.roles, ['edgar', 'rydia']);
  }
  for (const target of ['docs/README.md', 'README.md.bak', 'ROADMAP.md.bak']) { const unresolved = route(registry, target); assert.equal(unresolved.status, 'ROUTE_UNRESOLVED'); assert.equal(unresolved.dispatchL3, false); assert.deepEqual(unresolved.roles, ['el', 'edgar']); }
});
test('root Cargo.lock routes through Rust ownership while lookalikes stay unresolved', () => {
  const target = 'Cargo.lock'; const rule = selected(target); assert.equal(rule.id, 'rust'); assert.equal(rule.implementer, 'backend-l3-pokemon-haganeil');
  const planning = route(registry, target, { phase: 'planning' }); assert.deepEqual(planning.roles, ['edgar', 'bartz', 'steiner']); assert.deepEqual(planning.requiredGates, ['steiner']); assert.equal(planning.dispatchL3, false);
  const required = route(registry, target); assert.equal(required.status, 'BRIEF_REQUIRED'); assert.equal(required.dispatchL3, false); assert.equal(required.candidateImplementer, 'backend-l3-pokemon-haganeil'); assert.deepEqual(required.roles, ['edgar', 'bartz']);
  const ready = route(registry, target, { taskBrief: brief(target, rule) }); assert.equal(ready.status, 'READY'); assert.equal(ready.actionable, true); assert.equal(ready.dispatchL3, true); assert.deepEqual(ready.requiredGates, ['steiner']); assert.deepEqual(ready.roles, ['edgar', 'bartz', 'backend-l3-pokemon-haganeil']);
  const invalid = route(registry, target, { taskBrief: { ...brief(target, rule), approvedBy: 'luida' } }); assert.equal(invalid.status, 'BRIEF_INVALID'); assert.equal(invalid.actionable, false); assert.equal(invalid.dispatchL3, false); assert.deepEqual(invalid.roles, ['edgar', 'bartz']);
  for (const category of ['security', 'eu-oss-compliance']) { const result = route(registry, target, { phase: 'planning', category }); assert.ok(result.roles.includes('eu-oss-compliance')); assert.ok(result.roles.includes('cyan')); assert.ok(result.requiredGates.includes('cyan')); }
  const release = route(registry, target, { category: 'release-readiness', taskBrief: brief(target, rule) }); assert.ok(release.roles.includes('sephiroth')); assert.ok(release.roles.includes('eu-oss-compliance')); assert.deepEqual(release.requiredGates, ['steiner', 'cyan']);
  for (const unresolvedTarget of ['Cargo.lock.bak', 'docs/Cargo.lock', 'Cargo.toml']) { const unresolved = route(registry, unresolvedTarget); assert.equal(unresolved.status, 'ROUTE_UNRESOLVED'); assert.equal(unresolved.dispatchL3, false); assert.deepEqual(unresolved.roles, ['el', 'edgar']); }
});
test('categories append contributors and gates while bridge research stays planning only', () => {
  const target = 'packages/typescript/src/client'; const rule = selected(target);
  const parity = route(registry, target, { category: 'codegen-parity', taskBrief: brief(target, rule) }); assert.ok(parity.roles.includes('gogo')); assert.equal(parity.candidateImplementer, rule.implementer);
  const release = route(registry, target, { category: 'release-readiness', taskBrief: brief(target, rule) }); assert.ok(release.roles.includes('sephiroth')); assert.deepEqual(release.requiredGates, ['steiner', 'cyan']);
  const bridge = route(registry, target, { category: 'bridging-research', taskBrief: brief(target, rule) }); assert.equal(bridge.status, 'RESEARCH_REQUIRED'); assert.equal(bridge.dispatchL3, false);
});
test('planning and fallback never dispatch implementation; unresolved paths are explicit', () => {
  assert.equal(route(registry, 'packages/go/src/x', { phase: 'planning' }).dispatchL3, false);
  const fallback = route(registry, 'docs/unknown.md', { phase: 'implementation' }); assert.equal(fallback.status, 'ROUTE_UNRESOLVED'); assert.equal(fallback.dispatchL3, false); assert.deepEqual(fallback.roles, ['el', 'edgar']);
});
test('invalid target, phase, category, briefs, refs, and ownership are rejected', () => {
  for (const target of ['', '/absolute', '../escape', 'a\\b', 'a//b', 'a/./b', 'a/../b', 'a\0b']) assert.throws(() => route(registry, target));
  assert.throws(() => route(registry, 'AGENTS.md', { phase: 'later' })); assert.throws(() => route(registry, 'AGENTS.md', { category: 'unknown' }));
  const target = 'packages/go/src/x'; const rule = selected(target); assert.equal(route(registry, target).status, 'BRIEF_REQUIRED'); assert.equal(route(registry, target, { taskBrief: {...brief(target, rule), approvedBy: 'el'} }).status, 'BRIEF_INVALID'); assert.equal(route(registry, target, { taskBrief: {...brief(target, rule), ownedFiles: ['packages/rust/src/x'] } }).status, 'BRIEF_INVALID'); assert.equal(route(registry, target, { taskBrief: {...brief(target, rule), acceptanceCriteria: [] } }).status, 'BRIEF_INVALID');
  const malformed = structuredClone(registry); malformed.roles[0].name = 42; assert.throws(() => validate(malformed)); const renamed = structuredClone(registry); renamed.roles[4].id = 'not-gogo'; renamed.routing.categories['codegen-parity'].contributors[0] = 'not-gogo'; assert.throws(() => validate(renamed)); const unknown = structuredClone(registry); unknown.routing.pathRules[0].gates.push('missing'); assert.throws(() => validate(unknown)); const badGate = structuredClone(registry); badGate.routing.categories.security.requiredGates = ['backend-l3-pokemon-rarecoil']; assert.throws(() => validate(badGate)); const badPrefix = structuredClone(registry); badPrefix.routing.pathRules[3].pathPrefixes = ['packages/python']; assert.throws(() => validate(badPrefix)); const overlap = structuredClone(registry); overlap.routing.pathRules[1].pathPrefixes.push('.codex/'); assert.throws(() => validate(overlap));
});
test('write repairs drift, is idempotent, and check flags but preserves extra profiles', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-harness-')); fs.mkdirSync(path.join(fixture, '.codex'), { recursive: true }); fs.copyFileSync(path.resolve('.codex/agent-registry.json'), path.join(fixture, '.codex/agent-registry.json')); write(fixture); const managed = () => [path.join(fixture, 'AGENTS.md'), path.join(fixture, '.codex/config.toml'), ...fs.readdirSync(path.join(fixture, '.codex/agents')).map(file => path.join(fixture, '.codex/agents', file))]; const manifest = () => managed().map(file => `${path.relative(fixture, file)}:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`).join('\n'); const first = manifest(); fs.writeFileSync(path.join(fixture, 'AGENTS.md'), 'stale'); assert.throws(() => check(fixture)); write(fixture); assert.equal(manifest(), first); fs.unlinkSync(path.join(fixture, '.codex/agents/el.toml')); assert.throws(() => check(fixture)); write(fixture); const second = manifest(); write(fixture); assert.equal(manifest(), second); fs.writeFileSync(path.join(fixture, '.codex/agents/extra.toml'), 'x'); assert.throws(() => check(fixture)); assert.equal(fs.existsSync(path.join(fixture, '.codex/agents/extra.toml')), true);
});

test('generated root guidance states the exact child-thread cap', () => { assert.match(fs.readFileSync('AGENTS.md', 'utf8'), /The active session allows at most 3 concurrent child threads, excluding the root task \(4 total tasks\)\./); });

test('canonical guidance is rendered in an isolated fixture and source stays editable', () => {
  const source = fs.readFileSync('.codex/agent-registry.json', 'utf8'); const sentence = registry.guidance.find(item => item.includes('metadata is structural')); const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guidance-')); fs.mkdirSync(path.join(fixture, '.codex'), { recursive: true }); fs.copyFileSync('.codex/agent-registry.json', path.join(fixture, '.codex/agent-registry.json')); write(fixture);
  assert.match(fs.readFileSync(path.join(fixture, 'AGENTS.md'), 'utf8'), new RegExp(sentence));
  for (const role of registry.roles) assert.match(fs.readFileSync(path.join(fixture, `.codex/agents/${role.id}.toml`), 'utf8'), new RegExp(sentence));
  assert.equal(fs.readFileSync('.codex/agent-registry.json', 'utf8'), source); assert.equal(fs.readFileSync(path.join(fixture, '.codex/agent-registry.json'), 'utf8'), source);
});

test('every tier uses its canonical model pair and rejects old bindings', () => {
  const expected = { L1: ['gpt-6-astra', 'max'], L2: ['gpt-5.6-sol', 'xhigh'], L3: ['gpt-5.6-luna', 'max'], GATE: ['gpt-6-astra', 'max'] };
  for (const role of registry.roles) { const pair = ['bahamut', 'eu-oss-compliance'].includes(role.id) ? expected.L1 : expected[role.tier]; assert.deepEqual([role.model, role.modelReasoningEffort], pair); }
  for (const [tier, pair] of Object.entries({ L1: ['gpt-5.6-sol', 'xhigh'], L2: ['gpt-5.6-terra', 'high'], L3: ['gpt-5.6-luna', 'medium'], GATE: ['gpt-5.6-sol', 'xhigh'] })) {
    const invalid = structuredClone(registry); const role = invalid.roles.find(item => item.tier === tier); [role.model, role.modelReasoningEffort] = pair; assert.throws(() => validate(invalid));
  }
  const bahamut = structuredClone(registry); Object.assign(bahamut.roles.find(role => role.id === 'bahamut'), { model: 'gpt-5.6-sol', modelReasoningEffort: 'high' }); assert.throws(() => validate(bahamut));
});

test('EU OSS compliance is the Astra/max packet-only contributor under Edgar', () => {
  const legal = registry.roles.find(role => role.id === 'eu-oss-compliance');
  assert.deepEqual([legal.model, legal.modelReasoningEffort], ['gpt-6-astra', 'max']);
  assert.equal(legal.tier, 'L2'); assert.equal(legal.authority, 'packet-only'); assert.equal(legal.reportsTo, 'edgar');
  for (const mutate of [
    role => { role.model = 'gpt-5.6-sol'; role.modelReasoningEffort = 'xhigh'; },
    role => { role.tier = 'L3'; role.authority = 'scoped-write'; },
    role => { role.authority = 'decision-only'; },
    role => { role.reportsTo = 'luida'; }
  ]) { const invalid = structuredClone(registry); mutate(invalid.roles.find(role => role.id === 'eu-oss-compliance')); assert.throws(() => validate(invalid)); }
  const renamed = structuredClone(registry); renamed.roles.find(role => role.id === 'eu-oss-compliance').id = 'eu-oss'; assert.throws(() => validate(renamed));
  const removed = structuredClone(registry); removed.roles = removed.roles.filter(role => role.id !== 'eu-oss-compliance'); assert.throws(() => validate(removed));
});

test('EU OSS, release, and security categories keep mandatory contributors and Cyan gates', () => {
  const cases = [
    ['eu-oss-compliance', 'contributors', []],
    ['eu-oss-compliance', 'requiredGates', []],
    ['release-readiness', 'contributors', ['sephiroth']],
    ['release-readiness', 'requiredGates', []],
    ['security', 'contributors', []],
    ['security', 'requiredGates', ['steiner']],
    ['security', 'requiredGates', ['backend-l3-pokemon-rarecoil']]
  ];
  for (const [category, field, value] of cases) { const invalid = structuredClone(registry); invalid.routing.categories[category][field] = value; assert.throws(() => validate(invalid)); }
  const misplaced = structuredClone(registry); misplaced.routing.categories['codegen-parity'].contributors = ['eu-oss-compliance']; assert.throws(() => validate(misplaced));
  const renamed = structuredClone(registry); renamed.routing.categories['eu-oss-compliance-renamed'] = renamed.routing.categories['eu-oss-compliance']; delete renamed.routing.categories['eu-oss-compliance']; assert.throws(() => validate(renamed));
});

test('EU OSS category composes planning contributors and non-author gates while preserving path L3 ownership', () => {
  const target = 'packages/typescript/src/client'; const rule = selected(target); const taskBrief = brief(target, rule);
  const planning = route(registry, target, { phase: 'planning', category: 'eu-oss-compliance' });
  assert.deepEqual(planning.roles, ['edgar', 'bartz', 'eu-oss-compliance', 'steiner', 'cyan']); assert.deepEqual(planning.requiredGates, ['steiner', 'cyan']); assert.equal(planning.dispatchL3, false);
  const implementation = route(registry, target, { category: 'eu-oss-compliance', taskBrief });
  assert.ok(implementation.roles.includes('eu-oss-compliance')); assert.ok(implementation.roles.includes(rule.implementer)); assert.equal(implementation.candidateImplementer, 'backend-l3-pokemon-rarecoil'); assert.deepEqual(implementation.requiredGates, ['steiner', 'cyan']); assert.equal(new Set(implementation.requiredGates).size, implementation.requiredGates.length);
  const release = route(registry, target, { category: 'release-readiness', taskBrief }); assert.ok(release.roles.includes('sephiroth')); assert.ok(release.roles.includes('eu-oss-compliance')); assert.equal(release.candidateImplementer, rule.implementer);
  const ciTarget = '.github/workflows/release.yml'; const ciRule = selected(ciTarget); const ci = route(registry, ciTarget, { category: 'release-readiness', taskBrief: brief(ciTarget, ciRule) }); assert.deepEqual(ci.requiredGates, ['cyan']); assert.equal(ci.candidateImplementer, ciRule.implementer);
});

test('EU OSS contributor cannot become a path detail owner even when an L3 parent is changed', () => {
  const invalid = structuredClone(registry); const rule = invalid.routing.pathRules.find(item => item.id === 'typescript'); rule.detailOwner = 'eu-oss-compliance'; invalid.roles.find(role => role.id === rule.implementer).reportsTo = 'eu-oss-compliance'; assert.throws(() => validate(invalid));
});

test('contributor-only ownership remains strict', () => {
  for (const contributor of ['gogo', 'sephiroth']) { const invalid = structuredClone(registry); invalid.routing.pathRules[1].detailOwner = contributor; invalid.roles.find(role => role.id === contributor).reportsTo = 'edgar'; assert.throws(() => validate(invalid)); }
});

test('bridge research is research required in every phase and unresolved paths always fallback', () => {
  for (const phase of ['planning', 'implementation', 'fallback']) { const result = route(registry, 'packages/go/src/x', { phase, category: 'bridging-research' }); assert.equal(result.status, 'RESEARCH_REQUIRED'); assert.equal(result.dispatchL3, false); assert.equal(result.phase, 'fallback'); }
  for (const phase of ['planning', 'implementation', 'fallback']) assert.equal(route(registry, 'unknown/path', { phase }).phase, 'fallback');
});

test('category duplicates are rejected and composed roles/gates are deduplicated', () => {
  const duplicate = structuredClone(registry); duplicate.routing.categories.security.requiredGates = ['cyan', 'cyan']; assert.throws(() => validate(duplicate));
  const composed = route(registry, 'packages/go/src/x', { category: 'release-readiness', taskBrief: brief('packages/go/src/x', selected('packages/go/src/x')) }); assert.deepEqual(composed.requiredGates, ['steiner', 'cyan']); assert.equal(new Set(composed.roles).size, composed.roles.length);
});

test('bridge category is exact and duplicate role output is first-seen ordered', () => {
  for (const mutate of [category => { category.contributors = []; }, category => { category.contributors = ['bartz']; }, category => { category.contributors = ['rydia', 'bartz']; }, category => { category.requiredGates = ['cyan']; }]) { const invalid = structuredClone(registry); mutate(invalid.routing.categories['bridging-research']); assert.throws(() => validate(invalid)); }
  const clone = structuredClone(registry); clone.routing.categories['codegen-parity'].contributors = ['bartz']; const target = 'packages/go/src/x'; const rule = clone.routing.pathRules.find(item => item.pathPrefixes.some(prefix => target.startsWith(prefix))); const result = route(clone, target, { category: 'codegen-parity', taskBrief: brief(target, rule) }); assert.deepEqual(result.roles, ['edgar', 'bartz', 'sdk-l3-go']);
});
