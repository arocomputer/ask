/*
 * Tests for the cursor agent. Each runs agents/cursor as ask does (prompt on stdin, ASK_* env,
 * answer on stdout, report in $ASK_REPORT), driving the fake agent in ./bin. No network, no
 * account. Run: node --test
 */
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, readJson, readJsonl } from '../../../src/test/baymax/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, '..', 'agents', 'cursor');
const { nodeDir: NODE_DIR, tmp, env: offlineEnv, launch } = offline(AGENT, join(HERE, 'bin'));

/* Runs the agent on one prompt. Resolves with { code, stdout, stderr, report, calls }, calls being the fake CLI's recorded invocations. */
async function run(prompt, { model = 'gpt-5', effort = '', access = 'write', extra = {} } = {}) {
  const env = offlineEnv({ FAKE_LOG: join(tmp(), 'calls.jsonl'), ASK_MODEL: model, ASK_EFFORT: effort, ASK_ACCESS: access, ASK_REPORT: join(tmp(), 'report.json'), ...extra });
  const r = await launch([], env, prompt);
  return { ...r, report: readJson(env.ASK_REPORT), calls: readJsonl(env.FAKE_LOG) };
}

const after = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('write runs pass the model and the prompt as the argument, forcing changes', async () => {
  const r = await run('hello');
  assert.equal(r.stdout, 'hello\n');
  const [{ argv, cwd }] = r.calls;
  assert.deepEqual(argv, ['-p', '--force', '--trust', '--output-format', 'stream-json', '--model', 'gpt-5', 'hello']);
  assert.equal(cwd, tmp());
});

test('read runs are refused without starting Cursor', async () => {
  const r = await run('look', { access: 'read' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /read runs are refused/);
  assert.deepEqual(r.calls, []);
});

test('an effort is refused, since Cursor takes it in the model id', async () => {
  const r = await run('hi', { effort: 'high' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /effort in the model id/);
  assert.deepEqual(r.calls, []);
});

test('the answer is the last message, not the result that joins them all', async () => {
  const r = await run('q', { extra: { FAKE_ANSWER: 'The answer.' } });
  assert.equal(r.stdout, 'The answer.\n');
});

test('the session and model name are reported and the session continued', async () => {
  const first = await run('one');
  assert.deepEqual([first.report.session, first.report.name], ['chat-fake', 'Fake Model']);
  const call = (await run('two', { extra: { ASK_SESSION: 'chat-9' } })).calls.at(-1);
  assert.equal(after(call.argv, '--resume'), 'chat-9');
});

test('a prompt starting with a dash is not read as an option', async () => {
  const [{ argv }] = (await run('--force-delete everything')).calls;
  assert.equal(argv.at(-1), ' --force-delete everything');
});

test('an error result and a failed exit fail the run with Cursor\'s reason', async () => {
  const result = await run('x', { extra: { FAKE_ERROR_RESULT: '1' } });
  assert.deepEqual([result.code, result.stderr], [1, 'cursor refused\n']);
  const exit = await run('please fail', { extra: { FAKE_FAIL: 'fail' } });
  assert.deepEqual([exit.code, exit.stderr], [1, 'cursor boom\n']);
  assert.equal(exit.report.session, 'chat-fake');
});

test('lists no models, since Cursor\'s depend on the account', async () => {
  const r = await launch(['models'], offlineEnv());
  assert.equal(r.stdout, '');
});

test('finds the cursor-agent name when there is no agent', async () => {
  const bin = join(tmp(), 'bin');
  mkdirSync(bin);
  symlinkSync(join(HERE, 'bin', 'agent'), join(bin, 'cursor-agent'));
  const r = await launch([], offlineEnv({ PATH: `${bin}:${NODE_DIR}`, ASK_MODEL: 'gpt-5', ASK_ACCESS: 'write' }), 'hi');
  assert.equal(r.stdout, 'hi\n');
});

test('says what to install when Cursor is missing', async () => {
  const r = await launch([], offlineEnv({ PATH: NODE_DIR, ASK_MODEL: 'gpt-5', ASK_ACCESS: 'write' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Cursor not found/);
});
