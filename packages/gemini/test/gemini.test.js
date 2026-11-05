/*
 * Tests for the gemini agent. Each runs agents/gemini as ask does (prompt on stdin, ASK_* env,
 * answer on stdout, report in $ASK_REPORT), driving the fake gemini in ./bin. No network, no real
 * models. Run: node --test
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, readJson, readJsonl } from '../../../src/test/integration/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, '..', 'agents', 'gemini');
const FAKE = join(HERE, 'bin', 'gemini');
const { nodeDir: NODE_DIR, tmp, env: offlineEnv, launch } = offline(AGENT, join(HERE, 'bin'));

/*
 * Runs the agent on one prompt. Resolves with { code, stdout, stderr, report, calls }, where calls
 * are the fake CLI's recorded invocations.
 */
async function run(prompt, { model = 'gemini-3.5-flash', effort = '', access = 'read', extra = {} } = {}) {
  const env = offlineEnv({ FAKE_LOG: join(tmp(), 'calls.jsonl'), ASK_MODEL: model, ASK_EFFORT: effort, ASK_ACCESS: access, ASK_REPORT: join(tmp(), 'report.json'), ...extra });
  const r = await launch([], env, prompt);
  return { ...r, report: readJson(env.ASK_REPORT), calls: readJsonl(env.FAKE_LOG) };
}

const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
const GROUNDING = 'Answer from the files in your working directory: search and read them before answering. Never guess file names, functions or facts; if you cannot find something, say so.\n\n';

test('lists the models Gemini CLI uses by default, with display names', async () => {
  const r = await launch(['models'], offlineEnv());
  assert.deepEqual(r.stdout.trim().split('\n'), ['gemini-3.1-pro-preview\tGemini 3.1 Pro Preview', 'gemini-2.5-pro\tGemini 2.5 Pro', 'gemini-3.5-flash\tGemini 3.5 Flash', 'gemini-3.1-flash-lite\tGemini 3.1 Flash Lite']);
});

test('read runs use plan mode under an admin policy that allows only reading tools', async () => {
  const [call] = (await run('look')).calls;
  assert.equal(after(call.argv, '--approval-mode'), 'plan');
  assert.match(call.policy, /toolName = "\*"\ndecision = "deny"\npriority = 998/);
  assert.match(call.policy, /toolName = \["read_file", "read_many_files", "list_directory", "glob", "grep_search"\]\ndecision = "allow"\npriority = 999/);
  assert.equal(call.gitLocks, '0');
});

test('write runs use yolo mode without the read policy', async () => {
  const [call] = (await run('change', { access: 'write' })).calls;
  assert.equal(after(call.argv, '--approval-mode'), 'yolo');
  assert.equal(call.policy, null);
  assert.equal(call.gitLocks, null);
});

test('a new read run is told to answer from the files; write runs and follow-ups get the prompt as is', async () => {
  const read = (await run('where is main?')).calls[0];
  const write = (await run('fix it', { access: 'write' })).calls[1];
  const followUp = (await run('and then?', { extra: { ASK_SESSION: 'sess' } })).calls[2];
  assert.equal(read.stdin, `${GROUNDING}where is main?`);
  assert.equal(write.stdin, 'fix it');
  assert.equal(followUp.stdin, 'and then?');
});

test('runs a model by its id in any case, and refuses aliases and efforts', async () => {
  const [call] = (await run('hi', { model: 'Gemini-3.5-Flash' })).calls;
  assert.equal(after(call.argv, '--model'), 'gemini-3.5-flash');
  const alias = await run('hi', { model: 'flash' });
  const effort = await run('hi', { effort: 'high' });
  assert.equal(alias.code, 1);
  assert.match(alias.stderr, /"flash" is an alias; name the exact model, like gemini:gemini-3.5-flash/);
  assert.equal(effort.code, 1);
  assert.equal(effort.stderr, 'Gemini CLI has no effort option; drop #high\n');
  assert.equal(effort.calls.length, 1);
});

test('a new run reports its session id at once; a follow-up resumes it', async () => {
  const first = await run('hi');
  const id = first.report.session;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(after(first.calls[0].argv, '--session-id'), id);
  const second = await run('more', { extra: { ASK_SESSION: id } });
  assert.equal(after(second.calls[1].argv, '--resume'), id);
  assert.ok(!second.calls[1].argv.includes('--session-id'));
});

test("answers with the last turn's text and reports usage, thinking counted as output", async () => {
  const r = await run('hi', { extra: { FAKE_TOOLS: '1' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'gemini: hi\n');
  assert.deepEqual([r.report.input, r.report.output, r.report.cached, r.report.cost], [120, 12, 40, undefined]);
  assert.equal(r.report.name, 'Gemini 3.5 Flash');
});

test("a failing Gemini CLI's own message is the reason", async () => {
  const r = await run('break', { extra: { FAKE_FAIL: 'break' } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'gemini boom\n');
});

test('finds Gemini CLI off PATH through ASK_GEMINI_BIN', async () => {
  const r = await run('hi', { extra: { PATH: NODE_DIR, ASK_GEMINI_BIN: FAKE } });
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
});

test('finds Gemini CLI off PATH where npm puts it', async () => {
  mkdirSync(join(tmp(), '.npm-global', 'bin'), { recursive: true });
  symlinkSync(FAKE, join(tmp(), '.npm-global', 'bin', 'gemini'));
  const r = await run('hi', { extra: { PATH: NODE_DIR } });
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
});

test('without Gemini CLI, models and runs fail saying how to install it', async () => {
  const extra = { ASK_GEMINI_BIN: join(tmp(), 'missing') };
  const hint = /^Gemini CLI not found: install it from https:\/\/geminicli\.com, or set ASK_GEMINI_BIN to its path\n$/;
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
  assert.equal(r.stderr, 'gemini needs Node.js 18 or newer: install it from https://nodejs.org (or set ASK_NODE)\n');
});
