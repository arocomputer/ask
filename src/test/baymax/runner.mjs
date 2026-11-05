#!/usr/bin/env node
/* Build ask once, run adapter assertions, then Baymax's integration and safety checks. */
import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { execute, isolated, root, selection } from './integration.mjs';

/* Pass only the verified git executable to safety tests, not the developer's entire PATH. */
function gitPath() {
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const path = resolve(dir, 'git');
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return realpathSync(path);
    } catch {}
  }
  throw new Error('Baymax writing checks require git on PATH');
}

/* Keep Go's tool discovery and module cache, while disabling downloads and user Go configuration. */
async function run() {
  const names = selection(process.argv.slice(2));
  const git = gitPath();
  const s = isolated('ask-baymax-build-');
  try {
    const tools = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: homedir(), GOENV: 'off', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off' };
    const info = await execute('go', ['env', '-json', 'GOMODCACHE', 'GOROOT'], { env: tools });
    if (info.code !== 0) throw new Error(`go env failed: ${info.stderr}`);
    const { GOMODCACHE, GOROOT } = JSON.parse(info.stdout);
    const ask = join(s.dir, 'ask');
    console.log(`Baymax: building ask for ${names.join(', ')}`);
    const built = await execute(join(GOROOT, 'bin', 'go'), ['build', '-o', ask, '.'], {
      env: { ...s.env, ...Object.fromEntries(Object.entries(tools).filter(([key]) => key !== 'HOME' && key !== 'PATH')), GOMODCACHE, GOROOT, GOCACHE: join(s.dir, 'go-cache'), CGO_ENABLED: '0' },
      timeout: 180_000, stream: true,
    });
    if (built.code !== 0) return built.code || 1;
    const files = names.flatMap((name) => readdirSync(join(root, 'packages', name, 'test'))
      .filter((file) => /\.test\.(?:js|mjs)$/.test(file)).sort()
      .map((file) => join(root, 'packages', name, 'test', file)));
    for (const name of names) if (!files.some((file) => file.startsWith(join(root, 'packages', name, 'test') + '/'))) throw new Error(`no retained tests for ${name}`);
    console.log('Baymax: retained package tests');
    const retained = await execute(process.execPath, ['--test', ...files], { env: s.env, timeout: 180_000, stream: true });
    console.log('Baymax: real ask integration and safety checks');
    const checks = readdirSync(join(root, 'src', 'test', 'baymax')).filter((file) => file.endsWith('.test.mjs')).sort()
      .map((file) => join(root, 'src', 'test', 'baymax', file));
    const integration = await execute(process.execPath, ['--test', ...checks], {
      env: { ...s.env, BAYMAX_ASK: ask, BAYMAX_GIT: git, BAYMAX_PACKAGES: JSON.stringify(names) }, timeout: 180_000, stream: true,
    });
    return retained.code || integration.code || (retained.signal || integration.signal ? 1 : 0);
  } finally { s.cleanup(); }
}

try { process.exitCode = await run(); }
catch (error) { console.error(`Baymax: ${error.message}`); process.exitCode = 1; }
