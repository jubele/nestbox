import { delimiter } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NestboxError } from '@shared/errors';
import { belongsTo } from '@shared/processes';
import { createMemoryLogger } from '../logger';
import { fakePlatform, flushIo } from './fake-child';
import { backoffMs, type ProcessEvent, ProcessManager, type StartRequest } from './process-manager';

const req = (over: Partial<StartRequest> = {}): StartRequest => ({
  projectId: 'p1',
  script: 'dev',
  cwd: 'C:\\shop',
  packageManager: 'pnpm',
  autoRestart: false,
  ...over,
});

function setup(opts: { bufferLines?: number } = {}) {
  const platform = fakePlatform();
  const ledger = { add: vi.fn(), remove: vi.fn() };
  const logger = createMemoryLogger();
  const pm = new ProcessManager({ platform, ledger, bufferLines: () => opts.bufferLines ?? 1_000, logger });
  const events: ProcessEvent[] = [];
  pm.on((e) => events.push(e));
  const texts = (projectId = 'p1', script = 'dev') => pm.logs(projectId, script).lines.map((l) => l.text);
  return { pm, platform, ledger, logger, events, texts };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ProcessManager start', () => {
  it('spawns through the adapter with FORCE_COLOR and the package manager', async () => {
    const { pm, platform } = setup();
    await pm.start(req());
    expect(platform.spawnScript).toHaveBeenCalledWith({
      cwd: 'C:\\shop',
      command: 'pnpm',
      args: ['run', 'dev'],
      env: expect.objectContaining({ FORCE_COLOR: '1', PATH: 'x' }),
    });
  });

  it('runs a command line with extra env instead of a package script', async () => {
    const { pm, platform, texts } = setup();
    await pm.start(
      req({
        script: 'api',
        argv: ['python', '-m', 'uvicorn', 'main:app', '--reload'],
        env: { VIRTUAL_ENV: '/shop/.venv', PYTHONUNBUFFERED: '1' },
        pathPrepend: '/shop/.venv/bin',
      }),
    );
    expect(platform.spawnScript).toHaveBeenCalledWith({
      cwd: 'C:\\shop',
      command: 'python',
      args: ['-m', 'uvicorn', 'main:app', '--reload'],
      env: expect.objectContaining({
        FORCE_COLOR: '1',
        VIRTUAL_ENV: '/shop/.venv',
        PYTHONUNBUFFERED: '1',
        PATH: `/shop/.venv/bin${delimiter}x`,
      }),
    });
    expect(texts('p1', 'api')).toEqual(['▸ python -m uvicorn main:app --reload']);
  });

  it('loads the env file at every spawn, under the virtualenv and NestBox variables, logging only a count', async () => {
    const { pm, platform, texts } = setup();
    let vars: Record<string, string> | null = { API_KEY: 'k-secret', VIRTUAL_ENV: '/wrong', PATH: '/from-dotenv' };
    const read = vi.fn(async () => vars);
    await pm.start(
      req({ script: 'api', argv: ['python', 'main.py'], env: { VIRTUAL_ENV: '/shop/.venv' }, pathPrepend: '/shop/.venv/bin', loadEnv: { file: '.env', read } }),
    );
    expect(platform.spawnScript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ API_KEY: 'k-secret', VIRTUAL_ENV: '/shop/.venv', PATH: `/shop/.venv/bin${delimiter}/from-dotenv` }),
      }),
    );
    expect(texts('p1', 'api')).toEqual(['▸ python main.py', '▸ env: .env (3 variables)']);
    vars = null;
    await pm.restart(req({ script: 'api', argv: ['python', 'main.py'], loadEnv: { file: '.env', read } }));
    expect(read).toHaveBeenCalledTimes(2);
    expect(texts('p1', 'api')).toContain('▸ .env not found: started without it');
    expect(texts('p1', 'api').join('\n')).not.toContain('k-secret');
  });

  it('starts without the env file when it cannot be read', async () => {
    const { pm, platform, texts } = setup();
    await pm.start(req({ loadEnv: { file: '.env.local', read: async () => Promise.reject(new Error('EACCES')) } }));
    expect(platform.spawnScript).toHaveBeenCalled();
    expect(texts()).toContain('▲ .env.local could not be read: started without it');
  });

  it('logs the version advice first, puts fnm\'s Node first on PATH and keeps the warning', async () => {
    const { pm, platform, texts } = setup();
    const summary = await pm.start(
      req({ warning: "Node v20.11.1 doesn't match 18 (.nvmrc)", note: '▸ fnm: Node 18 from /fnm/18/bin', pathPrepend: '/fnm/18/bin' }),
    );
    expect(texts()).toEqual(['▸ fnm: Node 18 from /fnm/18/bin', "▲ Node v20.11.1 doesn't match 18 (.nvmrc)", '▸ pnpm run dev']);
    expect(platform.spawnScript).toHaveBeenCalledWith(
      expect.objectContaining({ env: expect.objectContaining({ PATH: `/fnm/18/bin${delimiter}x` }) }),
    );
    expect(summary.warning).toBe("Node v20.11.1 doesn't match 18 (.nvmrc)");
  });

  it('prepends to PATH under the casing the environment uses (Path on Windows)', async () => {
    const { pm, platform } = setup();
    platform.resolveShellEnv.mockResolvedValue({ Path: 'C:\\Windows' });
    await pm.start(req({ pathPrepend: 'C:\\fnm\\18' }));
    const env = (platform.spawnScript.mock.calls as unknown as [{ env: NodeJS.ProcessEnv }][])[0]?.[0].env;
    expect(env?.['Path']).toBe(`C:\\fnm\\18${delimiter}C:\\Windows`);
    expect(env).not.toHaveProperty('PATH');
  });

  it('falls back to npm when no package manager was detected', async () => {
    const { pm, platform } = setup();
    await pm.start(req({ packageManager: null }));
    expect(platform.spawnScript).toHaveBeenCalledWith(expect.objectContaining({ command: 'npm' }));
  });

  it('records the PID with the spawn time before start resolves, without asking the OS', async () => {
    const { pm, platform, ledger } = setup();
    vi.setSystemTime(1_700_000_000_000);
    const summary = await pm.start(req());
    expect(summary).toMatchObject({ state: 'starting', pid: 1000 });
    expect(ledger.add).toHaveBeenCalledTimes(1);
    expect(ledger.add).toHaveBeenCalledWith({ pid: 1000, startTime: 1_700_000_000_000, projectId: 'p1', script: 'dev' });
    // The OS lookup (PowerShell on Windows) can take seconds; it is only used by the orphan check.
    expect(platform.listProcesses).not.toHaveBeenCalled();
  });

  it('never records a process that closed before it spawned', async () => {
    const { pm, platform, ledger } = setup();
    platform.failNextSpawn();
    await pm.start(req());
    await flushIo();
    expect(ledger.add).not.toHaveBeenCalled();
  });

  it('promotes starting to running after 3 s', async () => {
    const { pm } = setup();
    await pm.start(req());
    await vi.advanceTimersByTimeAsync(2_999);
    expect(pm.get('p1', 'dev')?.state).toBe('starting');
    await vi.advanceTimersByTimeAsync(1);
    expect(pm.get('p1', 'dev')?.state).toBe('running');
  });

  it('rejects a second start while live with CONFLICT', async () => {
    const { pm } = setup();
    await pm.start(req());
    await expect(pm.start(req())).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('counts live processes', async () => {
    const { pm } = setup();
    await pm.start(req());
    await pm.start(req({ script: 'api' }));
    expect(pm.liveCount()).toBe(2);
    await pm.stop('p1', 'api');
    expect(pm.liveCount()).toBe(1);
  });
});

describe('ProcessManager exits', () => {
  it('reads a user stop as stopped even though taskkill exits 1', async () => {
    const { pm, platform, ledger } = setup();
    await pm.start(req());
    const stopped = await pm.stop('p1', 'dev');
    expect(platform.killTree).toHaveBeenCalledWith(1000);
    expect(stopped).toMatchObject({ state: 'stopped', crashCount: 0, pid: null });
    expect(ledger.remove).toHaveBeenCalledWith(1000);
  });

  it('classifies exit 0 as exited', async () => {
    const { pm, platform } = setup();
    await pm.start(req());
    platform.last().stdout.write('done\n');
    platform.last().exit(0);
    await flushIo();
    expect(pm.get('p1', 'dev')).toMatchObject({ state: 'exited', exit: { code: 0, signal: null, lastLine: 'done' } });
  });

  it('classifies a non-zero exit as crashed with the last stderr line', async () => {
    const { pm, platform, events } = setup();
    await pm.start(req());
    platform.last().stdout.write('ready\n');
    platform.last().stderr.write('Error: boom\n');
    platform.last().stdout.write('bye\n');
    await flushIo();
    platform.last().exit(1);
    await flushIo();
    expect(pm.get('p1', 'dev')).toMatchObject({
      state: 'crashed',
      crashCount: 1,
      exit: { code: 1, signal: null, lastLine: 'Error: boom' },
    });
    expect(events).toContainEqual(expect.objectContaining({ type: 'crashed', final: true }));
  });

  it.each([
    ['npm', ['npm error code 3', 'npm error command failed', 'npm error command C:\\WINDOWS\\system32\\cmd.exe /d /s /c x']],
    ['npm 6', ['npm ERR! code ELIFECYCLE', 'npm ERR! errno 3']],
    ['pnpm', [' ELIFECYCLE  Command failed with exit code 3.']],
    ['yarn', ['error Command failed with exit code 3.', 'info Visit https://yarnpkg.com/en/docs/cli/run for documentation about this command.']],
  ])('skips %s failure noise when picking the last line', async (_pm, noise) => {
    const { pm, platform } = setup();
    await pm.start(req());
    platform.last().stderr.write(`kaboom\n${noise.join('\n')}\n`);
    await flushIo();
    platform.last().exit(3);
    await flushIo();
    expect(pm.get('p1', 'dev')?.exit).toEqual({ code: 3, signal: null, lastLine: 'kaboom' });
  });

  it('keeps the last meaningful line without ANSI codes (vitest separators are skipped)', async () => {
    const { pm, platform } = setup();
    await pm.start(req());
    platform.last().stdout.write('\u001b[31mFAIL\u001b[39m src/a.test.ts > adds\n');
    platform.last().stdout.write('\u001b[31m\u001b[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\u001b[22m\u001b[39m\n');
    await flushIo();
    platform.last().exit(1);
    await flushIo();
    expect(pm.get('p1', 'dev')?.exit?.lastLine).toBe('FAIL src/a.test.ts > adds');
  });

  it('uses the last stdout line when stderr was silent, and reports signals', async () => {
    const { pm, platform, texts } = setup();
    await pm.start(req());
    platform.last().stdout.write('last words\n');
    await flushIo();
    platform.last().exit(null, 'SIGKILL');
    await flushIo();
    expect(pm.get('p1', 'dev')?.exit).toEqual({ code: null, signal: 'SIGKILL', lastLine: 'last words' });
    expect(texts().at(-1)).toBe('■ killed by SIGKILL');
  });

  it('turns a spawn failure into crashed with a could-not-start line', async () => {
    const { pm, platform, texts, ledger } = setup();
    platform.failNextSpawn();
    await pm.start(req());
    await flushIo();
    expect(pm.get('p1', 'dev')).toMatchObject({ state: 'crashed', exit: { code: null } });
    expect(texts()).toContain('■ could not start');
    expect(ledger.add).not.toHaveBeenCalled();
  });

  it('rethrows a spawnScript VALIDATION error and leaves the entry stopped', async () => {
    const { pm, platform, texts } = setup();
    platform.spawnScript.mockImplementationOnce(() => {
      throw new NestboxError('VALIDATION', 'Argument contains a character that cannot be passed safely to cmd.exe');
    });
    await expect(pm.start(req())).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(pm.get('p1', 'dev')?.state).toBe('stopped');
    expect(texts().at(-1)).toMatch(/^■ could not start: Argument contains/);
  });
});

describe('ProcessManager logs', () => {
  it('streams lines with increasing seqs and system markers', async () => {
    const { pm, platform, events } = setup();
    await pm.start(req());
    platform.last().stdout.write('hello\n');
    await flushIo();
    platform.last().exit(0);
    await flushIo();
    const lines = pm.logs('p1', 'dev').lines;
    expect(lines.map((l) => [l.seq, l.stream, l.text])).toEqual([
      [1, 'system', '▸ pnpm run dev'],
      [2, 'stdout', 'hello'],
      [3, 'system', '■ exited with code 0'],
    ]);
    expect(events.filter((e) => e.type === 'line')).toHaveLength(3);
  });

  it('flushes a partial line after 50 ms of silence', async () => {
    const { pm, platform, texts } = setup();
    await pm.start(req());
    platform.last().stdout.write('no newline');
    await flushIo();
    await vi.advanceTimersByTimeAsync(49);
    expect(texts()).not.toContain('no newline');
    await vi.advanceTimersByTimeAsync(1);
    expect(texts()).toContain('no newline');
  });

  it('waits for 50 ms of silence, so a line arriving in pieces stays whole', async () => {
    const { pm, platform, texts } = setup();
    await pm.start(req());
    platform.last().stdout.write('{"level":30,');
    await flushIo();
    await vi.advanceTimersByTimeAsync(30);
    platform.last().stdout.write('"msg":"a"');
    await flushIo();
    await vi.advanceTimersByTimeAsync(30);
    platform.last().stdout.write('}');
    await flushIo();
    await vi.advanceTimersByTimeAsync(49);
    expect(texts()).toEqual(['▸ pnpm run dev']);
    await vi.advanceTimersByTimeAsync(1);
    expect(texts()).toEqual(['▸ pnpm run dev', '{"level":30,"msg":"a"}']);
  });

  it('keeps a multibyte character intact across a timed flush', async () => {
    const { pm, platform, texts } = setup();
    await pm.start(req());
    const bytes = Buffer.from('ok é\n');
    platform.last().stdout.write(bytes.subarray(0, 4)); // ends in the middle of é
    await flushIo();
    await vi.advanceTimersByTimeAsync(50);
    platform.last().stdout.write(bytes.subarray(4));
    await flushIo();
    expect(texts().slice(1)).toEqual(['ok ', 'é']);
    expect(texts().join('')).not.toContain('\uFFFD');
  });

  it('flushes a partial line when the process closes', async () => {
    const { pm, platform, texts } = setup();
    await pm.start(req());
    platform.last().stdout.write('tail');
    platform.last().exit(0);
    await flushIo();
    expect(texts()).toEqual(['▸ pnpm run dev', 'tail', '■ exited with code 0']);
  });

  it('returns only newer lines after a seq and keeps lastSeq across a clear', async () => {
    const { pm, platform } = setup();
    await pm.start(req());
    platform.last().stdout.write('a\nb\n');
    await flushIo();
    expect(pm.logs('p1', 'dev', 2).lines.map((l) => l.text)).toEqual(['b']);
    pm.clearLogs('p1', 'dev');
    expect(pm.logs('p1', 'dev')).toEqual({ lines: [], firstSeq: 4, lastSeq: 3 });
    platform.last().stdout.write('c\n');
    await flushIo();
    expect(pm.logs('p1', 'dev').lines.map((l) => l.seq)).toEqual([4]);
  });

  it('caps the buffer at bufferLines', async () => {
    const { pm, platform } = setup({ bufferLines: 10 });
    await pm.start(req());
    platform.last().stdout.write(Array.from({ length: 30 }, (_, i) => `l${i}\n`).join(''));
    await flushIo();
    const lines = pm.logs('p1', 'dev').lines;
    expect(lines).toHaveLength(10);
    expect(lines.at(-1)?.text).toBe('l29');
  });

  it('returns an empty snapshot for an unknown script', () => {
    expect(setup().pm.logs('p1', 'nope')).toEqual({ lines: [], firstSeq: 1, lastSeq: 0 });
  });

  it('never passes env values or output to the logger', async () => {
    const { pm, platform, logger } = setup();
    platform.killTree.mockRejectedValueOnce(new NestboxError('INTERNAL', 'Could not stop the process tree'));
    await pm.start(req());
    platform.last().stdout.write('secret output\n');
    await flushIo();
    const stopping = pm.stop('p1', 'dev');
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    const logged = JSON.stringify(logger.entries);
    expect(logged).not.toContain('do-not-log');
    expect(logged).not.toContain('secret output');
    expect(logged).not.toContain('C:\\\\shop');
    expect(logger.entries).toContainEqual({ level: 'warn', message: 'killTree failed', fields: { pid: 1000, code: 'INTERNAL' } });
  });
});

describe('ProcessManager auto-restart', () => {
  it('backs off 1, 2, 4, 8 s and gives up on the 5th crash', async () => {
    const { pm, platform, events } = setup();
    await pm.start(req({ autoRestart: true }));
    const delays = [1_000, 2_000, 4_000, 8_000];
    for (const [i, delay] of delays.entries()) {
      platform.last().exit(1);
      await flushIo();
      expect(pm.get('p1', 'dev')?.nextRestartAt).not.toBeNull();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(platform.spawnScript).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      await flushIo();
      expect(platform.spawnScript).toHaveBeenCalledTimes(i + 2);
    }
    platform.last().exit(1);
    await flushIo();
    expect(pm.get('p1', 'dev')).toMatchObject({ state: 'crashed', crashCount: 5, gaveUp: true, nextRestartAt: null });
    expect(pm.logs('p1', 'dev').lines.at(-1)?.text).toBe('■ gave up after 5 crashes');
    const finals = events.flatMap((e) => (e.type === 'crashed' ? [e.final] : []));
    expect(finals).toEqual([false, false, false, false, true]);
  });

  it('caps the backoff at 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(backoffMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it('resets the crash count after 60 s of healthy running', async () => {
    const { pm, platform } = setup();
    await pm.start(req({ autoRestart: true }));
    platform.last().exit(1);
    await flushIo();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushIo();
    expect(pm.get('p1', 'dev')?.crashCount).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pm.get('p1', 'dev')).toMatchObject({ state: 'running', crashCount: 0 });
  });

  it('cancels a pending restart on stop and clears crashed to stopped', async () => {
    const { pm, platform } = setup();
    await pm.start(req({ autoRestart: true }));
    platform.last().exit(1);
    await flushIo();
    expect((await pm.stop('p1', 'dev')).state).toBe('stopped');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(platform.spawnScript).toHaveBeenCalledTimes(1);
  });

  it('turning auto-restart off cancels a pending restart', async () => {
    const { pm, platform } = setup();
    await pm.start(req({ autoRestart: true }));
    platform.last().exit(1);
    await flushIo();
    pm.setAutoRestart('p1', 'dev', false);
    expect(pm.get('p1', 'dev')).toMatchObject({ autoRestart: false, nextRestartAt: null, state: 'crashed' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(platform.spawnScript).toHaveBeenCalledTimes(1);
  });

  it('a user start resets the crash count', async () => {
    const { pm, platform } = setup();
    await pm.start(req());
    platform.last().exit(1);
    await flushIo();
    expect((await pm.start(req())).crashCount).toBe(0);
  });
});

describe('ProcessManager stopping', () => {
  it('clears a crashed script to stopped without killing anything', async () => {
    const { pm, platform } = setup();
    await pm.start(req());
    platform.last().exit(1);
    await flushIo();
    expect((await pm.stop('p1', 'dev')).state).toBe('stopped');
    expect(platform.killTree).not.toHaveBeenCalled();
  });

  it('marks stopped after 5 s if the tree does not exit, keeping the ledger entry', async () => {
    const { pm, platform, ledger } = setup();
    platform.killTree.mockResolvedValue(undefined); // the child never exits
    await pm.start(req());
    const stopping = pm.stop('p1', 'dev');
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await stopping).state).toBe('stopped');
    expect(ledger.remove).not.toHaveBeenCalled();
    expect(pm.logs('p1', 'dev').lines.at(-1)?.text).toBe('■ did not exit within 5 s');
    // A late close from that run changes nothing.
    platform.last().exit(1);
    await flushIo();
    expect(pm.get('p1', 'dev')?.state).toBe('stopped');
  });

  it('a failing environment lookup leaves the entry stopped, not starting', async () => {
    const { pm, platform, texts } = setup();
    platform.resolveShellEnv.mockRejectedValueOnce(new NestboxError('NOT_IMPLEMENTED', 'resolveShellEnv is not implemented on this platform yet'));
    await expect(pm.start(req())).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    expect(pm.get('p1', 'dev')?.state).toBe('stopped');
    expect(pm.liveCount()).toBe(0);
    expect(texts().at(-1)).toBe('■ could not start: resolveShellEnv is not implemented on this platform yet');
    expect(platform.spawnScript).not.toHaveBeenCalled();
  });

  it('stop during the environment lookup prevents the spawn', async () => {
    const { pm, platform } = setup();
    let release!: (env: NodeJS.ProcessEnv) => void;
    platform.resolveShellEnv.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const starting = pm.start(req());
    await Promise.resolve();
    expect((await pm.stop('p1', 'dev')).state).toBe('stopped');
    release({});
    await starting;
    expect(platform.spawnScript).not.toHaveBeenCalled();
    expect(pm.get('p1', 'dev')?.state).toBe('stopped');
  });

  it('ignores close events from a previous run after a restart', async () => {
    const { pm, platform } = setup();
    platform.killTree.mockResolvedValueOnce(undefined);
    await pm.start(req());
    const first = platform.last();
    const restarting = pm.restart(req());
    await vi.advanceTimersByTimeAsync(5_000);
    await restarting;
    first.exit(1);
    await flushIo();
    expect(pm.get('p1', 'dev')).toMatchObject({ state: 'starting', pid: 1001, crashCount: 0 });
  });

  it('restartExisting reuses the last request', async () => {
    const { pm, platform } = setup();
    await pm.start(req({ cwd: 'C:\\other' }));
    await pm.restartExisting('p1', 'dev');
    expect(platform.spawnScript).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: 'C:\\other' }));
    await expect(pm.restartExisting('p1', 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('stopAll stops matching projects only, and forget drops them', async () => {
    const { pm } = setup();
    await pm.start(req());
    await pm.start(req({ projectId: 'p1::packages/api' }));
    await pm.start(req({ projectId: 'p2' }));
    await pm.stopAll((id) => belongsTo(id, 'p1'));
    expect(pm.list().map((p) => [p.projectId, p.state])).toEqual([
      ['p1', 'stopped'],
      ['p1::packages/api', 'stopped'],
      ['p2', 'starting'],
    ]);
    pm.forget((id) => belongsTo(id, 'p1'));
    expect(pm.list().map((p) => p.projectId)).toEqual(['p2']);
  });

  it('stop of an unknown script is NOT_FOUND', async () => {
    await expect(setup().pm.stop('p1', 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Unknown process' });
  });
});
