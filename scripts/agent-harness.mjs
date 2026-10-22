import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryFile = path.join(root, '.codex/agent-registry.json');
const profileKeys = ['name', 'description', 'developer_instructions', 'model', 'model_reasoning_effort'];
const tierModel = { L1: ['gpt-6-astra', 'max'], L2: ['gpt-5.6-sol', 'xhigh'], L3: ['gpt-5.6-luna', 'max'], GATE: ['gpt-6-astra', 'max'] };
const criticalModelPair = ['gpt-6-astra', 'max'];
const modelCriticalExceptions = new Set(['bahamut', 'eu-oss-compliance']);
const canonicalRoleIds = ['el','edgar','luida','celes','gogo','sephiroth','bartz','rydia','bahamut','eu-oss-compliance','backend-l3-pokemon-rotom','backend-l3-pokemon-rarecoil','backend-l3-pokemon-haganeil','sdk-l3-python','sdk-l3-go','sdk-l3-ruby','sdk-l3-registry','backend-l3-pokemon-wanriky','steiner','cyan'];
const mandatoryCategories = {
  'release-readiness': { contributors: ['sephiroth', 'eu-oss-compliance'], requiredGates: ['cyan'] },
  security: { contributors: ['eu-oss-compliance'], requiredGates: ['cyan'] },
  'eu-oss-compliance': { contributors: ['eu-oss-compliance'], requiredGates: ['cyan'] }
};
const arrayIncludesAll = (values, required) => required.every(value => values.includes(value));
const sameArray = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

const readRegistry = (base = root) => JSON.parse(fs.readFileSync(path.join(base, '.codex/agent-registry.json'), 'utf8'));
const tomlString = value => JSON.stringify(value);
const operatingRules = role => role.tier === 'L1'
  ? 'Make decisions for the stated scope, intake and route work, and close the task; do not implement.'
  : role.tier === 'L2'
    ? 'Produce an actionable packet with evidence and acceptance details for the reporting L1; do not write code or dispatch L3.'
    : role.tier === 'L3'
      ? 'Make scoped edits only in the approved Task Brief files, report results to the named L2 owner, and never self-review.'
      : 'Review independently against the requested gate, report findings to the named L1, and do not review your own authored work.';
const guidanceText = registry => registry.guidance.join(' ');
const profileText = (role, registry) => [
  `name = ${tomlString(role.id)}`,
  `description = ${tomlString(role.description)}`,
  `developer_instructions = ${tomlString(`${role.scope}. ${operatingRules(role)} ${guidanceText(registry)} Report to ${role.reportsTo}. Follow the approved task brief and owned paths.`)}`,
  `model = ${tomlString(role.model)}`,
  `model_reasoning_effort = ${tomlString(role.modelReasoningEffort)}`,
  ''
].join('\n');
const configText = '[agents]\nenabled = true\nmax_concurrent_threads_per_session = 3\n';
const agentsText = registry => `# Codex project agents\n\nThis project uses the canonical registry at [.codex/agent-registry.json](.codex/agent-registry.json). Load only the selected persona profile in [.codex/agents](.codex/agents); never load the full roster.\n\n## Work routing\n\nPlanning selects L1 and L2 contributors and attaches non-author gates; never dispatch L3. Implementation requires an L1-approved Task Brief naming exact owned files and acceptance criteria, then an independent gate; an author cannot self-review. Path and category routing, fallback behavior, and cross-domain Cyan gates are defined in the registry. Future assets/** and registry/** are proposed directories.\n\nUse the current tree and branch. The active session allows at most 3 concurrent child threads, excluding the root task (4 total tasks). Pass the selected profile's explicit model and reasoning effort when spawning a fresh bounded process; a task name alone does not load a persona.\n\n## Product guardrails\n\n${guidanceText(registry)}\n\n## Validation\n\nRun node scripts/agent-harness.mjs check (or pnpm agent:check) and node --test scripts/agent-harness.test.mjs. See [.codex/docs/agent-workflow.md](.codex/docs/agent-workflow.md) for the short workflow pointer and [.codex/docs/eu-oss-compliance.md](.codex/docs/eu-oss-compliance.md) for the EU OSS compliance packet runbook.\n`;

function requireKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`unknown ${label} field ${key}`);
  for (const key of keys) if (!(key in value)) throw new Error(`missing ${label} field ${key}`);
}
function validTarget(target) {
  if (typeof target !== 'string' || !target || target.includes('\\') || target.includes('\0') || path.isAbsolute(target)) throw new Error('invalid target path');
  const parts = target.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('invalid target path');
  return parts.join('/');
}
export function validate(registry) {
  requireKeys(registry, ['schemaVersion','runtime','roles','routing','guidance'], 'registry');
  requireKeys(registry.runtime, ['enabled','maxConcurrentThreadsPerSession'], 'runtime');
  if (registry.schemaVersion !== 1 || registry.runtime.enabled !== true || registry.runtime.maxConcurrentThreadsPerSession !== 3 || !Array.isArray(registry.guidance) || registry.guidance.some(x => typeof x !== 'string' || !x.trim())) throw new Error('invalid schema/runtime/guidance');
  const roles = registry.roles ?? [], ids = new Set(roles.map(r => r?.id));
  if (roles.length !== 20 || ids.size !== roles.length || canonicalRoleIds.some((id, index) => roles[index]?.id !== id)) throw new Error('registry must contain exactly canonical 20 roles');
  for (const r of roles) {
    requireKeys(r, ['id','name','description','tier','reportsTo','model','modelReasoningEffort','authority','scope'], `role ${r.id}`);
    for (const key of ['id','name','description','tier','reportsTo','model','modelReasoningEffort','authority','scope']) if (typeof r[key] !== 'string' || !r[key].trim()) throw new Error(`invalid role field ${r.id}`);
    if (!r.id || !r.name || !r.description || !r.tier || !r.reportsTo || !r.model || !r.modelReasoningEffort || !r.authority || !r.scope) throw new Error(`incomplete role ${r.id}`);
    if (!ids.has(r.reportsTo)) throw new Error(`unknown reportsTo ${r.id}->${r.reportsTo}`);
    const expected = tierModel[r.tier];
    const allowed = modelCriticalExceptions.has(r.id) ? criticalModelPair : expected;
    if (!expected || r.model !== allowed[0] || r.modelReasoningEffort !== allowed[1]) throw new Error(`model/effort mismatch ${r.id}`);
    const authority = { L1: 'decision-only', L2: 'packet-only', L3: 'scoped-write', GATE: 'independent-review' }[r.tier];
    if (r.authority !== authority) throw new Error(`authority mismatch ${r.id}`);
    if (r.tier === 'L1' && r.id !== 'el' && r.reportsTo !== 'el') throw new Error(`L1 must report to El ${r.id}`);
    if (r.tier === 'L1' && r.id === 'el' && r.reportsTo !== 'el') throw new Error('El must be terminal');
    if (r.tier === 'L2' && roles.find(parent => parent.id === r.reportsTo)?.tier !== 'L1') throw new Error(`L2 must report to L1 ${r.id}`);
    if (r.tier === 'L3' && roles.find(parent => parent.id === r.reportsTo)?.tier !== 'L2') throw new Error(`L3 must report to L2 ${r.id}`);
    if (r.tier === 'GATE' && roles.find(parent => parent.id === r.reportsTo)?.tier !== 'L1') throw new Error(`gate must report to L1 ${r.id}`);
  }
  const legalRole = roles.find(role => role.id === 'eu-oss-compliance');
  if (legalRole.tier !== 'L2' || legalRole.reportsTo !== 'edgar' || legalRole.authority !== 'packet-only' || legalRole.model !== criticalModelPair[0] || legalRole.modelReasoningEffort !== criticalModelPair[1]) throw new Error('EU OSS compliance role policy mismatch');
  const l3 = roles.filter(r => r.tier === 'L3');
  if (l3.length !== 8 || roles.filter(r => r.tier === 'L1').length !== 3 || roles.filter(r => r.tier === 'L2').length !== 7 || roles.filter(r => r.tier === 'GATE').length !== 2) throw new Error('tier roster mismatch');
  requireKeys(registry.routing, ['pathRules','categories','phaseRules','fallback'], 'routing');
  requireKeys(registry.routing.phaseRules, ['planning','implementation','fallback'], 'phaseRules');
  if (Object.keys(registry.routing.phaseRules).length !== 3 || Object.values(registry.routing.phaseRules).some(value => typeof value !== 'string')) throw new Error('invalid phase rules');
  if (registry.routing.phaseRules.planning !== 'L1+L2 only; never dispatch L3' || registry.routing.phaseRules.implementation !== 'requires L1-approved Task Brief; independent gate; author cannot self-review' || registry.routing.phaseRules.fallback !== 'L1+L2 investigation only; no L3') throw new Error('invalid phase policy');
  if (!Array.isArray(registry.routing.pathRules) || registry.routing.pathRules.length !== 8) throw new Error('invalid path rules');
  const ruleIds = new Set();
  for (const rule of registry.routing.pathRules) {
    requireKeys(rule, ['id','exactPaths','pathPrefixes','decisionOwner','detailOwner','implementer','gates'], `route ${rule.id}`);
    if (ruleIds.has(rule.id) || typeof rule.id !== 'string' || !rule.id.trim() || !Array.isArray(rule.exactPaths) || !Array.isArray(rule.pathPrefixes) || !Array.isArray(rule.gates)) throw new Error(`invalid route ${rule.id}`);
    ruleIds.add(rule.id);
    for (const candidate of rule.exactPaths) { if (candidate.endsWith('/')) throw new Error(`invalid file selector ${candidate}`); validTarget(candidate); }
    for (const candidate of rule.pathPrefixes) { if (!candidate.endsWith('/') || candidate.length < 2) throw new Error(`invalid directory selector ${candidate}`); validTarget(candidate.slice(0, -1) + '/x'); }
    for (const owner of [rule.decisionOwner, rule.detailOwner, rule.implementer, ...rule.gates]) if (!ids.has(owner)) throw new Error(`unknown route role ${owner}`);
    const decision = roles.find(r => r.id === rule.decisionOwner), detail = roles.find(r => r.id === rule.detailOwner), impl = roles.find(r => r.id === rule.implementer);
    if (decision.tier !== 'L1' || detail.tier !== 'L2' || new Set(['gogo', 'sephiroth', 'eu-oss-compliance']).has(detail.id) || impl.tier !== 'L3' || detail.reportsTo !== decision.id || impl.reportsTo !== detail.id || rule.gates.some(id => roles.find(r => r.id === id).tier !== 'GATE' || roles.find(r => r.id === id).authority !== 'independent-review') || new Set([rule.decisionOwner, rule.detailOwner, rule.implementer, ...rule.gates]).size !== 3 + rule.gates.length) throw new Error(`invalid route ownership ${rule.id}`);
  }
  const selectors = registry.routing.pathRules.flatMap(rule => [...rule.exactPaths.map(value => ({ value, prefix: false, rule: rule.id })), ...rule.pathPrefixes.map(value => ({ value, prefix: true, rule: rule.id }))]);
  for (let index = 0; index < selectors.length; index += 1) for (let other = index + 1; other < selectors.length; other += 1) {
    const left = selectors[index], right = selectors[other];
    if (left.rule !== right.rule && (left.value === right.value || (left.prefix && right.value.startsWith(left.value)) || (right.prefix && left.value.startsWith(right.value)))) throw new Error('overlapping selectors');
  }
  requireKeys(registry.routing.categories, ['codegen-parity','release-readiness','public-cross-language','security','eu-oss-compliance','money-path','cross-domain','bridging-research'], 'categories');
  for (const [name, category] of Object.entries(registry.routing.categories)) {
    requireKeys(category, ['contributors','requiredGates', ...(name === 'bridging-research' ? ['planningOnly'] : [])], `category ${name}`);
    if (!Array.isArray(category.contributors) || !Array.isArray(category.requiredGates) || category.contributors.some(id => !ids.has(id)) || category.requiredGates.some(id => !ids.has(id)) || new Set(category.contributors).size !== category.contributors.length || new Set(category.requiredGates).size !== category.requiredGates.length) throw new Error(`invalid category ${name}`);
    if (category.requiredGates.some(id => roles.find(r => r.id === id).tier !== 'GATE' || roles.find(r => r.id === id).authority !== 'independent-review') || category.requiredGates.some(id => category.contributors.includes(id))) throw new Error(`invalid category gate ${name}`);
    if (name === 'bridging-research' && category.planningOnly !== true) throw new Error('bridge category must be planning only');
    if (name === 'bridging-research' && (category.contributors.length !== 1 || category.contributors[0] !== 'rydia' || category.requiredGates.length !== 0)) throw new Error('bridge category policy mismatch');
    const mandatory = mandatoryCategories[name];
    if (mandatory && (!arrayIncludesAll(category.contributors, mandatory.contributors) || !arrayIncludesAll(category.requiredGates, mandatory.requiredGates))) throw new Error(`mandatory category membership missing ${name}`);
    if (name === 'eu-oss-compliance' && (!sameArray(category.contributors, mandatoryCategories[name].contributors) || !sameArray(category.requiredGates, mandatoryCategories[name].requiredGates))) throw new Error('EU OSS compliance category policy mismatch');
    if (!mandatory && category.contributors.includes('eu-oss-compliance')) throw new Error(`EU OSS contributor is not valid for category ${name}`);
    for (const id of category.contributors) if (roles.find(r => r.id === id).tier !== 'L2') throw new Error(`category contributor must be L2 ${id}`);
  }
  requireKeys(registry.routing.fallback, ['planningOwners'], 'fallback');
  if (!registry.routing.fallback.planningOwners.every(id => ids.has(id) && roles.find(r => r.id === id).tier === 'L1')) throw new Error('invalid fallback owners');
  const seen = new Set(), visiting = new Set();
  const visit = id => { if (visiting.has(id)) throw new Error(`return cycle at ${id}`); if (seen.has(id)) return; visiting.add(id); const r = roles.find(x => x.id === id); if (r.reportsTo !== id) visit(r.reportsTo); visiting.delete(id); seen.add(id); };
  roles.forEach(r => visit(r.id));
}

function findRule(registry, target) {
  const matches = registry.routing.pathRules.filter(rule => rule.exactPaths.includes(target) || rule.pathPrefixes.some(prefix => target.startsWith(prefix)));
  if (matches.length > 1) throw new Error('multiple matching routes');
  return matches[0];
}
function validBrief(brief, rule, target, registry) {
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) return false;
  const keys = ['approvedBy','detailOwner','implementer','ownedFiles','acceptanceCriteria'];
  if (Object.keys(brief).some(key => !keys.includes(key)) || !keys.every(key => key in brief)) return false;
  if (brief.approvedBy !== rule.decisionOwner || brief.detailOwner !== rule.detailOwner || brief.implementer !== rule.implementer) return false;
  if (!Array.isArray(brief.ownedFiles) || !brief.ownedFiles.includes(target) || brief.ownedFiles.length === 0 || !Array.isArray(brief.acceptanceCriteria) || brief.acceptanceCriteria.length === 0 || brief.acceptanceCriteria.some(item => typeof item !== 'string' || !item.trim())) return false;
  return brief.ownedFiles.every(file => { try { validTarget(file); } catch { return false; } const selected = findRule(registry, file); return selected && selected.decisionOwner === rule.decisionOwner && selected.detailOwner === rule.detailOwner && selected.implementer === rule.implementer; });
}
export function route(registry, target, { phase = 'implementation', category, taskBrief } = {}) {
  validate(registry); const normalized = validTarget(target);
  if (!['planning','implementation','fallback'].includes(phase)) throw new Error('invalid phase');
  if (category !== undefined && !Object.hasOwn(registry.routing.categories, category)) throw new Error('unknown category');
  const rule = findRule(registry, normalized);
  if (category === 'bridging-research') { const rydia = registry.roles.find(role => role.id === registry.routing.categories[category].contributors[0]); return { phase: 'fallback', status: 'RESEARCH_REQUIRED', noL3: true, dispatchL3: false, roles: [rydia.reportsTo, ...registry.routing.categories[category].contributors] }; }
  if (!rule) return { phase: 'fallback', status: 'ROUTE_UNRESOLVED', dispatchL3: false, roles: registry.routing.fallback.planningOwners };
  const categories = category ? registry.routing.categories[category] : { contributors: [], requiredGates: [] };
  const requiredGates = [...new Set([...rule.gates, ...categories.requiredGates])];
  if (phase === 'planning') return { phase, roles: [...new Set([rule.decisionOwner, rule.detailOwner, ...categories.contributors, ...requiredGates])], requiredGates, dispatchL3: false };
  if (phase === 'fallback') return { phase, roles: [...new Set([rule.decisionOwner, rule.detailOwner, ...categories.contributors])], dispatchL3: false };
  const actionable = validBrief(taskBrief, rule, normalized, registry);
  const roles = [...new Set([rule.decisionOwner, rule.detailOwner, ...categories.contributors])];
  if (actionable) roles.push(rule.implementer);
  return { phase, roles, candidateImplementer: rule.implementer, requiredGates, actionable, dispatchL3: actionable, status: actionable ? 'READY' : (taskBrief ? 'BRIEF_INVALID' : 'BRIEF_REQUIRED') };
}

function renderAgents(registry) { return agentsText(registry).replace(`${registry.runtime.maxConcurrentThreadsPerSession} concurrent threads (3 children excluding the primary, 4 total)`, '3 concurrent child threads, excluding the root task (4 total tasks)'); }
function expectedFiles(registry) { return new Map([['AGENTS.md', renderAgents(registry)], ['.codex/config.toml', configText], ...registry.roles.map(r => [`.codex/agents/${r.id}.toml`, profileText(r, registry)] )]); }
export function check(base = root) {
  const registry = readRegistry(base); validate(registry); const expected = expectedFiles(registry); const problems = [];
  for (const [file, text] of expected) if (!fs.existsSync(path.join(base, file)) || fs.readFileSync(path.join(base, file), 'utf8') !== text) problems.push(`missing or stale ${file}`);
  const profileRoot = path.join(base, '.codex/agents');
  const actual = fs.existsSync(profileRoot) ? fs.readdirSync(profileRoot).filter(f => f.endsWith('.toml')) : [];
  if (actual.length !== 20 || actual.some(f => !expected.has(`.codex/agents/${f}`))) problems.push('profile set is not exactly 20 files');
  if (problems.length) throw new Error(problems.join('; '));
  return true;
}
export function write(base = root) { const registry = readRegistry(base); validate(registry); const expected = expectedFiles(registry); fs.mkdirSync(path.join(base, '.codex/agents'), { recursive: true }); for (const [file, text] of expected) { const dest = path.join(base, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, text); } }
if (process.argv[1]?.endsWith('agent-harness.mjs')) {
  const command = process.argv[2], base = process.argv[3] === '--root' ? process.argv[4] : root;
  if (command === 'write') write(base); else if (command === 'check') { check(base); console.log('agent harness check: ok'); } else { console.error('usage: node scripts/agent-harness.mjs write|check [--root dir]'); process.exitCode = 2; }
}
