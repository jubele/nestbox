import type { z } from 'zod';
import type { PlatformAdapter } from '../platform/adapter';

export type EcosystemId = 'python' | 'dotnet' | 'node';

export interface DetectedTask {
  /** Unique identifier within the package (e.g. 'run', 'test', 'uvicorn'). */
  name: string;
  /** Command line as argv (no shell). */
  argv: string[];
  /** Human-readable title shown in the UI. */
  title: string;
}

export interface RunEnv {
  /** Directory to prepend to PATH. */
  pathPrepend?: string;
  /** Environment variables to set. */
  env?: Record<string, string>;
  /** Optional note shown in the log (e.g. "Using .venv"). */
  note?: string;
  /** Programs to substitute as the command's first word (e.g. `python` → `python3` without a virtualenv). */
  programs?: Record<string, string>;
}

export interface RunEnvContext<Settings = unknown> {
  /** The package's folder. */
  dir: string;
  /** The project folder (the root package's; the same as `dir` for a root). */
  rootDir: string;
  platform: PlatformAdapter;
  /** The package's choices from the Scripts tool's settings (see `EcosystemChoices`). */
  settings: Settings;
}

/** What the Scripts tool knows about a package's environment choice, passed to every module's runEnv. */
export interface EcosystemChoices {
  /**
   * The virtualenv the user picked: a path (absolute, or posix from the project folder), null for none,
   * undefined for the module's own default.
   */
  venv?: string | null;
}

export interface EcosystemModule<Info, Settings = unknown> {
  id: EcosystemId;

  /** Zod schema for validating detected info. */
  infoSchema: z.ZodSchema<Info>;

  /** Pure filesystem detection of one folder. No Electron, no subprocess. */
  detect(dir: string, files: ReadonlySet<string>, dirs: ReadonlySet<string>): Promise<Info | null>;

  /** Globs that make a sub-folder a package (multi-folder projects). */
  packageGlobs: string[];

  /** Commands the ecosystem offers without the user typing them. */
  tasks(info: Info): DetectedTask[];

  /** How a command of this package runs: PATH entry, env, note. */
  runEnv(ctx: RunEnvContext<Settings>, info: Info): Promise<RunEnv>;

  /** Optional: one-line summary for project-info (e.g. "Python 3.12 · uv · .venv"). */
  summary?(info: Info): string | null;

  /**
   * Optional: files the Add command dialog offers to run (e.g. a package's `.py` files), with the argv each
   * one becomes. May read the folder (like runEnv); paths are posix from the package.
   */
  files?(dir: string, info: Info): Promise<{ path: string; argv: string[] }[]>;

  // Optional providers for later phases:
  // version?(ctx: RunEnvContext<Settings>, info: Info): Promise<string | null>;
  // deps?(ctx: RunEnvContext<Settings>, info: Info): Promise<DepsResult>;
}

export interface EcosystemEntry {
  id: EcosystemId;
  info: unknown;
}
