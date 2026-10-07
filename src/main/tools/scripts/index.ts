import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCommandLine } from '@shared/command-line';
import { type DetectedProject, type EcosystemId, workspaceId } from '@shared/detected';
import { NestboxError } from '@shared/errors';
import { isLive, type LogLine, type ProcessState, type ProcessSummary } from '@shared/processes';
import {
  type ComposeStep,
  type CustomCommand,
  type ScriptKind,
  scriptsContract,
  scriptsDefinition,
  type ScriptsSettings,
  type SkippedEntry,
} from '@shared/tools/scripts/contract';
import type { RunGroup, RunGroupCompose, RunGroupEntry } from '@shared/types';
import { ECOSYSTEM_MODULES, type EcosystemChoices } from '../../ecosystems';
import { type PythonInfo, resolveVenv } from '../../ecosystems/python';
import { findProjectVenvs } from '../../ecosystems/python/venvs';
import type { Logger } from '../../logger';
import type { ProcessManager, StartRequest } from '../../processes/process-manager';
import type { SharedContext } from '../shared-context';
import { type AnyMainTool, defineMainTool, type ToolContext } from '../types';
import { exportFileName, formatExport } from './export';
import { createLogBatcher } from './log-batcher';
import type { PlatformAdapter } from '../../platform/adapter';

export interface ScriptsToolDeps {
  processes: ProcessManager;
  runGroups: {
    get(rootId: string): RunGroup[];
    set(rootId: string, groups: RunGroup[]): RunGroup[];
  };
  /** Throws NOT_FOUND for unknown ids (used to resolve run-group entries in other packages). */
  getDetected(projectId: string): DetectedProject;
  shared: SharedContext;
  platform: PlatformAdapter;
  saveFile(defaultName: string): Promise<string | null>;
  writeFile(path: string, text: string): Promise<void>;
  isFile(path: string): Promise<boolean>;
  emit(projectId: string, event: 'logs', payload: { script: string; lines: LogLine[] }): void;
  logger: Logger;
  /** The Node tool's advice for a start (version warning, fnm's PATH); asked before every start. */
  node: {
    advice(projectId: string): Promise<{ warning: string | null; pathPrepend: string | null; note: string | null }>;
  };
  /** The Compose tool's actions for a package (services empty = the whole stack). */
  compose: {
    up(projectId: string, services: string[], opts: { wait: boolean }): Promise<{ ok: boolean }>;
    stop(projectId: string, services: string[]): Promise<{ ok: boolean }>;
  };
  /** A package's env files (the env tool's file access): names, and one file's variables (null when missing). */
  envFiles: {
    list(dir: string): Promise<string[]>;
    read(dir: string, file: string): Promise<Record<string, string> | null>;
  };
}

/** The shared-context fact the scripts tool publishes per project (read by the M2 port manager). */
export const PROCESSES_FACT = 'scripts.processes';

const ADVICE_TIMEOUT_MS = 3_000;
/** At most this many custom commands per root project (the settings schema's cap). */
const MAX_COMMANDS = 100;

type Ctx = ToolContext<ScriptsSettings>;

/** Something a package can run: a package.json script, or a custom command line. */
interface Runnable {
  name: string;
  kind: ScriptKind;
  /** The script's text, or the command line for display. */
  command: string;
  /** null for a package.json script (`<pm> run <name>`). */
  argv: string[] | null;
  /** The module a detected task comes from. */
  ecosystem?: EcosystemId;
}

const isEntry =
  (relPath: string, script: string | undefined) =>
  (e: RunGroupEntry): boolean =>
    e.relPath === relPath && e.script === script;

/**
 * A package's runnables in display order: package.json scripts, then detected tasks (ecosystem),
 * then custom commands. Names are unique: on a clash package.json wins, then detected, then custom.
 */
function runnables(project: DetectedProject, settings: ScriptsSettings): Runnable[] {
  const npm: Runnable[] = Object.entries(project.packageJson?.scripts ?? {}).map(([name, command]) => ({
    name,
    kind: 'npm',
    command,
    argv: null,
  }));

  const asRunnable =
    (kind: ScriptKind) =>
    ({ name, argv }: { name: string; argv: string[] }): Runnable => ({ name, kind, command: formatCommandLine(argv), argv });

  const taken = new Set(npm.map((r) => r.name));
  const unique = (r: Runnable): boolean => !taken.has(r.name) && Boolean(taken.add(r.name));

  // Detected tasks from ecosystem modules (not hidden)
  const hiddenForPackage = settings.hidden[project.relPath] ?? [];
  const detected: Runnable[] = [];
  for (const entry of project.ecosystems) {
    const module = ECOSYSTEM_MODULES.find((m) => m.id === entry.id);
    if (!module) continue;
    const tasks = module.tasks(entry.info);
    for (const task of tasks) {
      if (hiddenForPackage.includes(task.name)) continue;
      detected.push({ ...asRunnable('detected')(task), ecosystem: entry.id });
    }
  }

  const custom = settings.commands.filter((c) => c.relPath === project.relPath).map(asRunnable('custom')).filter(unique);
  return [...npm, ...detected.filter(unique), ...custom];
}

/** Detected tasks the user hid, unless something else now has the name. */
function hiddenOf(project: DetectedProject, settings: ScriptsSettings): { name: string; command: string }[] {
  const hidden = settings.hidden[project.relPath] ?? [];
  const names = new Set(runnables(project, settings).map((r) => r.name));
  return project.ecosystems.flatMap((entry) =>
    (ECOSYSTEM_MODULES.find((m) => m.id === entry.id)?.tasks(entry.info) ?? [])
      .filter((t) => hidden.includes(t.name) && !names.has(t.name))
      .map((t) => ({ name: t.name, command: formatCommandLine(t.argv) })),
  );
}

/** The package's environment choice, as every module's runEnv gets it. */
function choicesOf(settings: ScriptsSettings, project: DetectedProject): EcosystemChoices {
  const choice = settings.venvs.find((v) => v.relPath === project.relPath);
  return choice ? { venv: choice.venv } : {};
}

/** A path for display and storage: posix from the project folder when inside it, else absolute as is. */
function fromRoot(rootPath: string, abs: string): string {
  const rel = relative(rootPath, abs);
  if (rel === '') return '.';
  return rel.startsWith('..') || isAbsolute(rel) ? abs : rel.split(sep).join('/');
}

/** A list of per-script settings with one package's `from` renamed to `to`. */
function renamed<T extends RunGroupEntry>(list: T[], relPath: string, from: string, to: string): T[] {
  return list.map((e) => (isEntry(relPath, from)(e) ? { ...e, script: to } : e));
}

/** The env file a runnable gets: its override, else .env for commands and none for package.json scripts. */
function envFileOf(settings: ScriptsSettings, project: DetectedProject, runnable: Runnable): string | null {
  const override = settings.envFiles.find(isEntry(project.relPath, runnable.name));
  if (override) return override.file;
  return defaultEnvFile(runnable);
}

/** Custom commands get .env; package.json scripts none (Vite, Next and friends load it themselves). */
const defaultEnvFile = (runnable: Runnable): string | null => (runnable.kind === 'npm' ? null : '.env');

const mainOf = (settings: ScriptsSettings, project: DetectedProject): string | null =>
  settings.main.find((e) => e.relPath === project.relPath)?.script ?? null;

export function createScriptsTool(deps: ScriptsToolDeps): AnyMainTool {
  const batcher = createLogBatcher({
    intervalMs: 50,
    flush: (projectId, script, lines) => deps.emit(projectId, 'logs', { script, lines }),
  });

  deps.processes.on((event) => {
    if (event.type === 'line') batcher.add(event.projectId, event.script, event.line);
    if (event.type === 'changed') publishFacts();
  });

  /** Projects with a published fact, so one whose processes are all forgotten gets an empty list. */
  let published = new Set<string>();

  function publishFacts(): void {
    const byProject = new Map<string, { script: string; pid: number | null; state: ProcessState }[]>();
    for (const p of deps.processes.list()) {
      const facts = byProject.get(p.projectId) ?? [];
      facts.push({ script: p.script, pid: p.pid, state: p.state });
      byProject.set(p.projectId, facts);
    }
    for (const projectId of published) {
      if (!byProject.has(projectId)) deps.shared.forProject(projectId).publish(PROCESSES_FACT, []);
    }
    for (const [projectId, facts] of byProject) deps.shared.forProject(projectId).publish(PROCESSES_FACT, facts);
    published = new Set(byProject.keys());
  }

  const findRunnable = (project: DetectedProject, settings: ScriptsSettings, name: string): Runnable | null =>
    runnables(project, settings).find((r) => r.name === name) ?? null;

  function requireRunnable(project: DetectedProject, settings: ScriptsSettings, name: string): Runnable {
    const found = findRunnable(project, settings, name);
    if (!found) throw new NestboxError('NOT_FOUND', 'Unknown script');
    return found;
  }

  const isRunning = (projectId: string, name: string): boolean => {
    const state = deps.processes.get(projectId, name)?.state;
    return state !== undefined && isLive(state);
  };

  const isAuto = (settings: ScriptsSettings, project: DetectedProject, script: string): boolean =>
    settings.autoRestart.some((e) => e.relPath === project.relPath && e.script === script);

  /** The Node tool's advice, or none when it fails or is slow: a start never waits on it for long. */
  async function adviceFor(projectId: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ADVICE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([deps.node.advice(projectId), timeout]);
    } catch {
      deps.logger.warn('node advice failed', { projectId });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The project folder (the root package's path). */
  const rootPathOf = (project: DetectedProject): string =>
    project.relPath === '' ? project.path : deps.getDetected(project.rootId).path;

  const pythonInfoOf = (project: DetectedProject): PythonInfo | null =>
    (project.ecosystems.find((e) => e.id === 'python')?.info as PythonInfo | undefined) ?? null;

  /** A Python package's environment for the Scripts tab: the choice, the one in use and auto's. */
  async function pythonChoice(settings: ScriptsSettings, project: DetectedProject) {
    const info = pythonInfoOf(project);
    if (info === null) return null;
    const rootDir = rootPathOf(project);
    const ctx = { dir: project.path, rootDir, platform: deps.platform };
    const choices = choicesOf(settings, project);
    const used = await resolveVenv({ ...ctx, settings: choices }, info);
    const auto = await resolveVenv({ ...ctx, settings: {} }, info);
    return {
      choice: choices.venv === undefined ? ('auto' as const) : choices.venv === null ? ('none' as const) : ('path' as const),
      venv: used.venv === null ? null : fromRoot(rootDir, used.venv),
      auto: auto.venv === null ? null : fromRoot(rootDir, auto.venv),
    };
  }

  /** The Node tool is asked only about package.json scripts. The env file is read at every spawn. */
  const requestFor = async (
    settings: ScriptsSettings,
    project: DetectedProject,
    runnable: Runnable,
  ): Promise<StartRequest> => {
    const envFile = envFileOf(settings, project, runnable);
    const base: StartRequest = {
      projectId: project.id,
      script: runnable.name,
      cwd: project.path,
      packageManager: project.packageManager,
      autoRestart: isAuto(settings, project, runnable.name),
      ...(envFile === null ? {} : { loadEnv: { file: envFile, read: () => deps.envFiles.read(project.path, envFile) } }),
    };

    // npm scripts: use package manager with Node advice
    if (runnable.argv === null) {
      return { ...base, ...(await adviceFor(project.id)) };
    }

    // Custom and detected commands run as argv, in the environment of the package's ecosystems (a detected
    // task in its own module's only): PATH entry, variables, a program swap such as python → python3.
    const entries = project.ecosystems.filter(
      (entry) => runnable.kind !== 'detected' || entry.id === runnable.ecosystem,
    );
    let request: StartRequest = { ...base, argv: runnable.argv };
    for (const entry of entries) {
      const module = ECOSYSTEM_MODULES.find((m) => m.id === entry.id);
      if (!module) continue;
      const runEnv = await module.runEnv(
        { dir: project.path, rootDir: rootPathOf(project), platform: deps.platform, settings: choicesOf(settings, project) },
        entry.info,
      );
      const [program = '', ...args] = request.argv ?? [];
      const swapped = runEnv.programs?.[program];
      request = {
        ...request,
        ...(swapped ? { argv: [swapped, ...args] } : {}),
        ...(runEnv.env ? { env: { ...request.env, ...runEnv.env } } : {}),
        ...(runEnv.pathPrepend && !request.pathPrepend ? { pathPrepend: runEnv.pathPrepend } : {}),
        ...(runEnv.note && !request.note ? { note: runEnv.note } : {}),
      };
    }
    return request;
  };

  function requireRoot(project: DetectedProject): void {
    if (project.relPath !== '') throw new NestboxError('VALIDATION', 'Run groups belong to the root project');
  }

  function findGroup(project: DetectedProject, name: string): RunGroup {
    const group = deps.runGroups.get(project.rootId).find((g) => g.name === name);
    if (!group) throw new NestboxError('NOT_FOUND', 'Unknown run group');
    return group;
  }

  /** The package an entry names and what it runs, or null when either is gone. */
  function resolveEntry(
    rootId: string,
    settings: ScriptsSettings,
    entry: RunGroupEntry,
  ): { project: DetectedProject; runnable: Runnable } | null {
    const id = entry.relPath === '' ? rootId : workspaceId(rootId, entry.relPath);
    try {
      const project = deps.getDetected(id);
      const runnable = findRunnable(project, settings, entry.script);
      return runnable ? { project, runnable } : null;
    } catch {
      return null;
    }
  }

  /** The package a compose entry names, or null when it is gone or has no compose file. */
  function resolveCompose(rootId: string, entry: RunGroupCompose): DetectedProject | null {
    const id = entry.relPath === '' ? rootId : workspaceId(rootId, entry.relPath);
    try {
      const project = deps.getDetected(id);
      return project.dockerCompose === null ? null : project;
    } catch {
      return null;
    }
  }

  /** Brings a group's compose services up and waits for them; a failure never stops the scripts. */
  async function composeUp(rootId: string, entry: RunGroupCompose): Promise<ComposeStep> {
    const project = resolveCompose(rootId, entry);
    if (!project) return { relPath: entry.relPath, result: 'missing' };
    try {
      const { ok } = await deps.compose.up(project.id, entry.services, { wait: true });
      if (!ok) deps.logger.warn('run group compose failed', { projectId: project.id });
      return { relPath: entry.relPath, result: ok ? 'ok' : 'failed' };
    } catch (error) {
      const code = error instanceof NestboxError ? error.code : 'unknown';
      deps.logger.warn('run group compose failed', { projectId: project.id, code });
      return { relPath: entry.relPath, result: code === 'CONFLICT' ? 'busy' : code === 'NOT_FOUND' ? 'missing' : 'failed' };
    }
  }

  /**
   * Candidate files for a path taken from log text, most likely first: file: URLs, paths relative to
   * the project, and rooted paths, which Vite prints relative to the project but which are absolute on POSIX.
   */
  function candidatePaths(project: DetectedProject, raw: string): string[] {
    if (raw.startsWith('file:')) {
      try {
        return [fileURLToPath(raw)];
      } catch {
        return [];
      }
    }
    if (/^[\\/](?![\\/])/.test(raw)) return [resolve(project.path, `.${raw}`), resolve(raw)];
    return [isAbsolute(raw) ? raw : resolve(project.path, raw)];
  }

  return defineMainTool({
    ...scriptsDefinition,
    contract: scriptsContract,

    async dispose() {
      batcher.flushNow();
      batcher.dispose();
    },

    handlers: {
      list: async (ctx: Ctx) => {
        const settings = ctx.settings.get();
        const main = mainOf(settings, ctx.project);
        const scripts = runnables(ctx.project, settings)
          .map((r) => ({
            name: r.name,
            command: r.command,
            autoRestart: isAuto(settings, ctx.project, r.name),
            kind: r.kind,
            envFile: envFileOf(settings, ctx.project, r),
            main: r.name === main,
          }))
          // The main one first.
          .sort((a, b) => Number(b.main) - Number(a.main));
        const envFiles = await deps.envFiles.list(ctx.project.path).catch(() => []);
        const hidden = hiddenOf(ctx.project, settings);
        const python = await pythonChoice(settings, ctx.project);
        if (ctx.project.relPath !== '') return { scripts, runGroups: null, packages: null, envFiles, hidden, python };
        const packages = [ctx.project, ...ctx.project.workspaces].map((p) => {
          const names = runnables(p, settings).map((r) => r.name);
          const pkgMain = mainOf(settings, p);
          return {
            relPath: p.relPath,
            name: p.name,
            scripts: names,
            compose: p.dockerCompose !== null,
            main: pkgMain !== null && names.includes(pkgMain) ? pkgMain : null,
          };
        });
        return { scripts, runGroups: deps.runGroups.get(ctx.project.rootId), packages, envFiles, hidden, python };
      },

      start: async (ctx: Ctx, { script }) => {
        const settings = ctx.settings.get();
        const runnable = requireRunnable(ctx.project, settings, script);
        return deps.processes.start(await requestFor(settings, ctx.project, runnable));
      },

      stop: async (ctx: Ctx, { script }) => deps.processes.stop(ctx.project.id, script),

      restart: async (ctx: Ctx, { script }) => {
        const settings = ctx.settings.get();
        const runnable = requireRunnable(ctx.project, settings, script);
        return deps.processes.restart(await requestFor(settings, ctx.project, runnable));
      },

      setAutoRestart: async (ctx: Ctx, { script, enabled }) => {
        requireRunnable(ctx.project, ctx.settings.get(), script);
        const { relPath } = ctx.project;
        ctx.settings.update((s) => ({
          ...s,
          autoRestart: [
            ...s.autoRestart.filter((e) => !(e.relPath === relPath && e.script === script)),
            ...(enabled ? [{ relPath, script }] : []),
          ],
        }));
        deps.processes.setAutoRestart(ctx.project.id, script, enabled);
        return { enabled };
      },

      getLogs: async (ctx: Ctx, { script, afterSeq }) => deps.processes.logs(ctx.project.id, script, afterSeq),

      clearLogs: async (ctx: Ctx, { script }) => {
        deps.processes.clearLogs(ctx.project.id, script);
      },

      exportLogs: async (ctx: Ctx, { script, seqs }) => {
        const all = deps.processes.logs(ctx.project.id, script).lines;
        const wanted = seqs === 'all' ? null : new Set(seqs);
        const lines = wanted ? all.filter((l) => wanted.has(l.seq)) : all;
        const path = await deps.saveFile(exportFileName(script, new Date()));
        if (path === null) return { saved: false };
        await deps.writeFile(path, formatExport(lines));
        return { saved: true };
      },

      openFileAt: async (ctx: Ctx, { path, line }) => {
        for (const file of candidatePaths(ctx.project, path)) {
          if (await deps.isFile(file)) {
            await ctx.platform.openInEditor(file, line);
            return;
          }
        }
        throw new NestboxError('NOT_FOUND', 'File not found');
      },

      saveCommand: async (ctx: Ctx, { previousName, name, argv, main }) => {
        const { relPath, id, rootId } = ctx.project;
        const settings = ctx.settings.get();
        const isOld = (c: { relPath: string; name: string }) => c.relPath === relPath && c.name === previousName;
        if (previousName !== undefined && !settings.commands.some(isOld)) {
          throw new NestboxError('NOT_FOUND', 'Unknown command');
        }
        const others = runnables(ctx.project, { ...settings, commands: settings.commands.filter((c) => !isOld(c)) });
        if (others.some((r) => r.name === name)) {
          throw new NestboxError('CONFLICT', 'This package already has a script or command with this name');
        }
        if (previousName === undefined && settings.commands.length >= MAX_COMMANDS) {
          throw new NestboxError('VALIDATION', `A project can have at most ${MAX_COMMANDS} commands`);
        }
        const wasRenamed = previousName !== undefined && previousName !== name;
        if (wasRenamed && isRunning(id, previousName)) {
          throw new NestboxError('CONFLICT', 'Stop the command before renaming it');
        }
        const saved = { relPath, name, argv };
        ctx.settings.update((s) => {
          const rename = <T extends RunGroupEntry>(list: T[]): T[] =>
            wasRenamed && previousName !== undefined ? renamed(list, relPath, previousName, name) : list;
          let mains = rename(s.main);
          if (main === true) mains = [...mains.filter((e) => e.relPath !== relPath), { relPath, script: name }];
          if (main === false) mains = mains.filter((e) => !isEntry(relPath, name)(e));
          return {
            ...s,
            commands: previousName === undefined ? [...s.commands, saved] : s.commands.map((c) => (isOld(c) ? saved : c)),
            autoRestart: rename(s.autoRestart),
            envFiles: rename(s.envFiles),
            main: mains,
          };
        });
        if (wasRenamed) {
          const groups = deps.runGroups.get(rootId);
          const renameEntry = (e: RunGroupEntry): RunGroupEntry =>
            e.relPath === relPath && e.script === previousName ? { relPath, script: name } : e;
          if (groups.some((g) => g.entries.some((e) => renameEntry(e) !== e))) {
            deps.runGroups.set(rootId, groups.map((g) => ({ ...g, entries: g.entries.map(renameEntry) })));
          }
        }
      },

      deleteCommand: async (ctx: Ctx, { name }) => {
        const { relPath, id } = ctx.project;
        const isIt = (c: CustomCommand) => c.relPath === relPath && c.name === name;
        if (!ctx.settings.get().commands.some(isIt)) throw new NestboxError('NOT_FOUND', 'Unknown command');
        if (isRunning(id, name)) throw new NestboxError('CONFLICT', 'Stop the command before deleting it');
        const other = (e: RunGroupEntry) => !isEntry(relPath, name)(e);
        ctx.settings.update((s) => ({
          ...s,
          commands: s.commands.filter((c) => !isIt(c)),
          autoRestart: s.autoRestart.filter(other),
          envFiles: s.envFiles.filter(other),
          main: s.main.filter(other),
        }));
      },

      setEnvFile: async (ctx: Ctx, { script, file }) => {
        const runnable = requireRunnable(ctx.project, ctx.settings.get(), script);
        const { relPath } = ctx.project;
        ctx.settings.update((s) => ({
          ...s,
          envFiles: [
            ...s.envFiles.filter((e) => !isEntry(relPath, script)(e)),
            // Only a choice that differs from the default is kept.
            ...(file === defaultEnvFile(runnable) ? [] : [{ relPath, script, file }]),
          ],
        }));
      },

      setMain: async (ctx: Ctx, { script, main }) => {
        requireRunnable(ctx.project, ctx.settings.get(), script);
        const { relPath } = ctx.project;
        ctx.settings.update((s) => ({
          ...s,
          main: [
            ...s.main.filter((e) => (main ? e.relPath !== relPath : !isEntry(relPath, script)(e))),
            ...(main ? [{ relPath, script }] : []),
          ],
        }));
      },

      saveRunGroup: async (ctx: Ctx, { previousName, group }) => {
        requireRoot(ctx.project);
        const groups = deps.runGroups.get(ctx.project.rootId);
        const replacing = previousName ?? group.name;
        if (previousName !== undefined && !groups.some((g) => g.name === previousName)) {
          throw new NestboxError('NOT_FOUND', 'Unknown run group');
        }
        if (groups.some((g) => g.name === group.name && g.name !== replacing)) {
          throw new NestboxError('CONFLICT', 'A run group with this name already exists');
        }
        const exists = groups.some((g) => g.name === replacing);
        const next = exists ? groups.map((g) => (g.name === replacing ? group : g)) : [...groups, group];
        return deps.runGroups.set(ctx.project.rootId, next);
      },

      deleteRunGroup: async (ctx: Ctx, { name }) => {
        requireRoot(ctx.project);
        findGroup(ctx.project, name);
        return deps.runGroups.set(
          ctx.project.rootId,
          deps.runGroups.get(ctx.project.rootId).filter((g) => g.name !== name),
        );
      },

      startRunGroup: async (ctx: Ctx, { name }) => {
        const group = findGroup(ctx.project, name);
        // Services first, so a database is accepting connections before the API starts.
        const compose = await Promise.all(group.compose.map((entry) => composeUp(ctx.project.rootId, entry)));
        const settings = ctx.settings.get();
        const skipped: SkippedEntry[] = [];
        const started: ProcessSummary[] = [];
        const results = await Promise.allSettled(
          group.entries.map(async (entry) => {
            const resolved = resolveEntry(ctx.project.rootId, settings, entry);
            if (!resolved) {
              skipped.push({ ...entry, reason: 'missing' });
              return;
            }
            const { project, runnable } = resolved;
            try {
              started.push(
                await deps.processes.start(await requestFor(settings, project, runnable)),
              );
            } catch (error) {
              if (error instanceof NestboxError && error.code === 'CONFLICT') {
                skipped.push({ ...entry, reason: 'running' });
                return;
              }
              throw error;
            }
          }),
        );
        const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failure) throw failure.reason;
        return { started, skipped, compose };
      },

      stopRunGroup: async (ctx: Ctx, { name }) => {
        const group = findGroup(ctx.project, name);
        const ids = new Set(
          group.entries.map((e) => JSON.stringify([e.relPath === '' ? ctx.project.rootId : workspaceId(ctx.project.rootId, e.relPath), e.script])),
        );
        // Live members, and crashed ones waiting out an auto-restart backoff (or they would come back).
        const targets = deps.processes
          .list()
          .filter(
            (p) => (isLive(p.state) || p.nextRestartAt !== null) && ids.has(JSON.stringify([p.projectId, p.script])),
          );
        const services = group.compose.flatMap((entry) => {
          const project = resolveCompose(ctx.project.rootId, entry);
          return project ? [{ project, entry }] : [];
        });
        await Promise.allSettled([
          ...targets.map((p) => deps.processes.stop(p.projectId, p.script)),
          // `stop`, never `down`: containers and volumes stay.
          ...services.map(({ project, entry }) =>
            deps.compose.stop(project.id, entry.services).catch((error: unknown) => {
              deps.logger.warn('run group compose stop failed', {
                projectId: project.id,
                code: error instanceof NestboxError ? error.code : 'unknown',
              });
            }),
          ),
        ]);
      },

      hideCommand: async (ctx: Ctx, { name }) => {
        const runnable = requireRunnable(ctx.project, ctx.settings.get(), name);
        if (runnable.kind !== 'detected') {
          throw new NestboxError('VALIDATION', 'Only detected commands can be hidden');
        }
        if (isRunning(ctx.project.id, name)) {
          throw new NestboxError('CONFLICT', 'Stop the command before hiding it');
        }
        const { relPath } = ctx.project;
        ctx.settings.update((s) => ({
          ...s,
          hidden: {
            ...s.hidden,
            [relPath]: [...(s.hidden[relPath] ?? []), name].filter((n, i, a) => a.indexOf(n) === i),
          },
        }));
      },

      files: async (ctx: Ctx) => {
        const lists = await Promise.all(
          ctx.project.ecosystems.map(async (entry) => {
            const module = ECOSYSTEM_MODULES.find((m) => m.id === entry.id);
            return (await module?.files?.(ctx.project.path, entry.info).catch(() => [])) ?? [];
          }),
        );
        return { files: lists.flat() };
      },

      pythonEnvs: async (ctx: Ctx) => ({ envs: await findProjectVenvs(rootPathOf(ctx.project)).catch(() => []) }),

      setVenv: async (ctx: Ctx, { mode, path }) => {
        if (pythonInfoOf(ctx.project) === null) throw new NestboxError('VALIDATION', 'Not a Python package');
        const { relPath } = ctx.project;
        let venv: string | null = null;
        if (mode === 'path') {
          if (path === undefined) throw new NestboxError('VALIDATION', 'Choose a virtualenv folder');
          const root = rootPathOf(ctx.project);
          const trimmed = path.trim();
          const abs = isAbsolute(trimmed) ? trimmed : join(root, ...trimmed.split(/[\\/]/));
          if (!(await deps.isFile(join(abs, 'pyvenv.cfg')))) {
            throw new NestboxError('VALIDATION', 'Not a virtualenv: that folder has no pyvenv.cfg');
          }
          venv = fromRoot(root, abs);
        }
        ctx.settings.update((s) => ({
          ...s,
          venvs: [...s.venvs.filter((v) => v.relPath !== relPath), ...(mode === 'auto' ? [] : [{ relPath, venv }])],
        }));
      },

      showCommand: async (ctx: Ctx, { name }) => {
        const { relPath } = ctx.project;
        const hiddenForPackage = ctx.settings.get().hidden[relPath] ?? [];
        if (!hiddenForPackage.includes(name)) {
          throw new NestboxError('NOT_FOUND', 'Command is not hidden');
        }
        ctx.settings.update((s) => ({
          ...s,
          hidden: {
            ...s.hidden,
            [relPath]: hiddenForPackage.filter((n) => n !== name),
          },
        }));
      },
    },
  });
}
