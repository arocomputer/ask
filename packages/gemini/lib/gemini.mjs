/*
 * The Gemini CLI agent: runs `gemini` headless with the prompt on stdin and stream-json events on
 * stdout. Read runs use plan mode plus an admin-tier policy (--admin-policy, which outranks the
 * user's own policies) that denies every tool except read_file, read_many_files, list_directory,
 * glob and grep_search: plan mode alone still lets the model write .md files and leave plan mode.
 * Gemini CLI ignores --admin-policy when the system policy directory holds policies, so read runs
 * are refused there. Read runs also keep git from taking optional locks or running fsmonitor (see
 * readEnv). Write runs use yolo mode. Models are Gemini CLI's ids (gemini-3.5-flash); its aliases
 * (auto, pro, flash, flash-lite) are refused, and so is an effort, which Gemini CLI has no option
 * for. Every run gets a session id up front, reported at once and passed as --session-id; a
 * follow-up resumes it with --resume. Gemini CLI cannot name a session, so ASK_TITLE is unused.
 * Tokens come with the result event; Gemini CLI reports no cost. A new read run's prompt starts
 * with GROUNDING. Gemini CLI is $ASK_GEMINI_BIN, else on PATH, else where its installers put it.
 * Visible native messages and tools append best-effort to ASK_EVENTS; no reasoning is emitted.
 * Started by agents/gemini, which finds Node.js.
 */
import { spawn } from 'node:child_process';
import { activity, argumentsText } from './activity.mjs';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

// The models Gemini CLI uses by default; ask models also lists any ids added in ~/.ask/models.json.
const MODELS = ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'];
// Gemini CLI's names for "the current one", refused so every run names the model it means.
const ALIASES = ['auto', 'pro', 'flash', 'flash-lite', 'auto-gemini-3', 'auto-gemini-2.5'];

// Put before a new read run's prompt, so the answer comes from the code rather than a guess.
const GROUNDING = 'Answer from the files in your working directory: search and read them before answering. Never guess file names, functions or facts; if you cannot find something, say so.\n\n';

// The admin-tier policy of a read run: the highest-priority matching rule wins, and a tool denied
// without arguments is never offered to the model.
const READ_POLICY = `[[rule]]
toolName = "*"
decision = "deny"
priority = 998
denyMessage = "This is a read-only run: only reading and searching files is allowed."

[[rule]]
toolName = ["read_file", "read_many_files", "list_directory", "glob", "grep_search"]
decision = "allow"
priority = 999
`;

// Where Gemini CLI looks for system policies; any .toml here makes it ignore --admin-policy.
const SYSTEM_POLICIES = { darwin: '/Library/Application Support/GeminiCli/policies', win32: 'C:\\ProgramData\\gemini-cli\\policies' }[platform()] || '/etc/gemini-cli/policies';

/* The gemini executable: $ASK_GEMINI_BIN if set, else the first on PATH or where Gemini CLI's installers put it; undefined when there is none. */
function findCli() {
  if (process.env.ASK_GEMINI_BIN) return executable(process.env.ASK_GEMINI_BIN) ? process.env.ASK_GEMINI_BIN : undefined;
  const home = homedir();
  const dirs = [...(process.env.PATH || '').split(delimiter).filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', join(home, '.npm-global', 'bin'), join(home, '.local', 'bin'), join(home, '.local', 'share', 'pnpm')];
  return dirs.map((dir) => join(dir, 'gemini')).find(executable);
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

/* Whether system policies may supersede --admin-policy; unreadable directories fail closed. */
function systemPolicies() {
  try {
    return readdirSync(SYSTEM_POLICIES).some((file) => file.endsWith('.toml'));
  } catch (error) {
    return error.code !== 'ENOENT';
  }
}

/* "Gemini 3.5 Flash" for a model id like gemini-3.5-flash. */
const displayName = (id) => id.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

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
  console.error('Gemini CLI not found: install it from https://geminicli.com, or set ASK_GEMINI_BIN to its path');
  process.exit(1);
}

await adapter({
  models: () => MODELS.map((id) => [id, displayName(id)]),

  async run({ prompt, model, effort, write, session, report }) {
    model = model.toLowerCase();
    if (ALIASES.includes(model)) return { ok: false, error: `"${model}" is an alias; name the exact model, like gemini:${MODELS[2]} (see ask models)` };
    if (effort) return { ok: false, error: `Gemini CLI has no effort option; drop #${effort}` };
    if (!write && systemPolicies()) return { ok: false, error: `Gemini CLI's system policies prevent verifying ask's read-only policy, so read runs are refused; use another harness, or -w if write access is intended` };
    const id = session || randomUUID();
    report({ session: id });
    const work = mkdtempSync(join(tmpdir(), 'ask-gemini-'));
    try {
      const args = ['--output-format', 'stream-json', '--model', model, ...(session ? ['--resume', session] : ['--session-id', id])];
      if (write) args.push('--approval-mode', 'yolo');
      else {
        writeFileSync(join(work, 'read.toml'), READ_POLICY);
        args.push('--approval-mode', 'plan', '--admin-policy', join(work, 'read.toml'));
      }
      // The answer is the last turn's text: a tool call starts a new turn.
      let text = '';
      let failure;
      let result;
      const emit = activity(process.env.ASK_EVENTS);
      const tools = new Map();
      const onLine = (line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (!event || typeof event !== 'object' || Array.isArray(event)) return;
        // Native schema: google-gemini/gemini-cli packages/core/src/output/types.ts.
        if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') {
          text += event.content;
          emit('message', event.content);
        }
        if (event.type === 'tool_use' && typeof event.tool_name === 'string') {
          if (typeof event.tool_id === 'string' && event.tool_id.length <= 256) {
            if (tools.size >= 1024) tools.delete(tools.keys().next().value);
            tools.set(event.tool_id, event.tool_name.slice(0, 256));
          }
          emit('tool', event.tool_name + ' ' + argumentsText(event.parameters), event.tool_name);
        }
        if (event.type === 'tool_result') {
          const tool = tools.get(event.tool_id);
          emit('tool_result', typeof event.output === 'string' ? event.output : event.error?.message, tool);
          tools.delete(event.tool_id);
        }
        if (event.type === 'tool_use') text = '';
        if (event.type === 'error' && event.severity === 'error') failure = event.message;
        if (event.type === 'result') result = event;
      };
      // gemini is a Node.js script: let it find the Node.js running this agent if PATH has none.
      const env = { ...(write ? {} : readEnv()), PATH: [process.env.PATH, dirname(process.execPath)].filter(Boolean).join(delimiter) };
      const r = await exec(CLI, args, { input: prompt, env, onLine });
      const stats = result?.stats;
      // Gemini CLI's total counts the answer, thinking and prompt; output is all but the prompt.
      const usage = stats && { input: stats.input_tokens, output: stats.total_tokens - stats.input_tokens, cached: stats.cached };
      const ran = Object.entries(stats?.models || {}).sort((a, b) => (b[1].output_tokens || 0) - (a[1].output_tokens || 0))[0]?.[0];
      const name = displayName(ran || model);
      if (r.code === 0 && result?.status === 'success' && text.trim()) return { ok: true, text: text.trim(), usage, name };
      const lines = r.stderr.trim().split('\n').filter((line) => /\w/.test(line));
      return { ok: false, error: result?.error?.message || failure || lines.pop() || (text.trim() ? `exit ${r.code}` : `no answer (exit ${r.code})`), usage, name };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
});
