/*
 * Tests for the claude agent. Runs agents/claude as ask does (prompt on stdin, ASK_* env,
 * answer on stdout, report in $ASK_REPORT), driving the fake claude in ./bin. No network, no real
 * models. Run: node --test
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, pollJson, readJson, readJsonl } from '../../../src/test/integration/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, '..', 'agents', 'claude');
const FAKE = join(HERE, 'bin', 'claude');
const { nodeDir: NODE_DIR, tmp, env: offlineEnv, launch } = offline(AGENT, join(HERE, 'bin'));

/*
 * Runs the agent on one prompt. Resolves with { code, stdout, stderr, report, calls }, where calls
 * are the fake CLI's recorded invocations.
 */
async function run(prompt, { model = 'opus-5.5', effort = '', access = 'read', schema, extra = {} } = {}) {
  const env = offlineEnv({ FAKE_LOG: join(tmp(), 'calls.jsonl'), ASK_MODEL: model, ASK_EFFORT: effort, ASK_ACCESS: access, ASK_REPORT: join(tmp(), 'report.json'), ...extra });
  if (schema) writeFileSync((env.ASK_SCHEMA = join(tmp(), 'schema.json')), JSON.stringify(schema));
  const r = await launch([], env, prompt);
  return { ...r, report: readJson(env.ASK_REPORT), calls: readJsonl(env.FAKE_LOG) };
}

/* Runs `claude models` and resolves with its lines. */
async function models(extra = {}) {
  const r = await launch(['models'], offlineEnv(extra));
  return r.stdout.trim().split('\n').filter(Boolean);
}

const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
const GROUNDING = 'Answer from the files in your working directory: search and read them before answering. Never guess file names, functions or facts; if you cannot find something, say so.\n\n';

const ACTIVITY_FIXTURE = join(HERE, 'fixtures', 'activity.jsonl');
const EXPECTED_ACTIVITY = [
  { type: 'message', text: 'Inspecting ' },
  { type: 'message', text: 'files 🔎.\n' },
  { type: 'tool', text: 'Read', tool: 'Read' },
  { type: 'tool_result', text: 'package main\n', tool: 'Read' },
  { type: 'message', text: 'Subagent summary.' },
  { type: 'message', text: 'Done.' },
  { type: 'message', text: ' ✅' },
  { type: 'tool', text: 'Bash', tool: 'Bash' },
  { type: 'tool_result', text: 'Error: permission denied', tool: 'Bash' },
  { type: 'message', text: 'Fallback visible.' },
];

test('visible activity', async (t) => {
  await t.test('streams native deltas and tool lifecycles live without repeating assistant snapshots', async () => {
    const path = join(tmp(), 'events-0.jsonl');
    const gate = join(tmp(), 'continue');
    writeFileSync(path, '', { mode: 0o600 });
    const running = run('hi', { extra: { ASK_EVENTS: path, FAKE_EVENT_FILE: ACTIVITY_FIXTURE, FAKE_EVENT_CHUNK_SIZE: '1', FAKE_EVENT_GATE_AFTER: '3', FAKE_EVENT_GATE: gate } });
    let live;
    try { live = await pollJson(path, running, (record) => record.type === 'message'); }
    finally { writeFileSync(gate, ''); }
    const r = await running;
    assert.deepEqual(live, EXPECTED_ACTIVITY[0]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'claude: hi\n');
    assert.deepEqual(readJsonl(path), EXPECTED_ACTIVITY);
    assert.equal(r.report.input, 35);
    assert.equal(r.report.output, 7);
    assert.ok(!JSON.stringify(r.report).includes('Inspecting'));
  });

  await t.test('bounds complete UTF-8 JSONL records and suppresses obvious credentials and terminal controls', async () => {
    const path = join(tmp(), 'events-0.jsonl');
    const source = join(tmp(), 'large.jsonl');
    writeFileSync(path, '', { mode: 0o600 });
    const prefix = '\u001b]52;c;CLIPBOARD\u0007\u001b[31mvisible\u001b[0m\r\b API_KEY="key with spaces" password=hunter2 Authorization: Bearer abc123 Basic basicvalue https://user:pass@example.com sk-abcdefghijklmnop ghp_abcdefghijklmnop AWS_SECRET_ACCESS_KEY=awsvalue\n';
    const huge = prefix + '🔎\\"\n'.repeat(12000);
    const tool = 'Read' + '🔎'.repeat(10000);
    const events = [
      { type: 'assistant', message: { id: 'large', content: [{ type: 'text', text: huge }, { type: 'tool_use', id: 'large-tool', name: tool }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'large-tool', content: huge }] } },
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

  await t.test('ignores malformed, hidden and unrelated native events and recovers for a valid message', async () => {
    const path = join(tmp(), 'events-0.jsonl');
    writeFileSync(path, '', { mode: 0o600 });
    const events = [
      'not json', 'null', '[]', '42', '{"type":"stream_event","event":null}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"UNRELATED"}}}',
      '{"type":"assistant","message":{"id":"bad","content":[null,{"type":"text","text":42},{"type":"thinking","thinking":"HIDDEN"},{"type":"redacted_thinking","data":"HIDDEN"}]}}',
      '{"type":"user","message":{"content":[null,{"type":"text","text":"PROMPT"},{"type":"tool_result","tool_use_id":"bad","content":42}]}}',
      '{"type":"future","text":"UNRELATED"}',
      '{"type":"assistant","message":{"id":"good","content":[{"type":"text","text":"Visible"}]}}',
    ].join('\n');
    const r = await run('hi', { extra: { ASK_EVENTS: path, FAKE_EVENTS: events } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'claude: hi\n');
    assert.deepEqual(readJsonl(path), [{ type: 'message', text: 'Visible' }]);
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
    for (const sink of ['', missing, tmp(), 'relative.jsonl', link]) {
      const r = await run('hi', { ...options, extra: { ...source, ASK_EVENTS: sink } });
      assert.equal(r.code, baseline.code);
      assert.equal(r.stdout, baseline.stdout);
      assert.equal(r.stderr, baseline.stderr);
      assert.deepEqual(r.report, baseline.report);
      assert.deepEqual(r.calls.at(-1).argv, baseline.calls[0].argv);
      assert.equal(r.calls.at(-1).stdin, baseline.calls[0].stdin);
    }
    assert.ok(!existsSync(missing));
    assert.ok(!existsSync(join(tmp(), 'relative.jsonl')));
    assert.equal(readFileSync(target, 'utf8'), '');
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
    assert.equal(resumed.stdout, 'claude: hi\n');
    assert.ok(readFileSync(path, 'utf8').startsWith(prefix));
    assert.deepEqual(readJsonl(path), [previous, ...EXPECTED_ACTIVITY, ...EXPECTED_ACTIVITY]);
  });
});

test('lists its models as family-version, with their names', async () => {
  assert.deepEqual(await models(), ['fable-5.1\tFable 5.1', 'opus-5.5\tOpus 5.5', 'sonnet-5.5\tSonnet 5.5', 'haiku-4.5\tHaiku 4.5']);
});

test("runs family-version as Claude Code's id, and passes a full id through", async () => {
  const [short] = (await run('hi', { model: 'sonnet-5.5' })).calls;
  const full = (await run('hi', { model: 'claude-haiku-4-5-20251001' })).calls[1];
  const major = (await run('hi', { model: 'sonnet-5' })).calls[2];
  assert.equal(after(short.argv, '--model'), 'claude-sonnet-5-5');
  assert.equal(after(major.argv, '--model'), 'claude-sonnet-5');
  assert.equal(after(full.argv, '--model'), 'claude-haiku-4-5-20251001');
});

test('matches model names without regard to case', async () => {
  const [call] = (await run('hi', { model: 'Sonnet-5.5' })).calls;
  assert.equal(after(call.argv, '--model'), 'claude-sonnet-5-5');
});

test('names the Claude session from ASK_TITLE', async () => {
  const [call] = (await run('hi', { extra: { ASK_TITLE: 'Sonnet 5.5 · Fix tests · write' } })).calls;
  assert.equal(after(call.argv, '--name'), 'Sonnet 5.5 · Fix tests · write');
});

test('refuses an alias, naming the exact model to use', async () => {
  const r = await run('hi', { model: 'sonnet' });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
  assert.match(r.stderr, /"sonnet" is an alias; name the exact model, like claude:sonnet-5.5/);
});

test('read runs get the read-only flags', async () => {
  const r = await run('where is main?');
  assert.equal(r.code, 0);
  const [call] = r.calls;
  assert.equal(after(call.argv, '--permission-mode'), 'default');
  assert.equal(after(call.argv, '--allowedTools'), 'Read,Grep,Glob');
  assert.equal(after(call.argv, '--disallowedTools'), 'Bash,Edit,Write,NotebookEdit');
});

test('read runs refuse shell access entirely', async () => {
  const [call] = (await run('look')).calls;
  assert.equal(after(call.argv, '--disallowedTools'), 'Bash,Edit,Write,NotebookEdit');
  assert.equal(after(call.argv, '--allowedTools'), 'Read,Grep,Glob');
});

test('a new read run is told to answer from the files; write runs and follow-ups get the prompt as is', async () => {
  const read = (await run('where is main?')).calls[0];
  const write = (await run('fix it', { access: 'write' })).calls[1];
  const followUp = (await run('and then?', { extra: { ASK_SESSION: 'ses' } })).calls[2];
  assert.equal(read.stdin, `${GROUNDING}where is main?`);
  assert.equal(write.stdin, 'fix it');
  assert.equal(followUp.stdin, 'and then?');
});

test('write runs bypass permissions', async () => {
  const r = await run('fix it', { access: 'write' });
  assert.equal(after(r.calls[0].argv, '--permission-mode'), 'bypassPermissions');
  assert.ok(!r.calls[0].argv.includes('--allowedTools'));
});

test('passes an effort as --effort', async () => {
  const [call] = (await run('hi', { effort: 'high' })).calls;
  assert.equal(after(call.argv, '--effort'), 'high');
});

test('answers on stdout and reports usage', async () => {
  const r = await run('hi');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'claude: hi\n');
  for (const [key, value] of Object.entries({ input: 35, output: 7, cached: 20, cost: 0.01 })) assert.equal(r.report[key], value, key);
});

test('reports usage while Claude Code is still running', async () => {
  const running = run('hi', { extra: { FAKE_PAUSE: '1500' } });
  const live = await pollJson(join(tmp(), 'report.json'), running, (report) => report.input > 0);
  assert.ok(live, 'no usage reported before the run finished');
  await running;
});

test('reports coarse activity without exposing tool contents', async () => {
  const secret = 'private command and path';
  const running = run('hi', { extra: { FAKE_BLOCK: JSON.stringify({ type: 'tool_use', name: 'Bash', input: { command: secret } }), FAKE_PAUSE: '1500' } });
  const live = await pollJson(join(tmp(), 'report.json'), running, (report) => report.activity === 'running commands');
  assert.ok(live, 'no activity reported while running');
  assert.ok(!JSON.stringify(live).includes(secret));
  const r = await running;
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'claude: hi\n');
});

test('reports the model that did most of the work', async () => {
  // The fake's haiku call did less, so the name is opus's whatever model was asked for.
  assert.equal((await run('hi', { model: 'haiku-4.5' })).report.name, 'Opus 5.5');
});

test('fails a run whose Claude Code exited nonzero, with the reason last on stderr', async () => {
  const r = await run('hi', { extra: { FAKE_EXIT: '1' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr.trim().split('\n').pop(), /exit 1/);
});

test("a failing Claude Code's own message is the reason", async () => {
  const r = await run('break', { extra: { FAKE_FAIL: 'break' } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr.trim().split('\n').pop(), 'claude boom');
});

test('passes a schema natively and answers with the structured output', async () => {
  const r = await run('go', { schema: { type: 'object' }, extra: { FAKE_ANSWER: '{"a": 1}' } });
  assert.deepEqual(JSON.parse(r.stdout), { a: 1 });
  assert.deepEqual(JSON.parse(after(r.calls[0].argv, '--json-schema')), { type: 'object' });
});

test('starts each run with a session id it reports at once, and resumes it on a follow-up', async () => {
  const first = await run('hi');
  const id = after(first.calls[0].argv, '--session-id');
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(first.report.session, id);
  const second = await run('more', { extra: { ASK_SESSION: id } });
  assert.equal(after(second.calls[1].argv, '--resume'), id);
  assert.ok(!second.calls[1].argv.includes('--session-id'));
  assert.equal(second.report.session, id);
});

test('finds Claude Code off PATH through ASK_CLAUDE_BIN', async () => {
  const r = await run('hi', { extra: { PATH: NODE_DIR, ASK_CLAUDE_BIN: FAKE } });
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
});

test('finds Claude Code off PATH where its installer puts it', async () => {
  mkdirSync(join(tmp(), '.local', 'bin'), { recursive: true });
  symlinkSync(FAKE, join(tmp(), '.local', 'bin', 'claude'));
  const r = await run('hi', { extra: { PATH: NODE_DIR } });
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
});

test('without Claude Code, models and runs fail saying how to install it', async () => {
  const extra = { ASK_CLAUDE_BIN: join(tmp(), 'missing') };
  const hint = /^Claude Code not found: install it from https:\/\/claude\.com\/claude-code, or set ASK_CLAUDE_BIN to its path\n$/;
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
  assert.equal(r.stderr, 'claude needs Node.js 18 or newer: install it from https://nodejs.org (or set ASK_NODE)\n');
});

test("passes ask's cost limit to Claude Code, and reports reaching it in ask's words", async () => {
  const r = await run('hi', { extra: { ASK_MAX_COST: '0.005' } });
  assert.equal(after(r.calls[0].argv, '--max-budget-usd'), '0.005');
  assert.equal(r.code, 1);
  assert.match(r.stderr.trim().split('\n').pop(), /^stopped at the \$0\.005 cost limit$/);
  assert.equal(r.report.cost, 0.01);
  assert.equal(r.report.input, 35);
  assert.ok(r.report.session);
});

test('minimal MCP and skills controls apply to read, write and continued launches', async () => {
  for (const options of [{}, { access: 'write' }, { extra: { ASK_SESSION: 'existing' } }]) {
    const r = await run('task', options);
    assert.equal(r.code, 0, r.stderr);
    const { argv } = r.calls.at(-1);
    assert.ok(argv.includes('--strict-mcp-config'));
    assert.deepEqual(JSON.parse(after(argv, '--mcp-config')), { mcpServers: {} });
    assert.ok(argv.includes('--disable-slash-commands'));
    if (options.access !== 'write') assert.equal(after(argv, '--tools'), 'Read,Grep,Glob');
    for (const flag of ['--bare', '--safe-mode', '--restricted', '--setting-sources', '--settings']) assert.ok(!argv.includes(flag), flag);
    assert.match(r.stderr, /unavailable for plugins.*policy hooks/);
  }
});

test('skills and MCP opt-in remove only their own controls', async () => {
  const skills = await run('task', { extra: { ASK_ENVIRONMENT: '{"skills":true}' } });
  assert.equal(skills.code, 0, skills.stderr);
  assert.ok(!skills.calls.at(-1).argv.includes('--disable-slash-commands'));
  assert.ok(skills.calls.at(-1).argv.includes('--strict-mcp-config'));
  const mcp = await run('task', { access: 'write', extra: { ASK_ENVIRONMENT: '{"mcp":true}' } });
  assert.equal(mcp.code, 0, mcp.stderr);
  assert.ok(!mcp.calls.at(-1).argv.includes('--strict-mcp-config'));
  assert.ok(mcp.calls.at(-1).argv.includes('--disable-slash-commands'));
});

test('unavailable explicit Claude restrictions and unsafe opt-ins refuse before a task', async (t) => {
  for (const [policy, reason] of [
    [{ hooks: false }, /policy hooks/], [{ plugins: false }, /plugins:false cannot be enforced/],
    [{ plugins: true }, /trusted write run/], [{ mcp: true }, /trusted write run/],
  ]) await t.test(JSON.stringify(policy), async () => {
    const r = await run('task', { extra: { ASK_ENVIRONMENT: JSON.stringify(policy) } });
    assert.equal(r.code, 1);
    assert.equal(r.calls.length, 0);
    assert.match(r.stderr, reason);
  });
});

test('older Claude keeps legacy flags with a warning but refuses explicit unsupported controls', async () => {
  const legacy = { FAKE_HELP: '--allowedTools <tools...>\n--disallowedTools <tools...>' };
  const r = await run('task', { extra: legacy });
  assert.equal(r.code, 0, r.stderr);
  const { argv } = r.calls.at(-1);
  for (const flag of ['--strict-mcp-config', '--mcp-config', '--tools', '--disable-slash-commands']) assert.ok(!argv.includes(flag));
  assert.match(r.stderr, /unavailable for mcp, skills, built-in tool selection/);
  for (const key of ['mcp', 'skills']) {
    const denied = await run('task', { extra: { ...legacy, ASK_ENVIRONMENT: JSON.stringify({ [key]: false }) } });
    assert.equal(denied.code, 1);
    assert.equal(denied.calls.length, 1); // Only the preceding legacy task reached the harness.
    assert.match(denied.stderr, /help does not confirm controls/);
  }
  const failed = await run('task', { extra: { FAKE_HELP_EXIT: '1', ASK_ENVIRONMENT: '{"mcp":false}' } });
  assert.equal(failed.code, 1);
  assert.equal(failed.calls.length, 1);
});

test('Claude uses the ordinary permission mode advertised by newer help', async () => {
  const r = await run('task', { extra: { FAKE_HELP: '--tools <tools...>\n--permission-mode (choices: "manual", "bypassPermissions")' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(after(r.calls.at(-1).argv, '--permission-mode'), 'manual');
});
