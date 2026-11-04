/* Pi's ask adapter: one JSON-mode turn, controlled integrations, saved sessions and usage. */
import { spawn } from 'node:child_process';
import { environmentArgs } from './environment.mjs';
import { accessSync, constants, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';

const GROUNDING = 'Answer from the files in your working directory: search and read them before answering. Never guess file names, functions or facts; if you cannot find something, say so.\n\n';

/* Find an executable Pi, respecting an explicit override without falling back. */
function findCli() {
  const executable = (path) => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  };
  if (process.env.ASK_PI_BIN) return executable(process.env.ASK_PI_BIN) ? process.env.ASK_PI_BIN : undefined;
  return [...(process.env.PATH || '').split(delimiter).filter(Boolean), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
    .map((dir) => join(dir, 'pi')).find(executable);
}

/* Replace ask's report atomically, preserving fields learned earlier in the turn. */
function reporter() {
  const fields = {};
  return (update) => {
    Object.assign(fields, update);
    if (!process.env.ASK_REPORT) return;
    writeFileSync(`${process.env.ASK_REPORT}.tmp`, JSON.stringify(fields));
    renameSync(`${process.env.ASK_REPORT}.tmp`, process.env.ASK_REPORT);
  };
}

/* Map Pi's disjoint token categories to ask's total input and cached subset. */
function usage(u) {
  const mapped = {};
  if ([u.input, u.cacheRead, u.cacheWrite].some((v) => typeof v === 'number')) mapped.input = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
  if (typeof u.output === 'number') mapped.output = u.output;
  if (typeof u.cacheRead === 'number') mapped.cached = u.cacheRead;
  if (typeof u.cost?.total === 'number') mapped.cost = u.cost.total;
  return mapped;
}

/* Run one turn; only final assistant text reaches stdout, even when JSON mode exits zero on error. */
async function main() {
  const cli = findCli();
  if (!cli) throw new Error('Pi not found: install it from https://pi.dev, or set ASK_PI_BIN to its path');
  // Pi has no machine-readable catalog command; the contract permits an empty list.
  if (process.argv[2] === 'models') return;
  const { ASK_MODEL: model, ASK_EFFORT: effort, ASK_ACCESS: access, ASK_SESSION: session, ASK_TITLE: title } = process.env;
  if (access !== 'write' && existsSync(join(process.cwd(), '.pi', 'commands')) && !existsSync(join(process.cwd(), '.pi', 'prompts'))) {
    throw new Error('Pi would migrate .pi/commands to .pi/prompts at startup; migrate it yourself before a read run');
  }
  if (!model || !/^[^/\s*?:]+\/[^\s*?:]+$/.test(model)) throw new Error('Pi requires an explicit provider/model id; unqualified aliases, patterns and thinking suffixes are unsupported');
  if (effort && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error(`unsupported Pi thinking level: ${effort}`);
  const split = model.indexOf('/');
  const args = ['--mode', 'json', '--provider', model.slice(0, split), '--model', model.slice(split + 1),
    ...environmentArgs(cli, access),
    '--tools', access === 'write' ? 'read,grep,find,ls,bash,edit,write' : 'read,grep,find,ls'];
  if (effort) args.push('--thinking', effort);
  if (session) args.push('--session', session);
  if (title) args.push('--name', title);
  const report = reporter();
  const totals = {};
  let text = '';
  let failure;
  let terminal = false;
  let stderr = '';
  // Avoid startup downloads in both modes. This does not block model API requests.
  const child = spawn(cli, args, { env: { ...process.env, PI_OFFLINE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const finished = new Promise((resolve) => {
    child.on('error', (error) => { failure = error.message; });
    child.on('close', (code) => resolve(code));
  });
  child.stdin.on('error', () => {});
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  child.stdin.end((access !== 'write' && !session ? GROUNDING : '') + readFileSync(0, 'utf8'));
  for await (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'session' && typeof event.id === 'string') report({ session: event.id });
    if (event.type === 'message_update' && event.usage) {
      const current = usage(event.usage);
      report(Object.fromEntries(Object.entries(current).map(([key, value]) => [key, (totals[key] || 0) + value])));
    }
    if (event.type === 'compaction_end' && event.result?.usage) {
      for (const [key, value] of Object.entries(usage(event.result.usage))) totals[key] = (totals[key] || 0) + value;
      report(totals);
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const message = event.message;
      for (const [key, value] of Object.entries(usage(message.usage || {}))) totals[key] = (totals[key] || 0) + value;
      report({ ...totals, name: message.model });
      failure = ['error', 'aborted'].includes(message.stopReason) ? message.errorMessage || `Pi request ${message.stopReason}` : undefined;
      terminal = message.stopReason === 'stop' || message.stopReason === 'length';
      text = (message.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('');
      if (message.stopReason === 'length') report({ note: 'hit output limit; answer may be partial' });
    }
  }
  const code = await finished;
  if (failure || code !== 0 || !terminal || !text) throw new Error(failure || stderr.trim().split('\n').pop() || `no completed answer (exit ${code})`);
  process.stdout.write(`${text}\n`);
}

await main().catch((error) => {
  console.error(String(error.message).replace(/\s+/g, ' ').trim());
  process.exitCode = 1;
});
