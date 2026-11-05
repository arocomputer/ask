/*
 * The Codex agent: runs `codex exec` in Codex's OS sandbox, read-only for read runs and
 * workspace-write with network access for write runs (installing dependencies and running tests
 * need it). Models and their display names come from Codex's own model cache ($CODEX_HOME or
 * ~/.codex). Schemas are converted to the strict form OpenAI structured output requires. The thread id
 * Codex announces first is reported as the session; a follow-up runs `codex exec resume` on it. A
 * new read run's prompt starts with GROUNDING. Codex is $ASK_CODEX_BIN, else on PATH, else where
 * its installers put it. Started by agents/codex, which finds Node.js.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createActivity } from './activity.mjs';

// Put before a new read run's prompt, so the answer comes from the code rather than a guess.
const GROUNDING = 'Answer from the files in your working directory: search and read them before answering. Never guess file names, functions or facts; if you cannot find something, say so.\n\n';

/* The codex executable: $ASK_CODEX_BIN if set, else the first on PATH or where Codex's installers put it; undefined when there is none. */
function findCli() {
  if (process.env.ASK_CODEX_BIN) return executable(process.env.ASK_CODEX_BIN) ? process.env.ASK_CODEX_BIN : undefined;
  const dirs = [...(process.env.PATH || '').split(delimiter).filter(Boolean), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin'];
  return [...dirs.map((dir) => join(dir, 'codex')), '/Applications/Codex.app/Contents/Resources/codex'].find(executable);
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

/* Codex's cached model list, without review and reserved models; [] when there is none. */
function cachedModels() {
  try {
    const cache = JSON.parse(readFileSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'), 'utf8'));
    return (cache.models || []).filter((m) => m.slug && !/review|reserve/.test(m.slug));
  } catch {
    return [];
  }
}

/* "GPT-6.1 Sol" from a display name like GPT-6.1-Sol. */
const displayName = (m) => m?.display_name?.replace(/-(?=[A-Z][a-z])/g, ' ');

/*
 * OpenAI structured output accepts only strict schemas: every object closed with
 * additionalProperties false and listing all its properties as required. Converts any schema to
 * that form, so callers can write ordinary JSON Schema; optional fields become required. Only
 * keywords that hold schemas are descended into, so a property named like a keyword stays a name.
 */
function strictSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const each = (map) => Object.fromEntries(Object.entries(map).map(([key, value]) => [key, strictSchema(value)]));
  const strict = { ...schema };
  if (strict.type === 'object' || strict.properties) {
    strict.properties = each(strict.properties || {});
    strict.required = Object.keys(strict.properties);
    strict.additionalProperties = false;
  }
  if (strict.items) strict.items = strictSchema(strict.items);
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(strict[key])) strict[key] = strict[key].map(strictSchema);
  for (const key of ['$defs', 'definitions']) if (strict[key]) strict[key] = each(strict[key]);
  return strict;
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
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

/* Name a Codex thread through app-server, since its exec CLI has no thread-name flag. */
function nameThread(command, threadId, title) {
  return new Promise((resolve) => {
    const child = spawn(command, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    let id = 0;
    let pending = 0;
    let stage = 0;
    let done = false;
    const timer = setTimeout(() => finish(), 5000);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve();
    };
    const request = (method, params = {}) => {
      pending = ++id;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: pending, method, params })}\n`);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\n')) !== -1;) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== pending) continue;
        if (message.error) return finish();
        if (stage === 0) {
          stage++;
          child.stdin.write('{"jsonrpc":"2.0","method":"initialized","params":{}}\n');
          request('thread/resume', { threadId });
        } else if (stage === 1) {
          stage++;
          request('thread/name/set', { threadId, name: title });
        } else finish();
      }
    });
    child.on('error', finish);
    child.stdin.on('error', finish);
    child.on('close', finish);
    request('initialize', { clientInfo: { name: 'ask', title: 'ask', version: '1' } });
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
    for (const [id, name] of await models()) console.log(name ? `${id}\t${name}` : id);
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
  console.error('Codex not found: install it from https://developers.openai.com/codex, or set ASK_CODEX_BIN to its path');
  process.exit(1);
}

await adapter({
  models: () => cachedModels().map((m) => [m.slug, displayName(m)]),

  async run({ prompt, model, effort, write, schema, dir, session, title, report }) {
    model = model.toLowerCase();
    const work = mkdtempSync(join(tmpdir(), 'ask-codex-'));
    try {
      const out = join(work, 'answer');
      const sandbox = write ? 'workspace-write' : 'read-only';
      const common = ['-m', model, '--skip-git-repo-check', '-o', out, '--json', '-c', 'approval_policy="never"'];
      // resume takes no --sandbox or -C: it runs where it is started, with the sandbox set as config.
      const args = session ? ['exec', 'resume', ...common, '-c', `sandbox_mode="${sandbox}"`] : ['exec', ...common, '-C', dir, '--sandbox', sandbox];
      if (session) report({ session });
      if (write) args.push('-c', 'sandbox_workspace_write.network_access=true');
      if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
      if (schema) {
        writeFileSync(join(work, 'schema.json'), JSON.stringify(strictSchema(schema)));
        args.push('--output-schema', join(work, 'schema.json'));
      }
      args.push(...(session ? [session, '-'] : ['-']));
      // --json streams events on stdout; each finished turn reports its tokens (Codex reports no cost).
      const usage = { input: 0, output: 0, cached: 0 };
      const activityEvent = createActivity();
      let sessionId;
      let activity = '';
      const activities = new Map([
        ['reasoning', 'thinking'], ['command_execution', 'running commands'],
        ['file_change', 'editing files'], ['web_search', 'searching'],
        ['mcp_tool_call', 'using tools'], ['agent_message', 'answering'],
      ]);
      const onLine = (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (!event || typeof event !== 'object') return;
        // Optional activity must never interfere with the answer, usage or session report.
        try { activityEvent(event); } catch {}
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          sessionId = event.thread_id;
          report({ session: sessionId });
        }
        // The report keeps fixed labels only; visible text belongs in the optional activity sink.
        if (['item.started', 'item.updated', 'item.completed'].includes(event.type)) {
          const category = activities.get(event.item?.type);
          if (category && category !== activity) {
            activity = category;
            report({ activity });
          }
        }
        if (event.type !== 'turn.completed') return;
        const u = event.usage || {};
        usage.input += u.input_tokens || 0;
        usage.output += (u.output_tokens || 0) + (u.reasoning_output_tokens || 0);
        usage.cached += u.cached_input_tokens || 0;
        activity = '';
        report({ ...usage, activity });
      };
      const r = await exec(CLI, args, { input: prompt, onLine });
      if (title && sessionId) await nameThread(CLI, sessionId, title);
      const name = displayName(cachedModels().find((m) => m.slug === model));
      let text = '';
      try {
        text = readFileSync(out, 'utf8');
      } catch {}
      if (r.code === 0 && text.trim()) return { ok: true, text, usage, name };
      // Codex reports API errors as JSON on either stream; give its message, not a closing brace.
      const messages = [...(r.stderr + '\n' + r.stdout).matchAll(/"message":\s*"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
      const lines = r.stderr.trim().split('\n').filter((line) => /\w/.test(line));
      return { ok: false, error: (messages.pop() || lines.pop() || `exit ${r.code}`).slice(0, 300), usage, name };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
});
