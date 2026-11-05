/*
 * The Claude Code agent: runs `claude -p` with streamed JSON output, reporting tokens as each model
 * call starts and finishes (Claude Code gives cost only at the end). Read runs use the ordinary permission
 * mode with Read, Grep and Glob tools (and --tools when supported): model shell commands and edits are denied, so
 * the user's own default mode and allow rules cannot widen them, and git takes no optional locks
 * and runs no fsmonitor (see readEnv); write runs bypass permissions. Models are named family-version,
 * like sonnet-5.5 (Claude Code's claude-sonnet-5-5), or by full Claude Code id; never by Claude
 * Code's aliases (opus, sonnet), which change meaning as new models ship. Add older or newer models
 * in ~/.ask/models.json. The report names the model that ran (claude-opus-5-5 -> Opus 5.5). Every run gets
 * a session id up front, reported at once; a follow-up resumes it with --resume. A new read run's
 * prompt starts with GROUNDING. Claude Code is $ASK_CLAUDE_BIN, else on PATH, else where its
 * installers put it. Started by agents/claude, which finds Node.js.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createActivity } from './activity.mjs';

// The current models; ask models also lists any ids added in ~/.ask/models.json.
const MODELS = ['fable-5.1', 'opus-5.5', 'sonnet-5.5', 'haiku-4.5'];
// Claude Code's names for "the current one", refused so every run names the model it means.
const ALIASES = ['fable', 'opus', 'sonnet', 'haiku', 'best', 'default'];

// Put before a new read run's prompt, so the answer comes from the code rather than a guess.
const GROUNDING = 'Answer from the files in your working directory: search and read them before answering. Never guess file names, functions or facts; if you cannot find something, say so.\n\n';

/* The claude executable: $ASK_CLAUDE_BIN if set, else the first on PATH or where Claude Code's installers put it; undefined when there is none. */
function findCli() {
  if (process.env.ASK_CLAUDE_BIN) return executable(process.env.ASK_CLAUDE_BIN) ? process.env.ASK_CLAUDE_BIN : undefined;
  const home = homedir();
  const dirs = [...(process.env.PATH || '').split(delimiter).filter(Boolean), join(home, '.local', 'bin'), join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.npm-global', 'bin'), join(home, '.local', 'share', 'pnpm')];
  return dirs.map((dir) => join(dir, 'claude')).find(executable);
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

/*
 * Launch controls that keep a run minimal, applied when the installed Claude Code supports them
 * (found in --help): no MCP servers, no slash commands or skills, and for read runs only the
 * Read, Grep and Glob tools in the ordinary permission mode. Hooks and plugins stay as the user
 * configured them: Claude Code has no switch that drops optional ones without policy hooks.
 */
function controls(cli, write) {
  const help = spawnSync(cli, ['--help'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
  const text = !help.error && help.status === 0 ? help.stdout || '' : '';
  const supports = (flag) => new RegExp(`${flag}(?=[\\s,]|$)`).test(text);
  const args = [];
  if (supports('--strict-mcp-config') && supports('--mcp-config')) args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
  if (supports('--disable-slash-commands')) args.push('--disable-slash-commands');
  if (!write) {
    if (supports('--tools')) args.push('--tools', 'Read,Grep,Glob');
    // New Claude versions call the ordinary approval mode "manual"; older ones use "default".
    args.push('--permission-mode', /"manual"/.test(text) ? 'manual' : 'default');
  }
  return args;
}

/* Claude Code's id for a model named family-version (sonnet-5.5 -> claude-sonnet-5-5, sonnet-5 -> claude-sonnet-5); other ids pass through. */
const claudeId = (model) => model.toLowerCase().replace(/^([a-z]+)-(\d+)(?:\.(\d+))?$/, (_, family, major, minor) => `claude-${family}-${major}${minor ? `-${minor}` : ''}`);

/* ask's token counts from a Claude usage object: input includes cache writes and reads. */
const tokens = (u) => ({
  input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
  output: u.output_tokens || 0,
  cached: u.cache_read_input_tokens || 0,
});

/* "Opus 5.5" for a model id like claude-opus-5-5, or undefined. */
function displayName(id) {
  const match = /claude-([a-z]+)-(\d+)-(\d+)/.exec(id || '');
  return match ? `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}.${match[3]}` : undefined;
}

/*
 * The environment of a read run's CLI, for the git it runs on its own (Claude Code reads git
 * status for context): no optional locks, so status never rewrites the index, and core.fsmonitor
 * off, so the repository's config cannot start a command. Added after any GIT_CONFIG_* the user set.
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
    child.on('close', (code) => resolve({ code, stdout, stderr }));
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
    maxCost: Number(process.env.ASK_MAX_COST) || undefined,
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
  console.error('Claude Code not found: install it from https://claude.com/claude-code, or set ASK_CLAUDE_BIN to its path');
  process.exit(1);
}

await adapter({
  models: () => MODELS.map((id) => [id, displayName(claudeId(id))]),

  async run({ prompt, model, effort, write, schema, session, maxCost, title, report }) {
    if (ALIASES.includes(model.toLowerCase()))
      return { ok: false, error: `"${model}" is an alias; name the exact model, like claude:${MODELS.find((m) => m.startsWith(model.toLowerCase())) || MODELS[1]} (see ask models)` };
    const id = session || randomUUID();
    report({ session: id });
    const args = ['-p', ...controls(CLI, write), '--model', claudeId(model), '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...(session ? ['--resume', session] : ['--session-id', id])];
    if (title) args.push('--name', title);
    if (effort) args.push('--effort', effort);
    // Claude Code reports cost only when it ends, so it enforces ask's limit itself.
    if (maxCost) args.push('--max-budget-usd', String(maxCost));
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    // Rules over a command's text cannot follow shell expansion; deny the model's shell tool.
    if (write) args.push('--permission-mode', 'bypassPermissions');
    else args.push('--allowedTools', 'Read,Grep,Glob', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit');
    // Each model call's usage arrives as it starts (message_start) and, with its output, as it
    // finishes (message_delta); the result event closes the run.
    const calls = new Map();
    let call;
    let result;
    let so = { input: 0, output: 0, cached: 0 };
    const activityEvent = createActivity();
    const onLine = (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (!event || typeof event !== 'object') return;
      // Optional activity must never interfere with the answer, usage or session report.
      try { activityEvent(event); } catch {}
      if (event.type === 'result') result = event;
      const e = event.type === 'stream_event' ? event.event || {} : {};
      if (e.type === 'content_block_start') {
        const block = e.content_block || {};
        let activity;
        if (block.type === 'thinking') activity = 'thinking';
        else if (block.type === 'text') activity = 'answering';
        else if (block.type === 'tool_use') {
          if (block.name === 'Bash') activity = 'running commands';
          else if (['Edit', 'Write', 'NotebookEdit'].includes(block.name)) activity = 'editing files';
          else if (['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'].includes(block.name)) activity = 'searching';
          else activity = 'using tools';
        }
        if (activity) report({ activity });
      }
      if (e.type === 'message_start') call = e.message?.id;
      const u = e.type === 'message_start' ? e.message?.usage : e.type === 'message_delta' ? e.usage : undefined;
      if (!u || !call) return;
      calls.set(call, u);
      so = { input: 0, output: 0, cached: 0 };
      for (const u of calls.values()) for (const [key, n] of Object.entries(tokens(u))) so[key] += n;
      report(so);
    };
    const r = await exec(CLI, args, { input: prompt, env: write ? {} : readEnv(), onLine });
    if (!result) return { ok: false, error: r.stderr.trim().split('\n').pop() || `unreadable output (exit ${r.code})` };
    // A run stopped at its budget ends with empty usage; the streamed counts are the real ones then.
    const final = tokens(result.usage || {});
    const usage = { ...(final.input || final.output ? final : so), cost: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined };
    // The model that did most of the work, so an alias like opus shows as the version it resolved to.
    const ran = Object.entries(result.modelUsage || {}).sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0))[0]?.[0];
    const name = displayName(ran);
    if (result.subtype === 'error_max_budget_usd') return { ok: false, error: `stopped at the $${maxCost >= 0.01 ? maxCost.toFixed(2) : maxCost} cost limit`, usage, name };
    if (result.is_error || r.code !== 0) return { ok: false, error: result.is_error ? result.result || result.subtype || 'error' : `exit ${r.code}`, usage, name };
    const text = result.structured_output !== undefined ? JSON.stringify(result.structured_output) : result.result;
    return text ? { ok: true, text, usage, name } : { ok: false, error: 'no answer', usage, name };
  },
});
