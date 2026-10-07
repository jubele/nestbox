import type { ChildProcess } from 'node:child_process';
import { NestboxError } from '@shared/errors';
import type { PlatformId } from '@shared/types';
import type { Logger } from '../logger';

/** A listening TCP port and the process that owns it (one entry per port and PID, all addresses merged). */
export interface PortEntry {
  port: number;
  pid: number;
  /** '0.0.0.0', '::', '127.0.0.1', '::1', … */
  addresses: string[];
  /** Image name ('node.exe'); null when it could not be read. */
  processName: string | null;
}

export interface ProcessInfo {
  pid: number;
  parentPid: number;
  /** When the process started, in epoch ms. */
  startTime: number;
  /** POSIX process group (macOS); absent on Windows. */
  groupId?: number;
}

export interface SpawnOpts {
  cwd: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface OverlayColors {
  color: string;
  symbolColor: string;
  height: number;
}

export interface WindowChrome {
  titleBarStyle: 'hidden' | 'hiddenInset';
  titleBarOverlay?: OverlayColors;
}

export interface ExecResult {
  /** null when the process was killed by the timeout or a signal. */
  code: number | null;
  /** Capped at 64 KiB unless the call asks for more (maxBytes). */
  stdout: string;
}

export interface PipedSpawnOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
  verbatim?: boolean;
  /** Written to the child's stdin, which is then closed. Without it stdin is ignored. */
  stdin?: string;
  /** POSIX: make the child the leader of a new process group, so its whole tree can be signalled. */
  newProcessGroup?: boolean;
}

export interface CommandRunner {
  /** Starts a detached process and resolves once it has spawned. Rejects (e.g. ENOENT) if it cannot start. */
  launch(file: string, args: readonly string[], opts?: { cwd?: string; verbatim?: boolean; hidden?: boolean }): Promise<void>;
  /** Runs to completion with a hidden window and no shell. Rejects only if it cannot start. */
  exec(
    file: string,
    args: readonly string[],
    opts?: {
      timeoutMs?: number;
      maxBytes?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      verbatim?: boolean;
      /** Resolve as soon as stdout satisfies this (code: the exit code if known yet, else null). */
      doneWhen?: (stdout: string) => boolean;
    },
  ): Promise<ExecResult>;
  /** A long-running child with piped stdout/stderr, ignored stdin (unless opts.stdin) and a hidden window. */
  spawn(file: string, args: readonly string[], opts: PipedSpawnOpts): ChildProcess;
}

export interface PlatformDeps {
  runner: CommandRunner;
  getEditorCommand(): string;
  /** The terminal setting (TERMINAL_APPS); 'auto' when absent. */
  getTerminalApp?(): string;
  /** For failures without values (the macOS shell env). Silent when absent. */
  logger?: Logger;
  /** Windows: finds a command on PATH, never in the current folder (tests inject one). */
  resolveCommand?(command: string, env: NodeJS.ProcessEnv): string | null;
  /** Development only (NESTBOX_PATH_PREPEND, unpackaged): folders put first on the login shell's PATH, for e2e fakes. */
  pathPrepend?: string;
}

export interface PlatformAdapter {
  readonly id: PlatformId;
  /** Every listening TCP port (IPv4 and IPv6), sorted by port then PID. Throws INTERNAL when it cannot be read. */
  listListeningPorts(): Promise<PortEntry[]>;
  /**
   * Command lines of up to 64 PIDs (null when unknown or unreadable). Shown in the UI only: command lines
   * can contain secrets, so they are never logged or stored.
   */
  describeProcesses(pids: readonly number[]): Promise<Map<number, string | null>>;
  killTree(pid: number): Promise<void>;
  /**
   * Every running process with its parent and start time (the start time tells a reused PID apart); null
   * when the list cannot be read. Used by the orphan check at startup.
   */
  listProcesses(): Promise<ProcessInfo[] | null>;
  spawnScript(opts: SpawnOpts): ChildProcess;
  /**
   * Runs a NestBox-built command line (e.g. `claude -p`) like spawnScript. Free text goes through stdin,
   * never the command line: it can hold quotes and newlines that cmd.exe can't take safely.
   */
  spawnCommand(opts: SpawnOpts & { stdin?: string }): ChildProcess;
  /** Runs a NestBox-built command line to completion (e.g. `claude --version`, `git check-ignore`). */
  execCommand(
    command: string,
    args: readonly string[],
    opts: {
      cwd?: string;
      timeoutMs: number;
      /** stdout cap; 64 KiB by default. */
      maxBytes?: number;
      /** Extra variables on top of the environment scripts get. */
      env?: Record<string, string>;
    },
  ): Promise<ExecResult>;
  /** Opens a terminal in cwd, optionally running command (NestBox-built only: no quotes, newlines or %). */
  openTerminal(cwd: string, command?: string): Promise<void>;
  openInEditor(path: string, line?: number): Promise<void>;
  resolveShellEnv(): Promise<NodeJS.ProcessEnv>;
  /** Comparison key only — never store, display or pass to a command. */
  normalizePath(p: string): string;
  samePath(a: string, b: string): boolean;
  windowChrome(colors: OverlayColors): WindowChrome;
  /** The AppUserModelID Windows needs for toast notifications (matches electron-builder's appId); null elsewhere. */
  notificationAppId(): string | null;
  /** Whether a command (name on PATH, or a path) exists; null when it cannot be checked. */
  commandExists(command: string): Promise<boolean | null>;
  /** The Python interpreter when a package has no virtualenv: python on Windows, python3 on macOS. */
  readonly pythonCommand: string;
  /** A virtualenv's folder of executables (`Scripts` on Windows, `bin` elsewhere). */
  venvBinDir(venvPath: string): string;
}

export function notImplemented(method: string): never {
  throw new NestboxError('NOT_IMPLEMENTED', `${method} is not implemented on this platform yet`);
}
