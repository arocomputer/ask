/* Runs the package launcher against a fake CLI, exercising ask's stdin/env/report contract. */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, readJson, readJsonl } from '../../../src/test/integration/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NAME = 'vibe';
const BIN = join(HERE, 'bin', 'vibe');
const MODEL = 'model-1.0';
const { tmp, env: offlineEnv, launch } = offline(join(HERE, '..', 'agents', NAME));

/* Invokes the actual shell launcher in the test's scratch directory, against the fake CLI only. */
async function run(extra = {}, args = [], input = 'task') {
  const env = offlineEnv({
    ASK_NODE: process.execPath,
    ASK_MODEL: MODEL, ASK_ACCESS: 'write', ASK_REPORT: join(tmp(), 'report.json'),
    FAKE_LOG: join(tmp(), 'calls.jsonl'),
    VIBE_MODELS: JSON.stringify([
      { name: MODEL, provider: 'test', alias: 'shortcut', input_price: 2 },
      { name: 'other-2.0', provider: 'test', alias: 'other' },
    ]),
    [`ASK_${NAME.toUpperCase()}_BIN`]: BIN,
    ...extra,
  });
  const r = await launch(args, env, input);
  return { ...r, calls: readJsonl(env.FAKE_LOG), report: readJson(env.ASK_REPORT, {}) };
}

const after = (args, flag) => args[args.indexOf(flag) + 1];

test('models fails readiness when the selected CLI executable is missing', async () => {
  const r = await run({ ASK_VIBE_BIN: '/does-not-exist/ask-test-vibe' }, ['models']);
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

test('lists explicit backend names, excluding mutable aliases', async () => {
  const r = await run({}, ['models']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'model-1.0\nother-2.0\n');
});

test('pins backend definition and preserves model pricing while allowing writes', async () => {
  const r = await run({ ASK_MODEL: 'MODEL-1.0', ASK_TITLE: 'title' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'final answer\n');
  const [call] = r.calls;
  assert.equal(call.stdin, 'task');
  assert.deepEqual(call.models, [{ name: MODEL, provider: 'test', alias: MODEL, input_price: 2 }]);
  assert.equal(call.active, MODEL);
  assert.deepEqual(call.allowed, [MODEL]);
  assert.equal(after(call.args, '--output'), 'streaming');
  assert.equal(after(call.args, '--agent'), 'auto-approve');
  assert.ok(call.args.includes('--auto-approve'));
  assert.ok(!call.args.includes('--enabled-tools'));
  assert.equal(r.report.session, 'vibe-session');
  assert.equal(r.report.cost, undefined);
  assert.equal(r.report.output, undefined);
});

test('refuses read access before profiles can override CLI tool filters', async () => {
  const r = await run({ ASK_ACCESS: 'read' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /profiles can override CLI tool filters/);
  assert.deepEqual(r.calls, []);
});

test('resumes an exact session and leaves follow-up prompts unchanged', async () => {
  const r = await run({ ASK_SESSION: 'vibe-session' });
  assert.equal(r.code, 0);
  assert.equal(after(r.calls[0].args, '--resume'), 'vibe-session');
  assert.equal(r.calls[0].stdin, 'task');
});

test('refuses unknown models before Vibe can fall back to its default', async () => {
  const r = await run({ ASK_MODEL: 'unknown-1.0' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /exactly one concrete model/);
  assert.deepEqual(r.calls, []);
});

test('refuses invalid access instead of allowing writes', async () => {
  const r = await run({ ASK_ACCESS: '' });
  assert.equal(r.code, 1);
  assert.deepEqual(r.calls, []);
});


test('passes cost limits to the native price cap', async () => {
  const r = await run({ ASK_MAX_COST: '0.50' });
  assert.equal(r.code, 0);
  assert.equal(after(r.calls[0].args, '--max-price'), '0.5');
});
