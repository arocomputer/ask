/* Isolated subprocesses and homes for Baymax; no developer credentials reach children. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profiles } from './profiles.mjs';
import { readJson, readJsonl, runProcess } from './helper.mjs';

export const root = fileURLToPath(new URL('../../', import.meta.url));

/* Discover installable packages from their launchers, rather than a second package registry. */
export function packages() {
  return readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'agents', entry.name)))
    .map((entry) => entry.name).sort();
}

/* Reject every unknown name before building, creating homes, or starting tests. */
export function selection(names) {
  const all = packages();
  for (const name of names) if (!all.includes(name)) throw new Error(`unknown package: ${name}; choose ${all.join(', ')}`);
  return names.length ? [...new Set(names)] : all;
}

/* Run integration commands using the same bounded plumbing as adapter tests. */
export function execute(command, args, options = {}) {
  return runProcess(command, args, { cwd: root, timeout: 30_000, ...options });
}

/* Create a disposable HOME and a PATH containing only Node and explicitly linked fake CLIs. */
export function isolated(prefix = 'ask-baymax-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(dir, 'home'), bin = join(dir, 'bin'), work = join(dir, 'work');
  for (const path of [home, bin, work, join(dir, 'tmp')]) mkdirSync(path);
  symlinkSync(process.execPath, join(bin, 'node'));
  return {
    dir, home, bin, work,
    env: { HOME: home, PATH: bin, TMPDIR: join(dir, 'tmp'), ASK_HOME: join(home, '.ask'), ASK_NODE: process.execPath, LANG: 'C.UTF-8', NO_COLOR: '1' },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/* Install the real embedded package against its own fake, with minimal local model configuration. */
export async function harness(name, ask) {
  const profile = profiles[name];
  if (!profile) throw new Error(`missing integration profile for ${name}`);
  const s = isolated(`ask-baymax-${name}-`);
  try {
    const cli = profile.cli || name;
    symlinkSync(join(root, 'packages', name, 'test', 'bin', cli), join(s.bin, cli));
    Object.assign(s.env, {
      [`ASK_${name.toUpperCase()}_BIN`]: join(s.bin, cli),
      FAKE_LOG: join(s.dir, 'calls.jsonl'), FAKE_STATE: join(s.dir, 'state.json'),
      FAKE_ANSWER: 'baymax answer', ...profile.env,
      CODEX_HOME: join(s.home, 'codex'), COPILOT_HOME: join(s.home, 'copilot'), QWEN_HOME: join(s.home, 'qwen'),
    });
    if (name === 'qwen') {
      mkdirSync(s.env.QWEN_HOME);
      writeFileSync(join(s.env.QWEN_HOME, 'settings.json'), JSON.stringify({ modelProviders: { openai: [{ id: 'Qwen3-Coder-Plus' }] } }));
    }
    if (name === 'continue') {
      s.env.ASK_CONTINUE_CONFIG = join(s.home, 'continue.json');
      writeFileSync(s.env.ASK_CONTINUE_CONFIG, JSON.stringify({ name: 'test', version: '1', schema: 'v1', models: [{ name: 'one', model: profile.model, provider: 'test' }] }));
    }
    if (name === 'vibe') s.env.VIBE_MODELS = JSON.stringify([{ name: profile.model, provider: 'test' }]);
    const runs = join(s.env.ASK_HOME, 'runs');
    s.run = async (args, extra = {}) => {
      const before = new Set(existsSync(runs) ? readdirSync(runs) : []);
      const bounded = ['-m', '-c'].includes(args[0]) ? ['-t', '10', ...args] : args;
      const out = await execute(ask, bounded, { cwd: s.work, env: { ...s.env, ...extra } });
      const created = (existsSync(runs) ? readdirSync(runs) : []).filter((dir) => !before.has(dir));
      return { ...out, runDir: created.length === 1 ? join(runs, created[0]) : undefined };
    };
    s.calls = () => readJsonl(s.env.FAKE_LOG);
    s.record = (output) => {
      if (!output.runDir) throw new Error(`expected one new run directory: ${output.stderr}`);
      const task = readJson(join(output.runDir, 'tasks.json'))[0];
      const result = readJson(join(output.runDir, 'results.json'))[0];
      return { id: result.run, task, result };
    };
    const installed = await s.run(['install', name]);
    if (installed.code !== 0) throw new Error(`install ${name}: ${installed.stderr}`);
    const launcher = join(s.env.ASK_HOME, 'packages', 'ask', 'packages', name, 'agents', name);
    if (!existsSync(launcher)) throw new Error(`install did not write ${launcher}`);
    const manifest = `${launcher}.environment.json`;
    if (existsSync(manifest)) {
      const defaults = readJson(manifest);
      // The CLI simulator needs its fixture controls, never the developer's environment.
      writeFileSync(join(s.env.ASK_HOME, 'environment.json'), JSON.stringify({ agents: {
        [name]: { inherit: [...new Set([...defaults.inherit, ...Object.keys(s.env), ...Object.keys(profile.failure || {})])] },
      } }));
    }
    return s;
  } catch (error) { s.cleanup(); throw error; }
}
