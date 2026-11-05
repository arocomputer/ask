/* Pi's installed adapter and core policy together; all credentials are local fixture strings. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { harness, root, selection } from './integration.mjs';

const names = selection(process.env.INTEGRATION_PACKAGES ? JSON.parse(process.env.INTEGRATION_PACKAGES) : []);
test('Pi environment fixture preserves auth and instructions while disabling integrations', {
  skip: (!process.env.INTEGRATION_ASK || !names.includes('pi')) && 'run via ./x integration pi',
}, async (t) => {
  const s = await harness('pi', process.env.INTEGRATION_ASK);
  t.after(s.cleanup);
  const path = join(s.env.ASK_HOME, 'environment.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const fixture = JSON.parse(readFileSync(join(root, 'packages/pi/test/fixtures/environment.json'), 'utf8'));
  config.agents.pi.integrations = fixture.agents.pi.integrations;
  writeFileSync(path, JSON.stringify(config));
  const authDir = join(s.home, 'custom-pi');
  mkdirSync(authDir);
  writeFileSync(join(authDir, 'auth.json'), '{"fixture":"not-a-real-credential"}');
  writeFileSync(join(authDir, 'models.json'), '{}');
  writeFileSync(join(s.work, 'AGENTS.md'), 'Keep the project policy.');
  const env = {
    PI_CODING_AGENT_DIR: authDir, OPENAI_API_KEY: 'fixture-key', AWS_SESSION_TOKEN: 'fixture-session',
    COPILOT_GITHUB_TOKEN: 'fixture-token', GOOGLE_APPLICATION_CREDENTIALS: join(s.home, 'adc.json'),
    UNRELATED_SECRET: 'private-sentinel',
  };
  for (const access of ['-r', '-w']) {
    const r = await s.run(['-m', 'pi:provider/model', '--wait', access, 'task'], env);
    assert.equal(r.code, 0, r.stderr);
    const call = s.calls().at(-1);
    assert.deepEqual(call.auth, { file: true, models: true, openai: true, awsSession: true, copilot: true, adc: true, unrelated: false, preload: false });
    for (const flag of ['--no-mcp', '--no-extensions', '--no-skills']) assert.ok(call.argv.includes(flag));
    for (const flag of ['--no-context-files', '--no-approve']) assert.ok(!call.argv.includes(flag));
    assert.equal(readFileSync(join(s.work, 'AGENTS.md'), 'utf8'), 'Keep the project policy.');
    assert.ok(!JSON.stringify(s.record(r)).includes('private-sentinel'));
    assert.ok(!r.stderr.includes('fixture-key'));
  }
  const before = s.calls().length;
  config.agents.pi.integrations.mcp = true;
  writeFileSync(path, JSON.stringify(config));
  const denied = await s.run(['-r', '-m', 'pi:provider/model', '--wait', 'task'], env);
  assert.equal(denied.code, 1);
  assert.equal(s.calls().length, before);
  assert.match(denied.stderr, /cannot enforce read/);
});

for (const [name, model, configVar, authNames] of [
  ['claude', 'haiku-4.5', 'CLAUDE_CONFIG_DIR', ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_IDENTITY_TOKEN_FILE']],
  ['codex', 'gpt-x', 'CODEX_HOME', ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'AZURE_OPENAI_API_KEY']],
  ['opencode', 'p/m', 'OPENCODE_CONFIG_DIR', ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'OPENCODE_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_API_KEY', 'GOOGLE_VERTEX_PROJECT', 'GITHUB_ENTERPRISE_TOKEN']],
]) test(`${name}: installed policy filters inheritance, preserves auth paths and honors explicit overrides`, {
  skip: (!process.env.INTEGRATION_ASK || !names.includes(name)) && `run via ./x integration ${name}`,
}, async (t) => {
  const s = await harness(name, process.env.INTEGRATION_ASK);
  t.after(s.cleanup);
  const authDir = join(s.home, 'auth-config');
  mkdirSync(authDir);
  writeFileSync(join(authDir, 'auth.json'), '{"fixture":"not-real"}');
  writeFileSync(join(authDir, 'config.toml'), 'model_provider = "fixture"\n');
  writeFileSync(join(s.work, 'AGENTS.md'), 'Preserve project policy.');
  const probe = join(s.bin, 'auth-probe');
  const log = join(s.dir, 'auth-probe.jsonl');
  const keys = [...authNames, 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'AZURE_FEDERATED_TOKEN_FILE', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'TEST_PROVIDER_KEY', 'UNRELATED_SECRET', 'NODE_OPTIONS'];
  // A subprocess wrapper observes the exact environment handed to every harness entry point,
  // including help, model listing and Codex's auxiliary naming server. No values enter its log.
  writeFileSync(probe, `#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const keys = ${JSON.stringify(keys)};
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  argv: process.argv.slice(2), home: process.env.HOME === ${JSON.stringify(s.home)},
  file: existsSync((process.env[${JSON.stringify(configVar)}] || '') + '/auth.json'),
  variables: Object.fromEntries(keys.map(k => [k, k in process.env])),
}) + '\\n');
const r = spawnSync(${JSON.stringify(join(root, 'packages', name, 'test', 'bin', name))}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(r.status ?? 1);
`, { mode: 0o755 });
  const env = {
    [`ASK_${name.toUpperCase()}_BIN`]: probe, [configVar]: authDir,
    ...Object.fromEntries(keys.filter(k => k !== 'NODE_OPTIONS').map(k => [k, 'fixture-not-real'])),
    // If this leaked it would break Node before the harness can respond.
    NODE_OPTIONS: '--require=/does/not/exist',
  };
  // A CA path should not provoke a runtime warning in the fixture's Node process.
  delete env.NODE_EXTRA_CA_CERTS;
  const path = join(s.env.ASK_HOME, 'environment.json');
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  for (const access of ['-r', '-w']) {
    const out = await s.run(['-m', `${name}:${model}`, '--wait', access, 'task'], env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stderr, /unavailable/, 'successful runs must show the integration limitation');
    assert.match(s.record(out).result.note, /unavailable/, 'limitation must survive in the saved run');
    const call = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1));
    assert.equal(call.home, true);
    assert.equal(call.file, true);
    for (const key of keys.filter(k => !['TEST_PROVIDER_KEY', 'UNRELATED_SECRET', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS'].includes(k))) assert.equal(call.variables[key], true, key);
    for (const key of ['TEST_PROVIDER_KEY', 'UNRELATED_SECRET', 'NODE_OPTIONS']) assert.equal(call.variables[key], false, key);
    assert.equal(readFileSync(join(s.work, 'AGENTS.md'), 'utf8'), 'Preserve project policy.');
    assert.ok(!JSON.stringify(s.record(out)).includes('fixture-not-real'));
  }
  policy.agents[name].inherit.push('TEST_PROVIDER_KEY');
  writeFileSync(path, JSON.stringify(policy));
  const overridden = await s.run(['-m', `${name}:${model}`, '--wait', '-w', 'task'], env);
  assert.equal(overridden.code, 0, overridden.stderr);
  assert.equal(JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1)).variables.TEST_PROVIDER_KEY, true);
  const before = readFileSync(log, 'utf8');
  policy.agents[name].integrations = { plugins: false };
  writeFileSync(path, JSON.stringify(policy));
  const denied = await s.run(['-m', `${name}:${model}`, '--wait', '-w', 'task'], env);
  assert.equal(denied.code, 1);
  assert.match(s.record(denied).result.error, /cannot.*enforce/);
  assert.equal(readFileSync(log, 'utf8'), before);
});
