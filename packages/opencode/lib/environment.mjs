/* V1 and v2 have different, additive config/discovery systems. Permission rules restrict tool
 * use, not plugin execution or MCP connections. Never replace config roots to simulate isolation. */
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
  if (Object.values(requested).includes(false)) throw new Error('OpenCode cannot safely enforce the requested integration restriction while preserving auth, project instructions and plugin policy hooks');
  if (policy.hooks === false) throw new Error('OpenCode cannot disable optional hooks separately from policy hooks; hooks must remain true');
  if (['mcp', 'plugins', 'skills'].some((key) => policy[key] !== true)) {
    console.error('OpenCode minimal integrations are unavailable: retaining normal MCP, plugins, skills and policy hooks. Explicit restrictions are refused; tool permissions do not stop integration loading or establish an isolation boundary.');
    return 'OpenCode integration isolation unavailable; normal MCP/plugins/skills and policy hooks retained';
  }
}
