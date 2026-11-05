/*
 * Tests for the goose agent. Each runs agents/goose as ask does (prompt on stdin, ASK_* env, answer
 * on stdout, report in $ASK_REPORT), driving the fake goose in ./bin. No network, no real models.
 * Run: node --test
 */
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, readJson, readJsonl } from '../../../src/test/integration/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, '..', 'agents', 'goose');
const FAKE = join(HERE, 'bin', 'goose');
const { nodeDir: NODE_DIR, tmp, env: offlineEnv, launch } = offline(AGENT, join(HERE, 'bin'));

/* Runs the agent on one prompt. Resolves with { code, stdout, stderr, report, calls }. */
async function run(prompt, { model = 'anthropic/claude-sonnet-5-5', effort = '', access = 'write', extra = {} } = {}) {
  const env = offlineEnv({ FAKE_LOG: join(tmp(), 'calls.jsonl'), ASK_MODEL: model, ASK_EFFORT: effort, ASK_ACCESS: access, ASK_REPORT: join(tmp(), 'report.json'), ...extra });
  const r = await launch([], env, prompt);
  return { ...r, report: readJson(env.ASK_REPORT), calls: readJsonl(env.FAKE_LOG) };
}

const after = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('lists no models, since Goose cannot', async () => {
  const r = await launch(['models'], offlineEnv());
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('refuses read runs without starting Goose', async () => {
  const r = await run('look', { access: 'read' });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
  assert.match(r.stderr, /^Goose cannot run read-only: .*; use -w\n$/);
});

test('write runs pass the prompt on stdin in auto mode, with provider and model split', async () => {
  const [call] = (await run('fix it')).calls;
  assert.deepEqual(call.argv.slice(0, 4), ['run', '-i', '-', '--output-format']);
  assert.equal(call.stdin, 'fix it');
  assert.equal(call.env.GOOSE_MODE, 'auto');
  assert.equal(after(call.argv, '--provider'), 'anthropic');
  assert.equal(after(call.argv, '--model'), 'claude-sonnet-5-5');
});

test('a model without a provider runs on the provider set up in Goose', async () => {
  const [call] = (await run('fix it', { model: 'gpt-6.1' })).calls;
  assert.ok(!call.argv.includes('--provider'));
  assert.equal(after(call.argv, '--model'), 'gpt-6.1');
});

test('passes an effort as GOOSE_THINKING_EFFORT and refuses one Goose would ignore', async () => {
  const [call] = (await run('fix it', { effort: 'high' })).calls;
  assert.equal(call.env.GOOSE_THINKING_EFFORT, 'high');
  const bad = await run('fix it', { effort: 'xxhigh' });
  assert.equal(bad.code, 1);
  assert.equal(bad.calls.length, 1);
  assert.equal(bad.stderr, 'Goose has no effort xxhigh; use one of off, low, medium, high, max\n');
});

test('answers with the text after the last tool call and reports usage', async () => {
  const r = await run('fix it');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'goose: fix it\n');
  for (const [key, value] of Object.entries({ input: 150, output: 17, cached: 40, cost: 0.003 })) assert.equal(r.report[key], value, key);
});

test('names a new session from ASK_TITLE, reports it, and a follow-up resumes it by name', async () => {
  const first = await run('fix it', { extra: { ASK_TITLE: 'Sonnet · Fix tests · write' } });
  const name = after(first.calls[0].argv, '--name');
  assert.match(name, /^Sonnet · Fix tests · write · [0-9a-f]{8}$/);
  assert.ok(!first.calls[0].argv.includes('--resume'));
  assert.equal(first.report.session, name);
  const second = await run('more', { extra: { ASK_SESSION: name } });
  assert.equal(after(second.calls[1].argv, '--name'), name);
  assert.ok(second.calls[1].argv.includes('--resume'));
  assert.equal(second.report.session, name);
});

test("a follow-up reports no usage, since Goose's totals include the earlier turns", async () => {
  const r = await run('more', { extra: { ASK_SESSION: 'Sonnet · Fix tests · write · 3f2a9c1e' } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.report, { session: 'Sonnet · Fix tests · write · 3f2a9c1e' });
});

test("a failing Goose's own message is the reason, and its session is kept", async () => {
  const r = await run('break', { extra: { FAKE_FAIL: 'break' } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'goose boom\n');
  assert.ok(r.report.session);
});

test('finds Goose off PATH where its installer puts it', async () => {
  mkdirSync(join(tmp(), '.local', 'bin'), { recursive: true });
  symlinkSync(FAKE, join(tmp(), '.local', 'bin', 'goose'));
  const r = await run('fix it', { extra: { PATH: NODE_DIR } });
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
});

test('without Goose, runs fail saying how to install it', async () => {
  const r = await run('fix it', { extra: { ASK_GOOSE_BIN: join(tmp(), 'missing') } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'Goose not found: install it from https://github.com/aaif-goose/goose, or set ASK_GOOSE_BIN to its path\n');
});
