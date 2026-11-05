/* Black-box adapter tests: fake CLI only, prompt on stdin, atomic ask report on disk. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, pollJson, readJson, readJsonl } from '../../../src/test/integration/helper.mjs';
const agent = fileURLToPath(new URL('../agents/e', import.meta.url));
const fake = fileURLToPath(new URL('./bin/e', import.meta.url));
const { tmp, env: offlineEnv, launch } = offline(agent);

/* Runs the shell launcher on a fixed prompt against the fake CLI only, from the test's scratch directory. */
async function run(extra = {}, args = []) {
  const env = offlineEnv({ ASK_NODE: process.execPath, ASK_E_BIN: fake, ASK_MODEL: 'provider/model', ASK_ACCESS: 'read',
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
const created = (r) => r.calls.find((call) => call.method === 'session.create' && !call.params.tools?.includes('__ask_read_only_probe__'))?.params;

test('read runs enforce the RPC built-in allowlist and disable extensions at startup', async () => {
  const r = await run();
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls[0].argv, ['rpc', '--no-extensions']);
  assert.deepEqual(created(r).tools, ['read', 'grep', 'read_result']);
  assert.equal(created(r).save, true);
  assert.equal(created(r).cwd, tmp());
  assert.match(r.calls.find((call) => call.method === 'session.prompt').params.prompt, /^Answer from the files/);
});
test('an older server that silently ignores tools is refused before any prompt', async () => {
  const r = await run({ FAKE_IGNORE_TOOLS: '1' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /does not recognize the tool allowlist/);
  assert.ok(!r.calls.some((call) => call.method === 'session.prompt'));
});
test('write runs keep the full toolset and pass the prompt unchanged', async () => {
  const r = await run({ ASK_ACCESS: 'write' });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!('tools' in created(r)));
  assert.equal(r.calls.find((call) => call.method === 'session.prompt').params.prompt, 'look at files');
});
test('explicit model, effort and native name are session.create parameters', async () => {
  const r = await run({ ASK_EFFORT: 'high', ASK_TITLE: 'Title · exact' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(created(r).model, 'provider/model');
  assert.equal(created(r).effort, 'high');
  assert.equal(created(r).name, 'Title · exact');
});
test('continuation uses the saved path and reapplies read access to a new RPC session', async () => {
  const first = await run();
  assert.equal(first.report.session, '/saved/e-session.jsonl');
  const r = await run({ ASK_SESSION: first.report.session });
  const call = r.calls.filter((call) => call.method === 'session.create').at(-1).params;
  assert.equal(call.resume, '/saved/e-session.jsonl');
  assert.deepEqual(call.tools, ['read', 'grep', 'read_result']);
  assert.equal(r.calls.filter((call) => call.method === 'session.prompt').at(-1).params.prompt, 'look at files');
});
test('final result replaces live totals, includes cache writes, and prints no event text', async () => {
  const r = await run();
  assert.equal(r.stdout, 'answer\n');
  assert.deepEqual(r.report, { name: 'provider/model', session: '/saved/e-session.jsonl', input: 52, output: 10, cached: 6, cost: 0.02 });
});
test('reports saved path and tokens before completion', liveRun);
test('unknown pricing is omitted instead of reported as zero', async () => {
  const r = await run({ FAKE_NO_COST: '1' });
  assert.equal(r.code, 0);
  assert.ok(!('cost' in r.report));
});
test('turn errors and aborts preserve the saved path but print no answer', async () => {
  for (const extra of [{ FAKE_ERROR: '1' }, { FAKE_ABORT: '1' }]) {
    const r = await run(extra);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.report.session, '/saved/e-session.jsonl');
  }
});
test('premature RPC exit rejects the pending prompt', async () => {
  const r = await run({ FAKE_DIE: '1' });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /closed before response/);
});
test('untrusted directories fail without changing trust settings', async () => {
  const r = await run({ FAKE_UNTRUSTED: '1' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not trusted/);
  assert.ok(!r.calls.some((call) => call.method === 'session.prompt'));
});
test('unsupported protocol is refused before session creation', async () => {
  const r = await run({ FAKE_PROTOCOL: '1' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /requires RPC protocol 2/);
  assert.ok(!r.calls.some((call) => call.method === 'session.create'));
});
test('cost limits retain the final cost for ask to note overspending', async () => {
  const r = await run({ ASK_MAX_COST: '0.01' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.report.cost, 0.02);
});
test('models lists the native RPC catalog once per explicit ID', async () => {
  const r = await run({}, ['models']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'other/model\nprovider/model\n');
});
test('nonzero exit after a reply still fails the run', async () => {
  const r = await run({ FAKE_EXIT: '4' });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
});
test('missing override and non-explicit models fail without invoking a real CLI', async () => {
  for (const extra of [{ ASK_E_BIN: join(tmp(), 'missing') }, { ASK_MODEL: 'latest' }]) {
    const r = await run(extra);
    assert.equal(r.code, 1);
    assert.deepEqual(r.calls, []);
  }
});
