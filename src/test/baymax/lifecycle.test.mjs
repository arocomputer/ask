/* Check embedded package resources, refresh and removal without touching a developer's home. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { harness, root, selection } from './integration.mjs';

const ask = process.env.BAYMAX_ASK;
const names = selection(process.env.BAYMAX_PACKAGES ? JSON.parse(process.env.BAYMAX_PACKAGES) : []);

/* Return every shipped resource, including nested helper files required at runtime. */
function resources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? resources(path) : [path];
  });
}

for (const name of names) {
  test(`${name}: package lifecycle`, { skip: !ask && 'run via ./x baymax', timeout: 60_000 }, async (t) => {
    const s = await harness(name, ask);
    t.after(s.cleanup);
    const source = join(root, 'packages', name);
    const installed = join(s.env.ASK_HOME, 'packages', 'ask', 'packages', name);
    await t.test('every embedded resource matches the source and launchers are executable', () => {
      const files = ['README.md', ...['agents', 'lib'].flatMap((dir) => resources(join(source, dir)).map((path) => relative(source, path)))];
      for (const file of files) {
        const target = join(installed, file);
        assert.deepEqual(readFileSync(target), readFileSync(join(source, file)), `${name}/${file}`);
        if (file.startsWith('agents/')) assert.ok(statSync(target).mode & 0o111, `${file} is executable`);
      }
      assert.equal(existsSync(join(installed, 'test')), false, 'simulators are never installed');
    });
    await t.test('a stale installed package refreshes without replacing user overrides', async () => {
      const own = join(s.env.ASK_HOME, 'agents');
      mkdirSync(own, { recursive: true });
      const override = join(own, name);
      const content = '#!/bin/sh\necho baymax-user-model\n';
      writeFileSync(override, content, { mode: 0o755 });
      writeFileSync(join(installed, '.ask-version'), 'previous-build\n');
      writeFileSync(join(installed, 'README.md'), 'stale resource\n');
      const out = await s.run(['packages']);
      assert.equal(out.code, 0, out.stderr);
      assert.deepEqual(readFileSync(join(installed, 'README.md')), readFileSync(join(source, 'README.md')));
      assert.equal(readFileSync(override, 'utf8'), content);
    });
    await t.test('removal leaves user agents and unrelated files intact', async () => {
      const sentinel = join(s.home, 'keep.txt');
      writeFileSync(sentinel, 'user content');
      const override = join(s.env.ASK_HOME, 'agents', name);
      const before = readFileSync(override);
      const out = await s.run(['remove', name]);
      assert.equal(out.code, 0, out.stderr);
      assert.equal(existsSync(installed), false);
      assert.deepEqual(readFileSync(override), before);
      assert.equal(readFileSync(sentinel, 'utf8'), 'user content');
    });
  });
}
