/*
 * Tests for the qwen agent. Each runs agents/qwen as ask does (prompt on stdin, ASK_* env, answer
 * on stdout, report in $ASK_REPORT), driving the fake qwen in ./bin with a fake QWEN_HOME. No
 * network, no real models. Run: node --test
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, readJson, readJsonl } from '../../../src/test/baymax/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, '..', 'agents', 'qwen');
const { nodeDir: NODE_DIR, tmp, env: offlineEnv, launch } = offline(AGENT, join(HERE, 'bin'));
// Qwen reads settings as JSON with comments; one id appears under two providers.
const SETTINGS = `{
  // models
  "modelProviders": {
    "openai": [{ "id": "qwen3.8-flash", "name": "Qwen 3.8 Flash" }, { "id": "Qwen3-Coder-Plus" }],
    "custom": [{ "id": "qwen3.8-flash" }, { "id": "dup-1" }, { "id": "dup-v1" }]
  }
}`;

beforeEach(() => {
  mkdirSync(join(tmp(), 'qwen'));
  writeFileSync(join(tmp(), 'qwen', 'settings.json'), SETTINGS);
});
const qwenEnv = (vars) => offlineEnv({ QWEN_HOME: join(tmp(), 'qwen'), ...vars });

/* Runs the agent on one prompt; resolves with { code, stdout, stderr, report, calls } (the fake's recorded calls). */
async function run(prompt, { model = 'qwen-3-coder-plus', effort = '', access = 'write', extra = {} } = {}) {
  const env = qwenEnv({ FAKE_LOG: join(tmp(), 'calls.jsonl'), ASK_MODEL: model, ASK_EFFORT: effort, ASK_ACCESS: access, ASK_REPORT: join(tmp(), 'report.json'), ...extra });
  const r = await launch([], env, prompt);
  return { ...r, report: readJson(env.ASK_REPORT), calls: readJsonl(env.FAKE_LOG) };
}

const after = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('lists the modelProviders models once each, by clean name unless that fits several ids', async () => {
  const r = await launch(['models'], qwenEnv());
  assert.equal(r.stdout, 'qwen-3.8-flash\tQwen 3.8 Flash\nqwen-3-coder-plus\tQwen3-Coder-Plus\ndup-1\tdup-1\ndup-v1\tdup-v1\n');
});

test('passes the exact modelProviders id to --model, matched by clean name or id in any case', async () => {
  for (const model of ['qwen-3-coder-plus', 'QWEN3-CODER-PLUS']) {
    const [call] = (await run('hi', { model })).calls;
    assert.equal(after(call.argv, '--model'), 'Qwen3-Coder-Plus');
  }
});

test('refuses a model Qwen was not set up with, or whose name fits several ids, without running qwen', async () => {
  const unknown = await run('hi', { model: 'nope' });
  const ambiguous = await run('hi', { model: 'dup-1' });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /no Qwen model named nope/);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /dup-1, dup-v1/);
  assert.deepEqual(ambiguous.calls, []);
});

test('refuses an effort, which Qwen Code cannot take', async () => {
  const r = await run('hi', { effort: 'max' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no reasoning-effort/);
  assert.deepEqual(r.calls, []);
});

test('refuses read runs, new or follow-up, without starting qwen: its tool list cannot be pinned', async () => {
  for (const extra of [{}, { ASK_SESSION: 'sess-1' }]) {
    const r = await run('look', { access: 'read', extra });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot be restricted to reading/);
    assert.deepEqual(r.calls, []);
  }
});

test('write runs approve every tool and pass the prompt as is', async () => {
  const [call] = (await run('change')).calls;
  assert.equal(after(call.argv, '--approval-mode'), 'yolo');
  assert.equal(call.stdin, 'change');
  for (const flag of ['--core-tools', '--exclude-tools', '--allowed-mcp-server-names']) assert.ok(!call.argv.includes(flag), flag);
});

test('reports the session and resumes it for a follow-up', async () => {
  assert.equal((await run('hi')).report.session, 'sess-fake');
  const call = (await run('more', { extra: { ASK_SESSION: 'sess-1' } })).calls.at(-1);
  assert.equal(after(call.argv, '--resume'), 'sess-1');
});

test('answers on stdout and reports the result usage and model name', async () => {
  const r = await run('hi');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'qwen: hi\n');
  assert.deepEqual(r.report, { session: 'sess-fake', name: 'Qwen3-Coder-Plus', input: 50, output: 7, cached: 10 });
});

test('fails with Qwen\'s own error message', async () => {
  const r = await run('please explode', { extra: { FAKE_FAIL: 'explode' } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'qwen boom\n');
});

test('fails when another model than the one asked for answers', async () => {
  const r = await run('hi', { extra: { FAKE_MODEL: 'qwen-turbo' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /answered with qwen-turbo, not Qwen3-Coder-Plus/);
  assert.equal(r.stdout, '');
});

test('explains how to install Qwen Code when it is missing, and lists no models then either', async () => {
  for (const args of [[], ['models']]) {
    const r = await launch(args, qwenEnv({ PATH: NODE_DIR, ASK_MODEL: 'qwen-3.8-flash', ASK_ACCESS: 'write' }), 'hi');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Qwen Code not found/);
    assert.equal(r.stdout, '');
  }
});
