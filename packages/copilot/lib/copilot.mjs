/*
 * The GitHub Copilot CLI agent: runs `copilot` non-interactively with the prompt on stdin and
 * JSONL events on stdout. Read runs give the model only the view, glob and grep (or rg) tools
 * through --available-tools and deny shell and write outright, so no command runs and no file is
 * written whatever the user's own rules allow; git takes no optional locks and runs no fsmonitor
 * (see readEnv). Write runs allow all tools and URLs. Models are Copilot's ids (gpt-5.4,
 * claude-haiku-4.5); Claude models may also be named the clean way (haiku-4.5), and `auto` is
 * refused. Copilot has no command that lists its models, so `copilot models` lists none. Every
 * run gets a session id up front, reported at once and passed as --session-id; a follow-up passes
 * the same id, which resumes it. ASK_TITLE names a new session (--name; Copilot cannot rename one).
 * Tokens come from --usage-output-file when Copilot exits, less what a resumed session had already
 * used; Copilot bills in AI credits, not USD, so no cost is reported. A new read run's prompt starts with GROUNDING. Copilot is
 * $ASK_COPILOT_BIN, else on PATH, else where its installers put it. Started by agents/copilot,
 * which finds Node.js. Visible native messages and tools append best-effort to ASK_EVENTS;
 * no reasoning is emitted.
 */
import { spawn } from 'node:child_process';
import { activity, argumentsText } from './activity.mjs';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// Copilot's names for "pick one for me", refused so every run names the model it means.
const ALIASES = ['auto'];

// Put before a new read run's prompt, so the answer comes from the code rather than a guess.
const GROUNDING = 'Answer from the files in your working directory: search and read them before answering. Never guess file names, functions or facts; if you cannot find something, say so.\n\n';

/* The copilot executable: $ASK_COPILOT_BIN if set, else the first on PATH or where Copilot's installers put it; undefined when there is none. */
function findCli() {
  if (process.env.ASK_COPILOT_BIN) return executable(process.env.ASK_COPILOT_BIN) ? process.env.ASK_COPILOT_BIN : undefined;
  const home = homedir();
  const dirs = [...(process.env.PATH || '').split(delimiter).filter(Boolean), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', join(home, '.npm-global', 'bin')];
  return dirs.map((dir) => join(dir, 'copilot')).find(executable);
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

/* Copilot's id for a model: a Claude model named family-version gets its claude- prefix (haiku-4.5 -> claude-haiku-4.5); other ids pass through. */
const copilotId = (model) => model.toLowerCase().replace(/^(fable|opus|sonnet|haiku)-(?=\d)/, 'claude-$1-');

/* "GPT-5.3 Codex", "Haiku 4.5" or "Gemini 3.7 Flash" for a Copilot model id. */
function displayName(id) {
  const words = id.replace(/^claude-/, '').split('-').filter(Boolean).map((w) => (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)));
  return words[0] === 'Gpt' ? [`GPT-${words[1]}`, ...words.slice(2)].join(' ') : words.join(' ');
}

/*
 * The environment of a read run's CLI, for the git it runs on its own (Copilot reads the branch and
 * commit for context): no optional locks, so status never rewrites the index, and core.fsmonitor
 * off, so the repository's config cannot start a command. Added after any GIT_CONFIG_* the user set.
 */
function readEnv() {
  const n = Number(process.env.GIT_CONFIG_COUNT) || 0;
  return { GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'core.fsmonitor', [`GIT_CONFIG_VALUE_${n}`]: 'false' };
}

/* ask's token counts from Copilot's per-model metrics, summed; Copilot counts input like OpenAI does, cache reads included. */
function tokens(modelMetrics = {}) {
  const sum = { input: 0, output: 0, cached: 0 };
  for (const { usage: u = {} } of Object.values(modelMetrics)) {
    sum.input += u.inputTokens || 0;
    sum.output += u.outputTokens || 0;
    sum.cached += u.cacheReadTokens || 0;
  }
  return sum;
}

/*
 * A session's tokens so far: Copilot's usage file counts the whole session, so a follow-up
 * subtracts these. They are the last session.shutdown event in the session's events log
 * ($COPILOT_HOME or ~/.copilot); zero when there is none.
 */
function savedTokens(session) {
  try {
    const log = readFileSync(join(process.env.COPILOT_HOME || join(homedir(), '.copilot'), 'session-state', session, 'events.jsonl'), 'utf8');
    return tokens(JSON.parse(log.split('\n').filter((line) => line.includes('"session.shutdown"')).pop()).data.modelMetrics);
  } catch {
    return tokens();
  }
}

/* The run's usage from Copilot's --usage-output-file less `before`, and the model that did most of the work; {} when there is none. */
function usageFile(path, before) {
  let metrics;
  try {
    metrics = JSON.parse(readFileSync(path, 'utf8')).modelMetrics || {};
  } catch {
    return {};
  }
  const usage = Object.fromEntries(Object.entries(tokens(metrics)).map(([key, n]) => [key, Math.max(0, n - before[key])]));
  const ran = Object.entries(metrics).sort((a, b) => (b[1].usage?.outputTokens || 0) - (a[1].usage?.outputTokens || 0))[0]?.[0];
  return { usage, ran };
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
  console.error('GitHub Copilot CLI not found: install it from https://github.com/github/copilot-cli, or set ASK_COPILOT_BIN to its path');
  process.exit(1);
}

await adapter({
  // Copilot can't list its models; add the ones you use to ~/.ask/models.json.
  models: () => [],

  async run({ prompt, model, effort, write, session, title, report }) {
    if (ALIASES.includes(model.toLowerCase())) return { ok: false, error: `"${model}" lets Copilot pick the model; name the exact model, like copilot:gpt-5.4` };
    const id = session || randomUUID();
    report({ session: id });
    const before = session && /^[\w-]+$/.test(session) ? savedTokens(session) : tokens();
    const work = mkdtempSync(join(tmpdir(), 'ask-copilot-'));
    try {
      const usagePath = join(work, 'usage.json');
      const args = ['--output-format', 'json', '--no-ask-user', '--model', copilotId(model), '--session-id', id, '--usage-output-file', usagePath];
      // --name only names a new session; with an existing one Copilot refuses to start.
      if (title && !session) args.push('--name', title);
      if (effort) args.push('--reasoning-effort', effort);
      // Rules over a command's text cannot follow everything a shell expands, so a read run gets
      // no shell at all: the model sees only the reading tools, and shell and writes are denied.
      if (write) args.push('--allow-all-tools', '--allow-all-urls');
      else args.push('--available-tools=view,glob,grep,rg', '--allow-tool=read', '--deny-tool=shell', '--deny-tool=write');
      // The answer is the main agent's last turn: a message that asks for tools starts a new turn.
      let text = '';
      let failure;
      let result;
      const emit = activity(process.env.ASK_EVENTS);
      const tools = new Map();
      const streaming = new Set();
      const onLine = (line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (!event || typeof event !== 'object' || Array.isArray(event)) return;
        const data = event.data && typeof event.data === 'object' ? event.data : {};
        if (event.type === 'result') result = event;
        if (event.type === 'session.error') failure = data.message || data.errorType;
        // Native schema: github/copilot-sdk nodejs/src/generated/session-events.ts.
        // Keep the main-agent scope used by the answer; never project reasoning/opaque fields.
        if (event.agentId || data.parentToolCallId) return;
        const toolCall = (id, name, args) => {
          if (typeof name !== 'string') return;
          const tracked = typeof id === 'string' && id.length <= 256;
          if (tracked && tools.has(id)) return;
          if (tracked) {
            if (tools.size >= 1024) tools.delete(tools.keys().next().value);
            tools.set(id, name.slice(0, 256));
          }
          emit('tool', name + ' ' + argumentsText(args), name);
        };
        if (event.type === 'tool.execution_start') toolCall(data.toolCallId, data.toolName, data.arguments);
        if (event.type === 'tool.execution_complete') {
          const output = data.result;
          emit('tool_result', typeof output?.detailedContent === 'string' ? output.detailedContent :
            typeof output?.content === 'string' ? output.content : data.error?.message, tools.get(data.toolCallId));
          tools.delete(data.toolCallId);
        }
        if (event.type === 'assistant.message_delta' && typeof data.deltaContent === 'string' && typeof data.messageId === 'string' && data.messageId.length <= 256) {
          if (!streaming.has(data.messageId) && streaming.size >= 1024) streaming.delete(streaming.values().next().value);
          streaming.add(data.messageId);
          emit('message', data.deltaContent);
        }
        if (event.type !== 'assistant.message') return;
        if (!streaming.delete(data.messageId)) emit('message', data.content);
        if (Array.isArray(data.toolRequests)) {
          for (const request of data.toolRequests) {
            if (request && typeof request === 'object') toolCall(request.toolCallId, request.name, request.arguments);
          }
        }
        if (Array.isArray(data.toolRequests) && data.toolRequests.length) text = '';
        else if (typeof data.content === 'string' && data.content.trim()) text += (text ? '\n\n' : '') + data.content;
      };
      const r = await exec(CLI, args, { input: prompt, env: write ? {} : readEnv(), onLine });
      const { usage, ran } = usageFile(usagePath, before);
      const name = displayName(ran || copilotId(model));
      if (r.code === 0 && result?.exitCode === 0 && text) return { ok: true, text, usage, name };
      const lines = r.stderr.trim().split('\n').filter((line) => /\w/.test(line));
      return { ok: false, error: failure || lines.pop() || (text ? `exit ${r.code}` : `no answer (exit ${r.code})`), usage, name };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
});
