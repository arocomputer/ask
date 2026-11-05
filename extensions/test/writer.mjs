/* Shared regressions for the local writers; never shipped or imported by installed agents. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

export function testActivityWriter(activityWriter) {
  function sink(t, content = '') {
    const dir = fs.mkdtempSync(join(tmpdir(), 'ask-activity-writer-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'events.jsonl');
    fs.writeFileSync(path, content, { mode: 0o600 });
    return path;
  }

  test('activity writer refuses unsafe sinks without creating or altering files', (t) => {
    const target = sink(t);
    const dir = fs.mkdtempSync(join(tmpdir(), 'ask-activity-sinks-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const link = join(dir, 'link');
    fs.symlinkSync(target, link);
    const publicFile = sink(t);
    fs.chmodSync(publicFile, 0o644);
    const missing = join(dir, 'missing');
    for (const path of ['', missing, 'relative-events.jsonl', dir, link, publicFile]) {
      assert.doesNotThrow(() => activityWriter(path)('message', 'unsafe'));
    }
    assert.equal(fs.existsSync(missing), false);
    assert.equal(fs.readFileSync(target, 'utf8'), '');
    assert.equal(fs.readFileSync(publicFile, 'utf8'), '');
  });

  test('activity writer checks ownership on the opened file', { skip: !process.getuid }, (t) => {
    const path = sink(t);
    const original = fs.fstatSync;
    fs.fstatSync = (fd) => {
      const stat = original(fd);
      stat.uid = process.getuid() + 1;
      return stat;
    };
    syncBuiltinESMExports();
    try {
      assert.doesNotThrow(() => activityWriter(path)('message', 'unsafe'));
    } finally {
      fs.fstatSync = original;
      syncBuiltinESMExports();
    }
    assert.equal(fs.readFileSync(path, 'utf8'), '');
  });

  test('activity writer revalidates permissions and disables an unsafe sink for the invocation', (t) => {
    const path = sink(t);
    const emit = activityWriter(path);
    emit('message', 'first');
    const before = fs.readFileSync(path, 'utf8');
    fs.chmodSync(path, 0o644);
    emit('message', 'unsafe');
    fs.chmodSync(path, 0o600);
    emit('message', 'disabled');
    assert.equal(fs.readFileSync(path, 'utf8'), before);
  });

  test('activity writer preserves whitespace and bounds escaped UTF-8 records and tool names', (t) => {
    const seed = '{"type":"message","text":"previous attempt"}\n';
    const path = sink(t, seed);
    const emit = activityWriter(path);
    emit('message', ' ');
    emit('tool_result', '🐾漢字"\\\t\n'.repeat(10000), '🐾'.repeat(200));
    const wire = fs.readFileSync(path, 'utf8');
    assert.ok(wire.startsWith(seed));
    assert.ok(wire.endsWith('\n'));
    const lines = wire.slice(seed.length).trimEnd().split('\n');
    assert.deepEqual(JSON.parse(lines[0]), { type: 'message', text: ' ' });
    const record = JSON.parse(lines[1]);
    assert.ok(Buffer.byteLength(lines[1] + '\n') <= 16 * 1024);
    assert.ok(record.text.endsWith('…'));
    assert.doesNotMatch(record.text + record.tool, /\ufffd/);
    assert.equal(record.tool, '🐾'.repeat(64));
  });

  test('activity writer strips terminal controls in text and tool names and suppresses common credentials', (t) => {
    const path = sink(t);
    const key = 'ASK_TEST_ACTIVITY_TOKEN';
    const previous = process.env[key];
    process.env[key] = 'fixture-environment-value';
    try {
      const emit = activityWriter(path);
      const controls = '\x1b[31mvisible\x1b[0m\x1b]52;c;clipboard\x07\x1bPdevice\x1b\\\x9dtitle\x9c\r\x00\u202e';
      const credentials = 'Bearer bearer-value Basic basic-value api_key="quoted \\"key\\" value" '
        + "password='password-value' --token flag-value Cookie: cookie-value AWS_ACCESS_KEY_ID=access-value "
        + 'github_pat_fixture ghp_fixture sk-fixture AIzafixture https://user:url-value@example.test/ '
        + '-----BEGIN PRIVATE KEY-----private-value-----END PRIVATE KEY----- fixture-environment-value';
      emit('tool', controls + '\n\t' + credentials, controls);
      emit('message', '\x1b]unfinished title');
      const records = fs.readFileSync(path, 'utf8').trimEnd().split('\n').map(JSON.parse);
      assert.equal(records.length, 1, 'empty sanitized chunks are omitted');
      assert.equal(records[0].tool, 'visible');
      assert.ok(records[0].text.startsWith('visible\n\t'));
      assert.doesNotMatch(records[0].text, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202e]|clipboard|device|title/);
      assert.doesNotMatch(records[0].text, /bearer-value|basic-value|quoted|password-value|flag-value|cookie-value|access-value|github_pat_fixture|ghp_fixture|sk-fixture|AIzafixture|url-value|private-value|fixture-environment-value/);
      assert.match(records[0].text, /\[redacted\]/);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  test('activity writer stops after a short or failed append and never repairs the partial tail', async (t) => {
    for (const failure of ['short', 'exception']) await t.test(failure, (t) => {
      const seed = '{"type":"message","text":"previous attempt"}\n';
      const path = sink(t, seed);
      const emit = activityWriter(path);
      const original = fs.writeSync;
      let attempts = 0;
      fs.writeSync = (fd, bytes) => {
        attempts++;
        const count = original(fd, bytes.subarray(0, 3));
        if (failure === 'exception') throw new Error('simulated write failure after partial append');
        return count;
      };
      syncBuiltinESMExports();
      try {
        assert.doesNotThrow(() => emit('message', 'first'));
        assert.doesNotThrow(() => emit('message', 'second'));
      } finally {
        fs.writeSync = original;
        syncBuiltinESMExports();
      }
      assert.equal(attempts, 1);
      assert.equal(fs.readFileSync(path, 'utf8'), seed + '{"t');
      activityWriter(path)('message', 'retry');
      assert.equal(fs.readFileSync(path, 'utf8'), seed + '{"t' + '{"type":"message","text":"retry"}\n');
    });
  });
}
