import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const shell = process.env.BASH || '/bin/bash';
const gate = readFileSync(join(root, 'scripts/check-oss-hygiene.sh'), 'utf8');
const config = readFileSync(join(root, '.gitleaks.toml'), 'utf8');
function run(command, args, cwd = root, env = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000, maxBuffer: 8e6 });
  assert.ifError(result.error);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'erpc-oss-controls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(root, 'scripts'), join(dir, 'scripts'), { recursive: true });
  cpSync(join(root, 'lefthook.yml'), join(dir, 'lefthook.yml'));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  assert.equal(run('git', ['init', '-q'], dir).status, 0);
  return dir;
}
function hygiene(dir) {
  return run(shell, ['scripts/tests/check-oss-hygiene.test.sh'], dir, { ERPC_TEST_LOCALE: 'C', LC_ALL: 'C' });
}

test('every independent hygiene diagnostic is protected by a failing mutation', t => {
  const dir = fixture(t);
  assert.equal(hygiene(dir).status, 0, 'baseline must pass before mutations');
  const reports = gate.split('\n').filter(line => /^\s*(?:.*\) )?report "\$f"/u.test(line));
  assert.equal(reports.length, 11, 'all independent hygiene report sites are enumerated');
  for (const report of reports) {
    const mutant = gate.replace(report, report.replace(/report "\$f".*?(?=;;|$)/u, ':'));
    assert.notEqual(mutant, gate);
    writeFileSync(join(dir, 'scripts/check-oss-hygiene.sh'), mutant);
    const result = hygiene(dir);
    assert.notEqual(result.status, 0, `survived removal: ${report}`);
    assert.match(result.output, /FAIL /u, 'must fail a case, not a setup error');
    console.log(`killed hygiene mutation: ${report.trim().split('"')[5] || '.env'}`);
  }
});

test('index and exact self-exemption mutations fail behavioral tests', t => {
  const dir = fixture(t);
  for (const [name, before, after, expected] of [
    ['policy EOF validation', 'while IFS= read -r host || [ -n "$host" ]; do', 'while IFS= read -r host; do', 'FAIL malformed final policy line without newline'],
    ['index content', 'git show ":$f" > "$scratch/content"', 'cat "$f" > "$scratch/content"', 'FAIL unborn index scans staged bytes'],
    ['index policy', 'git show ":$allowlist_src" > "$scratch/hosts"', 'cat "$allowlist_src" > "$scratch/hosts"', 'FAIL staged policy ignores unstaged grant'],
    ['broad exemption', "self_re='^(scripts/check-oss-hygiene\\.sh|scripts/tests/check-oss-hygiene\\.test\\.sh)$'", "self_re='^scripts/'", 'FAIL nearby test file is not exempt'],
    ['dotenv ordering', '.env|.env.*|*/.env|*/.env.*)', '.env|*/.env)', 'FAIL dotenv path precedes binary suffix skip'],
  ]) {
    assert.ok(gate.includes(before), name);
    writeFileSync(join(dir, 'scripts/check-oss-hygiene.sh'), gate.replace(before, after));
    const result = hygiene(dir);
    assert.notEqual(result.status, 0, name);
    assert.ok(result.output.includes(expected), result.output);
    console.log(`killed hygiene mutation: ${name}`);
  }
});

test('removing archive checksum enforcement fails the offline wrapper tests', t => {
  const dir = fixture(t);
  const path = join(dir, 'scripts/run-gitleaks.sh');
  const source = readFileSync(path, 'utf8');
  assert.ok(source.includes('if [ "$actual" != "$sha" ]; then'));
  writeFileSync(path, source.replace('if [ "$actual" != "$sha" ]; then', 'if false; then'));
  const result = run(shell, ['scripts/tests/run-gitleaks.test.sh'], dir);
  assert.notEqual(result.status, 0, result.output);
  assert.ok(!result.output.includes('6 wrapper checks passed'));
});

const synthetic = 'Ab9Cd2Ef7Gh4Jk8Lm3Np6Qr1St5Uv0WxZ';
const samples = {
  'solana-keypair-json': JSON.stringify(Array(64).fill(7)),
  'blockchain-private-key-hex': 'private_key = "' + 'a1'.repeat(32) + '"',
  'blockchain-private-key-base58': 'keypair = "' + '123456789ABCDEFGHJKLMNPQRSTUVWXYZ'.repeat(3).slice(0, 88) + '"',
  'bip39-mnemonic': 'mnemonic = "' + Array(12).fill('abandon').join(' ') + '"',
  'ethereum-keystore-json': JSON.stringify({ crypto: { ciphertext: 'synthetic' } }),
  'cloudflare-api-token': 'cloudflare_token = "' + synthetic.repeat(2).slice(0, 40) + '"',
  'cloudflare-global-api-key': 'cloudflare_key = "' + 'a'.repeat(37) + '"',
  'r2-s3-secret-access-key': 'aws_secret_access_key = "' + synthetic.repeat(2).slice(0, 40) + '"',
  'gcp-service-account-json': JSON.stringify({ type: 'service_account' }),
  'onepassword-service-account-token': ['ops', synthetic.repeat(2)].join('_'),
  'minisign-secret-key': ['untrusted comment:', 'minisign encrypted secret key'].join(' '),
  'erpc-storage-access-key': ['erpcsk', 'abcdefghijklmnop'].join('_'),
  'crates-io-token': 'cio' + synthetic.repeat(2),
};
function scan(dir, configuration, content, filename = 'sample.txt') {
  const data = join(dir, 'data');
  rmSync(data, { recursive: true, force: true });
  mkdirSync(join(data, filename, '..'), { recursive: true });
  writeFileSync(join(data, filename), content);
  writeFileSync(join(dir, 'config.toml'), configuration);
  const report = join(dir, 'report.json');
  rmSync(report, { force: true });
  const result = run(shell, [join(root, 'scripts/run-gitleaks.sh'), 'dir', '--redact', '--config', join(dir, 'config.toml'), '--report-path', report, '--report-format', 'json', '.'], data);
  assert.ok([0, 1].includes(result.status), result.output);
  return existsSync(report) ? JSON.parse(readFileSync(report, 'utf8') || '[]') : [];
}
function requireRules(findings) {
  const actual = new Set(findings.map(f => f.RuleID));
  for (const rule of Object.keys(samples)) assert.ok(actual.has(rule), `missing detector ${rule}`);
}

test('all imported Gitleaks rules detect fixtures and fail when individually disabled', t => {
  const dir = fixture(t);
  const content = Object.values(samples).join('\n');
  requireRules(scan(dir, config, content));
  for (const rule of Object.keys(samples)) {
    const start = config.indexOf(`id = "${rule}"`);
    assert.ok(start >= 0);
    const end = config.indexOf('\n[[rules]]', start);
    const block = config.slice(start, end === -1 ? config.length : end);
    const mutantBlock = block.replace(/regex = '''[^]*?'''/u, "regex = '''a^'''");
    assert.notEqual(mutantBlock, block);
    const mutant = config.replace(block, () => mutantBlock);
    assert.throws(() => requireRules(scan(dir, mutant, content)), /missing detector/u, rule);
    console.log(`killed Gitleaks mutation: ${rule}`);
  }
});

test('Gitleaks keyword filters cover every accepted private-key and mnemonic label', t => {
  const dir = fixture(t);
  const privateLabels = ['privkey', 'priv_key', 'priv-key', 'privatekey', 'private_key', 'private-key', 'secretkey', 'secret_key', 'secret-key', 'keypair'];
  const families = [
    ['blockchain-private-key-hex', [...privateLabels, 'signingkey', 'signing_key', 'signing-key'], 'a1'.repeat(32)],
    ['blockchain-private-key-base58', privateLabels, '123456789ABCDEFGHJKLMNPQRSTUVWXYZ'.repeat(3).slice(0, 88)],
    ['bip39-mnemonic', ['mnemonic', 'seedphrase', 'seed_phrase', 'seed-phrase', 'recoveryphrase', 'recovery_phrase', 'recovery-phrase', 'secretrecovery', 'secret_recovery', 'secret-recovery'], Array(12).fill('abandon').join(' ')],
  ];
  function requireLabel(configuration, rule, label, value) {
    // Gitleaks prefilters whole fragments: another label in the same file
    // would mask a missing keyword. Each scan contains exactly one label.
    const findings = scan(dir, configuration, `${label} = "${value}"`);
    assert.ok(findings.some(f => f.RuleID === rule), `keyword filter lost ${label}`);
  }
  for (const [rule, labels, value] of families) {
    for (const label of labels) requireLabel(config, rule, label, value);
    const start = config.indexOf(`id = "${rule}"`);
    const end = config.indexOf('\n[[rules]]', start);
    const block = config.slice(start, end);
    const oldKeywords = rule === 'bip39-mnemonic'
      ? '["mnemonic", "seed phrase", "seed_phrase", "recovery phrase", "recovery_phrase"]'
      : '["privatekey", "private_key", "private-key", "privkey", "secretkey", "secret_key", "signingkey", "keypair"]';
    const mutantBlock = block.replace(/keywords = \[[^\]]+\]/u, () => `keywords = ${oldKeywords}`);
    assert.notEqual(mutantBlock, block);
    const mutant = config.replace(block, () => mutantBlock);
    const omittedLabel = rule === 'bip39-mnemonic' ? 'seed-phrase' : 'priv_key';
    assert.throws(() => requireLabel(mutant, rule, omittedLabel, value), new RegExp(`keyword filter lost ${omittedLabel}`));
    console.log(`killed keyword-prefilter mutation: ${rule}`);
  }
});

test('Gitleaks public metadata exceptions do not hide nearby credentials or key arrays', t => {
  const dir = fixture(t);
  const address = '0x' + 'abcdef1234'.repeat(4);
  assert.equal(scan(dir, config, `token0Address: "${address}"`).length, 0);
  // A public-address prefix cannot exempt an entire private-key finding.
  for (const publicAddress of ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42']) {
    const value = publicAddress + 'a1'.repeat(12);
    assert.ok(scan(dir, config, `private_key = "${value}"`).some(f => f.RuleID === 'blockchain-private-key-hex'));
  }
  const key = `api_key = "${synthetic.repeat(2)}"`;
  assert.ok(scan(dir, config, `token0Address: "${address}"; ${key}`).some(f => f.RuleID === 'generic-api-key'));
  assert.ok(scan(dir, config, samples['onepassword-service-account-token'], 'scripts/tests/nearby.test.sh').some(f => f.RuleID === 'onepassword-service-account-token'));
  assert.equal(scan(dir, config, 'def test_stops_consuming_an_oversized_stream_and_closes_response(): pass').length, 0);
  assert.ok(scan(dir, config, samples['solana-keypair-json'], 'registry/evidence/discovery-receipts-2026-09-16.json').some(f => f.RuleID === 'solana-keypair-json'));
  const indices = JSON.stringify(Array.from({ length: 64 }, (_, i) => i));
  assert.equal(scan(dir, config, indices, 'registry/evidence/discovery-receipts-2026-09-16.json').length, 0);
  assert.ok(scan(dir, config, indices, 'another.json').some(f => f.RuleID === 'solana-keypair-json'));
});

test('Gitleaks hash metadata exception is exact, rule-local, and AND-scoped', t => {
  const dir = fixture(t);
  const hash = createHash('sha256').update(`runtime-${synthetic}`).digest('hex');
  const valid = `"rawTokenSha256": "${hash}"`;
  const nearbyApiKey = `api_key = "${synthetic.repeat(2)}"`;
  const exactPath = 'registry/fixtures/rpc-chain-contract-cases.json';
  assert.equal(scan(dir, config, valid, exactPath).filter(f => f.RuleID === 'generic-api-key').length, 0);
  assert.ok(scan(dir, config, valid, `${exactPath}.bak`).some(f => f.RuleID === 'generic-api-key'));
  assert.ok(scan(dir, config, valid, 'registry/fixtures/rpc-chain-contract-cases.jsonx').some(f => f.RuleID === 'generic-api-key'));
  assert.ok(scan(dir, config, valid, 'registry/fixtures/rpc-chain-contract-cases-copy.json').some(f => f.RuleID === 'generic-api-key'));
  assert.ok(scan(dir, config, valid.replaceAll('a', 'A'), exactPath).some(f => f.RuleID === 'generic-api-key'));
  assert.ok(scan(dir, config, valid.replace(hash, `${hash}f`), exactPath).some(f => f.RuleID === 'generic-api-key'));
  assert.ok(scan(dir, config, valid.replace(hash, `g${hash.slice(1)}`), exactPath).some(f => f.RuleID === 'generic-api-key'));
  assert.ok(scan(dir, config, `${valid}; ${nearbyApiKey}`, exactPath).some(f => f.RuleID === 'generic-api-key'));
  assert.ok(scan(dir, config, `private_key = "${'b'.repeat(64)}"`, exactPath).some(f => f.RuleID === 'blockchain-private-key-hex'));

  const start = config.lastIndexOf('[[rules.allowlists]]');
  const exactBlock = config.slice(start);
  const broad = config.replace(exactBlock, exactBlock.replace('condition = "AND"', 'condition = "OR"'));
  assert.ok(scan(dir, config, nearbyApiKey, exactPath).some(f => f.RuleID === 'generic-api-key'));
  assert.equal(scan(dir, broad, nearbyApiKey, exactPath).some(f => f.RuleID === 'generic-api-key'), false, 'AND-to-OR mutation must be observable');
});

function requiredScript(source) {
  const block = source.split('      - name: Require every required CI job to pass\n')[1]?.split('\n  source-binding:')[0];
  assert.ok(block);
  return block.split('        run: |\n')[1].split('\n').map(line => line.slice(10)).join('\n');
}
test('required-ci rejects both new gates on failure, skip, cancellation, or missing result', () => {
  const source = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const script = requiredScript(source);
  const names = [...script.matchAll(/\$([A-Z0-9_]+_RESULT)/gu)].map(m => m[1]);
  const env = Object.fromEntries(names.map(name => [name, 'success']));
  assert.equal(run(shell, ['-c', script], root, env).status, 0);
  for (const job of ['oss-hygiene', 'oss-hygiene-bash32']) {
    const required = source.split('  required-ci:\n')[1].split('\n  source-binding:')[0];
    assert.ok(required.includes(`      - ${job}\n`));
    const variable = required.match(new RegExp(`([A-Z0-9_]+_RESULT): \\$\\{\\{ needs\\.${job}\\.result \\}\\}`))?.[1];
    assert.ok(variable, `missing result binding ${job}`);
    for (const value of ['failure', 'skipped', 'cancelled', '']) {
      assert.notEqual(run(shell, ['-c', script], root, { ...env, [variable]: value }).status, 0);
    }
    const mutant = script.replace(`test "$${variable}" = success`, ':');
    assert.equal(run(shell, ['-c', mutant], root, { ...env, [variable]: 'failure' }).status, 0, 'removing the control must reproduce the defect');
  }
});

test('removing either pre-commit scanner fails the actual Lefthook integration test', t => {
  const dir = fixture(t);
  const source = readFileSync(join(root, 'lefthook.yml'), 'utf8');
  for (const command of ['bash scripts/run-gitleaks.sh protect --staged --redact --config .gitleaks.toml', 'bash scripts/check-oss-hygiene.sh --staged']) {
    assert.ok(source.includes(command));
    writeFileSync(join(dir, 'lefthook.yml'), source.replace(command, 'echo scanner-disabled'));
    const result = run(shell, ['scripts/tests/oss-hooks.test.sh'], dir);
    assert.notEqual(result.status, 0, `survived hook deletion ${command}`);
    assert.match(result.output, /missing hook call|FAIL pre-commit accepted/u);
  }
});
