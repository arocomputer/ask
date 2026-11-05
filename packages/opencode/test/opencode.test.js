/*
 * Tests for the opencode agent. Each runs agents/opencode as ask does (prompt on stdin, ASK_* env,
 * answer on stdout, report in $ASK_REPORT), driving the fake opencode in ./bin. No network, no real
 * models. Run: node --test
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, pollJson, readJson, readJsonl } from '../../../src/test/baymax/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, '..', 'agents', 'opencode');
const FAKE = join(HERE, 'bin', 'opencode');
const { nodeDir: NODE_DIR, tmp, env: offlineEnv, launch } = offline(AGENT, join(HERE, 'bin'));

/*
 * Runs the agent on one prompt. Resolves with { code, stdout, stderr, report, calls }, where calls
 * are the fake CLI's recorded invocations.
 */
async function run(prompt, { model = 'm', effort = '', access = 'read', schema, extra = {} } = {}) {
  const env = offlineEnv({ FAKE_LOG: join(tmp(), 'calls.jsonl'), ASK_MODEL: model, ASK_EFFORT: effort, ASK_ACCESS: access, ASK_REPORT: join(tmp(), 'report.json'), ...extra });
  if (schema) writeFileSync((env.ASK_SCHEMA = join(tmp(), 'schema.json')), JSON.stringify(schema));
  const r = await launch([], env, prompt);
  return { ...r, report: readJson(env.ASK_REPORT), calls: readJsonl(env.FAKE_LOG) };
}

/* Runs `opencode models` and resolves with its lines. */
async function models(extra = {}) {
  const r = await launch(['models'], offlineEnv(extra));
  return r.stdout.trim().split('\n').filter(Boolean);
}

const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
const GROUNDING = 'Answer from the files in your working directory: search and read them before answering. Never guess file names, functions or facts; if you cannot find something, say so.\n\n';

test('lists every model Opencode offers, once each by clean name', async () => {
  assert.deepEqual(await models(), ['deepseek-4.1-flash', 'glm-5', 'kimi-k3', 'm', 'qwen-3.8-flash']);
});

test('read runs use the plan agent with injected read-only permissions', async () => {
  const [call] = (await run('look')).calls;
  assert.equal(after(call.argv, '--agent'), 'plan');
  const { steps, permissions } = call.config.agents.plan;
  assert.equal(steps, 25);
  assert.deepEqual(permissions[0], { action: '*', resource: '*', effect: 'deny' });
  assert.deepEqual(permissions.slice(1), ['read', 'grep', 'glob'].map((action) => ({ action, resource: '*', effect: 'allow' })));
});

test('read runs refuse shell access entirely', async () => {
  const [call] = (await run('look')).calls;
  assert.deepEqual(call.config.agents.plan.permissions, [
    { action: '*', resource: '*', effect: 'deny' },
    ...['read', 'grep', 'glob'].map((action) => ({ action, resource: '*', effect: 'allow' })),
  ]);
});

test('write runs use the build agent with the larger step cap', async () => {
  const [call] = (await run('change', { access: 'write' })).calls;
  assert.equal(after(call.argv, '--agent'), 'build');
  assert.deepEqual(call.config, { agents: { build: { steps: 100 } } });
});

test('a new read run is told to answer from the files; write runs and follow-ups get the prompt as is', async () => {
  const read = (await run('where is main?')).calls[0];
  const write = (await run('fix it', { access: 'write' })).calls[1];
  const followUp = (await run('and then?', { extra: { ASK_SESSION: 'ses_fake' } })).calls[2];
  assert.equal(read.stdin, `${GROUNDING}where is main?`);
  assert.equal(write.stdin, 'fix it');
  assert.equal(followUp.stdin, 'and then?');
});

test('passes an effort as the model variant', async () => {
  const [call] = (await run('hi', { model: 'p/m', effort: 'max' })).calls;
  assert.equal(after(call.argv, '-m'), 'p/m#max');
});

test('names the OpenCode session from ASK_TITLE', async () => {
  const [call] = (await run('hi', { extra: { ASK_TITLE: 'GPT-6.1 Sol · Fix tests · write' } })).calls;
  assert.equal(after(call.argv, '--title'), 'GPT-6.1 Sol · Fix tests · write');
});

test('answers on stdout and reports usage', async () => {
  const r = await run('hi');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'opencode: hi\n');
  for (const [key, value] of Object.entries({ input: 50, output: 7, cached: 10, cost: 0.002 })) assert.equal(r.report[key], value, key);
});

test('counts the usage of the answering step that Opencode prints no step_finish for', async () => {
  const r = await run('hi', { extra: { FAKE_STEPS: '2', FAKE_UNFINISHED: '1' } });
  assert.equal(r.code, 0);
  for (const [key, value] of Object.entries({ input: 100, output: 14, cached: 20, cost: 0.004 })) assert.equal(r.report[key], value, key);
});

test('counts the answering step when Opencode prints only its text', async () => {
  const r = await run('hi', { extra: { FAKE_UNFINISHED: 'text' } });
  assert.equal(r.code, 0);
  for (const [key, value] of Object.entries({ input: 50, output: 7, cached: 10, cost: 0.002 })) assert.equal(r.report[key], value, key);
});

test('waits for Opencode to save the answering step before counting it', async () => {
  const r = await run('hi', { extra: { FAKE_STEPS: '2', FAKE_UNFINISHED: '1', FAKE_SAVED_LATE: join(tmp(), 'saved') } });
  assert.equal(r.code, 0);
  for (const [key, value] of Object.entries({ input: 100, output: 14, cached: 20, cost: 0.004 })) assert.equal(r.report[key], value, key);
});

test('reports usage while Opencode is still running', async () => {
  const running = run('hi', { extra: { FAKE_PAUSE: '1500' } });
  const live = await pollJson(join(tmp(), 'report.json'), running, (report) => report.input > 0);
  assert.ok(live, 'no usage reported before the run finished');
  await running;
});

test('a run that reports no usage reports none', async () => {
  const r = await run('hi', { extra: { FAKE_NO_USAGE: '1' } });
  assert.equal(r.code, 0);
  assert.ok(!r.report.input && !r.report.output);
});

test('a run that hits the step cap notes its answer may be partial', async () => {
  const r = await run('look', { extra: { FAKE_STEPS: '25' } });
  assert.equal(r.code, 0);
  assert.match(r.report.note, /hit step cap/);
});

test('fails a run whose Opencode exited nonzero, with the reason last on stderr', async () => {
  const r = await run('hi', { extra: { FAKE_EXIT: '1' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr.trim().split('\n').pop(), /exit 1/);
});

test("a failing Opencode's own message is the reason", async () => {
  const r = await run('break', { extra: { FAKE_FAIL: 'break' } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr.trim(), 'opencode boom');
});

test('reports its session, and a follow-up continues it', async () => {
  const first = await run('hi');
  assert.equal(first.report.session, 'ses_fake');
  const second = await run('more', { extra: { ASK_SESSION: 'ses_fake' } });
  assert.equal(after(second.calls[1].argv, '--session'), 'ses_fake');
});

test('runs a clean model name as its listed id, in any case, and a provider/model id as it is', async () => {
  const qwen = (await run('hi', { model: 'Qwen-3.8-Flash' })).calls[0];
  const other = (await run('hi', { model: 'other/deepseek-v4.1-flash' })).calls[1];
  assert.equal(after(qwen.argv, '-m'), 'opencode-go/qwen3.8-flash');
  assert.equal(after(other.argv, '-m'), 'other/deepseek-v4.1-flash');
});

test('prefers ASK_OPENCODE_PROVIDER, then opencode-go, then opencode, then the first alphabetically', async () => {
  const chosen = (await run('hi', { model: 'deepseek-4.1-flash', extra: { ASK_OPENCODE_PROVIDER: 'other' } })).calls[0];
  const go = (await run('hi', { model: 'deepseek-4.1-flash' })).calls[1];
  const zen = (await run('hi', { model: 'glm-5' })).calls[2];
  const first = (await run('hi', { model: 'kimi-k3' })).calls[3];
  assert.equal(after(chosen.argv, '-m'), 'other/deepseek-v4.1-flash');
  assert.equal(after(go.argv, '-m'), 'opencode-go/deepseek-v4.1-flash');
  assert.equal(after(zen.argv, '-m'), 'opencode/glm-5');
  assert.equal(after(first.argv, '-m'), 'beta/kimi-k3');
});

test('refuses a model name it cannot find', async () => {
  const r = await run('hi', { model: 'nope-1.0' });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
  assert.equal(r.stderr, 'no Opencode model named nope-1.0; see opencode models\n');
});

test('finds Opencode off PATH through ASK_OPENCODE_BIN', async () => {
  const r = await run('hi', { extra: { PATH: NODE_DIR, ASK_OPENCODE_BIN: FAKE } });
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
});

test('finds Opencode off PATH where its installer puts it', async () => {
  mkdirSync(join(tmp(), '.opencode', 'bin'), { recursive: true });
  symlinkSync(FAKE, join(tmp(), '.opencode', 'bin', 'opencode'));
  const r = await run('hi', { extra: { PATH: NODE_DIR } });
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
});

test('without Opencode, models and runs fail saying how to install it', async () => {
  const extra = { ASK_OPENCODE_BIN: join(tmp(), 'missing') };
  const hint = /^Opencode not found: install it from https:\/\/opencode\.ai, or set ASK_OPENCODE_BIN to its path\n$/;
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
  assert.equal(r.stderr, 'opencode needs Node.js 18 or newer: install it from https://nodejs.org (or set ASK_NODE)\n');
});

test('v1 reads use fresh permissions despite permissive global and plan config', async () => {
  const r = await run('look', { effort: 'high', extra: { FAKE_VERSION: '1.2.9', ASK_TITLE: 'Read task', ASK_SESSION: 'ses_existing' } });
  assert.equal(r.code, 0);
  const [call] = r.calls;
  const agent = after(call.argv, '--agent');
  assert.match(agent, /^ask-read-/);
  assert.equal(call.argv.includes('--standalone'), false);
  assert.equal(after(call.argv, '-m'), 'opencode-go/m');
  assert.equal(after(call.argv, '--variant'), 'high');
  assert.equal(after(call.argv, '--title'), 'Read task');
  assert.equal(after(call.argv, '--session'), 'ses_existing');
  assert.equal(call.stdin, 'look');
  assert.deepEqual(Object.keys(call.config.agent), [agent]);
  const injected = call.config.agent[agent];
  assert.equal(injected.steps, 25);
  assert.equal(injected.mode, 'primary');
  assert.deepEqual(injected.permission, { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow' });
  // V1 appends agent rules after global rules; a fresh name cannot inherit plan's specific allows.
  const inherited = { plan: { permission: { bash: 'allow', edit: 'allow', custom: 'allow' } } };
  const rules = [['*', 'allow'], ...Object.entries(inherited[agent]?.permission || {}), ...Object.entries(injected.permission)];
  for (const action of ['read', 'grep', 'glob', 'bash', 'edit', 'task', 'skill', 'custom']) {
    const effect = [...rules].reverse().find(([key]) => key === '*' || key === action)[1];
    assert.equal(effect, ['read', 'grep', 'glob'].includes(action) ? 'allow' : 'deny', action);
  }
  assert.deepEqual(call.git, { locks: '0', count: '1', key: 'core.fsmonitor', value: 'false' });
});

test('v1 writes retain build permissions and pass effort with --variant', async () => {
  const r = await run('change', { access: 'write', model: 'p/m', effort: 'high', extra: { FAKE_VERSION: 'opencode v1.1.65' } });
  assert.equal(r.code, 0);
  const [call] = r.calls;
  assert.equal(after(call.argv, '--agent'), 'build');
  assert.equal(after(call.argv, '-m'), 'p/m');
  assert.equal(after(call.argv, '--variant'), 'high');
  assert.deepEqual(call.config, { agent: { build: { steps: 100 } } });
  assert.equal(call.stdin, 'change');
  assert.deepEqual(call.git, {});
});

test('v1 exports nested assistant usage without recounting streamed steps or previous turns', async () => {
  const log = join(tmp(), 'controls.jsonl');
  const r = await run('hi', { extra: { FAKE_VERSION: '1.2.9', FAKE_STEPS: '2', FAKE_UNFINISHED: 'text', FAKE_CONTROL_LOG: log } });
  assert.equal(r.code, 0);
  assert.equal(r.report.session, 'ses_fake');
  for (const [key, value] of Object.entries({ input: 100, output: 14, cached: 20, cost: 0.004 })) assert.equal(r.report[key], value, key);
  const controls = readJsonl(log);
  assert.deepEqual(controls.at(-1), ['export', 'ses_fake']);
});

test('version detection accepts supported releases and prereleases for model listing', async () => {
  for (const version of ['1.1.65', 'v1.2.9', '2.0.0', '2.0.0-beta.3+build.1']) {
    assert.deepEqual(await models({ FAKE_VERSION: version }), ['deepseek-4.1-flash', 'glm-5', 'kimi-k3', 'm', 'qwen-3.8-flash'], version);
  }
});

test('unknown, malformed, old and failing versions stop before models or runs', async () => {
  const log = join(tmp(), 'versions.jsonl');
  for (const extra of [
    ...['', 'dev', '2', '2.0', 'garbage 2.0.0', '2.0.0\n1.2.9', '2.0.0-..', '2.0.0-', '3.0.0', '0.15.0', '1.0.0', '1.1.64'].map((FAKE_VERSION) => ({ FAKE_VERSION })),
    { FAKE_VERSION: '2.0.0', FAKE_VERSION_EXIT: '1' },
  ]) {
    for (const args of [[], ['models']]) {
      const r = await launch(args, offlineEnv({ ASK_OPENCODE_BIN: FAKE, ASK_MODEL: 'p/m', ASK_ACCESS: 'write', FAKE_CONTROL_LOG: log, ...extra }), 'change');
      assert.equal(r.code, 1);
      assert.match(r.stderr, /version.*refusing to run/);
      assert.equal(r.stdout, '');
    }
  }
  assert.ok(readJsonl(log).every((argv) => argv.length === 1 && argv[0] === '--version'));
});
