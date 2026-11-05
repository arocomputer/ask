/*
 * Tests for the copilot agent. Each runs agents/copilot as ask does (prompt on stdin, ASK_* env,
 * answer on stdout, report in $ASK_REPORT), driving the fake copilot in ./bin. No network, no real
 * models. Run: node --test
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, readJson, readJsonl } from '../../../src/test/baymax/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, '..', 'agents', 'copilot');
const FAKE = join(HERE, 'bin', 'copilot');
const { nodeDir: NODE_DIR, tmp, env: offlineEnv, launch } = offline(AGENT, join(HERE, 'bin'));

/*
 * Runs the agent on one prompt. Resolves with { code, stdout, stderr, report, calls }, where calls
 * are the fake CLI's recorded invocations.
 */
async function run(prompt, { model = 'gpt-5.4', effort = '', access = 'read', extra = {} } = {}) {
  const env = offlineEnv({ COPILOT_HOME: join(tmp(), 'copilot'), FAKE_LOG: join(tmp(), 'calls.jsonl'), ASK_MODEL: model, ASK_EFFORT: effort, ASK_ACCESS: access, ASK_REPORT: join(tmp(), 'report.json'), ...extra });
  const r = await launch([], env, prompt);
  return { ...r, report: readJson(env.ASK_REPORT), calls: readJsonl(env.FAKE_LOG) };
}

const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
const GROUNDING = 'Answer from the files in your working directory: search and read them before answering. Never guess file names, functions or facts; if you cannot find something, say so.\n\n';

test('lists no models, since Copilot has no command that lists them', async () => {
  const r = await launch(['models'], offlineEnv());
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('read runs see only the reading tools, with shell and writes denied', async () => {
  const [call] = (await run('look')).calls;
  assert.ok(call.argv.includes('--available-tools=view,glob,grep,rg'));
  assert.ok(call.argv.includes('--deny-tool=shell') && call.argv.includes('--deny-tool=write'));
  assert.ok(!call.argv.some((arg) => arg.startsWith('--allow-all')));
  assert.equal(call.gitLocks, '0');
});

test('write runs allow all tools and URLs', async () => {
  const [call] = (await run('change', { access: 'write' })).calls;
  assert.ok(call.argv.includes('--allow-all-tools') && call.argv.includes('--allow-all-urls'));
  assert.ok(!call.argv.some((arg) => arg.startsWith('--available-tools') || arg.startsWith('--deny-tool')));
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

test('runs Copilot ids as they are, Claude models by clean name, in any case', async () => {
  const gpt = (await run('hi', { model: 'GPT-5.4' })).calls[0];
  const haiku = (await run('hi', { model: 'haiku-4.5' })).calls[1];
  assert.equal(after(gpt.argv, '--model'), 'gpt-5.4');
  assert.equal(after(haiku.argv, '--model'), 'claude-haiku-4.5');
});

test('refuses auto, which lets Copilot pick the model', async () => {
  const r = await run('hi', { model: 'auto' });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
  assert.match(r.stderr, /name the exact model/);
});

test('passes an effort as --reasoning-effort', async () => {
  const [call] = (await run('hi', { effort: 'high' })).calls;
  assert.equal(after(call.argv, '--reasoning-effort'), 'high');
});

test('a new run reports its session id at once; a follow-up resumes it without renaming it', async () => {
  const first = await run('hi', { extra: { ASK_TITLE: 'GPT-5.4 · Fix tests · read' } });
  const id = first.report.session;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(after(first.calls[0].argv, '--session-id'), id);
  assert.equal(after(first.calls[0].argv, '--name'), 'GPT-5.4 · Fix tests · read');
  const second = await run('more', { extra: { ASK_SESSION: id, ASK_TITLE: 'GPT-5.4 · Fix tests · read' } });
  assert.equal(after(second.calls[1].argv, '--session-id'), id);
  assert.ok(!second.calls[1].argv.includes('--name'));
});

test("answers with the main agent's last turn and reports usage and the model", async () => {
  const r = await run('hi', { model: 'haiku-4.5', extra: { FAKE_TOOLS: '1' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'copilot: hi\n');
  assert.deepEqual([r.report.input, r.report.output, r.report.cached, r.report.cost], [120, 5, 40, undefined]);
  assert.equal(r.report.name, 'Haiku 4.5');
});

test('a follow-up reports only its own tokens, not the whole session\'s', async () => {
  const first = await run('hi');
  const second = await run('more', { extra: { ASK_SESSION: first.report.session } });
  assert.deepEqual([second.report.input, second.report.output, second.report.cached], [120, 5, 40]);
});

test("a failing Copilot's own message is the reason", async () => {
  const r = await run('break', { extra: { FAKE_FAIL: 'break' } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'copilot boom\n');
});

test('finds Copilot off PATH through ASK_COPILOT_BIN', async () => {
  const r = await run('hi', { extra: { PATH: NODE_DIR, ASK_COPILOT_BIN: FAKE } });
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
});

test('finds Copilot off PATH where its installer puts it', async () => {
  mkdirSync(join(tmp(), '.local', 'bin'), { recursive: true });
  symlinkSync(FAKE, join(tmp(), '.local', 'bin', 'copilot'));
  const r = await run('hi', { extra: { PATH: NODE_DIR } });
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
});

test('without Copilot, models and runs fail saying how to install it', async () => {
  const extra = { ASK_COPILOT_BIN: join(tmp(), 'missing') };
  const hint = /^GitHub Copilot CLI not found: install it from https:\/\/github\.com\/github\/copilot-cli, or set ASK_COPILOT_BIN to its path\n$/;
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
  assert.equal(r.stderr, 'copilot needs Node.js 18 or newer: install it from https://nodejs.org (or set ASK_NODE)\n');
});
