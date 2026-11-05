/*
 * Tests for the codex agent. Each runs agents/codex as ask does (prompt on stdin, ASK_* env,
 * answer on stdout, report in $ASK_REPORT), driving the fake codex in ./bin. No network, no real
 * models. Run: node --test
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, pollJson, readJson, readJsonl } from '../../../src/test/baymax/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, '..', 'agents', 'codex');
const FAKE = join(HERE, 'bin', 'codex');
const { nodeDir: NODE_DIR, tmp, env: offlineEnv, launch } = offline(AGENT, join(HERE, 'bin'));

/*
 * Runs the agent on one prompt. Resolves with { code, stdout, stderr, report, calls }, where calls
 * are the fake CLI's recorded invocations.
 */
async function run(prompt, { model = 'gpt-x', effort = '', access = 'read', schema, extra = {} } = {}) {
  const env = offlineEnv({ CODEX_HOME: join(tmp(), 'codex'), FAKE_LOG: join(tmp(), 'calls.jsonl'), ASK_MODEL: model, ASK_EFFORT: effort, ASK_ACCESS: access, ASK_REPORT: join(tmp(), 'report.json'), ...extra });
  if (schema) writeFileSync((env.ASK_SCHEMA = join(tmp(), 'schema.json')), JSON.stringify(schema));
  const r = await launch([], env, prompt);
  return { ...r, report: readJson(env.ASK_REPORT), calls: readJsonl(env.FAKE_LOG) };
}

/* Runs `codex models` and resolves with its lines. */
async function models(extra = {}) {
  const r = await launch(['models'], offlineEnv({ CODEX_HOME: join(tmp(), 'codex'), ...extra }));
  return r.stdout.trim().split('\n').filter(Boolean);
}

const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
const GROUNDING = 'Answer from the files in your working directory: search and read them before answering. Never guess file names, functions or facts; if you cannot find something, say so.\n\n';

test('lists its model cache with display names, without review models', async () => {
  writeJson(join(tmp(), 'codex', 'models_cache.json'), { models: [{ slug: 'gpt-x', display_name: 'GPT-6.1-Sol' }, { slug: 'gpt-x-review' }] });
  assert.deepEqual(await models(), ['gpt-x\tGPT-6.1 Sol']);
});

test('matches model names without regard to case', async () => {
  const [call] = (await run('hi', { model: 'GPT-X' })).calls;
  assert.equal(after(call.argv, '-m'), 'gpt-x');
});

test('runs use the read-only sandbox, or workspace-write with network', async () => {
  const read = (await run('look')).calls[0];
  const write = (await run('change', { access: 'write' })).calls[1];
  assert.equal(after(read.argv, '--sandbox'), 'read-only');
  assert.equal(after(read.argv, '-m'), 'gpt-x');
  assert.equal(after(read.argv, '-C'), tmp());
  assert.ok(read.argv.includes('approval_policy="never"'));
  assert.ok(!read.argv.includes('sandbox_workspace_write.network_access=true'));
  assert.equal(after(write.argv, '--sandbox'), 'workspace-write');
  assert.ok(write.argv.includes('sandbox_workspace_write.network_access=true'));
});

test('a new read run is told to answer from the files; write runs and follow-ups get the prompt as is', async () => {
  const read = (await run('where is main?')).calls[0];
  const write = (await run('fix it', { access: 'write' })).calls[1];
  const followUp = (await run('and then?', { extra: { ASK_SESSION: 'fake' } })).calls[2];
  assert.equal(read.stdin, `${GROUNDING}where is main?`);
  assert.equal(write.stdin, 'fix it');
  assert.equal(followUp.stdin, 'and then?');
});

test('passes an effort as model_reasoning_effort', async () => {
  const [call] = (await run('hi', { effort: 'low' })).calls;
  assert.ok(call.argv.includes('model_reasoning_effort="low"'));
});

test('names the Codex thread through app-server from ASK_TITLE', async () => {
  const path = join(tmp(), 'title.json');
  const r = await run('fix tests', { extra: { ASK_TITLE: 'GPT-6.1 Sol · Fix tests · write', FAKE_TITLE_LOG: path } });
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  assert.deepEqual(readJson(path), { threadId: 'fake', name: 'GPT-6.1 Sol · Fix tests · write' });
});

test('answers on stdout and reports usage', async () => {
  const r = await run('hi');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'codex: hi\n');
  for (const [key, value] of Object.entries({ input: 100, output: 10, cached: 40 })) assert.equal(r.report[key], value, key);
});

test('reports usage while Codex is still running', async () => {
  const running = run('hi', { extra: { FAKE_PAUSE: '1500' } });
  const live = await pollJson(join(tmp(), 'report.json'), running, (report) => report.input > 0);
  assert.ok(live, 'no usage reported before the run finished');
  await running;
});

test('reports its display name', async () => {
  writeJson(join(tmp(), 'codex', 'models_cache.json'), { models: [{ slug: 'gpt-x', display_name: 'GPT-6.1-Sol' }] });
  assert.equal((await run('hi')).report.name, 'GPT-6.1 Sol');
});

test('fails a run whose Codex exited nonzero, with the reason last on stderr', async () => {
  const r = await run('hi', { extra: { FAKE_EXIT: '1' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr.trim().split('\n').pop(), /exit 1/);
});

test("a failing Codex's own message is the reason", async () => {
  const r = await run('break', { extra: { FAKE_FAIL: 'break' } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr.trim(), 'codex boom');
});

test('gets a strict schema: objects closed, every property required', async () => {
  const schema = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'object', properties: { c: { type: 'number' } } } } };
  const r = await run('go', { schema, extra: { FAKE_ANSWER: '{}' } });
  assert.deepEqual(r.calls[0].schema, {
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'object', properties: { c: { type: 'number' } }, required: ['c'], additionalProperties: false } },
    required: ['a', 'b'],
    additionalProperties: false,
  });
});

test('strict schemas leave a property named "properties" alone', async () => {
  const r = await run('go', { schema: { type: 'object', properties: { properties: { type: 'string' } } }, extra: { FAKE_ANSWER: '{"properties": "x"}' } });
  assert.deepEqual(r.calls[0].schema.properties, { properties: { type: 'string' } });
});

test('reports its thread as the session, and a follow-up resumes it with the sandbox as config', async () => {
  const first = await run('hi');
  assert.equal(first.report.session, 'fake');
  const second = await run('more', { extra: { ASK_SESSION: 'fake' } });
  const argv = second.calls[1].argv;
  assert.deepEqual(argv.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(argv.slice(-2), ['fake', '-']);
  assert.ok(argv.includes('sandbox_mode="read-only"'));
  assert.ok(!argv.includes('--sandbox') && !argv.includes('-C'));
});

test('finds Codex off PATH through ASK_CODEX_BIN', async () => {
  const r = await run('hi', { extra: { PATH: NODE_DIR, ASK_CODEX_BIN: FAKE } });
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
});

test('finds Codex off PATH where its installer puts it', async () => {
  mkdirSync(join(tmp(), '.local', 'bin'), { recursive: true });
  symlinkSync(FAKE, join(tmp(), '.local', 'bin', 'codex'));
  const r = await run('hi', { extra: { PATH: NODE_DIR } });
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
});

test('without Codex, models and runs fail saying how to install it', async () => {
  const extra = { ASK_CODEX_BIN: join(tmp(), 'missing') };
  const hint = /^Codex not found: install it from https:\/\/developers\.openai\.com\/codex, or set ASK_CODEX_BIN to its path\n$/;
  const listed = await launch(['models'], offlineEnv(extra));
  const ran = await run('hi', { extra });
  assert.equal(listed.code, 1);
  assert.match(listed.stderr, hint);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, hint);
});

// Node at a fixed location, as on CI runners, would be found whatever PATH says.
const fixedNode = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/home/linuxbrew/.linuxbrew/bin/node'].some(existsSync);
test('the launcher says how to get Node.js when it finds none', { skip: fixedNode && 'Node.js is installed at a fixed location' }, async () => {
  const empty = join(tmp(), 'empty');
  mkdirSync(empty);
  const r = await launch(['models'], { PATH: empty, HOME: empty });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'codex needs Node.js 18 or newer: install it from https://nodejs.org (or set ASK_NODE)\n');
});
