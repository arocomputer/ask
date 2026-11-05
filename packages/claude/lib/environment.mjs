/* Use independent launch controls: broad reset modes also suppress auth, instructions or hooks. */
import { spawnSync } from 'node:child_process';

export function environmentArgs(cli, write) {
  let policy, requested;
  try {
    policy = JSON.parse(process.env.ASK_ENVIRONMENT || '{}');
    requested = JSON.parse(process.env.ASK_ENVIRONMENT_REQUESTED || process.env.ASK_ENVIRONMENT || '{}');
  } catch { throw new Error('invalid ASK_ENVIRONMENT policy'); }
  for (const value of [policy, requested]) {
    if (!value || Array.isArray(value) || typeof value !== 'object' ||
        Object.entries(value).some(([k, v]) => !['mcp', 'plugins', 'skills', 'hooks'].includes(k) || typeof v !== 'boolean')) {
      throw new Error('invalid ASK_ENVIRONMENT policy');
    }
  }
  policy = { mcp: false, plugins: false, skills: false, hooks: true, ...policy };
  if (!policy.hooks) throw new Error('Claude cannot disable optional hooks separately from policy hooks; hooks must remain true');
  if (requested.plugins === false) throw new Error('Claude cannot safely disable all plugins while preserving policy hooks; requested plugins:false cannot be enforced');
  if (!write && (policy.mcp || policy.plugins)) throw new Error('Claude cannot enforce read tools with MCP or plugins opted in; use a trusted write run');
  if (policy.plugins && (!policy.mcp || !policy.skills)) throw new Error('Claude plugins may supply MCP, skills and hooks; plugins opt-in requires mcp and skills opt-in too');

  // Help exits before a task. No reset flags, settings replacement or diagnostic echoing.
  const help = spawnSync(cli, ['--help'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
  const supports = (flag) => !help.error && help.status === 0 && new RegExp(`${flag}(?=[\\s,]|$)`).test(help.stdout || '');
  const args = [];
  const unavailable = [];
  for (const [key, flags] of [
    ['mcp', ['--strict-mcp-config', '--mcp-config']],
    ['skills', ['--disable-slash-commands']],
  ]) {
    if (policy[key]) continue;
    if (!flags.every(supports)) {
      if (requested[key] === false) throw new Error(`Claude help does not confirm controls for requested ${key}:false; upgrade Claude Code`);
      unavailable.push(key);
    } else if (key === 'mcp') args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
    else args.push('--disable-slash-commands');
  }
  // --allowedTools grants permission; --tools actually limits the built-in tool set.
  if (!write && supports('--tools')) args.push('--tools', 'Read,Grep,Glob');
  else if (!write) unavailable.push('built-in tool selection');
  // New Claude versions call the ordinary approval mode "manual"; older ones use "default".
  if (!write) args.push('--permission-mode', /"manual"/.test(help.stdout || '') ? 'manual' : 'default');
  if (!policy.plugins) unavailable.push('plugins (including possible policy hooks)');
  if (unavailable.length) console.error(`Claude minimal environment unavailable for ${unavailable.join(', ')}; retaining normal harness behavior for those integrations. This is not an enforced isolation boundary.`);
  return { args, note: unavailable.length ? `Claude minimal controls unavailable: ${unavailable.join(', ')}; normal integration loading retained` : undefined };
}
