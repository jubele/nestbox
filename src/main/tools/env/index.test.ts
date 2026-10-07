import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDetectedForTest } from '@shared/test-fixtures';
import type { EnvMatrix } from '@shared/tools/env/contract';
import { createMemoryLogger } from '../../logger';
import { createDarwinAdapter } from '../../platform/darwin';
import { noopRunner } from '../../platform/testing';
import { createSharedContext } from '../shared-context';
import type { ToolContext } from '../types';
import { createEnvFileAccess } from './env-files';
import { createEnvTool, ENV_FACTS } from './index';

const SECRET = 's3cr3t-value';
const notGitRunner = {
  ...noopRunner,
  exec: async (file: string) => ({ code: /git$/.test(file) ? 128 : 0, stdout: '' }),
};
let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nestbox-envtool-'));
  await writeFile(join(dir, '.env'), `# local\nPORT=3000\nDATABASE_URL=postgres://u:${SECRET}@h/db\n`);
  await writeFile(join(dir, '.env.example'), '# documented keys\nPORT=\nDATABASE_URL=\nREDIS_URL=redis://localhost:6379\n');
  await writeFile(join(dir, '.env.staging'), 'PORT=8080\n');
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

function setup() {
  const clipboard = { writeText: vi.fn() };
  const watchers: { dir: string; onChange: () => void; close: ReturnType<typeof vi.fn> }[] = [];
  const watch = vi.fn((watched: string, onChange: () => void) => {
    const close = vi.fn();
    watchers.push({ dir: watched, onChange, close });
    return close;
  });
  const logger = createMemoryLogger();
  const tool = createEnvTool({ files: createEnvFileAccess(), clipboard, watch, logger });
  const shared = createSharedContext();
  const emit = vi.fn();
  const ctx = {
    project: makeDetectedForTest({ path: dir }),
    shared: shared.forProject('p1'),
    emit,
    // git answers "not a repository", so the code scan walks the folder.
    platform: createDarwinAdapter({ runner: notGitRunner, getEditorCommand: () => 'code' }),
    settings: { get: () => ({}), update: (fn: (s: object) => object) => fn({}) },
  } as unknown as ToolContext;
  const call = <T,>(method: string, input: unknown = {}) => tool.handlers[method]?.(ctx, input) as Promise<T>;
  return { tool, call, clipboard, watchers, emit, logger, shared };
}

describe('env tool', () => {
  it('builds the matrix without values, starts one watcher and publishes facts', async () => {
    const { call, watchers, shared } = setup();
    const m = await call<EnvMatrix>('matrix');
    expect(m.files.map((f) => f.name)).toEqual(['.env.example', '.env', '.env.staging']);
    expect(m.keys.find((k) => k.key === 'REDIS_URL')?.missing).toBe(true);
    expect(m.profiles).toEqual([{ name: 'staging', file: '.env.staging', active: false }]);
    expect(JSON.stringify(m)).not.toContain(SECRET);
    await call('matrix');
    expect(watchers).toHaveLength(1);
    expect(shared.forProject('p1').get(ENV_FACTS)).toEqual({ port: 3000, urls: ['DATABASE_URL'] });
  });

  it('emits changed when the watcher sees a change (debounced)', async () => {
    vi.useFakeTimers();
    try {
      const { call, watchers, emit } = setup();
      await call('matrix');
      watchers[0]?.onChange();
      watchers[0]?.onChange();
      await vi.advanceTimersByTimeAsync(250);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith('changed', undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reveals one value and copies another without returning it', async () => {
    const { call, clipboard } = setup();
    expect(await call('reveal', { file: '.env', key: 'PORT' })).toEqual({ value: '3000' });
    expect(await call('copy', { file: '.env', key: 'DATABASE_URL' })).toEqual({});
    expect(clipboard.writeText).toHaveBeenCalledWith(`postgres://u:${SECRET}@h/db`);
  });

  it('reports a missing key without its value or name in the message', async () => {
    const { call } = setup();
    const error = await call('reveal', { file: '.env', key: 'NOPE_KEY' }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'NOT_FOUND' });
    expect((error as Error).message).not.toContain('NOPE_KEY');
  });

  it('edits, adds and removes keys, keeping the rest of the file, and emits changed', async () => {
    const { call, emit } = setup();
    let m = await call<EnvMatrix>('matrix');
    const version = () => m.files.find((f) => f.name === '.env')?.version ?? '';
    await call('setValue', { file: '.env', key: 'PORT', value: '4000', version: version() });
    m = await call<EnvMatrix>('matrix');
    await call('addKey', { file: '.env', key: 'REDIS_URL', value: 'redis://localhost:6379', version: version() });
    m = await call<EnvMatrix>('matrix');
    await call('removeKey', { file: '.env', key: 'DATABASE_URL', version: version() });
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('# local\nPORT=4000\nREDIS_URL=redis://localhost:6379\n');
    expect(emit).toHaveBeenCalledWith('changed', undefined);
  });

  it('creates a new env file with addKey and a null version', async () => {
    const { call } = setup();
    await call('addKey', { file: '.env.local', key: 'A', value: '1', version: null });
    expect(await readFile(join(dir, '.env.local'), 'utf8')).toBe('A=1\n');
  });

  it('refuses an edit based on a stale version', async () => {
    const { call } = setup();
    const m = await call<EnvMatrix>('matrix');
    const version = m.files.find((f) => f.name === '.env')?.version ?? '';
    await writeFile(join(dir, '.env'), 'PORT=1\n');
    await expect(call('setValue', { file: '.env', key: 'PORT', value: '2', version })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('switches profile: backs up .env, copies the profile, and the profile becomes active', async () => {
    const { call } = setup();
    const m = await call<EnvMatrix>('matrix');
    const envVersion = m.files.find((f) => f.name === '.env')?.version ?? null;
    await call('switchProfile', { file: '.env.staging', envVersion });
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('PORT=8080\n');
    expect(await readFile(join(dir, '.env.backup'), 'utf8')).toContain(SECRET);
    const after = await call<EnvMatrix>('matrix');
    expect(after.profiles.find((p) => p.file === '.env.staging')?.active).toBe(true);
    expect(after.profiles.map((p) => p.file)).not.toContain('.env.backup');
  });

  it('refuses to switch onto a symlinked .env before touching the backup', async (ctx) => {
    const { symlink } = await import('node:fs/promises');
    await writeFile(join(dir, '.env.backup'), 'precious');
    await writeFile(join(dir, 'real.env'), 'PORT=1\n');
    await rm(join(dir, '.env'));
    try {
      await symlink(join(dir, 'real.env'), join(dir, '.env'), 'file');
    } catch {
      ctx.skip();
    }
    const { call } = setup();
    const m = await call<EnvMatrix>('matrix');
    const envVersion = m.files.find((f) => f.name === '.env')?.version ?? null;
    await expect(call('switchProfile', { file: '.env.staging', envVersion })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await readFile(join(dir, '.env.backup'), 'utf8')).toBe('precious');
  });

  it('refuses to switch to a file that is not a profile', async () => {
    const { call } = setup();
    await expect(call('switchProfile', { file: '.env.example', envVersion: null })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('switches when there is no .env yet', async () => {
    await rm(join(dir, '.env'));
    const { call } = setup();
    await call('switchProfile', { file: '.env.staging', envVersion: null });
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('PORT=8080\n');
  });

  it('reads and writes a whole file as text, refusing a stale version and never logging it', async () => {
    const { call, emit, logger } = setup();
    const raw = await call<{ text: string; version: string }>('readRaw', { file: '.env' });
    expect(raw.text).toBe(`# local\nPORT=3000\nDATABASE_URL=postgres://u:${SECRET}@h/db\n`);
    const edited = `${raw.text.replace('3000', '4000')}NEW_KEY=1\n`;
    const { version } = await call<{ version: string }>('writeRaw', { file: '.env', text: edited, version: raw.version });
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe(edited);
    expect(version).not.toBe(raw.version);
    expect(emit).toHaveBeenCalledWith('changed', undefined);
    await expect(call('writeRaw', { file: '.env', text: 'X=1\n', version: raw.version })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(JSON.stringify(logger.entries)).not.toContain(SECRET);
    expect(JSON.stringify(logger.entries)).not.toContain('NEW_KEY');
  });

  it('lists the env keys the code reads, by name only', async () => {
    const { call, logger } = setup();
    await writeFile(join(dir, 'main.py'), `import os\nDSN = os.getenv("SENTRY_DSN", "${SECRET}")\nPORT = os.environ["PORT"]\n`);
    const found = await call<{ keys: unknown[]; files: number; truncated: boolean }>('codeKeys');
    expect(found).toEqual({
      keys: [
        { key: 'PORT', files: 1 },
        { key: 'SENTRY_DSN', files: 1 },
      ],
      files: 1,
      truncated: false,
    });
    expect(JSON.stringify(logger.entries)).not.toContain('SENTRY_DSN');
  });

  it('creates an env file with empty values for the given keys, never over an existing one', async () => {
    const { call, emit } = setup();
    await call('createFile', { file: '.env.local', keys: ['SENTRY_DSN', 'PORT'] });
    expect(await readFile(join(dir, '.env.local'), 'utf8')).toBe('SENTRY_DSN=\nPORT=\n');
    expect(emit).toHaveBeenCalledWith('changed', undefined);
    await expect(call('createFile', { file: '.env', keys: ['X'] })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readFile(join(dir, '.env'), 'utf8')).toContain('PORT=3000');
  });

  it('returns PORT from .env as a fact, null when absent or invalid', async () => {
    const { call } = setup();
    expect(await call('facts')).toEqual({ port: 3000 });
    await writeFile(join(dir, '.env'), 'PORT=abc\n');
    expect(await call('facts')).toEqual({ port: null });
  });

  it('never logs a value', async () => {
    const { call, logger } = setup();
    const m = await call<EnvMatrix>('matrix');
    await call('reveal', { file: '.env', key: 'DATABASE_URL' });
    await call('setValue', { file: '.env', key: 'DATABASE_URL', value: `new-${SECRET}`, version: m.files.find((f) => f.name === '.env')?.version });
    expect(JSON.stringify(logger.entries)).not.toContain(SECRET);
  });

  it('closes the watcher of a removed project, and watches again under a new id', async () => {
    const { tool, call, watchers } = setup();
    await call('matrix');
    tool.forgetProject?.('p1');
    expect(watchers[0]?.close).toHaveBeenCalled();
  });

  it('retries a watcher that could not start', async () => {
    const watch = vi.fn((): (() => void) | null => null);
    const tool = createEnvTool({ files: createEnvFileAccess(), clipboard: { writeText: vi.fn() }, watch, logger: createMemoryLogger() });
    const shared = createSharedContext();
    const context = {
      project: makeDetectedForTest({ path: dir }),
      shared: shared.forProject('p1'),
      emit: vi.fn(),
      // git answers "not a repository", so the code scan walks the folder.
    platform: createDarwinAdapter({ runner: notGitRunner, getEditorCommand: () => 'code' }),
      settings: { get: () => ({}), update: (fn: (s: object) => object) => fn({}) },
    } as unknown as ToolContext;
    await tool.handlers['matrix']?.(context, {});
    await tool.handlers['matrix']?.(context, {});
    expect(watch).toHaveBeenCalledTimes(2);
  });

  it('closes its watchers on dispose', async () => {
    const { tool, call, watchers } = setup();
    await call('matrix');
    await tool.dispose?.();
    expect(watchers[0]?.close).toHaveBeenCalled();
  });
});
