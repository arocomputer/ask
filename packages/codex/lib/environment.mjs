/* Codex has no confirmed global integration reset that preserves provider config and hooks.
 * In particular --ignore-user-config retains auth files, but drops config-defined auth/providers
 * and hooks; mcp_servers={} deep-merges, and disabling tools does not stop integration loading. */
export function checkEnvironment() {
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
  if (Object.values(requested).includes(false)) throw new Error('Codex cannot safely enforce the requested integration restriction while preserving auth, project instructions and policy hooks');
  if (policy.hooks === false) throw new Error('Codex cannot disable optional hooks separately from policy hooks; hooks must remain true');
  if (['mcp', 'plugins', 'skills'].some((key) => policy[key] !== true)) {
    console.error('Codex minimal integrations are unavailable: retaining normal MCP, plugins, skills and policy hooks. Explicit restrictions are refused; --ignore-user-config is not a safe substitute. The OS sandbox does not establish integration isolation.');
    return 'Codex integration isolation unavailable; normal MCP/plugins/skills and policy hooks retained';
  }
}
