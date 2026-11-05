/*
 * The Opencode agent for v1 and v2, selected by the executable's --version. V2 uses a
 * standalone server and plan permissions; v1 uses a fresh primary agent so merged plan config
 * cannot retain tool-specific allows. Read runs permit only read, grep and glob, with no shell,
 * and keep git from taking optional locks or running fsmonitor (see readEnv). Write runs use
 * build with the user's permissions. Models have clean names or explicit provider/model ids.
 * The first event reports the session for follow-ups; unfinished usage comes from the version's
 * export command. Started by agents/opencode; ASK_OPENCODE_BIN overrides executable discovery.
 */
import { activity } from './activity.mjs';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { checkEnvironment } from './environment.mjs';

// Put before a new read run's prompt, so the answer comes from the code rather than a guess.
const GROUNDING = 'Answer from the files in your working directory: search and read them before answering. Never guess file names, functions or facts; if you cannot find something, say so.\n\n';

/* The opencode executable: $ASK_OPENCODE_BIN if set, else the first on PATH or where Opencode's installers put it; undefined when there is none. */
function findCli() {
  if (process.env.ASK_OPENCODE_BIN) return executable(process.env.ASK_OPENCODE_BIN) ? process.env.ASK_OPENCODE_BIN : undefined;
  const home = homedir();
  const dirs = [...(process.env.PATH || '').split(delimiter).filter(Boolean), join(home, '.opencode', 'bin'), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.bun', 'bin')];
  return dirs.map((dir) => join(dir, 'opencode')).find(executable);
}

/* Whether path is an executable file. */
function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/* Detect the supported CLI contract before listing models or running any task; never guess. */
function cliVersion() {
  let version;
  try {
    version = execFileSync(CLI, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim();
  } catch {
    throw new Error('could not detect Opencode version with --version; refusing to run');
  }
  const match = /^(?:opencode\s+)?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/i.exec(version);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  const patch = Number(match?.[3]);
  if (!match || ![1, 2].includes(major) || (major === 1 && (minor < 1 || (minor === 1 && patch < 65)))) {
    throw new Error('unsupported or unparseable Opencode version; requires v1.1.65+ or v2; refusing to run');
  }
  return major;
}

/* The clean name of an Opencode model id: qwen3.8-flash -> qwen-3.8-flash, deepseek-v4.1-flash -> deepseek-4.1-flash. */
const clean = (id) => id.toLowerCase().replace(/^([a-z]+)(\d)/, '$1-$2').replace(/-v(\d)/g, '-$1');

/*
 * Every provider/model id Opencode offers, which is every model of the providers you have set up
 * in Opencode. Returns { listed } or { error }; the list is asked for twice before giving up, since
 * Opencode can briefly list nothing while it refreshes its catalog.
 */
function listed() {
  let ids = [];
  let reason = 'it listed none';
  for (let attempt = 0; attempt < 2 && !ids.length; attempt++) {
    try {
      ids = execFileSync(CLI, ['models'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter((id) => id.includes('/'));
    } catch (error) {
      reason = String(error.stderr || error.message).trim().split('\n').pop();
    }
  }
  return ids.length ? { listed: ids } : { error: `could not list Opencode's models: ${reason}` };
}

/*
 * Opencode's provider/model id for a model name: a provider/model id as it is, else the model with
 * that clean name. When several providers have it, the first of $ASK_OPENCODE_PROVIDER,
 * opencode-go and opencode wins, then the first alphabetically. Returns { id } or { error }.
 */
function opencodeId(model) {
  if (model.includes('/')) return { id: model };
  const all = listed();
  if (all.error) return all;
  const provider = (id) => id.slice(0, id.indexOf('/'));
  const found = all.listed.filter((id) => clean(id.slice(id.indexOf('/') + 1)) === clean(model));
  if (!found.length) return { error: `no Opencode model named ${model}; see opencode models` };
  const rank = (id) => [process.env.ASK_OPENCODE_PROVIDER, 'opencode-go', 'opencode', provider(id)].indexOf(provider(id));
  return { id: found.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0] };
}

/*
 * Assistant usage from v1's `export` (message.info) or v2's `session export --standalone`
 * (flat messages). Returns [] when Opencode cannot export the session.
 */
function exported(session) {
  try {
    const args = VERSION === 1 ? ['export', session] : ['session', 'export', '--standalone', session];
    const messages = JSON.parse(execFileSync(CLI, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 })).messages || [];
    return VERSION === 1 ? messages.map((message) => message.info).filter(Boolean) : messages;
  } catch {
    return [];
  }
}

// Agent iterations before it must answer in text: lookups measured 1-13, a runaway 107.
const STEPS = { read: 25, write: 100 };

/*
 * Version-specific config injected through OPENCODE_CONFIG_CONTENT for the selected agent.
 * Deny the model's shell tool: rules over command text cannot follow shell expansion. Preserve
 * inline auth, instructions and plugin hooks instead of replacing the user's entire config.
 */
function config(write, agent) {
  let configured;
  try { configured = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}'); }
  catch { throw new Error('invalid OPENCODE_CONFIG_CONTENT; cannot preserve inline provider and hook settings'); }
  if (!configured || Array.isArray(configured) || typeof configured !== 'object') throw new Error('OPENCODE_CONFIG_CONTENT must be an object');
  if (VERSION === 1) {
    return JSON.stringify({ ...configured, agent: { ...configured.agent, [agent]: write ? { ...configured.agent?.[agent], steps: STEPS.write } : {
      description: 'Read files to answer without modifying the project',
      mode: 'primary',
      steps: STEPS.read,
      permission: { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow' },
    } } });
  }
  const rule = (action, resource, effect) => ({ action, resource, effect });
  const readOnly = [rule('*', '*', 'deny'), ...['read', 'grep', 'glob'].map((action) => rule(action, '*', 'allow'))];
  return JSON.stringify({
    ...configured,
    agents: { ...configured.agents, [agent]: {
      ...configured.agents?.[agent], steps: STEPS[write ? 'write' : 'read'],
      ...(write ? {} : { permissions: readOnly }),
    } },
  });
}

/*
 * The environment of a read run's CLI, for the git it runs on its own: no optional locks, so
 * status never rewrites the index, and core.fsmonitor off, so the repository's config cannot start
 * a command. Added after any GIT_CONFIG_* the user set.
 */
function readEnv() {
  const n = Number(process.env.GIT_CONFIG_COUNT) || 0;
  return { GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'core.fsmonitor', [`GIT_CONFIG_VALUE_${n}`]: 'false' };
}

/*
 * Runs an agent CLI in the current directory with `input` on stdin, calling onLine with each line of
 * stdout as it arrives. Resolves with { code, stdout, stderr }; never rejects. No timeout: ask stops
 * the whole process group when a run is out of time.
 */
function exec(command, args, { input = '', env, onLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let seen = 0;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
      for (let end; onLine && (end = stdout.indexOf('\n', seen)) !== -1; seen = end + 1) onLine(stdout.slice(seen, end));
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (error) => (stderr += `${error.message}\n`));
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      if (onLine && seen < stdout.length) onLine(stdout.slice(seen));
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/*
 * The agent contract from ask's docs/agents.md: `models` prints [id, name] pairs from models();
 * otherwise run() answers the prompt on stdin, GROUNDING first for a new read run, and returns
 * { ok, text, error, name, note, usage }. run gets session (the session to continue, from
 * ASK_SESSION) and report(fields), which writes fields such as { session } or usage so far to the
 * report at once: a run stopped midway can still be continued, and ask shows usage live.
 */
async function adapter({ models, run }) {
  if (process.argv[2] === 'models') {
    try {
      for (const [id, name] of await models()) console.log(name ? `${id}\t${name}` : id);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
    return;
  }
  const { ASK_MODEL, ASK_EFFORT, ASK_ACCESS, ASK_SCHEMA, ASK_SESSION, ASK_REPORT, ASK_TITLE } = process.env;
  const reported = {};
  const report = (fields) => {
    Object.assign(reported, fields);
    if (!ASK_REPORT) return;
    // ask reads the report while the run goes, so replace it whole: never let it see half a file.
    writeFileSync(`${ASK_REPORT}.tmp`, JSON.stringify(reported));
    renameSync(`${ASK_REPORT}.tmp`, ASK_REPORT);
  };
  const r = await run({
    prompt: (ASK_ACCESS === 'read' && !ASK_SESSION ? GROUNDING : '') + readFileSync(0, 'utf8'),
    model: ASK_MODEL,
    effort: ASK_EFFORT || undefined,
    write: ASK_ACCESS === 'write',
    schema: ASK_SCHEMA ? JSON.parse(readFileSync(ASK_SCHEMA, 'utf8')) : undefined,
    session: ASK_SESSION || undefined,
    title: ASK_TITLE || undefined,
    dir: process.cwd(),
    report,
  });
  report({ name: r.name, note: r.note || undefined, ...r.usage });
  if (r.ok) process.stdout.write(`${r.text}\n`);
  else {
    process.stderr.write(`${String(r.error).replace(/\s+/g, ' ').trim()}\n`);
    process.exitCode = 1;
  }
}

const CLI = findCli();
if (!CLI) {
  console.error('Opencode not found: install it from https://opencode.ai, or set ASK_OPENCODE_BIN to its path');
  process.exit(1);
}

let VERSION;
let environmentNote;
try {
  environmentNote = checkEnvironment();
  VERSION = cliVersion();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

await adapter({
  // Every model Opencode offers, by clean name, once each; turn off the ones you don't use with ask.
  models: () => {
    const all = listed();
    if (all.error) throw new Error(all.error);
    return [...new Set(all.listed.map((id) => clean(id.slice(id.indexOf('/') + 1))))].sort().map((name) => [name]);
  },

  async run({ prompt, model, effort, write, session, title, report }) {
    const { id, error } = opencodeId(model);
    if (error) return { ok: false, error };
    // A fresh v1 agent avoids deep-merging permission objects from a user's configured agent.
    const agent = write ? 'build' : VERSION === 1 ? `ask-read-${randomUUID()}` : 'plan';
    const args = ['run', ...(VERSION === 2 ? ['--standalone'] : []), '--agent', agent, '-m', VERSION === 2 && effort ? `${id}#${effort}` : id, '--format', 'json'];
    if (VERSION === 1 && effort) args.push('--variant', effort);
    if (title) args.push('--title', title);
    if (session) args.push('--session', session);
    // Events stream on stdout: the session on the first, and tokens and cost after every step.
    let sessionId;
    let text = '';
    let steps = 0;
    let failure;
    const usage = {};
    const unfinished = new Set();
    const finished = new Set();
    const add = ({ tokens, cost }) => {
      const t = tokens || {};
      usage.input = (usage.input || 0) + (t.input || 0);
      usage.output = (usage.output || 0) + (t.output || 0) + (t.reasoning || 0);
      usage.cached = (usage.cached || 0) + (t.cache?.read || 0);
      if (typeof cost === 'number') usage.cost = (usage.cost || 0) + cost;
    };
    const onActivity = activity();
    const onLine = (line) => {
      const id = !sessionId && /"sessionID":"([^"]+)"/.exec(line)?.[1];
      if (id) report({ session: (sessionId = id) });
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (!event || typeof event !== 'object' || Array.isArray(event)) return;
      try { onActivity(event); } catch {} // Optional activity must never fail the turn.
      if (event.type === 'error') failure ??= event.error?.message || 'error';
      if (event.type === 'step_start') steps++;
      // Every step's events carry its message id; Opencode 2.0 sometimes prints only an answer's text.
      const step = event.part?.messageID;
      if (event.type === 'step_finish') {
        finished.add(step);
        unfinished.delete(step);
        add(event.part || {});
        report({ ...usage });
      } else if (step && !finished.has(step)) unfinished.add(step);
      if (event.type === 'text' && typeof event.part?.text === 'string' && !event.part.synthetic) text = event.part.text;
    };
    const r = await exec(CLI, args, { input: prompt, env: { ...(write ? {} : readEnv()), OPENCODE_CONFIG_CONTENT: config(write, agent) }, onLine });
    // Recover only unfinished messages, so streamed steps and earlier turns are never counted twice.
    // V2 may save the answering message just after exit; retry export for up to 1.5 seconds.
    if (unfinished.size && sessionId) {
      const saved = (m) => (VERSION === 1 ? m.role : m.type) === 'assistant' && unfinished.has(m.id) && (m.tokens?.input || 0) + (m.tokens?.cache?.read || 0) > 0;
      for (let attempt = 1; ; attempt++) {
        const found = exported(sessionId).filter(saved);
        if (found.length === unfinished.size || attempt === 10) {
          found.forEach(add);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      report({ ...usage });
    }
    if (failure) return { ok: false, error: failure, usage };
    if (r.code !== 0 || !text) return { ok: false, error: text ? `exit ${r.code}` : `no answer (exit ${r.code})`, usage };
    const capped = steps >= STEPS[write ? 'write' : 'read'];
    return { ok: true, text, note: [capped ? 'hit step cap; answer may be partial' : '', environmentNote].filter(Boolean).join('; '), usage };
  },
});
