/* Optional real-CLI contract check. All HTTP responses and credentials are local fixtures;
 * no real model or account is used. Normal Integration runs need only the CLI simulator. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isolated } from '../../../src/test/integration/integration.mjs';
import { runProcess } from '../../../src/test/integration/helper.mjs';

const cli = process.env.ASK_TEST_CLAUDE_BIN;
test('real Claude preserves config auth, instructions and hooks while controlling MCP and skills', {
  skip: !cli && 'set ASK_TEST_CLAUDE_BIN to a real Claude Code executable; uses local HTTP fixtures only',
  timeout: 60_000,
}, async (t) => {
  const s = isolated('ask-claude-cli-');
  t.after(s.cleanup);
  const config = join(s.home, '.claude');
  const hook = join(s.dir, 'hook');
  mkdirSync(config);
  mkdirSync(join(s.work, '.claude', 'skills', 'fixture'), { recursive: true });
  writeFileSync(join(s.work, 'CLAUDE.md'), 'PROJECT_INSTRUCTION_SENTINEL\n');
  writeFileSync(join(s.work, '.claude', 'skills', 'fixture', 'SKILL.md'), '---\nname: fixture\ndescription: SKILL_DESCRIPTION_SENTINEL\n---\nFixture skill.\n');
  writeFileSync(join(config, 'settings.json'), JSON.stringify({
    apiKeyHelper: 'printf fixture-provider-key',
    enableAllProjectMcpServers: true,
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `printf x >> '${hook}'` }] }] },
  }));
  const messages = [];
  const connections = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = JSON.parse(raw); } catch {}
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/mcp') {
      connections.push(body?.method);
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      if (body?.id === undefined) { res.writeHead(202); res.end(); return; }
      const result = body.method === 'initialize' ? {
        protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
      } : body.method === 'tools/list' ? { tools: [{ name: 'fixture_read', description: 'Fixture tool', inputSchema: { type: 'object', properties: {} } }] } : {};
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      return;
    }
    if (req.url.includes('count_tokens')) { res.end('{"input_tokens":20}'); return; }
    if (!req.url.startsWith('/v1/messages')) { res.end('{}'); return; }
    messages.push({ body, key: req.headers['x-api-key'] });
    const answer = { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: 'claude-haiku-4-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
    if (!body.stream) {
      res.end(JSON.stringify({ ...answer, content: [{ type: 'text', text: 'fixture answer' }], stop_reason: 'end_turn' }));
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    for (const event of [
      { type: 'message_start', message: answer },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture answer' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(s.work, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { type: 'http', url: `${url}/mcp` } } }));
  const agent = fileURLToPath(new URL('../lib/claude.mjs', import.meta.url));
  const env = {
    ...s.env, ASK_CLAUDE_BIN: cli, ASK_MODEL: 'haiku-4.5', ASK_ACCESS: 'read',
    CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
  };
  for (const optedIn of [false, true]) {
    const result = await runProcess(process.execPath, [agent], {
      cwd: s.work, input: 'fixture prompt', timeout: 25_000,
      env: { ...env, ...(optedIn ? { ASK_ACCESS: 'write', ASK_ENVIRONMENT: '{"mcp":true,"skills":true}' } : {}) },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'fixture answer\n');
    const request = messages.at(-1);
    assert.equal(request.key, 'fixture-provider-key', 'config-defined auth helper still supplies auth');
    assert.ok(JSON.stringify(request.body).includes('PROJECT_INSTRUCTION_SENTINEL'));
    assert.equal(JSON.stringify(request.body).includes('SKILL_DESCRIPTION_SENTINEL'), optedIn);
    assert.equal(connections.includes('tools/list'), optedIn);
    if (!optedIn) assert.deepEqual(request.body.tools.map(tool => tool.name).sort(), ['Glob', 'Grep', 'Read']);
    // Claude may defer MCP tools behind ToolSearch rather than include every schema up front.
    else assert.ok(request.body.tools.some(tool => tool.name.includes('fixture_read') || tool.name === 'ToolSearch'));
    assert.ok(existsSync(hook), 'SessionStart policy hook was not suppressed');
  }
  assert.equal(readFileSync(hook, 'utf8'), 'xx');
});
