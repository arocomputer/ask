/* Runs the package launcher against a fake CLI, exercising ask's stdin/env/report contract. */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, readJson, readJsonl } from '../../../src/test/baymax/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NAME = 'openhands';
const BIN = join(HERE, 'bin', 'openhands');
const MODEL = 'model-1.0';
const { tmp, env: offlineEnv, launch } = offline(join(HERE, '..', 'agents', NAME));

/* Invokes the actual shell launcher in the test's scratch directory, against the fake CLI only. */
async function run(extra = {}, args = [], input = 'task') {
  const env = offlineEnv({
    ASK_NODE: process.execPath,
    ASK_MODEL: MODEL, ASK_ACCESS: 'write', ASK_REPORT: join(tmp(), 'report.json'),
    FAKE_LOG: join(tmp(), 'calls.jsonl'),
    [`ASK_${NAME.toUpperCase()}_BIN`]: BIN,
    ...extra,
  });
  const r = await launch(args, env, input);
  return { ...r, calls: readJsonl(env.FAKE_LOG), report: readJson(env.ASK_REPORT, {}) };
}

const after = (args, flag) => args[args.indexOf(flag) + 1];

test('models fails readiness when the selected CLI executable is missing', async () => {
  const r = await run({ ASK_OPENHANDS_BIN: '/does-not-exist/ask-test-openhands' }, ['models']);
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

test('leaves model enumeration to the user instead of guessing a catalog', async () => {
  const r = await run({}, ['models']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.deepEqual(r.calls, []);
});

test('uses explicit environment override, write approval and final finish text', async () => {
  const r = await run({ ASK_TITLE: 'title' }, [], '--task-like prompt');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'final answer\n');
  const [call] = r.calls;
  assert.equal(call.model, MODEL);
  assert.equal(after(call.args, '--task'), '--task-like prompt');
  for (const flag of ['--headless', '--json', '--always-approve', '--override-with-envs']) assert.ok(call.args.includes(flag));
  assert.equal(r.report.session, '0123456789abcdef0123456789abcdef');
  assert.equal(r.report.input, undefined);
  assert.equal(r.report.cost, undefined);
});

test('refuses read runs before starting OpenHands', async () => {
  const r = await run({ ASK_ACCESS: 'read' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /read runs are unsupported/);
  assert.deepEqual(r.calls, []);
});

test('resumes only the requested conversation', async () => {
  const r = await run({ ASK_SESSION: '0123456789abcdef0123456789abcdef' });
  assert.equal(r.code, 0);
  assert.equal(after(r.calls[0].args, '--resume'), '0123456789abcdef0123456789abcdef');
});

test('treats conversation error events as failure even with exit zero', async () => {
  const r = await run({ FAKE_MODE: 'event-error' });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.doesNotMatch(r.stderr, /secret-provider-diagnostic/);
  assert.equal(r.report.session, '0123456789abcdef0123456789abcdef');
});
