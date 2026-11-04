/* Test actual ask timeout/stop behavior with a controlled agent and its subprocess. */
import assert from 'node:assert/strict';
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { execute, isolated, root } from './integration.mjs';

const ask = process.env.BAYMAX_ASK;

/* A zombie is stopped but may await reaping by the system's init process on Linux. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (status.slice(status.lastIndexOf(')') + 2).startsWith('Z ')) return false;
    }
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
    throw error;
  }
}

/* Poll only a local readiness condition, with a deadline that also bounds broken tests. */
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(25);
  }
  throw new Error('process tree did not reach the expected state within five seconds');
}

/* Register emergency process cleanup before launch, even if an assertion fails. */
function fixture(t) {
  const s = isolated('ask-baymax-stop-');
  const pidFile = join(s.dir, 'pids.json');
  const agents = join(s.env.ASK_HOME, 'agents');
  mkdirSync(agents, { recursive: true });
  const agent = join(agents, 'sleeper');
  copyFileSync(join(root, 'test', 'baymax', 'fixtures', 'sleeper'), agent);
  chmodSync(agent, 0o755);
  s.env.BAYMAX_PIDS = pidFile;
  s.pids = () => existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, 'utf8')) : [];
  t.after(() => {
    for (const pid of s.pids()) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    s.cleanup();
  });
  return s;
}

test('a task timeout stops the agent and its descendants and records failure', { skip: !ask && 'run via ./x baymax', timeout: 20_000 }, async (t) => {
  const s = fixture(t);
  const out = await execute(ask, ['-m', 'sleeper:slow', '--wait', '-w', '-t', '1', 'wait'], { cwd: s.work, env: s.env, timeout: 15_000 });
  assert.equal(out.code, 1, out.stderr);
  assert.equal(s.pids().length, 2, 'the simulated agent really launched its child');
  await until(() => s.pids().every((pid) => !alive(pid)));
  const runs = join(s.env.ASK_HOME, 'runs');
  const [dir] = readdirSync(runs);
  const [result] = JSON.parse(readFileSync(join(runs, dir, 'results.json'), 'utf8'));
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out|timeout/i);
});

test('ask stop shuts down the entire running agent tree', { skip: !ask && 'run via ./x baymax', timeout: 20_000 }, async (t) => {
  const s = fixture(t);
  const running = execute(ask, ['-m', 'sleeper:slow', '--wait', '-w', 'stop me'], { cwd: s.work, env: s.env, timeout: 15_000 });
  // Attach a rejection handler immediately; later assertions still await the original promise.
  running.catch(() => {});
  await until(() => s.pids().length === 2);
  const runs = join(s.env.ASK_HOME, 'runs');
  const [dir] = readdirSync(runs);
  const stopped = await execute(ask, ['stop', dir], { cwd: s.work, env: s.env });
  assert.equal(stopped.code, 0, stopped.stderr);
  const out = await running;
  assert.equal(out.code, 130, out.stderr);
  await until(() => s.pids().every((pid) => !alive(pid)));
  const listing = await execute(ask, ['runs'], { cwd: s.work, env: s.env });
  assert.match(listing.stdout, /stopped/);
});
