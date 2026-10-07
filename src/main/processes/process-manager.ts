import type { ChildProcess } from 'node:child_process';
import { delimiter } from 'node:path';
import type { PackageManager } from '@shared/detected';
import { stripAnsi } from '@shared/ansi-strip';
import { formatCommandLine } from '@shared/command-line';
import { NestboxError } from '@shared/errors';
import {
  isLive,
  type LogLine,
  type LogSnapshot,
  type ProcessState,
  type ProcessSummary,
} from '@shared/processes';
import type { Logger } from '../logger';
import type { PlatformAdapter } from '../platform/adapter';
import { LineSplitter } from './line-splitter';
import type { PidLedger } from './pid-ledger';
import { RingBuffer } from './ring-buffer';

/** A script counts as running once it has stayed up this long. */
export const STARTING_MS = 3_000;
/** Running this long without crashing resets the crash counter. */
export const HEALTHY_MS = 60_000;
/** How long a stop waits for the tree to exit before giving up on it. */
export const STOP_TIMEOUT_MS = 5_000;
/** A partial line is emitted after this much silence. */
export const PARTIAL_FLUSH_MS = 50;
/** Auto-restart gives up on this many consecutive crashes. */
export const MAX_CRASHES = 5;

/** Delay before auto-restart number `crashCount`: 1, 2, 4, 8, 16 s, capped at 30 s. */
export function backoffMs(crashCount: number): number {
  return Math.min(1_000 * 2 ** (crashCount - 1), 30_000);
}

export interface StartRequest {
  projectId: string;
  script: string;
  cwd: string;
  packageManager: PackageManager | null;
  autoRestart: boolean;
  /** A Node or package manager mismatch: logged first and shown on the script row. */
  warning?: string | null;
  /** An extra first log line (e.g. which Node fnm provides). */
  note?: string | null;
  /** A folder put first on the script's PATH (fnm's Node, a virtualenv's bin). */
  pathPrepend?: string | null;
  /** A program and its arguments to run instead of `<pm> run <script>` (Python and custom commands). */
  argv?: string[];
  /** Extra variables (VIRTUAL_ENV, PYTHONUNBUFFERED). Paths and flags only, never values from .env. */
  env?: Record<string, string>;
  /**
   * An env file whose variables the script gets, read at every spawn so edits apply on the next (re)start.
   * read() resolves null when the file is missing. The values go only to the child: never logged or kept.
   */
  loadEnv?: { file: string; read(): Promise<Record<string, string> | null> };
}

/** The env with `dir` first on PATH, under whatever casing the env uses for it (Windows: Path). */
function withPathFirst(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key];
  return { ...env, [key]: current ? `${dir}${delimiter}${current}` : dir };
}

export type ProcessEvent =
  | { type: 'changed' }
  | { type: 'line'; projectId: string; script: string; line: LogLine }
  | { type: 'crashed'; summary: ProcessSummary; final: boolean };

export interface ProcessManagerDeps {
  platform: Pick<PlatformAdapter, 'spawnScript' | 'killTree' | 'resolveShellEnv'>;
  ledger: Pick<PidLedger, 'add' | 'remove'>;
  /** Buffer capacity for a script's log, read when its buffer is created. */
  bufferLines(): number;
  logger: Logger;
  now?: () => number;
}

type Stream = 'stdout' | 'stderr';
type TimerName = 'promote' | 'healthy' | 'restart' | 'flush';

interface Entry {
  req: StartRequest;
  state: ProcessState;
  child: ChildProcess | null;
  pid: number | null;
  startedAt: number | null;
  exit: ProcessSummary['exit'];
  crashCount: number;
  gaveUp: boolean;
  nextRestartAt: number | null;
  buffer: RingBuffer<LogLine>;
  seq: number;
  /** Bumped on every spawn and on a stop that pre-empts one; events from older runs are ignored. */
  run: number;
  /** The run whose close has been handled (close and error can both arrive). */
  handledRun: number;
  stopRequested: boolean;
  closed: Promise<void> | null;
  lastLine: string | null;
  lastStderr: string | null;
  splitters: Record<Stream, LineSplitter>;
  timers: Partial<Record<TimerName, ReturnType<typeof setTimeout>>>;
}

const keyOf = (projectId: string, script: string): string => JSON.stringify([projectId, script]);

/** What npm, pnpm and yarn print after a failing script. Never the useful "last line" of a crash. */
const PACKAGE_MANAGER_NOISE = /^(?:npm (?:error|ERR!)|\s*ELIFECYCLE\b|error Command failed with exit code|info Visit https:\/\/yarnpkg)/;

/**
 * Owns every script process Nestbox starts: spawning through the platform adapter, the state machine,
 * crash classification, auto-restart, per-script log buffers and the PID ledger. It never logs env
 * values, working directories or output.
 */
export class ProcessManager {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: ProcessEvent) => void>();
  private readonly now: () => number;

  constructor(private readonly deps: ProcessManagerDeps) {
    this.now = deps.now ?? Date.now;
  }

  on(listener: (event: ProcessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): ProcessSummary[] {
    return [...this.entries.values()].map((e) => this.summarize(e));
  }

  get(projectId: string, script: string): ProcessSummary | null {
    const entry = this.entries.get(keyOf(projectId, script));
    return entry ? this.summarize(entry) : null;
  }

  liveCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (isLive(e.state)) n++;
    return n;
  }

  /** Throws CONFLICT if the script is live. Resolves once the PID is in the ledger, or the spawn failed. */
  async start(req: StartRequest): Promise<ProcessSummary> {
    const entry = this.entryFor(req);
    if (isLive(entry.state)) throw new NestboxError('CONFLICT', 'The script is already running');
    this.cancelRestart(entry);
    entry.req = req;
    entry.crashCount = 0;
    entry.gaveUp = false;
    await this.spawn(entry);
    return this.summarize(entry);
  }

  async restart(req: StartRequest): Promise<ProcessSummary> {
    const existing = this.entries.get(keyOf(req.projectId, req.script));
    if (existing && isLive(existing.state)) await this.stop(req.projectId, req.script);
    return this.start(req);
  }

  /** Restarts with the request the script was last started with (tray). */
  async restartExisting(projectId: string, script: string): Promise<ProcessSummary> {
    return this.restart(this.require(projectId, script).req);
  }

  async stop(projectId: string, script: string): Promise<ProcessSummary> {
    const entry = this.require(projectId, script);
    this.cancelRestart(entry);
    if (!isLive(entry.state)) {
      if (entry.state === 'crashed' || entry.state === 'exited') {
        entry.state = 'stopped';
        this.changed();
      }
      return this.summarize(entry);
    }
    if (entry.state === 'stopping') {
      await this.waitClosed(entry);
      return this.summarize(entry);
    }
    if (entry.child === null) {
      // Still resolving the environment: invalidate the pending spawn.
      entry.run++;
      entry.state = 'stopped';
      this.system(entry, '■ stopped');
      this.changed();
      return this.summarize(entry);
    }
    const run = entry.run;
    entry.stopRequested = true;
    entry.state = 'stopping';
    this.changed();
    if (entry.pid !== null) {
      try {
        await this.deps.platform.killTree(entry.pid);
      } catch (error) {
        this.deps.logger.warn('killTree failed', {
          pid: entry.pid,
          code: error instanceof NestboxError ? error.code : 'unknown',
        });
      }
    } else {
      entry.child.kill();
    }
    const exited = await this.waitClosed(entry);
    if (!exited && run === entry.run && entry.state === 'stopping') {
      // Keep the ledger entry: the next start offers to clean the tree up.
      entry.handledRun = run;
      this.clearTimers(entry);
      entry.child = null;
      entry.pid = null;
      entry.state = 'stopped';
      this.system(entry, '■ did not exit within 5 s');
      this.changed();
    }
    return this.summarize(entry);
  }

  setAutoRestart(projectId: string, script: string, enabled: boolean): void {
    const entry = this.entries.get(keyOf(projectId, script));
    if (!entry) return;
    entry.req = { ...entry.req, autoRestart: enabled };
    if (!enabled && entry.timers.restart !== undefined) {
      this.cancelRestart(entry);
      this.changed();
    }
  }

  logs(projectId: string, script: string, afterSeq?: number): LogSnapshot {
    const entry = this.entries.get(keyOf(projectId, script));
    if (!entry) return { lines: [], firstSeq: 1, lastSeq: 0 };
    const lines = afterSeq === undefined ? entry.buffer.toArray() : entry.buffer.after(afterSeq);
    return { lines, firstSeq: lines[0]?.seq ?? entry.seq + 1, lastSeq: entry.seq };
  }

  clearLogs(projectId: string, script: string): void {
    this.entries.get(keyOf(projectId, script))?.buffer.clear();
  }

  /** Stops every live or restart-pending process whose project matches, in parallel. */
  async stopAll(filter: (projectId: string) => boolean = () => true): Promise<void> {
    const targets = [...this.entries.values()].filter(
      (e) => filter(e.req.projectId) && (isLive(e.state) || e.timers.restart !== undefined),
    );
    await Promise.allSettled(targets.map((e) => this.stop(e.req.projectId, e.req.script)));
  }

  /** Drops entries and their logs (after stopAll), e.g. when a project is removed. */
  forget(filter: (projectId: string) => boolean): void {
    let removed = false;
    for (const [key, entry] of this.entries) {
      if (!filter(entry.req.projectId)) continue;
      this.clearTimers(entry);
      this.entries.delete(key);
      removed = true;
    }
    if (removed) this.changed();
  }

  private require(projectId: string, script: string): Entry {
    const entry = this.entries.get(keyOf(projectId, script));
    if (!entry) throw new NestboxError('NOT_FOUND', 'Unknown process');
    return entry;
  }

  private entryFor(req: StartRequest): Entry {
    const key = keyOf(req.projectId, req.script);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        req,
        state: 'stopped',
        child: null,
        pid: null,
        startedAt: null,
        exit: null,
        crashCount: 0,
        gaveUp: false,
        nextRestartAt: null,
        buffer: new RingBuffer<LogLine>(Math.max(1, this.deps.bufferLines())),
        seq: 0,
        run: 0,
        handledRun: 0,
        stopRequested: false,
        closed: null,
        lastLine: null,
        lastStderr: null,
        splitters: { stdout: new LineSplitter(), stderr: new LineSplitter() },
        timers: {},
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** The request's env file, or nothing when it has none, is missing or can't be read (the log says which). */
  private async readEnvFile(entry: Entry): Promise<Record<string, string>> {
    const load = entry.req.loadEnv;
    if (!load) return {};
    const vars = await load.read().catch(() => undefined);
    if (vars === undefined) {
      this.system(entry, `▲ ${load.file} could not be read: started without it`);
      return {};
    }
    if (vars === null) {
      this.system(entry, `▸ ${load.file} not found: started without it`);
      return {};
    }
    const n = Object.keys(vars).length;
    this.system(entry, `▸ env: ${load.file} (${n} ${n === 1 ? 'variable' : 'variables'})`);
    return vars;
  }

  private async spawn(entry: Entry): Promise<void> {
    const run = ++entry.run;
    entry.stopRequested = false;
    entry.exit = null;
    entry.pid = null;
    entry.child = null;
    entry.nextRestartAt = null;
    entry.lastLine = null;
    entry.lastStderr = null;
    entry.state = 'starting';
    entry.startedAt = this.now();
    const [command = 'npm', ...args] = entry.req.argv ?? [entry.req.packageManager ?? 'npm', 'run', entry.req.script];
    if (entry.req.note) this.system(entry, entry.req.note);
    if (entry.req.warning) this.system(entry, `▲ ${entry.req.warning}`);
    this.system(entry, `▸ ${formatCommandLine([command, ...args])}`);
    this.changed();

    let child: ChildProcess;
    try {
      const shell = await this.deps.platform.resolveShellEnv();
      const fromFile = await this.readEnvFile(entry);
      if (run !== entry.run) return; // a stop pre-empted the spawn
      // The file's variables over the shell's; the virtualenv and NestBox's own variables over both.
      const base = { ...shell, ...fromFile };
      const env = {
        ...(entry.req.pathPrepend ? withPathFirst(base, entry.req.pathPrepend) : base),
        ...entry.req.env,
        FORCE_COLOR: '1',
      };
      if (run !== entry.run) return; // a stop pre-empted the spawn
      child = this.deps.platform.spawnScript({ cwd: entry.req.cwd, command, args, env });
    } catch (error) {
      if (run !== entry.run) return;
      entry.state = 'stopped';
      this.system(entry, `■ could not start: ${error instanceof NestboxError ? error.message : 'unexpected error'}`);
      this.changed();
      throw error;
    }
    entry.child = child;
    entry.splitters = { stdout: new LineSplitter(), stderr: new LineSplitter() };
    let closed = false;
    let resolveClosed!: () => void;
    entry.closed = new Promise<void>((resolve) => (resolveClosed = resolve));
    const onClose = (code: number | null, signal: NodeJS.Signals | null, failedToStart: boolean): void => {
      closed = true;
      this.onClose(entry, run, code, signal, failedToStart);
      resolveClosed();
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      if (run === entry.run) this.onData(entry, 'stdout', chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (run === entry.run) this.onData(entry, 'stderr', chunk);
    });
    child.once('error', () => {
      if (child.pid === undefined) onClose(null, null, true);
    });
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => onClose(code, signal, false));

    await new Promise<void>((resolve) => {
      child.once('spawn', () => resolve());
      child.once('error', () => resolve());
    });
    const pid = child.pid;
    if (run !== entry.run || pid === undefined || closed) return;
    entry.pid = pid;
    this.setTimer(entry, 'promote', STARTING_MS, () => {
      if (run === entry.run && entry.state === 'starting') {
        entry.state = 'running';
        this.changed();
      }
    });
    this.setTimer(entry, 'healthy', HEALTHY_MS, () => {
      if (run === entry.run && entry.state === 'running' && entry.crashCount > 0) {
        entry.crashCount = 0;
        this.changed();
      }
    });
    // The spawn time stands in for the OS creation time (they differ by milliseconds). Asking the OS
    // (PowerShell on Windows) can take over 10 s on a cold machine, so it is left to the orphan check.
    this.deps.ledger.add({ pid, startTime: this.now(), projectId: entry.req.projectId, script: entry.req.script });
    this.changed();
  }

  private onData(entry: Entry, stream: Stream, chunk: Buffer): void {
    for (const text of entry.splitters[stream].push(chunk)) this.append(entry, stream, text);
    // A partial line is emitted after PARTIAL_FLUSH_MS of silence: every chunk restarts the wait.
    if (entry.splitters.stdout.hasPending || entry.splitters.stderr.hasPending) {
      this.setTimer(entry, 'flush', PARTIAL_FLUSH_MS, () => this.flushPartial(entry, false));
    } else {
      this.clearTimers(entry, ['flush']);
    }
  }

  private flushPartial(entry: Entry, final: boolean): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      for (const text of entry.splitters[stream].flush(final)) this.append(entry, stream, text);
    }
  }

  private onClose(
    entry: Entry,
    run: number,
    code: number | null,
    signal: NodeJS.Signals | null,
    failedToStart: boolean,
  ): void {
    if (run !== entry.run || entry.handledRun === run) return;
    entry.handledRun = run;
    this.flushPartial(entry, true);
    this.clearTimers(entry, ['promote', 'healthy', 'flush']);
    if (entry.pid !== null) this.deps.ledger.remove(entry.pid);
    entry.child = null;
    entry.pid = null;

    if (entry.stopRequested) {
      entry.state = 'stopped';
      this.system(entry, '■ stopped');
    } else if (code === 0) {
      entry.state = 'exited';
      entry.exit = { code: 0, signal: null, lastLine: entry.lastLine };
      this.system(entry, '■ exited with code 0');
    } else {
      entry.state = 'crashed';
      entry.crashCount++;
      entry.exit = { code: failedToStart ? null : code, signal, lastLine: entry.lastStderr ?? entry.lastLine };
      this.system(
        entry,
        failedToStart
          ? '■ could not start'
          : code === null
            ? `■ killed by ${signal ?? 'a signal'}`
            : `■ exited with code ${code}`,
      );
      const willRestart = entry.req.autoRestart && entry.crashCount < MAX_CRASHES;
      if (willRestart) {
        const delay = backoffMs(entry.crashCount);
        entry.nextRestartAt = this.now() + delay;
        this.system(entry, `↻ restarting in ${delay / 1000} s`);
        this.setTimer(entry, 'restart', delay, () => {
          entry.timers.restart = undefined;
          entry.nextRestartAt = null;
          this.spawn(entry).catch(() => this.deps.logger.error('auto-restart failed', { script: entry.req.script }));
        });
      } else if (entry.req.autoRestart) {
        entry.gaveUp = true;
        this.system(entry, `■ gave up after ${MAX_CRASHES} crashes`);
      }
      this.emit({ type: 'crashed', summary: this.summarize(entry), final: !willRestart });
    }
    this.changed();
  }

  /** Resolves true if the child closed within STOP_TIMEOUT_MS. */
  private async waitClosed(entry: Entry): Promise<boolean> {
    const closed = entry.closed;
    if (!closed) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
    });
    const result = await Promise.race([closed.then(() => true), timeout]);
    clearTimeout(timer);
    return result;
  }

  private append(entry: Entry, stream: LogLine['stream'], text: string): void {
    const line: LogLine = { seq: ++entry.seq, ts: this.now(), stream, text };
    entry.buffer.push(line);
    if (stream !== 'system') {
      // The crash row shows this as plain text: no ANSI codes, and only lines with words or numbers in them
      // (not test-runner separators like "⎯⎯⎯⎯" or package-manager noise).
      const plain = stripAnsi(text).trim();
      if (/[\p{L}\p{N}]/u.test(plain) && !PACKAGE_MANAGER_NOISE.test(plain)) {
        entry.lastLine = plain;
        if (stream === 'stderr') entry.lastStderr = plain;
      }
    }
    this.emit({ type: 'line', projectId: entry.req.projectId, script: entry.req.script, line });
  }

  private system(entry: Entry, text: string): void {
    this.append(entry, 'system', text);
  }

  private cancelRestart(entry: Entry): void {
    this.clearTimers(entry, ['restart']);
    entry.nextRestartAt = null;
  }

  private setTimer(entry: Entry, name: TimerName, ms: number, fn: () => void): void {
    clearTimeout(entry.timers[name]);
    entry.timers[name] = setTimeout(() => {
      entry.timers[name] = undefined;
      fn();
    }, ms);
  }

  private clearTimers(entry: Entry, names: TimerName[] = ['promote', 'healthy', 'restart', 'flush']): void {
    for (const name of names) {
      clearTimeout(entry.timers[name]);
      entry.timers[name] = undefined;
    }
  }

  private summarize(entry: Entry): ProcessSummary {
    return {
      projectId: entry.req.projectId,
      script: entry.req.script,
      state: entry.state,
      pid: entry.pid,
      startedAt: entry.startedAt,
      exit: entry.exit,
      crashCount: entry.crashCount,
      autoRestart: entry.req.autoRestart,
      nextRestartAt: entry.nextRestartAt,
      gaveUp: entry.gaveUp,
      warning: entry.req.warning ?? null,
    };
  }

  private changed(): void {
    this.emit({ type: 'changed' });
  }

  private emit(event: ProcessEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        this.deps.logger.error('process listener threw', { event: event.type });
      }
    }
  }
}
