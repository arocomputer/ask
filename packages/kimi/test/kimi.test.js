/*
 * Tests for the kimi agent. Each runs agents/kimi as ask does (prompt on stdin, ASK_* env, answer
 * on stdout, report in $ASK_REPORT), driving the fake kimi in ./bin. No network, no real models.
 * Run: node --test
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, readJson, readJsonl } from '../../../src/test/baymax/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, '..', 'agents', 'kimi');
const { nodeDir: NODE_DIR, tmp, env: offlineEnv, launch } = offline(AGENT, join(HERE, 'bin'));
const GROUNDING = 'Answer from the files in your working directory: search and read them before answering. Never guess file names, functions or facts; if you cannot find something, say so.\n\n';

/* Runs the agent on one prompt; resolves with { code, stdout, stderr, report, calls } (the fake's recorded runs). */
async function run(prompt, { model = 'kimi-for-coding', effort = '', access = 'read', extra = {} } = {}) {
  const env = offlineEnv({ FAKE_LOG: join(tmp(), 'calls.jsonl'), FAKE_STATE: join(tmp(), 'state.json'), ASK_MODEL: model, ASK_EFFORT: effort, ASK_ACCESS: access, ASK_REPORT: join(tmp(), 'report.json'), ...extra });
  const r = await launch([], env, prompt);
  return { ...r, report: readJson(env.ASK_REPORT), calls: readJsonl(env.FAKE_LOG) };
}

const BUNDLED = join(HERE, '..', 'lib', 'read-agent.md');
const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
const promptOf = (call) => call.argv.find((a) => a.startsWith('--prompt=')).slice('--prompt='.length);

test('lists each configured model by its model id, or by alias when several aliases share the id', async () => {
  const r = await launch(['models'], offlineEnv());
  assert.equal(r.stdout, 'kimi-for-coding\tKimi for Coding\nk3\tk3\na/shared\tshared\nb/shared\tshared\n');
});

test('passes the exact alias to -m, matched by model id or alias in any case', async () => {
  for (const model of ['kimi-for-coding', 'KIMI-CODE/Kimi-For-Coding', 'k3']) {
    const call = (await run('hi', { model })).calls.at(-1);
    assert.equal(after(call.argv, '-m'), model.toLowerCase() === 'k3' ? 'moon/k3' : 'kimi-code/kimi-for-coding');
  }
});

test('refuses an unknown model, or a model id that several aliases share, without running kimi', async () => {
  const unknown = await run('hi', { model: 'nope' });
  const shared = await run('hi', { model: 'shared' });
  assert.match(unknown.stderr, /no Kimi model named nope/);
  assert.match(shared.stderr, /a\/shared, b\/shared/);
  assert.deepEqual([...unknown.calls, ...shared.calls], []);
});

test('refuses an effort, which kimi -p cannot take', async () => {
  const r = await run('hi', { effort: 'max' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no reasoning-effort/);
  assert.deepEqual(r.calls, []);
});

test('read runs bind the bundled agent file, which allows only Read, Grep and Glob', async () => {
  const [call] = (await run('look')).calls;
  assert.equal(after(call.argv, '--agent-file'), BUNDLED);
  assert.match(call.agentFile, /^tools:\n {2}- Read\n {2}- Grep\n {2}- Glob\n---\n\n\$\{base_prompt\}$/m);
  assert.ok(!call.argv.includes('--yolo') && !call.argv.includes('--plan'));
});

test('a read session resumes after every temporary file of its first run is gone, still restricted', async () => {
  const first = await run('look', { extra: { TMPDIR: join(tmp(), 't1') } });
  rmSync(join(tmp(), 't1'), { recursive: true, force: true });
  mkdirSync(join(tmp(), 't2'));
  const second = await run('more', { extra: { TMPDIR: join(tmp(), 't2'), ASK_SESSION: first.report.session } });
  assert.equal(second.code, 0);
  assert.equal(second.stdout, 'kimi: more\n');
  assert.match(second.calls.at(-1).restored, /^tools:\n {2}- Read\n {2}- Grep\n {2}- Glob$/m);
  assert.equal(second.report.session, first.report.session);
});

test('write runs use the default agent', async () => {
  const [call] = (await run('change', { access: 'write' })).calls;
  assert.ok(!call.argv.includes('--agent-file'));
});

test('a new read run is told to answer from the files; write runs and follow-ups get the prompt as is', async () => {
  const read = (await run('where is main?')).calls[0];
  const write = (await run('fix it', { access: 'write' })).calls[1];
  const followUp = (await run('and then?', { extra: { ASK_SESSION: 'ask-read:sess-1' } })).calls[2];
  assert.equal(promptOf(read), `${GROUNDING}where is main?`);
  assert.equal(promptOf(write), 'fix it');
  assert.equal(promptOf(followUp), 'and then?');
});

test('reports a read session as ask-read:ID and a write session as the ID, and resumes it', async () => {
  assert.equal((await run('hi')).report.session, 'ask-read:sess-fake');
  assert.equal((await run('hi', { access: 'write' })).report.session, 'sess-fake');
  const call = (await run('more', { extra: { ASK_SESSION: 'ask-read:sess-1' } })).calls.at(-1);
  assert.equal(after(call.argv, '--session'), 'sess-1');
  assert.ok(!call.argv.includes('--agent-file'));
});

test('refuses to continue a session with the other access, since Kimi keeps the agent it was started with', async () => {
  const toRead = await run('more', { extra: { ASK_SESSION: 'sess-1' } });
  const toWrite = await run('more', { access: 'write', extra: { ASK_SESSION: 'ask-read:sess-1' } });
  assert.match(toRead.stderr, /started with write access/);
  assert.match(toWrite.stderr, /started read-only/);
  assert.deepEqual([...toRead.calls, ...toWrite.calls], []);
});

test('a write run never binds the read agent, and a bare id never reaches a read session through a read run', async () => {
  const write = await run('change', { access: 'write' });
  assert.ok(!write.calls[0].argv.includes('--agent-file'));
  assert.equal(write.report.session, 'sess-fake');
  const bare = await run('look', { extra: { ASK_SESSION: write.report.session } });
  assert.match(bare.stderr, /started with write access/);
  const empty = await run('look', { extra: { ASK_SESSION: 'ask-read:' } });
  assert.match(empty.stderr, /empty session id/);
  assert.equal(empty.calls.length, 1, "only the write run started kimi");
});

test('answers with the last assistant message after any tool turns, and reports the model name', async () => {
  const r = await run('hi', { extra: { FAKE_TOOLS: '1' } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'kimi: hi\n');
  assert.equal(r.report.name, 'Kimi for Coding');
});

test('runs kimi without KIMI_MODEL_* variables that could define another model', async () => {
  const [call] = (await run('hi', { extra: { KIMI_MODEL_NAME: 'other' } })).calls;
  assert.equal(call.modelEnv, null);
});

test('fails with the last line kimi printed on stderr', async () => {
  const r = await run('please explode', { extra: { FAKE_FAIL: 'explode' } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'kimi boom\n');
});

test('refuses a prompt too large for one argument', async () => {
  const r = await run('x'.repeat(100001));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /prompt too large/);
});

test('explains how to install Kimi Code when it is missing', async () => {
  const r = await launch([], offlineEnv({ PATH: NODE_DIR, ASK_MODEL: 'k3', ASK_ACCESS: 'read' }), 'hi');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Kimi Code not found/);
});
