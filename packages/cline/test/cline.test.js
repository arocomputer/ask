/*
 * Tests for the cline agent. Each runs agents/cline as ask does (prompt on stdin, ASK_* env, answer
 * on stdout, report in $ASK_REPORT), driving the fake ACP server in ./bin/cline. No network, no
 * real models. Run: node --test
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, readJson, readJsonl } from '../../../src/test/baymax/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, '..', 'agents', 'cline');
const { tmp, env: offlineEnv, launch } = offline(AGENT, join(HERE, 'bin'));

/*
 * Runs the agent on one prompt. Resolves with { code, stdout, stderr, report, log }, log being the
 * fake's entries: its start, the requests it got and the permission answers.
 */
async function run(prompt, { model = 'claude-sonnet-5.5', effort = '', access = 'write', extra = {} } = {}) {
  const env = offlineEnv({ FAKE_LOG: join(tmp(), 'log.jsonl'), ASK_MODEL: model, ASK_EFFORT: effort, ASK_ACCESS: access, ASK_REPORT: join(tmp(), 'report.json'), ...extra });
  const r = await launch([], env, prompt);
  return { ...r, report: readJson(env.ASK_REPORT), log: readJsonl(env.FAKE_LOG) };
}

const request = (log, method) => log.find((entry) => entry.method === method)?.params;
const outcomes = (log) => Object.fromEntries(log.filter((entry) => entry.tool).map((entry) => [entry.tool, entry.outcome]));
const TOOLS = 'read_files,search_codebase,run_commands,editor,spawn_agent,mcp__fs__write';

test('lists the models Cline offers, with their names', async () => {
  const r = await launch(['models'], offlineEnv());
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'anthropic/claude-sonnet-5.5\tClaude Sonnet 5.5\nopenai/gpt-6.1\n');
});

test('runs cline --acp in the local backend, in a new session in the working directory', async () => {
  const { log } = await run('look');
  assert.deepEqual(log[0].argv, ['--acp']);
  assert.equal(log[0].env.CLINE_SESSION_BACKEND_MODE, 'local');
  assert.deepEqual(request(log, 'session/new'), { cwd: tmp(), mcpServers: [] });
});

test('refuses read runs without starting Cline', async () => {
  const r = await run('look', { access: 'read' });
  assert.equal(r.code, 1);
  assert.equal(r.log.length, 0);
  assert.match(r.stderr, /^Cline cannot run read-only: .*; use -w\n$/);
});

test('write runs are in act mode, approve every tool and get the prompt as is', async () => {
  const r = await run('fix it', { extra: { FAKE_TOOLS: TOOLS } });
  assert.equal(r.code, 0);
  assert.equal(request(r.log, 'session/set_mode').modeId, 'act');
  assert.equal(request(r.log, 'session/prompt').prompt[0].text, 'fix it');
  assert.ok(Object.values(outcomes(r.log)).every((outcome) => outcome === 'allow_once'));
  assert.equal(Object.keys(outcomes(r.log)).length, 6);
});

test('sets the model explicitly, found by its id or the part after its last slash, in any case', async () => {
  const short = request((await run('hi', { model: 'Claude-Sonnet-5.5' })).log, 'session/set_config_option');
  rmSync(join(tmp(), 'log.jsonl'));
  const full = request((await run('hi', { model: 'openai/gpt-6.1' })).log, 'session/set_config_option');
  assert.deepEqual(short, { sessionId: 'ses_cline', configId: 'model', value: 'anthropic/claude-sonnet-5.5' });
  assert.equal(full.value, 'openai/gpt-6.1');
});

test('refuses a model Cline does not offer, and an effort', async () => {
  const missing = await run('hi', { model: 'nope-1.0' });
  assert.equal(missing.code, 1);
  assert.equal(missing.stderr, 'no Cline model named nope-1.0; see ask models cline\n');
  assert.equal(request(missing.log, 'session/prompt'), undefined);
  const effort = await run('hi', { effort: 'high' });
  assert.equal(effort.code, 1);
  assert.match(effort.stderr, /^Cline's ACP mode takes no effort/);
});

test('answers with the text after the last tool call, and reports the session and model name', async () => {
  const r = await run('hi', { extra: { FAKE_TOOLS: 'read_files' } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'cline: hi\n');
  assert.deepEqual(r.report, { session: 'ses_cline', name: 'Claude Sonnet 5.5' });
});

test('a follow-up loads its session, skips the replayed history and gets the prompt as is', async () => {
  const r = await run('and then?', { extra: { ASK_SESSION: 'ses_old', FAKE_TOOLS: 'read_files' } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'cline: and then?\n');
  assert.deepEqual(request(r.log, 'session/load'), { sessionId: 'ses_old', cwd: tmp(), mcpServers: [] });
  assert.equal(request(r.log, 'session/prompt').prompt[0].text, 'and then?');
  assert.equal(r.report.session, 'ses_old');
});

test('a turn that stops short fails with the reason', async () => {
  const r = await run('hi', { extra: { FAKE_STOP: 'max_turn_requests' } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'Cline stopped: max_turn_requests\n');
});

test("Cline's own error is the reason", async () => {
  const r = await run('hi', { extra: { FAKE_SIGNED_OUT: '1' } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'Call authenticate before starting a session\n');
});

test('ASK_CLINE_PROVIDER picks the provider', async () => {
  const { log } = await run('hi', { extra: { ASK_CLINE_PROVIDER: 'openrouter' } });
  assert.equal(log[0].env.CLINE_PROVIDER, 'openrouter');
});

test('without Cline, runs fail saying how to install it', async () => {
  const r = await run('hi', { extra: { ASK_CLINE_BIN: join(tmp(), 'missing') } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'Cline not found: install it with npm install -g cline, or set ASK_CLINE_BIN to its path\n');
});
