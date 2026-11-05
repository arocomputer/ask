/* Offline native-stream tests of the ASK_EVENTS projection, separate from the final answer. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { offline, pollJson, readJson, readJsonl } from '../../../src/test/integration/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { tmp, env, launch } = offline(join(HERE, '..', 'agents', 'gemini'), join(HERE, 'bin'));
const message = (content) => ({ type: 'message', role: 'assistant', content, delta: true });
const tool = (tool_name, parameters) => ({ type: 'tool_use', tool_name, tool_id: 't', parameters });
const result = (output) => ({ type: 'tool_result', tool_id: 't', status: 'success', output });
const hidden = { type: 'reasoning', text: 'hidden-thought' };

function file(name, content = '') {
  const path = join(tmp(), name);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}
const jsonl = (events) => events.map((event) => JSON.stringify(event) + '\n').join('');
function start(extra = {}, prompt = 'hi') {
  const report = join(tmp(), 'report.json');
  return launch([], env({ ASK_MODEL: 'gemini-3.5-flash', ASK_ACCESS: 'read', ASK_REPORT: report,
    COPILOT_HOME: join(tmp(), 'copilot'), ...extra }), prompt).then((r) => ({ ...r, report: readJson(report) }));
}
function answer(r) {
  const { session, ...report } = r.report;
  assert.match(session, /^[0-9a-f-]{36}$/);
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, report };
}
function events(path) {
  const wire = readFileSync(path, 'utf8');
  assert.ok(wire.endsWith('\n'));
  for (const line of wire.trimEnd().split('\n')) {
    assert.ok(Buffer.byteLength(line + '\n') <= 16 * 1024);
    const event = JSON.parse(line);
    assert.ok(['message', 'tool', 'tool_result'].includes(event.type));
    assert.equal(typeof event.text, 'string');
    assert.ok(Object.keys(event).every((key) => ['type', 'text', 'tool'].includes(key)));
    if ('tool' in event) assert.equal(typeof event.tool, 'string');
  }
  return readJsonl(path);
}

test('projects native narration, tool calls and results without changing answer or report', async () => {
  const baseline = await start({ FAKE_TOOLS: '1' });
  const sink = file('activity.jsonl');
  const r = await start({ ASK_EVENTS: sink, FAKE_TOOLS: '1' });
  assert.deepEqual(answer(r), answer(baseline));
  assert.equal(r.code, 0, r.stderr);
  const activity = events(sink);
  assert.deepEqual(activity.map((event) => event.type), ['message', 'tool', 'tool_result', 'message', 'message']);
  assert.equal(activity[0].text, 'Let me look.');
  assert.equal(activity[1].tool, 'read_file');
  assert.match(activity[1].text, /file_path/);
  assert.deepEqual(activity[2], { type: 'tool_result', text: 'a', tool: 'read_file' });
  assert.equal(activity.slice(3).map((event) => event.text).join(''), 'gemini: hi');
});

test('emits a complete UTF-8 message while the native CLI is still running', async () => {
  const sink = file('activity.jsonl');
  const stream = file('stream.jsonl', jsonl([message('Hel🌍lo')]));
  const release = join(tmp(), 'release');
  const running = start({ ASK_EVENTS: sink, FAKE_STREAM: stream, FAKE_RELEASE: release, FAKE_ANSWER: 'Hel🌍lo' });
  try {
    const live = await pollJson(sink, running, (event) => event.type === 'message');
    assert.deepEqual(live, { type: 'message', text: 'Hel🌍lo' });
  } finally {
    writeFileSync(release, 'go');
  }
  const r = await running;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'Hel🌍loHel🌍lo\n');
});

test('bounds and sanitizes untrusted visible fields, ignoring hidden and malformed data', async () => {
  const sink = file('activity.jsonl');
  const untrusted = '\x1b[31mred\x1b[0m\x1b]0;title\x07\x00\r\u202e '
    + 'Bearer fake-credential api_key="fake-key" github_pat_fakevalue '
    + 'https://user:fake-password@example.test/ '
    + '-----BEGIN PRIVATE KEY-----fake-private-key-----END PRIVATE KEY----- '
    + '😃\t\n"\\'.repeat(20000);
  const input = [null, [], 42, {}, hidden, { type: 'unknown', text: 'do not project', password: 'metadata-secret' },
    message({ unexpected: 'not text' }), tool('read_file', { path: 'a', password: 'argument-secret' }),
    result(untrusted), result({ unexpected: 'not text' }), result('a'.repeat(100000))];
  const stream = file('stream.jsonl', 'not json\n' + jsonl(input));
  const tail = file('tail', '{"type":');
  const r = await start({ ASK_EVENTS: sink, FAKE_STREAM: stream, FAKE_TAIL: tail, FAKE_TOOLS: '1' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'gemini: hi\n');
  const activity = events(sink);
  const wire = readFileSync(sink, 'utf8');
  assert.doesNotMatch(wire, /fake-credential|fake-key|github_pat_fakevalue|fake-password|fake-private-key|argument-secret|metadata-secret|hidden-thought|do not project/);
  assert.ok(activity.some((event) => event.text.includes('[redacted]')));
  const output = activity.find((event) => event.type === 'tool_result');
  assert.ok(output.text.endsWith('…'));
  assert.doesNotMatch(output.text, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202e]/);
  assert.ok(!output.text.includes('\ufffd'), 'truncation preserves Unicode code points');
});

test('preserves whitespace message chunks', async () => {
  const sink = file('activity.jsonl');
  const stream = file('stream.jsonl', jsonl([message('before'), message(' '), message('after'), { type: 'unknown', reasoning: 'hidden-thought' }]));
  const r = await start({ ASK_EVENTS: sink, FAKE_STREAM: stream, FAKE_TOOLS: '1' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'gemini: hi\n');
  const activity = events(sink);
  assert.deepEqual(activity.slice(0, 3), ['before', ' ', 'after'].map((text) => ({ type: 'message', text })));
  assert.equal(activity[3].text, 'Let me look.');
  assert.doesNotMatch(readFileSync(sink, 'utf8'), /hidden-thought/);
});

test('projects native tool error text without copying other event fields', async () => {
  const sink = file('activity.jsonl');
  const stream = file('stream.jsonl', jsonl([tool('read_file', { path: 'a' }), { type: 'tool_result', tool_id: 't', status: 'error', error: { type: 'execution', message: 'read denied' } }]));
  const r = await start({ ASK_EVENTS: sink, FAKE_STREAM: stream, FAKE_read_fileS: '1' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(events(sink)[1], { type: 'tool_result', text: 'read denied', tool: 'read_file' });
});

test('missing, failed and unsafe sinks preserve success and native failure behavior', async (t) => {
  const privateFile = file('private');
  const symlink = join(tmp(), 'symlink');
  symlinkSync(privateFile, symlink);
  const publicFile = file('public');
  chmodSync(publicFile, 0o644);
  const directory = join(tmp(), 'directory');
  mkdirSync(directory);
  const missing = join(tmp(), 'missing');
  const readOnly = file('read-only');
  chmodSync(readOnly, 0o400);
  const sinks = { absent: undefined, missing, relative: 'relative.jsonl', directory, symlink, public: publicFile, readOnly };
  const baseline = answer(await start({ FAKE_TOOLS: '1' }));
  const failure = answer(await start({ FAKE_FAIL: 'hi' }));
  for (const [name, sink] of Object.entries(sinks)) {
    await t.test(name, async () => {
      assert.deepEqual(answer(await start({ ASK_EVENTS: sink, FAKE_TOOLS: '1' })), baseline);
      assert.deepEqual(answer(await start({ ASK_EVENTS: sink, FAKE_FAIL: 'hi' })), failure);
    });
  }
  assert.equal(existsSync(missing), false);
  assert.equal(existsSync(join(tmp(), 'relative.jsonl')), false);
  assert.equal(readFileSync(privateFile, 'utf8'), '');
  assert.equal(readFileSync(publicFile, 'utf8'), '');
});

test('appends across a failed attempt and retry, including a complete final line without newline', async () => {
  const seed = { type: 'message', text: 'previous attempt' };
  const sink = file('activity.jsonl', jsonl([seed]));
  const stream = file('stream.jsonl', jsonl([message('before failure')]));
  const failed = await start({ ASK_EVENTS: sink, FAKE_STREAM: stream, FAKE_FAIL: 'hi' });
  assert.equal(failed.code, 1);
  const prefix = readFileSync(sink, 'utf8');
  assert.deepEqual(events(sink), [seed, { type: 'message', text: 'before failure' }]);
  const tail = file('tail', JSON.stringify(result('final result without newline')));
  const retried = await start({ ASK_EVENTS: sink, FAKE_TAIL: tail });
  assert.equal(retried.code, 0, retried.stderr);
  assert.ok(readFileSync(sink, 'utf8').startsWith(prefix));
  assert.deepEqual(events(sink).at(-1), { type: 'tool_result', text: 'final result without newline' });
});
