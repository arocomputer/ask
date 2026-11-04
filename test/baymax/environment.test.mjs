/* Pi's installed adapter and core policy together; all credentials are local fixture strings. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { harness, root, selection } from './integration.mjs';

const names = selection(process.env.BAYMAX_PACKAGES ? JSON.parse(process.env.BAYMAX_PACKAGES) : []);
test('Pi environment fixture preserves auth and instructions while disabling integrations', {
  skip: (!process.env.BAYMAX_ASK || !names.includes('pi')) && 'run via ./x baymax pi',
}, async (t) => {
  const s = await harness('pi', process.env.BAYMAX_ASK);
  t.after(s.cleanup);
  const path = join(s.env.ASK_HOME, 'environment.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const fixture = JSON.parse(readFileSync(join(root, 'packages/pi/test/fixtures/environment.json'), 'utf8'));
  config.agents.pi.integrations = fixture.agents.pi.integrations;
  writeFileSync(path, JSON.stringify(config));
  const authDir = join(s.home, 'custom-pi');
  mkdirSync(authDir);
  writeFileSync(join(authDir, 'auth.json'), '{"fixture":"not-a-real-credential"}');
  writeFileSync(join(authDir, 'models.json'), '{}');
  writeFileSync(join(s.work, 'AGENTS.md'), 'Keep the project policy.');
  const env = {
    PI_CODING_AGENT_DIR: authDir, OPENAI_API_KEY: 'fixture-key', AWS_SESSION_TOKEN: 'fixture-session',
    COPILOT_GITHUB_TOKEN: 'fixture-token', GOOGLE_APPLICATION_CREDENTIALS: join(s.home, 'adc.json'),
    UNRELATED_SECRET: 'private-sentinel',
  };
  for (const access of ['-r', '-w']) {
    const r = await s.run(['-m', 'pi:provider/model', access, 'task'], env);
    assert.equal(r.code, 0, r.stderr);
    const call = s.calls().at(-1);
    assert.deepEqual(call.auth, { file: true, models: true, openai: true, awsSession: true, copilot: true, adc: true, unrelated: false, preload: false });
    for (const flag of ['--no-mcp', '--no-extensions', '--no-skills']) assert.ok(call.argv.includes(flag));
    for (const flag of ['--no-context-files', '--no-approve']) assert.ok(!call.argv.includes(flag));
    assert.equal(readFileSync(join(s.work, 'AGENTS.md'), 'utf8'), 'Keep the project policy.');
    assert.ok(!JSON.stringify(s.record(r)).includes('private-sentinel'));
    assert.ok(!r.stderr.includes('fixture-key'));
  }
  const before = s.calls().length;
  config.agents.pi.integrations.mcp = true;
  writeFileSync(path, JSON.stringify(config));
  const denied = await s.run(['-r', '-m', 'pi:provider/model', 'task'], env);
  assert.equal(denied.code, 1);
  assert.equal(s.calls().length, before);
  assert.match(denied.stderr, /cannot enforce read/);
});
