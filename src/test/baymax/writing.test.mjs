/* Real ask WRITE checks with a cooperative simulated agent and disposable projects.
 * No models or APIs run. Read immutability proves this fixture honors ASK_ACCESS, not that
 * ask confines arbitrary agents or that any vendor enforces its own restrictions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute, isolated } from './integration.mjs';

const ask = process.env.BAYMAX_ASK && resolve(process.env.BAYMAX_ASK);
const options = { skip: !ask && 'supply BAYMAX_ASK with a built ask binary', timeout: 30_000 };
const writer = fileURLToPath(new URL('./fixtures/writer', import.meta.url));
const original = 'original project\n';

/* Locate only git on the host PATH; children retain a PATH with Node and this explicit link.
 * Git runs with a disposable HOME and system/global config disabled, never host git settings. */
function hostGit() {
  if (process.env.BAYMAX_GIT) {
    const path = process.env.BAYMAX_GIT;
    assert.ok(isAbsolute(path), 'BAYMAX_GIT must be an absolute executable path');
    accessSync(path, constants.X_OK);
    assert.ok(statSync(path).isFile());
    return realpathSync(path);
  }
  for (const entry of (process.env.PATH || '').split(delimiter)) {
    if (!entry) continue;
    const candidate = resolve(entry, 'git');
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {}
  }
  throw new Error('real ask Git WRITE checks require git on the host PATH');
}

/* Install the generic agent privately; read records from the one new run, not stderr titles. */
function fixture(t, git = false) {
  const s = isolated('ask-baymax-writing-');
  t.after(() => {
    try { assert.equal(readFileSync(join(s.dir, 'project.txt'), 'utf8'), original, 'file outside the task directory changed'); }
    finally { s.cleanup(); }
  });
  writeFileSync(join(s.dir, 'project.txt'), original);
  writeFileSync(join(s.work, 'project.txt'), original);
  mkdirSync(join(s.env.ASK_HOME, 'agents'), { recursive: true });
  symlinkSync(writer, join(s.env.ASK_HOME, 'agents', 'writer'));
  if (git) {
    symlinkSync(hostGit(), join(s.bin, 'git'));
    Object.assign(s.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null' });
  }
  s.run = async (args, input = '', expectedCode = 0) => {
    const runs = join(s.env.ASK_HOME, 'runs');
    const before = new Set(existsSync(runs) ? readdirSync(runs) : []);
    const bounded = args[0] === 'batch' ? ['batch', '-t', '10', ...args.slice(1)] : ['-t', '10', ...args];
    const out = await execute(ask, bounded, { cwd: s.work, env: s.env, input });
    assert.equal(out.code, expectedCode, out.stderr);
    const created = readdirSync(runs).filter((name) => !before.has(name));
    assert.equal(created.length, 1, 'expected one new ask run');
    return JSON.parse(readFileSync(join(runs, created[0], 'results.json'), 'utf8'));
  };
  s.git = async (...args) => {
    const out = await execute(join(s.bin, 'git'), ['-C', s.work, ...args], { env: s.env });
    assert.equal(out.code, 0, out.stderr);
    return out.stdout;
  };
  return s;
}

/* Seed a committed project without templates, hooks, signing, or external git configuration. */
async function repository(t) {
  const s = fixture(t, true);
  await s.git('init', '-q', '-b', 'main', '--template=');
  await s.git('add', 'project.txt');
  await s.git('-c', 'user.name=Baymax', '-c', 'user.email=baymax@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'seed');
  return s;
}

/* Check the actual agent environment against the fixture allowlist, never reading host config.
 * This pins test isolation, not ask's ability to sanitize arbitrary caller credentials. */
function environment(s, result, access, cwd = s.work) {
  const observation = JSON.parse(result.answer);
  assert.equal(result.write, access === 'write');
  assert.equal(observation.access, access);
  assert.equal(observation.cwd, cwd);
  assert.equal(observation.home, s.home);
  assert.equal(observation.askHome, s.env.ASK_HOME);
  assert.equal(observation.path, s.bin);
  assert.equal(observation.tmpdir, s.env.TMPDIR);
  assert.deepEqual(observation.inheritedConfig, s.env.GIT_CONFIG_GLOBAL ? ['GIT_CONFIG_GLOBAL'] : []);
  assert.deepEqual(observation.userConfig, []);
  return observation;
}

test('-w edits a normal folder with the isolated write environment', options, async (t) => {
  const s = fixture(t);
  const [result] = await s.run(['-m', 'writer:deterministic', '-w', 'normal edit']);
  environment(s, result, 'write');
  assert.equal(readFileSync(join(s.work, 'project.txt'), 'utf8'), 'normal edit\n');
});

test('-r leaves the project unchanged with the isolated read environment', options, async (t) => {
  const s = fixture(t);
  const [result] = await s.run(['-m', 'writer:deterministic', '-r', 'attempted edit']);
  environment(s, result, 'read');
  assert.equal(readFileSync(join(s.work, 'project.txt'), 'utf8'), original);
});

test('a checkout write records its changed path and excludes pre-existing edits', options, async (t) => {
  const s = await repository(t);
  writeFileSync(join(s.work, 'unrelated.txt'), 'pre-existing edit\n');
  const [result] = await s.run(['-m', 'writer:deterministic', '-w', 'checkout edit']);
  environment(s, result, 'write');
  assert.equal(readFileSync(join(s.work, 'project.txt'), 'utf8'), 'checkout edit\n');
  assert.equal(readFileSync(join(s.work, 'unrelated.txt'), 'utf8'), 'pre-existing edit\n');
  assert.deepEqual(result.changes, [{ path: 'project.txt', change: 'modified' }]);
});

test('a failed writer retains its actual changes without recording a successful answer', options, async (t) => {
  const s = await repository(t);
  const [result] = await s.run(['-m', 'writer:deterministic', '-w', 'fail after edit'], '', 1);
  assert.equal(result.ok, false);
  assert.match(result.error, /simulated writer failed after editing/);
  assert.equal(result.answer, undefined);
  assert.equal(readFileSync(join(s.work, 'project.txt'), 'utf8'), 'fail after edit\n');
  assert.deepEqual(result.changes, [{ path: 'project.txt', change: 'modified' }]);
  assert.equal(result.session, 'writer-session');
});

test('--worktree keeps the write in its worktree and leaves the original checkout untouched', options, async (t) => {
  const s = await repository(t);
  const head = await s.git('rev-parse', 'HEAD');
  writeFileSync(join(s.work, 'project.txt'), 'uncommitted original\n');
  const before = await s.git('status', '--porcelain=v1');
  const [result] = await s.run(['-m', 'writer:deterministic', '-w', '--worktree', 'worktree edit']);
  const path = result.worktree?.path;
  assert.ok(path && isAbsolute(path), 'changed worktree must be retained in the record');
  assert.equal(path, join(s.env.ASK_HOME, 'worktrees', result.run));
  environment(s, result, 'write', path);
  assert.equal(result.dir, path);
  assert.equal(readFileSync(join(path, 'project.txt'), 'utf8'), 'worktree edit\n');
  assert.equal(readFileSync(join(s.work, 'project.txt'), 'utf8'), 'uncommitted original\n');
  assert.equal(await s.git('rev-parse', 'HEAD'), head);
  assert.equal(await s.git('status', '--porcelain=v1'), before);
  assert.deepEqual(result.changes, [{ path: 'project.txt', change: 'modified' }]);
});

for (const writeDefault of [false, true]) {
  test(`batch ${writeDefault ? '-w' : 'read default'} honors per-task access overrides`, options, async (t) => {
    const s = fixture(t);
    const other = join(s.dir, 'other-task');
    mkdirSync(other);
    writeFileSync(join(other, 'project.txt'), original);
    const tasks = [
      { id: 'default', prompt: 'default edit', dir: s.work },
      { id: 'override', prompt: 'override edit', dir: other, write: !writeDefault },
    ];
    const results = await s.run(['batch', '-m', 'writer:deterministic', ...(writeDefault ? ['-w'] : []), '-'], JSON.stringify(tasks));
    for (const [index, task] of tasks.entries()) {
      const result = results[index], write = task.write ?? writeDefault;
      environment(s, result, write ? 'write' : 'read', task.dir);
      assert.equal(readFileSync(join(task.dir, 'project.txt'), 'utf8'), write ? `${task.prompt}\n` : original);
    }
  });
}

for (const readOverride of [false, true]) {
  test(`continuation ${readOverride ? '-r overrides inherited write' : 'inherits write access'}`, options, async (t) => {
    const s = fixture(t);
    const [first] = await s.run(['-m', 'writer:deterministic', '-w', 'first edit']);
    assert.equal(readFileSync(join(s.work, 'project.txt'), 'utf8'), 'first edit\n');
    const [followup] = await s.run(['-c', first.run, ...(readOverride ? ['-r'] : []), 'followup edit']);
    const observation = environment(s, followup, readOverride ? 'read' : 'write');
    assert.equal(observation.session, first.session);
    assert.equal(followup.session, first.session);
    assert.equal(readFileSync(join(s.work, 'project.txt'), 'utf8'), readOverride ? 'first edit\n' : 'followup edit\n');
  });
}
