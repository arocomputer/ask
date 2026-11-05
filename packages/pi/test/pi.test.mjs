/* Black-box adapter tests: fake CLI only, prompt on stdin, atomic ask report on disk. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, pollJson, readJson, readJsonl } from '../../../src/test/baymax/helper.mjs';
const agent = fileURLToPath(new URL('../agents/pi', import.meta.url));
const fake = fileURLToPath(new URL('./bin/pi', import.meta.url));
const { tmp, env: offlineEnv, launch } = offline(agent);

/* Runs the shell launcher on a fixed prompt against the fake CLI only, from the test's scratch directory. */
async function run(extra = {}, args = []) {
  const env = offlineEnv({ ASK_NODE: process.execPath, ASK_PI_BIN: fake, ASK_MODEL: 'provider/model', ASK_ACCESS: 'read',
    ASK_REPORT: join(tmp(), 'report'), FAKE_LOG: join(tmp(), 'calls'), ...extra });
  const r = await launch(args, env, 'look at files');
  return { ...r, report: readJson(env.ASK_REPORT, {}), calls: readJsonl(env.FAKE_LOG) };
}

/* Observe a report before the fake CLI's final response, then wait for normal completion. */
async function liveRun() {
  const running = run({ FAKE_PAUSE: '1200' });
  const live = await pollJson(join(tmp(), 'report'), running, (report) => report.session && report.input > 0);
  assert.ok(live, 'no session and usage reported before the run finished');
  await running;
}
const after = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('read runs allow only built-in reading tools and disable executable extensions', async () => {
  const r = await run();
  assert.equal(r.code, 0, r.stderr);
  const [call] = r.calls;
  assert.equal(after(call.argv, '--tools'), 'read,grep,find,ls');
  for (const flag of ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes']) assert.ok(call.argv.includes(flag));
  assert.match(call.stdin, /^Answer from the files/);
  assert.equal(call.cwd, tmp());
  assert.equal(call.offline, '1');
});
test('write runs enable shell and edits and pass the prompt unchanged', async () => {
  const r = await run({ ASK_ACCESS: 'write' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(after(r.calls[0].argv, '--tools'), 'read,grep,find,ls,bash,edit,write');
  assert.equal(r.calls[0].stdin, 'look at files');
});
test('passes explicit provider/model, thinking and native title independently', async () => {
  const title = 'A native title · with spaces';
  const r = await run({ ASK_MODEL: 'openrouter/vendor/exact-id', ASK_EFFORT: 'high', ASK_TITLE: title });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(after(r.calls[0].argv, '--provider'), 'openrouter');
  assert.equal(after(r.calls[0].argv, '--model'), 'vendor/exact-id');
  assert.equal(after(r.calls[0].argv, '--thinking'), 'high');
  assert.equal(after(r.calls[0].argv, '--name'), title);
});
test('reports a session and reapplies read tools on continuation', async () => {
  const first = await run();
  assert.equal(first.report.session, 'pi-session');
  const r = await run({ ASK_SESSION: first.report.session });
  assert.equal(r.code, 0, r.stderr);
  const call = r.calls.at(-1);
  assert.equal(after(call.argv, '--session'), 'pi-session');
  assert.equal(after(call.argv, '--tools'), 'read,grep,find,ls');
  assert.equal(call.stdin, 'look at files');
});
test('prints final text only and sums steps without double counting streaming usage', async () => {
  const r = await run({ FAKE_NO_NEWLINE: '1' });
  assert.equal(r.stdout, 'answer parts\n');
  assert.deepEqual(r.report, { session: 'pi-session', input: 50, output: 10, cached: 6, cost: 0.02, name: 'exact-model' });
});
test('reports session and usage live', liveRun);
test('JSON-mode provider failures fail even when the child exits zero', async () => {
  const r = await run({ FAKE_REASON: 'error' });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'provider failed\n');
  assert.equal(r.report.session, 'pi-session');
});
test('aborted, incomplete and nonzero-exit turns never return a successful answer', async () => {
  for (const extra of [{ FAKE_REASON: 'aborted' }, { FAKE_REASON: 'toolUse' }, { FAKE_EXIT: '3' }, { FAKE_EMPTY: '1' }]) {
    const r = await run(extra);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
  }
});
test('length-limited replies are explicitly marked partial', async () => {
  const r = await run({ FAKE_REASON: 'length' });
  assert.equal(r.code, 0);
  assert.match(r.report.note, /partial/);
});
test('refuses aliases, patterns and invalid effort before spawning', async () => {
  for (const extra of [{ ASK_MODEL: 'latest' }, { ASK_MODEL: 'provider/*' }, { ASK_EFFORT: 'typo' }]) {
    const r = await run(extra);
    assert.equal(r.code, 1);
    assert.deepEqual(r.calls, []);
  }
});
test('models returns an empty catalog for manually configured explicit IDs', async () => {
  const r = await run({}, ['models']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.deepEqual(r.calls, []);
});
test('missing CLI override fails without falling back to a real CLI', async () => {
  const r = await run({ ASK_PI_BIN: join(tmp(), 'missing') });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Pi not found.*ASK_PI_BIN/);
});
test('includes upstream compaction usage in the turn totals', async () => {
  const r = await run({ FAKE_COMPACTION: '1' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.report.input, 75);
  assert.equal(r.report.cost, 0.03);
});
test('omits usage when the CLI does not supply it', async () => {
  const r = await run({ FAKE_NO_USAGE: '1' });
  assert.equal(r.code, 0, r.stderr);
  for (const key of ['input', 'output', 'cached', 'cost']) assert.ok(!(key in r.report));
});
test('refuses Pi startup migration of legacy project resources in a read run', async () => {
  mkdirSync(join(tmp(), '.pi', 'commands'), { recursive: true });
  const r = await run();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /would migrate/);
  assert.deepEqual(r.calls, []);
  assert.ok(existsSync(join(tmp(), '.pi', 'commands')));
});
