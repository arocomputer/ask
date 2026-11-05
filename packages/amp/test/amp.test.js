/*
 * Tests for the amp agent. Each runs agents/amp as ask does (prompt on stdin, ASK_* env, answer on
 * stdout, report in $ASK_REPORT), driving the fake amp in ./bin. No network, no account. Run:
 * node --test
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, readJson, readJsonl } from '../../../src/test/baymax/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, '..', 'agents', 'amp');
const { nodeDir: NODE_DIR, tmp, env: offlineEnv, launch } = offline(AGENT, join(HERE, 'bin'));

/* Runs the agent on one prompt. Resolves with { code, stdout, stderr, report, calls }, calls being the fake CLI's recorded invocations. */
async function run(prompt, { model = 'medium', effort = '', access = 'write', extra = {} } = {}) {
  const env = offlineEnv({ FAKE_LOG: join(tmp(), 'calls.jsonl'), ASK_MODEL: model, ASK_EFFORT: effort, ASK_ACCESS: access, ASK_REPORT: join(tmp(), 'report.json'), ...extra });
  const r = await launch([], env, prompt);
  return { ...r, report: readJson(env.ASK_REPORT), calls: readJsonl(env.FAKE_LOG) };
}

const after = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('lists Amp modes as the models', async () => {
  const r = await launch(['models'], offlineEnv());
  assert.deepEqual(r.stdout.trim().split('\n').map((line) => line.split('\t')[0]), ['low', 'medium', 'high', 'ultra']);
});

test('the model is the mode, with the prompt on stdin and every tool allowed', async () => {
  const r = await run('hello', { model: 'high', effort: 'max' });
  assert.equal(r.stdout, 'amp: hello\n');
  const [call] = r.calls;
  assert.equal(after(call.argv, '--mode'), 'high');
  assert.equal(after(call.argv, '--effort'), 'max');
  assert.ok(['--execute', '--stream-json', '--dangerously-allow-all'].every((flag) => call.argv.includes(flag)));
  assert.equal(call.stdin, 'hello');
});

test('read runs are refused without starting Amp', async () => {
  const r = await run('look', { access: 'read' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /read runs are refused/);
  assert.deepEqual(r.calls, []);
});

test('the thread is reported and continued, keeping its mode and title', async () => {
  const first = await run('one', { extra: { ASK_TITLE: 'Amp · one' } });
  assert.equal(first.report.session, '["medium","T-fake"]');
  assert.equal(after(first.calls[0].argv, '--title'), 'Amp · one');
  const call = (await run('two', { extra: { ASK_SESSION: first.report.session, ASK_TITLE: 'Amp · two' } })).calls.at(-1);
  assert.deepEqual(call.argv.slice(0, 3), ['threads', 'continue', 'T-fake']);
  assert.ok(!call.argv.includes('--mode') && !call.argv.includes('--title'));
  assert.equal(call.stdin, 'two');
});

test('usage is summed over the assistant messages', async () => {
  const { report } = await run('count');
  assert.deepEqual([report.input, report.output, report.cached, report.cost], [70, 14, 40, undefined]);
  assert.equal(report.name, 'Amp Medium');
});

test('continuation refuses a different routing mode before starting Amp', async () => {
  const r = await run('two', { model: 'high', extra: { ASK_SESSION: '["medium","T-fake"]' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot change the mode/);
  assert.deepEqual(r.calls, []);
});

test('an error result fails the run with Amp\'s reason', async () => {
  const r = await run('please fail', { extra: { FAKE_FAIL: 'fail' } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'amp boom\n');
  assert.equal(r.report.session, '["medium","T-fake"]');
});

test('says what to install when Amp is missing', async () => {
  const r = await launch([], offlineEnv({ PATH: NODE_DIR, ASK_MODEL: 'medium', ASK_ACCESS: 'write' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Amp not found/);
});
