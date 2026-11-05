/* Tests for the shared package-test plumbing in helper.mjs, using node itself as the child. Run: node --test src/test/baymax */
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { offline, pollJson, readJson, readJsonl, runProcess } from './helper.mjs';

const NODE = process.execPath;
const { nodeDir, path, tmp, env, launch } = offline(NODE, '/fake/bin');

test('runProcess gives the child only the env it is passed, none by default, with input on stdin', async () => {
  process.env.BAYMAX_LEAK = 'leaked';
  try {
    const script = 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { console.log(JSON.stringify([Object.keys(process.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING"), s])); console.error("err"); process.exit(3); });';
    const r = await runProcess(NODE, ['-e', script], { env: { ONLY: '1' }, input: 'prompt' });
    assert.deepEqual(JSON.parse(r.stdout), [['ONLY'], 'prompt']);
    assert.equal(r.stderr, 'err\n');
    assert.equal(r.code, 3);
    assert.deepEqual(JSON.parse((await runProcess(NODE, ['-e', script])).stdout), [[], '']);
  } finally {
    delete process.env.BAYMAX_LEAK;
  }
});

test('runProcess kills a run that outlives its timeout, children included, and rejects', async () => {
  const marker = join(tmp(), 'grandchild-survived');
  const grandchild = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, ""), 600)`;
  const script = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "inherit" }); setInterval(() => {}, 1000);`;
  await assert.rejects(runProcess(NODE, ['-e', script], { timeout: 200 }), /timed out after 200ms/);
  await sleep(800);
  assert.equal(existsSync(marker), false);
});

test('readJson falls back only for a missing file, and readJsonl skips blank lines', () => {
  assert.equal(readJson(join(tmp(), 'missing')), null);
  assert.deepEqual(readJson(join(tmp(), 'missing'), {}), {});
  writeFileSync(join(tmp(), 'bad.json'), '{"torn":');
  assert.throws(() => readJson(join(tmp(), 'bad.json')), SyntaxError);
  assert.deepEqual(readJsonl(join(tmp(), 'missing')), []);
  writeFileSync(join(tmp(), 'log.jsonl'), '{"a":1}\n\n[2]\n');
  assert.deepEqual(readJsonl(join(tmp(), 'log.jsonl')), [{ a: 1 }, [2]]);
});

test('pollJson returns a value written while the run is going, and nothing once it has finished', async () => {
  const file = join(tmp(), 'report.json');
  const running = sleep(400);
  setTimeout(() => writeFileSync(file, '{"input":5}'), 50);
  assert.deepEqual(await pollJson(file, running, (report) => report.input > 0), { input: 5 });
  assert.equal(await pollJson(file, Promise.resolve(), () => true), undefined);
});

let previous;
test('offline launches in a scratch directory with PATH of bin then a node-only directory', async () => {
  const r = await launch(['-e', 'console.log(JSON.stringify([process.cwd(), process.env.PATH, process.env.HOME, process.env.X]))'], env({ X: 'x' }));
  assert.deepEqual(JSON.parse(r.stdout), [tmp(), `/fake/bin:${nodeDir}`, tmp(), 'x']);
  assert.equal(path, `/fake/bin:${nodeDir}`);
  assert.equal(env({ HOME: '/h' }).HOME, '/h');
  previous = tmp();
});

test('offline gives each test a fresh scratch directory and removes the last one', () => {
  assert.ok(previous);
  assert.notEqual(tmp(), previous);
  assert.equal(existsSync(previous), false);
});
