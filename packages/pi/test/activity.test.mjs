/* Offline wire fixtures: preserve stdout/report while appending ordered, bounded activity. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, readJson, readJsonl } from '../../../test/baymax/helper.mjs';
const agent = fileURLToPath(new URL('../agents/pi', import.meta.url));
const fake = fileURLToPath(new URL('./bin/pi', import.meta.url));
const native = fileURLToPath(new URL('./fixtures/activity.jsonl', import.meta.url));
const { tmp, env: offlineEnv, launch } = offline(agent);
const sink = () => join(tmp(), 'events-0.jsonl');

async function run(extra = {}) {
  const env = offlineEnv({ ASK_NODE: process.execPath, ASK_PI_BIN: fake,
    ASK_MODEL: 'provider/model', ASK_ACCESS: 'read', ASK_REPORT: join(tmp(), 'report.json'),
    FAKE_LOG: join(tmp(), 'calls'), FAKE_EVENTS: native, ...extra });
  const result = await launch([], env, 'look');
  return { ...result, report: readJson(env.ASK_REPORT), calls: readJsonl(env.FAKE_LOG) };
}
function fixture(events) {
  const path = join(tmp(), 'wire.jsonl');
  writeFileSync(path, events.map((e) => typeof e === 'string' ? e : JSON.stringify(e)).join('\n')); // final native record need not have LF
  return path;
}
function textEvent(text, index = 0) {
  return { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: index, content: text } };
}
function answer() {
  return { type: 'message_end', message: { role: 'assistant', model: 'exact-model', content: [{ type: 'text', text: 'answer' }], stopReason: 'stop' } };
}
const expected = [
  { type: 'message', text: 'Inspecting files 🐾' },
  { type: 'tool', text: 'Started: {"path":"src/main.ts"}', tool: 'read' },
  { type: 'tool_result', text: 'Completed: File contents', tool: 'read' },
  { type: 'tool', text: 'Started: {}', tool: 'grep' },
  { type: 'tool_result', text: 'Failed: No such directory', tool: 'grep' },
  { type: 'message', text: 'answer' },
];

test('native activity is live, ordered and emitted once; final output and report stay independent', async () => {
  writeFileSync(sink(), '', { mode: 0o600 });
  let done = false;
  const running = run({ ASK_EVENTS: sink(), FAKE_PAUSE_AFTER: '16', FAKE_PAUSE: '1500' });
  running.finally(() => { done = true; });
  let live;
  while (!done) {
    try { live = readJsonl(sink()); } catch {} // a reader may catch an in-flight write
    if (live?.some((record) => record.type === 'tool_result')) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(done, false, 'activity was withheld until exit');
  assert.ok(live.length > 0);
  assert.ok(!live.some((record) => record.text === 'answer'));
  const r = await running;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'answer\n');
  assert.deepEqual(readJsonl(sink()), expected);
  const without = await run();
  assert.equal(without.code, r.code);
  assert.equal(without.stdout, r.stdout);
  assert.equal(without.stderr, r.stderr);
  assert.deepEqual(without.report, r.report);
  // Activity cannot alter session/auth/integration/tool arguments or injected permissions.
  assert.deepEqual(without.calls.at(-1), r.calls[0]);
});

test('retries and session follow-ups append without truncating earlier records', async () => {
  const earlier = '{"type":"message","text":"earlier attempt"}\n';
  writeFileSync(sink(), earlier, { mode: 0o600 });
  for (const session of ['', 'continued-session']) {
    const r = await run({ ASK_EVENTS: sink(), ASK_SESSION: session });
    assert.equal(r.code, 0, r.stderr);
  }
  assert.equal(readFileSync(sink(), 'utf8').slice(0, earlier.length), earlier);
  assert.deepEqual(readJsonl(sink()), [{ type: 'message', text: 'earlier attempt' }, ...expected, ...expected]);
});

test('absent, missing, relative and failed sinks do not change agent results or create files', async () => {
  const baseline = await run();
  mkdirSync(join(tmp(), 'directory'));
  for (const path of [undefined, sink(), 'relative-events.jsonl', join(tmp(), 'directory'), '/dev/full']) {
    const r = await run({ ASK_EVENTS: path });
    assert.deepEqual({ code: r.code, stdout: r.stdout, stderr: r.stderr, report: r.report },
      { code: baseline.code, stdout: baseline.stdout, stderr: baseline.stderr, report: baseline.report });
  }
  assert.equal(existsSync(sink()), false);
  assert.equal(existsSync(join(tmp(), 'relative-events.jsonl')), false);
});

test('records bound serialized UTF-8, suppress obvious credentials and neutralize terminal controls', async () => {
  writeFileSync(sink(), '', { mode: 0o600 });
  const known = 'fixture-known-credential';
  const risky = `\x1b]0;untrusted title\x07\x1b[31mHello\x1b[0m\r\x00 Authorization: Bearer fixture-bearer api_key="fixture-key" password='fixture-password' ${known} https://user:fixture-pass@example.test`;
  const huge = '🐾漢字"\\\n'.repeat(10000);
  const tool = '\x1b[32mread\x1b[0m' + '🐾'.repeat(10000);
  const result = { type: 'tool_execution_end', toolName: tool, toolCallId: 'large', result: { content: [{ type: 'text', text: huge }] } };
  const r = await run({ ASK_EVENTS: sink(), OPENAI_API_KEY: known,
    FAKE_EVENTS: fixture([textEvent(risky), textEvent(huge, 1), result,
      { type: 'message_start', message: { role: 'assistant' } }, answer()]) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'answer\n');
  const bytes = readFileSync(sink());
  assert.equal(bytes.at(-1), 10);
  const lines = bytes.toString('utf8').trimEnd().split('\n');
  const records = lines.map(JSON.parse);
  assert.equal(records.length, 4);
  assert.ok(!records[2].tool.includes('\x1b'));
  assert.ok(records[2].text.endsWith('…'));
  assert.ok(records[2].tool.length <= 256);
  for (const line of lines) assert.ok(Buffer.byteLength(line + '\n') <= 16384);
  assert.ok(records[1].text.endsWith('…'));
  assert.ok(!records[1].text.includes('\ufffd'), 'truncation split UTF-8');
  assert.ok(!/[\ud800-\udbff]$/.test(records[1].text.slice(0, -1)), 'truncation split a surrogate pair');
  const redacted = records[0].text;
  for (const value of [known, 'fixture-bearer', 'fixture-key', 'fixture-password', 'fixture-pass', 'untrusted title']) assert.ok(!redacted.includes(value));
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(redacted));
  assert.match(redacted, /\[redacted\]/);
});

test('malformed and unrelated events cannot become activity or break a later valid answer', async () => {
  writeFileSync(sink(), '', { mode: 0o600 });
  const bad = ['{broken', 'null', '[]', '42', '"text"',
    { type: 'unknown', text: '\x1b]0;bad\x07' }, { type: 'text', part: null },
    { type: 'message_update', assistantMessageEvent: null },
    { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 9 } },
    { type: 'tool_use', part: { tool: {}, state: { status: 'completed', output: 'bad' } } },
    { type: 'tool_execution_start', toolName: {}, toolCallId: 't' },
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'user prompt' }] } },
    { type: 'message_end', message: { role: 'assistant', content: { malformed: true } } },
    { type: 'reasoning', part: { text: 'private reasoning' } },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'private reasoning' } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: 'untrusted argument fragment' } }];
  const r = await run({ ASK_EVENTS: sink(), FAKE_EVENTS: fixture([...bad, answer()]) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'answer\n');
  assert.deepEqual(readJsonl(sink()), [{ type: 'message', text: 'answer' }]);
});

test('a sink that fails after live delivery cannot fail the turn or change its report', async () => {
  writeFileSync(sink(), '', { mode: 0o600 });
  let done = false;
  const running = run({ ASK_EVENTS: sink(), FAKE_PAUSE_AFTER: '16', FAKE_PAUSE: '1500' });
  running.finally(() => { done = true; });
  while (!done && !readJsonl(sink()).some((record) => record.text === 'Failed: No such directory')) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(done, false);
  renameSync(sink(), join(tmp(), 'saved-events.jsonl'));
  mkdirSync(sink());
  const r = await running;
  const without = await run();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, without.stdout);
  assert.equal(r.stderr, without.stderr);
  assert.deepEqual(r.report, without.report);
});
