/*
 * Tests for the aider agent. Each runs agents/aider as ask does (prompt on stdin, ASK_* env,
 * answer on stdout, report in $ASK_REPORT), driving the fake aider in ./bin. No network, no model. Run: node --test
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, readJson, readJsonl, scratch } from '../../../src/test/integration/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, '..', 'agents', 'aider');
const { nodeDir: NODE_DIR, tmp, env: offlineEnv, launch } = offline(AGENT, join(HERE, 'bin'));
// HOME apart from the project directory, so a test can see the project is left empty.
const home = scratch('agent-home-');

/* Runs the agent on one prompt. Resolves with { code, stdout, stderr, report, calls }, calls being the fake CLI's recorded invocations. */
async function run(prompt, { model = 'gpt-4o', effort = '', access = 'write', extra = {} } = {}) {
  const log = join(home(), 'calls.jsonl');
  const env = offlineEnv({ HOME: home(), FAKE_LOG: log, ASK_MODEL: model, ASK_EFFORT: effort, ASK_ACCESS: access, ASK_REPORT: join(home(), 'report.json'), ...extra });
  const r = await launch([], env, prompt);
  return { ...r, report: readJson(env.ASK_REPORT), calls: readJsonl(log) };
}

const after = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('write runs pass the model, effort and prompt without letting Aider commit or run commands', async () => {
  const r = await run('edit it', { effort: 'high' });
  const [{ argv, message }] = r.calls;
  assert.equal(after(argv, '--model'), 'gpt-4o');
  assert.equal(after(argv, '--reasoning-effort'), 'high');
  assert.ok(!argv.includes('--chat-mode'));
  for (const flag of ['--yes-always', '--no-auto-commits', '--no-dirty-commits', '--no-suggest-shell-commands', '--no-auto-lint', '--no-gitignore']) assert.ok(argv.includes(flag), flag);
  assert.equal(message, 'edit it');
  assert.equal(r.stdout, 'fake: edit it\n');
});

test('Aider\'s own files go to a temporary directory that is removed, not the project', async () => {
  const [{ argv }] = (await run('look')).calls;
  for (const flag of ['--chat-history-file', '--input-history-file', '--llm-history-file', '--analytics-log', '--message-file']) {
    assert.ok(!after(argv, flag).startsWith(tmp()), flag);
    assert.ok(!existsSync(after(argv, flag)), flag);
  }
  assert.deepEqual(readdirSync(tmp()), []);
});

test('a prompt starting with / or ! is not run as an Aider command', async () => {
  for (const prompt of ['/run rm -rf .', '!ls']) {
    const { message } = (await run(prompt)).calls.at(-1);
    assert.equal(message, ` ${prompt}`);
  }
});

test('read runs are refused without starting Aider', async () => {
  const r = await run('look', { access: 'read' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /read runs are refused/);
  assert.deepEqual(r.calls, []);
});

test('the answer is the last response, with usage summed over them all', async () => {
  const r = await run('which file?', { extra: { FAKE_REFLECT: '1', FAKE_ANSWER: 'Line one.\n\nLine three.' } });
  assert.equal(r.stdout, 'Line one.\n\nLine three.\n');
  assert.deepEqual([r.report.input, r.report.output, r.report.cost, r.report.name], [200, 20, 0.02, 'gpt-4o']);
  assert.equal(r.report.session, undefined);
});

test('a run that sends nothing to the model fails with Aider\'s last message, though Aider exits 0', async () => {
  const r = await run('please fail', { extra: { FAKE_FAIL: 'fail' } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'litellm.AuthenticationError: bad key\n');
});

test('lists no models, since Aider takes any model litellm knows', async () => {
  const r = await launch(['models'], offlineEnv({ HOME: home() }));
  assert.equal(r.stdout, '');
});

test('says what to install when Aider is missing', async () => {
  const r = await launch([], offlineEnv({ PATH: NODE_DIR, HOME: home(), ASK_MODEL: 'gpt-4o', ASK_ACCESS: 'write' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Aider not found/);
});
