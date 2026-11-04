/* Pi's flags are launch controls, not a sandbox. Extensions can implement policy hooks as
 * well as tools, so refuse to suppress configured code rather than guessing its purpose. */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function environmentArgs(cli, access) {
  let policy;
  try { policy = JSON.parse(process.env.ASK_ENVIRONMENT || '{"mcp":false,"plugins":false,"skills":false,"hooks":true}'); }
  catch { throw new Error('invalid ASK_ENVIRONMENT'); }
  if (!policy || Array.isArray(policy) || typeof policy !== 'object' ||
      Object.entries(policy).some(([key, value]) => !['mcp', 'plugins', 'skills', 'hooks'].includes(key) || typeof value !== 'boolean')) {
    throw new Error('invalid ASK_ENVIRONMENT');
  }
  policy = { mcp: false, plugins: false, skills: false, hooks: true, ...policy };
  if (!policy.hooks) throw new Error('Pi cannot disable optional hooks separately from policy hooks; hooks must remain true');
  if (policy.plugins && (!policy.mcp || !policy.skills)) {
    throw new Error('Pi extensions can provide MCP and skills; enabling plugins requires explicit mcp and skills opt-in too');
  }
  if (access !== 'write' && (policy.plugins || policy.mcp)) {
    throw new Error('Pi cannot enforce read tools with MCP or plugins enabled; use a write run only if you trust these integrations');
  }
  if (!policy.plugins) checkExtensionSources();
  const args = ['--no-prompt-templates', '--no-themes'];
  if (!policy.plugins) args.push('--no-extensions');
  if (!policy.skills) args.push('--no-skills');
  if (!policy.mcp) args.push('--no-mcp');
  else if (!policy.plugins) args.push('--extension', 'builtin:mcp');
  // Probe help without executing discovered extensions or connecting servers. Do not repeat
  // harness diagnostics: these can include credentials or configuration contents.
  const help = spawnSync(cli, ['--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--help'], {
    env: { ...process.env, PI_OFFLINE: '1' }, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  if (help.error || help.status !== 0 || args.filter((arg) => arg.startsWith('--')).some((flag) => !new RegExp(`${flag}(?=[\\s,]|$)`).test(help.stdout))) {
    throw new Error('installed Pi help does not confirm the required environment controls (including --no-mcp); upgrade Pi');
  }
  return args;
}

function checkExtensionSources() {
  let agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  // Match Pi's config-path expansion so a nonliteral path cannot hide policy hooks.
  if (agentDir === '~') agentDir = homedir();
  else if (agentDir.startsWith('~/')) agentDir = join(homedir(), agentDir.slice(2));
  if (agentDir.startsWith('file://')) {
    try { agentDir = fileURLToPath(agentDir); }
    catch { throw new Error('cannot inspect Pi config directory safely for policy hooks'); }
  }
  const dirs = new Set([resolve(agentDir)]);
  // Check ancestors conservatively too; never ignore policy merely because project trust or
  // a harness version currently makes a directory inactive.
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    dirs.add(join(dir, '.pi'));
    if (dirname(dir) === dir) break;
  }
  for (const dir of dirs) {
    let settings = {};
    try { settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('cannot inspect Pi settings safely for policy hooks'); }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('cannot inspect Pi settings safely for policy hooks');
    // Even disabled entries and packages that might contain only skills cause a refusal:
    // resolving them would require running the harness or third-party code.
    if (['extensions', 'packages', 'hooks'].some((key) => key in settings && (!Array.isArray(settings[key]) || settings[key].length))) {
      throw new Error('Pi extension/package configuration may contain policy hooks; minimal mode refuses to disable it. Review it and opt in to plugins, mcp and skills for a trusted write run');
    }
    try {
      if (readdirSync(join(dir, 'extensions')).length) throw new Error('Pi extensions may contain policy hooks; review them and opt in to plugins, mcp and skills for a trusted write run');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Pi extensions may contain policy hooks or cannot be inspected; minimal mode refuses to disable them');
    }
  }
}
