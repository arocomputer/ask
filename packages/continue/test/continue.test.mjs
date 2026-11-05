/* Runs the package launcher against a fake CLI, exercising ask's stdin/env/report contract. */
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, readJson, readJsonl } from '../../../src/test/baymax/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NAME = 'continue';
const BIN = join(HERE, 'bin', 'cn');
const MODEL = 'model-1.0';
const { tmp, env: offlineEnv, launch } = offline(join(HERE, '..', 'agents', NAME));

/* Invokes the actual shell launcher in the test's scratch directory, against the fake CLI only. */
async function run(extra = {}, args = [], input = 'task') {
  const config = join(tmp(), 'config.json');
  writeFileSync(config, JSON.stringify({ name: 'test', version: '1', schema: 'v1', models: [
    { name: 'one', model: MODEL, provider: 'test', apiKey: 'fake-key' },
    { name: 'two', model: 'other-2.0', provider: 'test' },
  ] }));
  const env = offlineEnv({
    ASK_NODE: process.execPath,
    ASK_MODEL: MODEL, ASK_ACCESS: 'write', ASK_REPORT: join(tmp(), 'report.json'),
    FAKE_LOG: join(tmp(), 'calls.jsonl'), ASK_CONTINUE_CONFIG: config,
    [`ASK_${NAME.toUpperCase()}_BIN`]: BIN,
    ...extra,
  });
  const r = await launch(args, env, input);
  return { ...r, calls: readJsonl(env.FAKE_LOG), report: readJson(env.ASK_REPORT, {}) };
}

const after = (args, flag) => args[args.indexOf(flag) + 1];

test('models fails readiness when the selected CLI executable is missing', async () => {
  const r = await run({ ASK_CONTINUE_BIN: '/does-not-exist/ask-test-cn' }, ['models']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /CLI not found/);
  assert.equal(r.stdout, '');
});

test('requires an explicit model before starting the CLI', async () => {
  const r = await run({ ASK_MODEL: '' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /explicit ASK_MODEL/);
  assert.deepEqual(r.calls, []);
});

test('rejects unsupported effort before starting the CLI', async () => {
  const r = await run({ ASK_EFFORT: 'high' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /effort flag/);
  assert.deepEqual(r.calls, []);
});

test('fails on a CLI error without leaking its diagnostics or returning a partial answer', async () => {
  const r = await run({ FAKE_MODE: 'error' });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /exit 7/);
  assert.doesNotMatch(r.stderr, /secret-provider-diagnostic/);
});

test('fails on an empty answer', async () => {
  const r = await run({ FAKE_MODE: 'empty' });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /no.*answer/);
});

test('reports a missing CLI as failure', async () => {
  const r = await run({ [`ASK_${NAME.toUpperCase()}_BIN`]: '/nonexistent/ask-fake-cli' });
  assert.equal(r.code, 1);
  assert.deepEqual(r.calls, []);
});

test('refuses an empty prompt before invoking the CLI', async () => {
  const r = await run({}, [], '  ');
  assert.equal(r.code, 1);
  assert.deepEqual(r.calls, []);
});

test('lists concrete backend ids from explicit config', async () => {
  const r = await run({}, ['models']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'model-1.0\nother-2.0\n');
  assert.deepEqual(r.calls, []);
});

test('pins one configured model and allows write tools with the prompt on stdin', async () => {
  const r = await run({ ASK_MODEL: 'MODEL-1.0', ASK_TITLE: 'title' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'answer: task\n');
  const [call] = r.calls;
  assert.equal(call.stdin, 'task');
  assert.deepEqual(call.config.models, [{ name: 'one', model: MODEL, provider: 'test', apiKey: 'fake-key' }]);
  assert.ok(call.args.includes('-p'));
  assert.ok(call.args.includes('--silent'));
  assert.equal(after(call.args, '--allow'), '*');
  assert.equal(existsSync(after(call.args, '--config')), false);
  assert.equal(r.report.session, undefined);
  assert.equal(r.report.cost, undefined);
});

test('refuses read access before invoking cn', async () => {
  const r = await run({ ASK_ACCESS: 'read' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /read runs are unsupported/);
  assert.deepEqual(r.calls, []);
});

test('refuses latest-session resumption and session forks', async () => {
  const r = await run({ ASK_SESSION: 'session' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot resume a specific session/);
  assert.deepEqual(r.calls, []);
});

test('rejects unconfigured or floating model ids', async () => {
  for (const id of ['unknown-1.0', 'latest']) {
    const r = await run({ ASK_MODEL: id });
    assert.equal(r.code, 1);
    assert.deepEqual(r.calls, []);
  }
});

test('rejects YAML rather than guessing its model config', async () => {
  const r = await run({ ASK_CONTINUE_CONFIG: '/nonexistent/config.yaml' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /readable JSON/);
  assert.deepEqual(r.calls, []);
});
