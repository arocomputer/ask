/* Real ask integration: install the embedded packages and run only their offline fake CLIs. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness, packages, selection } from './integration.mjs';
import { profiles } from './profiles.mjs';

const ask = process.env.BAYMAX_ASK;
const names = selection(process.env.BAYMAX_PACKAGES ? JSON.parse(process.env.BAYMAX_PACKAGES) : []);

/* Check coverage when packages are added and fail selections before any execution. */
test('all discovered packages have profiles and unknown selections are refused', () => {
  assert.deepEqual(Object.keys(profiles).sort(), packages());
  for (const name of ['missing', '../claude', '--help']) assert.throws(() => selection([name]), /unknown package/);
});

for (const name of names) {
  const p = profiles[name];
  test(`${name}: installed package through real ask`, { skip: !ask && 'run via node test/baymax/runner.mjs', timeout: 120_000 }, async (t) => {
    const s = await harness(name, ask);
    t.after(s.cleanup);
    let first;
    await t.test('write answer, usage and session reach the run record', async () => {
      const out = await s.run(['-m', `${name}:${p.model}`, '--wait', '-w', 'task']);
      assert.equal(out.code, 0, out.stderr);
      const answer = p.answer || 'baymax answer';
      assert.equal(out.stdout, `${answer}\n`);
      first = s.record(out);
      assert.equal(first.task.model, `${name}:${p.model}`);
      assert.equal(first.result.ok, true);
      assert.equal(first.result.answer, answer);
      assert.equal(first.result.write, true);
      assert.deepEqual(first.result.usage, p.usage);
      if (p.session === false) assert.equal(first.result.session, null);
      else assert.ok(first.result.session, 'native session was persisted');
      assert.ok(s.calls().length, 'installed agent reached the fake CLI');
    });
    await t.test(p.read === false ? 'read is refused before any prompt is sent' : 'read succeeds and is recorded as read access', async () => {
      const before = s.calls().length;
      const out = await s.run(['-m', `${name}:${p.model}`, '--wait', '-r', 'task']);
      const { result } = s.record(out);
      if (p.read === false) {
        assert.equal(out.code, 1, out.stderr);
        assert.equal(result.ok, false);
        assert.match(result.error, /read|read-only/i);
        const calls = s.calls().slice(before);
        if (name === 'cline') assert.ok(!calls.some((call) => call.method === 'session/prompt'));
        else assert.deepEqual(calls, []);
      } else {
        assert.equal(out.code, 0, out.stderr);
        assert.equal(out.stdout, `${p.answer || 'baymax answer'}\n`);
        assert.equal(result.ok, true);
        assert.equal(result.write, false);
        reading(name, s.calls().slice(before));
      }
    });
    await t.test(p.session === false ? 'sessionless runs cannot be continued' : 'continuation passes the saved session to the fake CLI', async () => {
      assert.ok(first, 'initial run must succeed');
      const before = s.calls().length;
      const out = await s.run(['-c', first.id, '--wait', 'task']);
      if (p.session === false) {
        assert.equal(out.code, 2, out.stderr);
        assert.match(out.stderr, /reported no session/);
        assert.equal(s.calls().length, before);
      } else {
        assert.equal(out.code, 0, out.stderr);
        const { task, result } = s.record(out);
        assert.equal(task.session, first.result.session);
        assert.equal(task.continues, first.id);
        assert.equal(result.session, first.result.session);
        assert.equal(result.answer, p.answer || 'baymax answer');
        const native = name === 'amp' ? JSON.parse(task.session)[1] : task.session.replace(/^ask-read:/, '');
        assert.ok(JSON.stringify(s.calls().slice(before)).includes(native), 'CLI received the persisted session');
        assert.deepEqual(result.usage, Object.hasOwn(p, 'continuationUsage') ? p.continuationUsage : p.usage);
      }
    });
    await t.test('harness failure is persisted without a successful answer', async () => {
      const before = s.calls().length;
      const out = await s.run(['-m', `${name}:${p.model}`, '--wait', '-w', 'fail'], p.failure || { FAKE_FAIL: 'fail' });
      assert.equal(out.code, 1, out.stderr);
      const { result } = s.record(out);
      assert.equal(result.ok, false);
      assert.ok(result.error);
      assert.equal(result.answer, undefined);
      assert.ok(s.calls().length > before, 'failure came from the fake harness');
    });
  });
}

/* Assert a native read restriction actually reached the CLI through ask's environment. */
function reading(name, calls) {
  const call = calls[0];
  const after = (flag) => call.argv[call.argv.indexOf(flag) + 1];
  switch (name) {
    case 'claude': assert.equal(after('--allowedTools'), 'Read,Grep,Glob'); break;
    case 'codex': assert.equal(after('--sandbox'), 'read-only'); break;
    case 'copilot': assert.ok(call.argv.includes('--available-tools=view,glob,grep,rg')); break;
    case 'gemini': assert.equal(after('--approval-mode'), 'plan'); assert.match(call.policy, /decision = "deny"/); break;
    case 'pi': assert.equal(after('--tools'), 'read,grep,find,ls'); break;
    case 'e': assert.deepEqual(calls.find((c) => c.method === 'session.create' && !c.params.tools?.includes('__ask_read_only_probe__')).params.tools, ['read', 'grep', 'read_result']); break;
    case 'kimi': assert.match(call.agentFile, /tools:\n {2}- Read\n {2}- Grep\n {2}- Glob/); break;
    case 'kilo': assert.equal(call.config.agent[after('--agent')].permission['*'], 'deny'); break;
    case 'opencode': assert.deepEqual(call.config.agents.plan.permissions[0], { action: '*', resource: '*', effect: 'deny' }); break;
    default: assert.fail(`missing native read assertion for ${name}`);
  }
}
