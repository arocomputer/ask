/*
 * Tests for the kilo agent. Each runs agents/kilo as ask does (prompt on stdin, ASK_* env, answer on
 * stdout, report in $ASK_REPORT), driving the fake kilo in ./bin. No network, no real models.
 * Run: node --test
 */
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, readJson, readJsonl } from '../../../src/test/baymax/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, '..', 'agents', 'kilo');
const FAKE = join(HERE, 'bin', 'kilo');
const { nodeDir: NODE_DIR, tmp, env: offlineEnv, launch } = offline(AGENT, join(HERE, 'bin'));

/* Runs the agent on one prompt. Resolves with { code, stdout, stderr, report, calls }. */
async function run(prompt, { model = 'zeta/glm-5', effort = '', access = 'read', extra = {} } = {}) {
  const env = offlineEnv({ FAKE_LOG: join(tmp(), 'calls.jsonl'), ASK_MODEL: model, ASK_EFFORT: effort, ASK_ACCESS: access, ASK_REPORT: join(tmp(), 'report.json'), ...extra });
  const r = await launch([], env, prompt);
  return { ...r, report: readJson(env.ASK_REPORT), calls: readJsonl(env.FAKE_LOG) };
}

const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
const GROUNDING = 'Answer from the files in your working directory: search and read them before answering. Never guess file names, functions or facts; if you cannot find something, say so.\n\n';
const READ_ONLY = { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow' };

test('lists every model Kilo offers, once each by clean name', async () => {
  const r = await launch(['models'], offlineEnv());
  assert.deepEqual(r.stdout.trim().split('\n'), ['claude-sonnet-5.5', 'glm-5', 'qwen-3.8-flash']);
});

test('read runs use a fresh injected agent allowed only read, grep and glob, also the default agent', async () => {
  const { calls } = await run('look');
  const again = (await run('look again')).calls[1];
  const agent = after(calls[0].argv, '--agent');
  assert.match(agent, /^ask-read-[0-9a-f-]{36}$/);
  assert.notEqual(after(again.argv, '--agent'), agent);
  assert.ok(!calls[0].argv.includes('--auto'));
  assert.deepEqual(calls[0].config, {
    default_agent: agent,
    agent: { [agent]: { mode: 'primary', description: 'Read-only agent for ask: reads and searches files, changes nothing.', steps: 25, permission: READ_ONLY } },
  });
  assert.equal(calls[0].env.GIT_OPTIONAL_LOCKS, '0');
});

test('write runs use the code agent with --auto and the larger step cap', async () => {
  const [call] = (await run('change', { access: 'write' })).calls;
  assert.equal(after(call.argv, '--agent'), 'code');
  assert.ok(call.argv.includes('--auto'));
  assert.deepEqual(call.config, { agent: { code: { steps: 100 } } });
});

test('a new read run is told to answer from the files; write runs and follow-ups get the prompt as is', async () => {
  const read = (await run('where is main?')).calls[0];
  const write = (await run('fix it', { access: 'write' })).calls[1];
  const followUp = (await run('and then?', { extra: { ASK_SESSION: 'ses_kilo' } })).calls[2];
  assert.equal(read.stdin, `${GROUNDING}where is main?`);
  assert.equal(write.stdin, 'fix it');
  assert.equal(followUp.stdin, 'and then?');
});

test('passes the effort as the variant and ASK_TITLE as the session title', async () => {
  const [call] = (await run('hi', { effort: 'high', extra: { ASK_TITLE: 'GLM 5 · Fix tests · read' } })).calls;
  assert.equal(after(call.argv, '--variant'), 'high');
  assert.equal(after(call.argv, '--title'), 'GLM 5 · Fix tests · read');
});

test('runs a clean model name as its listed id, preferring the kilo provider, and a provider/model id as it is', async () => {
  const sonnet = (await run('hi', { model: 'Claude-Sonnet-5.5' })).calls[0];
  const chosen = (await run('hi', { model: 'claude-sonnet-5.5', extra: { ASK_KILO_PROVIDER: 'anthropic' } })).calls[1];
  const first = (await run('hi', { model: 'glm-5' })).calls[2];
  const exact = (await run('hi', { model: 'zeta/glm-5' })).calls[3];
  assert.equal(after(sonnet.argv, '-m'), 'kilo/anthropic/claude-sonnet-5.5');
  assert.equal(after(chosen.argv, '-m'), 'anthropic/claude-sonnet-5.5');
  assert.equal(after(first.argv, '-m'), 'beta/glm-5');
  assert.equal(after(exact.argv, '-m'), 'zeta/glm-5');
});

test('refuses a model name it cannot find', async () => {
  const r = await run('hi', { model: 'nope-1.0' });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
  assert.equal(r.stderr, 'no Kilo model named nope-1.0; see kilo models\n');
});

test('answers on stdout and reports session and usage summed over steps', async () => {
  const r = await run('hi', { extra: { FAKE_STEPS: '2' } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'kilo: hi\n');
  for (const [key, value] of Object.entries({ session: 'ses_kilo', input: 100, output: 14, cached: 20, cost: 0.004 })) assert.equal(r.report[key], value, key);
});

test('a follow-up continues the session', async () => {
  const [call] = (await run('more', { extra: { ASK_SESSION: 'ses_kilo' } })).calls;
  assert.equal(after(call.argv, '--session'), 'ses_kilo');
});

test('a run that hits the step cap notes its answer may be partial', async () => {
  const r = await run('look', { extra: { FAKE_STEPS: '25' } });
  assert.equal(r.code, 0);
  assert.match(r.report.note, /hit step cap/);
});

test("a failing Kilo's own message is the reason", async () => {
  const r = await run('break', { extra: { FAKE_FAIL: 'break' } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'kilo boom\n');
});

test("a Kilo that exits nonzero fails with its stderr's last line", async () => {
  const r = await run('hi', { extra: { FAKE_EXIT: '1', FAKE_STDERR: 'run ended with an auto-rejected permission' } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'run ended with an auto-rejected permission\n');
});

test('finds Kilo off PATH where its installer puts it', async () => {
  mkdirSync(join(tmp(), '.kilo', 'bin'), { recursive: true });
  symlinkSync(FAKE, join(tmp(), '.kilo', 'bin', 'kilo'));
  const r = await run('hi', { extra: { PATH: NODE_DIR } });
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
});

test('without Kilo, runs fail saying how to install it', async () => {
  const r = await run('hi', { extra: { ASK_KILO_BIN: join(tmp(), 'missing') } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'Kilo not found: install it from https://kilo.ai/cli, or set ASK_KILO_BIN to its path\n');
});
