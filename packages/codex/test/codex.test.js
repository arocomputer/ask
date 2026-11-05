/*
 * Tests for the codex agent. Runs agents/codex as ask does (prompt on stdin, ASK_* env,
 * answer on stdout, report in $ASK_REPORT), driving the fake codex in ./bin. No network, no real
 * models; sink failures are injected directly. Run: node --test
 */
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, pollJson, readJson, readJsonl } from '../../../test/baymax/helper.mjs';
import { createActivity } from '../lib/activity.mjs';

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

const ACTIVITY_FIXTURE = join(HERE, 'fixtures', 'activity.jsonl');
const EXPECTED_ACTIVITY = [
  { type: 'reasoning', text: 'Checking the implementation.' },
  { type: 'tool', text: 'rg main src', tool: 'command_execution' },
  { type: 'message', text: 'Found the entry point 🔎.' },
  { type: 'tool_result', text: 'completed (exit 0)\nsrc/main.go:func main()\n', tool: 'command_execution' },
  { type: 'tool_result', text: 'completed\nupdate: src/main.go', tool: 'file_change' },
  { type: 'tool', text: 'docs.lookup', tool: 'docs.lookup' },
  { type: 'tool_result', text: 'completed\nUse main().', tool: 'docs.lookup' },
  { type: 'tool', text: 'docs.lookup', tool: 'docs.lookup' },
  { type: 'tool_result', text: 'failed\nNo document', tool: 'docs.lookup' },
  { type: 'tool', text: 'Go main function', tool: 'web_search' },
  { type: 'tool_result', text: 'Completed\nGo main function', tool: 'web_search' },
  { type: 'tool', text: 'spawn_agent', tool: 'spawn_agent' },
  { type: 'tool_result', text: 'completed\nChecked the entry point.', tool: 'spawn_agent' },
];

test('visible activity', async (t) => {
  await t.test('streams native summaries, messages and actual tool lifecycles before the CLI finishes', async () => {
    const path = join(tmp(), 'events-0.jsonl');
    const gate = join(tmp(), 'continue');
    writeFileSync(path, '', { mode: 0o600 });
    const running = run('hi', { extra: { ASK_EVENTS: path, FAKE_EVENT_FILE: ACTIVITY_FIXTURE, FAKE_EVENT_CHUNK_SIZE: '1', FAKE_EVENT_GATE_AFTER: '1', FAKE_EVENT_GATE: gate } });
    let live;
    try { live = await pollJson(path, running, (record) => record.type === 'reasoning'); }
    finally { writeFileSync(gate, ''); }
    const r = await running;
    assert.deepEqual(live, EXPECTED_ACTIVITY[0]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'codex: hi\n');
    assert.deepEqual(readJsonl(path), EXPECTED_ACTIVITY);
    assert.equal(r.report.input, 100);
    assert.equal(r.report.output, 10);
    assert.equal(r.report.session, 'fake');
    assert.ok(!JSON.stringify(r.report).includes('implementation'));
  });

  await t.test('emits only new text suffixes from cumulative item snapshots, including whitespace', async () => {
    const path = join(tmp(), 'events-0.jsonl');
    writeFileSync(path, '', { mode: 0o600 });
    const item = (type, text) => JSON.stringify({ type, item: { id: 'message-1', type: 'agent_message', text } });
    const events = [item('item.started', 'Hello'), item('item.updated', 'Hello'), item('item.updated', 'Hello '), item('item.updated', 'Hello world'), item('item.completed', 'Hello world'), item('item.completed', 'Hello world')].join('\n');
    const r = await run('hi', { extra: { ASK_EVENTS: path, FAKE_EVENTS: events } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readJsonl(path), ['Hello', ' ', 'world'].map((text) => ({ type: 'message', text })));
  });

  await t.test('bounds complete UTF-8 JSONL records and suppresses obvious credentials and terminal controls', async () => {
    const path = join(tmp(), 'events-0.jsonl');
    const source = join(tmp(), 'large.jsonl');
    writeFileSync(path, '', { mode: 0o600 });
    const prefix = '\u001b]52;c;CLIPBOARD\u0007\u001b[31mvisible\u001b[0m\r\b API_KEY="key with spaces" password=hunter2 Authorization: Bearer abc123 Basic basicvalue https://user:pass@example.com sk-abcdefghijklmnop ghp_abcdefghijklmnop AWS_SECRET_ACCESS_KEY=awsvalue\n';
    const huge = prefix + '🔎\\"\n'.repeat(12000);
    const events = [
      { type: 'item.completed', item: { id: 'large-message', type: 'agent_message', text: huge } },
      { type: 'item.started', item: { id: 'large-command', type: 'command_execution', command: huge } },
      { type: 'item.completed', item: { id: 'large-command', type: 'command_execution', aggregated_output: huge, status: 'completed', exit_code: 0 } },
    ];
    writeFileSync(source, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const r = await run('hi', { extra: { ASK_EVENTS: path, FAKE_EVENT_FILE: source } });
    assert.equal(r.code, 0, r.stderr);
    const bytes = readFileSync(path);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assert.ok(text.endsWith('\n'));
    const lines = text.slice(0, -1).split('\n');
    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.ok(Buffer.byteLength(line + '\n') <= 16 * 1024);
      const event = JSON.parse(line);
      assert.ok(['message', 'tool', 'tool_result'].includes(event.type));
      assert.equal(typeof event.text, 'string');
      assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\uFFFD]/.test(event.text));
      assert.ok(!/CLIPBOARD|key with spaces|hunter2|abc123|basicvalue|user:pass|abcdefghijklmnop|awsvalue/.test(event.text));
    }
    assert.match(JSON.parse(lines[0]).text, /\[redacted\]/);
  });

  await t.test('ignores malformed and unrelated events and recovers for a valid summary', async () => {
    const path = join(tmp(), 'events-0.jsonl');
    writeFileSync(path, '', { mode: 0o600 });
    const events = [
      'not json', 'null', '[]', '42', '{"type":"item.completed","item":null}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"NO_ID"}}',
      '{"type":"item.completed","item":{"id":"bad-text","type":"agent_message","text":42}}',
      '{"type":"item.completed","item":{"id":"bad-summary","type":"reasoning","text":{},"raw_content":"HIDDEN"}}',
      '{"type":"item.completed","item":{"id":"future","type":"__proto__","text":"UNRELATED"}}',
      '{"type":"future","text":"UNRELATED"}',
      '{"type":"item.completed","item":{"id":"good","type":"reasoning","text":"Visible summary","raw_content":"HIDDEN"}}',
    ].join('\n');
    const r = await run('hi', { extra: { ASK_EVENTS: path, FAKE_EVENTS: events } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'codex: hi\n');
    assert.deepEqual(readJsonl(path), [{ type: 'reasoning', text: 'Visible summary' }]);
  });

  await t.test('absent or unusable sinks leave stdout, reports and CLI settings unchanged', async () => {
    const source = { FAKE_EVENT_FILE: ACTIVITY_FIXTURE, ASK_SESSION: 'continued', FAKE_ANSWER: '{"ok":true}' };
    const options = { schema: { type: 'object' }, effort: 'high' };
    const baseline = await run('hi', { ...options, extra: source });
    const missing = join(tmp(), 'missing.jsonl');
    const target = join(tmp(), 'target.jsonl');
    const link = join(tmp(), 'link.jsonl');
    writeFileSync(target, '');
    symlinkSync(target, link);
    const normalize = (argv) => argv.map((arg, i) => ['-o', '--output-schema'].includes(argv[i - 1]) ? 'TEMP_FILE' : arg);
    for (const sink of ['', missing, tmp(), 'relative.jsonl', link]) {
      const r = await run('hi', { ...options, extra: { ...source, ASK_EVENTS: sink } });
      assert.equal(r.code, baseline.code);
      assert.equal(r.stdout, baseline.stdout);
      assert.equal(r.stderr, baseline.stderr);
      assert.deepEqual(r.report, baseline.report);
      assert.deepEqual(normalize(r.calls.at(-1).argv), normalize(baseline.calls[0].argv));
      assert.deepEqual(r.calls.at(-1).schema, baseline.calls[0].schema);
      assert.equal(r.calls.at(-1).stdin, baseline.calls[0].stdin);
    }
    assert.ok(!existsSync(missing));
    assert.ok(!existsSync(join(tmp(), 'relative.jsonl')));
    assert.equal(readFileSync(target, 'utf8'), '');
  });

  await t.test('disables a failed sink after an exception or a short append, preserving any partial tail', async (t) => {
    for (const failure of ['exception', 'short write']) await t.test(failure, () => {
      const path = join(tmp(), 'failed-events.jsonl');
      writeFileSync(path, '', { mode: 0o600 });
      const emit = createActivity(path);
      const original = fs.writeSync;
      const target = fs.statSync(path);
      let attempts = 0;
      fs.writeSync = (fd, bytes, ...args) => {
        const file = fs.fstatSync(fd);
        if (file.ino !== target.ino || file.dev !== target.dev) return original(fd, bytes, ...args);
        attempts++;
        if (failure === 'exception') throw new Error('simulated full sink');
        return original(fd, bytes.subarray(0, 3));
      };
      syncBuiltinESMExports();
      const event = (id) => ({ type: 'item.completed', item: { id, type: 'agent_message', text: 'Visible' } });
      try {
        assert.doesNotThrow(() => emit(event('first')));
        assert.doesNotThrow(() => emit(event('second')));
      } finally {
        fs.writeSync = original;
        syncBuiltinESMExports();
      }
      assert.equal(attempts, 1);
      assert.equal(readFileSync(path, 'utf8'), failure === 'exception' ? '' : '{"t');
    });
  });

  await t.test('appends across a failed attempt and a resumed follow-up without changing existing records', async () => {
    const path = join(tmp(), 'events-0.jsonl');
    const previous = { type: 'message', text: 'Previous attempt' };
    const prefix = JSON.stringify(previous) + '\n';
    writeFileSync(path, prefix, { mode: 0o600 });
    const extra = { ASK_EVENTS: path, FAKE_EVENT_FILE: ACTIVITY_FIXTURE };
    const failed = await run('hi', { extra: { ...extra, FAKE_EXIT: '1' } });
    const resumed = await run('hi', { extra: { ...extra, ASK_SESSION: failed.report.session } });
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, '');
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.stdout, 'codex: hi\n');
    assert.ok(readFileSync(path, 'utf8').startsWith(prefix));
    assert.deepEqual(readJsonl(path), [previous, ...EXPECTED_ACTIVITY, ...EXPECTED_ACTIVITY]);
  });
});

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

test('item events report only coarse activity live, keeping the session and clearing at turn end', async (t) => {
  const cases = [
    ['item.started', 'reasoning', 'thinking'],
    ['item.updated', 'command_execution', 'running commands'],
    ['item.completed', 'file_change', 'editing files'],
    ['item.started', 'web_search', 'searching'],
    ['item.updated', 'mcp_tool_call', 'using tools'],
    ['item.completed', 'agent_message', 'answering'],
  ];
  for (const [type, itemType, activity] of cases) await t.test(itemType, async () => {
    const secret = 'PRIVATE_command_path_reasoning_output';
    const item = { type: itemType, command: secret, text: secret, changes: [{ path: secret }], arguments: secret, result: secret };
    const running = run('hi', { extra: { FAKE_EVENTS: `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7 } })}\n${JSON.stringify({ type, item })}`, FAKE_EVENT_PAUSE: '250' } });
    const live = await pollJson(join(tmp(), 'report.json'), running, (report) => report.activity === activity);
    assert.deepEqual(live, { session: 'fake', input: 7, output: 0, cached: 0, activity });
    const r = await running;
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'codex: hi\n');
    assert.match(r.stderr, /^Codex minimal integrations are unavailable:.*\n$/);
    assert.equal(r.report.activity, '');
    assert.equal(r.report.input, 107);
    assert.ok(!JSON.stringify(r.report).includes(secret));
  });
});

test('malformed and unknown item events cannot corrupt activity, sessions or usage', async () => {
  const events = [
    '{"type":"thread.started",', 'null', '[]',
    '{"type":"item.started"}', '{"type":"item.updated","item":null}',
    '{"type":"item.completed","item":{"type":"__proto__","text":"PRIVATE"}}',
    '{"type":"item.started","item":{"type":"future","command":"PRIVATE"}}',
    JSON.stringify({ type: 'future', text: '"turn.completed"' }),
  ].join('\n');
  const r = await run('hi', { extra: { FAKE_EVENTS: events } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'codex: hi\n');
  assert.match(r.stderr, /^Codex minimal integrations are unavailable:.*\n$/);
  assert.equal(r.report.session, 'fake');
  assert.equal(r.report.input, 100);
  assert.equal(r.report.activity, '');
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
  assert.equal(r.stderr.trim().split('\n').pop(), 'codex boom');
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

test('Codex retains config and reports unavailable integration defaults', async () => {
  const r = await run('task', { extra: { FAKE_HELP: 'old CLI without --ignore-user-config' } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /minimal integrations are unavailable/);
  const { argv } = r.calls[0];
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--disable']) assert.ok(!argv.includes(flag));
  assert.ok(!argv.includes('mcp_servers={}'));
});

test('Codex refuses explicit restrictions before exec, resume, naming or discovery', async (t) => {
  for (const key of ['mcp', 'plugins', 'skills', 'hooks']) await t.test(key, async () => {
    const extra = { ASK_ENVIRONMENT: JSON.stringify({ [key]: false }), ASK_TITLE: 'title', FAKE_TITLE_LOG: join(tmp(), 'title.json') };
    for (const continuation of [{}, { ASK_SESSION: 'existing' }]) {
      const r = await run('task', { extra: { ...extra, ...continuation } });
      assert.equal(r.code, 1);
      assert.equal(r.calls.length, 0);
      assert.match(r.stderr, /cannot safely enforce/);
      assert.ok(!existsSync(extra.FAKE_TITLE_LOG));
    }
    const listed = await launch(['models'], offlineEnv(extra));
    assert.equal(listed.code, 1);
    assert.equal(listed.stdout, '');
  });
});

test('Codex full integration opt-in acknowledges normal harness loading', async () => {
  const r = await run('task', { extra: { ASK_ENVIRONMENT: '{"mcp":true,"plugins":true,"skills":true,"hooks":true}' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
});
