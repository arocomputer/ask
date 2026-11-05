/*
 * Shared plumbing for the official agents' offline tests in packages/NAME/test: launching a
 * process with a bounded run time, reading the JSON report and JSONL logs it leaves behind, and
 * the fixture that keeps every run away from real CLIs, real homes and the developer's
 * environment. What each harness is expected to do stays in its own test file.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach } from 'node:test';

/*
 * Runs command with args and resolves with { code, signal, stdout, stderr } once it exits. The
 * child gets exactly env, never this process's environment, and input on stdin. A run still going
 * after timeout milliseconds is killed with its whole process group, and the promise rejects.
 * stream also mirrors output to the runner's terminal without changing captured results.
 */
export function runProcess(command, args = [], { cwd, env = {}, input = '', timeout = 20_000, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const group = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, env, detached: group });
    let stdout = '';
    let stderr = '';
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      try {
        process.kill(group ? -child.pid : child.pid, 'SIGKILL');
      } catch {}
    }, timeout);
    child.stdout.on('data', (d) => { stdout += d; if (stream) process.stdout.write(d); });
    child.stderr.on('data', (d) => { stderr += d; if (stream) process.stderr.write(d); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (expired) reject(new Error(`${command} timed out after ${timeout}ms; stderr: ${stderr}`));
      else resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/* Reads a JSON file such as $ASK_REPORT: fallback when it does not exist; malformed JSON throws. */
export function readJson(path, fallback = null) {
  const text = readMaybe(path);
  return text === undefined ? fallback : JSON.parse(text);
}

/* Reads a JSONL log such as a fake CLI's $FAKE_LOG, one value per non-empty line; [] when missing. */
export function readJsonl(path) {
  return (readMaybe(path) ?? '').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function readMaybe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/*
 * Polls the JSON file at path while running (a run's promise) is pending, and resolves with the
 * first value ready accepts, or undefined if the run finished first. For checking that an agent
 * reports live, before it exits; a half-written file is read again on the next poll.
 */
export async function pollJson(path, running, ready, interval = 20) {
  let finished = false;
  running.then(() => (finished = true), () => (finished = true));
  while (!finished) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    let value;
    try {
      value = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    if (!finished && ready(value)) return value;
  }
  return undefined;
}

/*
 * Gives each test in the calling suite a fresh empty directory, its real path, removed after the
 * test. Call at module top level; it returns a function giving the current test's directory.
 */
export function scratch(prefix = 'agent-test-') {
  let dir;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  return () => dir;
}

/*
 * The offline fixture for one agent's tests, set up once at module top level. nodeDir holds only
 * node, so a PATH built on it finds no real CLI; path is bin (the package's fake CLIs, if given),
 * then nodeDir. tmp() is the current test's scratch directory; env(vars) is an environment of only
 * PATH=path, HOME=tmp() and vars, which override either; launch(args, env, input) runs the agent
 * in tmp() through runProcess.
 */
export function offline(agent, bin) {
  const nodeDir = mkdtempSync(join(tmpdir(), 'agent-node-'));
  symlinkSync(process.execPath, join(nodeDir, 'node'));
  after(() => rmSync(nodeDir, { recursive: true, force: true }));
  const path = bin ? `${bin}:${nodeDir}` : nodeDir;
  const tmp = scratch();
  return {
    nodeDir,
    path,
    tmp,
    env: (vars = {}) => ({ PATH: path, HOME: tmp(), ...vars }),
    launch: (args, env, input = '') => runProcess(agent, args, { cwd: tmp(), env, input }),
  };
}
