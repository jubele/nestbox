import { z } from 'zod';
import { CommandArgvSchema } from '../../command-line';
import { COMMAND_NAME } from '../../detected';
import { EnvFileNameSchema } from '../env/contract';
import { LogLineSchema, LogSnapshotSchema, MAX_EXPORT_SEQS, ProcessSummarySchema } from '../../processes';
import { defineContract, defineEvents, type ToolDefinition } from '../../tool';
import { RunGroupEntrySchema, RunGroupSchema } from '../../types';

const ScriptName = z.string().min(1).max(200);
const ScriptInput = z.strictObject({ script: ScriptName });
const GroupName = z.string().trim().min(1).max(60);
const CommandName = z.string().regex(COMMAND_NAME, 'Use letters, digits, ":", ".", "_" or "-" (up to 60)');

/** A command the user added to a package: a program and its arguments, run without a shell. */
export const CustomCommandSchema = z.object({
  /** '' = the root package; otherwise the workspace package's posix relPath. */
  relPath: z.string(),
  name: CommandName,
  argv: CommandArgvSchema,
});
export type CustomCommand = z.infer<typeof CustomCommandSchema>;

const settingsSchema = z.object({
  /** Scripts with auto-restart on, across the root and its workspace packages. */
  autoRestart: z.array(RunGroupEntrySchema).max(500).default([]),
  /** Custom commands across the root and its workspace packages. */
  commands: z.array(CustomCommandSchema).max(100).default([]),
  /**
   * Which env file a script or command gets, where it differs from the default (.env for custom commands,
   * none for package.json scripts). null = none.
   */
  envFiles: z
    .array(RunGroupEntrySchema.extend({ file: EnvFileNameSchema.nullable() }))
    .max(500)
    .default([]),
  /** The main script or command of a package, at most one per package. */
  main: z.array(RunGroupEntrySchema).max(200).default([]),
  /** Hidden detected commands (ecosystem tasks), can be restored. */
  hidden: z.record(z.string(), z.array(z.string())).optional().default({}),
  /**
   * The virtualenv a package's commands run in, where the user picked one: a posix path from the project
   * folder, or an absolute path outside it; null = none (system Python). Absent = the module's default.
   */
  venvs: z
    .array(z.object({ relPath: z.string(), venv: z.string().min(1).max(4096).nullable() }))
    .max(200)
    .default([]),
});
export type ScriptsSettings = z.infer<typeof settingsSchema>;

export const VENV_MODES = ['auto', 'none', 'path'] as const;

export const scriptsDefinition: ToolDefinition<ScriptsSettings> = {
  id: 'scripts',
  name: 'Scripts',
  icon: 'terminal',
  // Every package: one without scripts can still run custom commands, and ecosystems provide detected tasks.
  appliesTo: (p) => p.packageJson !== null || p.ecosystems.length > 0 || p.workspaces.length > 0,
  settingsSchema,
};

/** Where a runnable comes from: package.json, detected by an ecosystem module, or the user. */
export const SCRIPT_KINDS = ['npm', 'detected', 'custom'] as const;
export type ScriptKind = (typeof SCRIPT_KINDS)[number];

export const ScriptInfoSchema = z.object({
  name: z.string(),
  /** The script's text, or the command line (custom commands). */
  command: z.string(),
  autoRestart: z.boolean(),
  kind: z.enum(SCRIPT_KINDS),
  /** The env file its process gets, or null. */
  envFile: z.string().nullable(),
  /** The package's main script or command. */
  main: z.boolean(),
});
export type ScriptInfo = z.infer<typeof ScriptInfoSchema>;

export const PackageScriptsSchema = z.object({
  relPath: z.string(),
  name: z.string(),
  scripts: z.array(z.string()),
  /** Has a compose file, so the run group editor offers its services. */
  compose: z.boolean(),
  /** The package's main script or command; a new run group starts with it ticked. */
  main: z.string().nullable(),
});
export type PackageScripts = z.infer<typeof PackageScriptsSchema>;

export const SkippedEntrySchema = RunGroupEntrySchema.extend({ reason: z.enum(['missing', 'running']) });
export type SkippedEntry = z.infer<typeof SkippedEntrySchema>;

/** What happened to one package's compose services when a group started. */
export const ComposeStepSchema = z.object({
  relPath: z.string(),
  result: z.enum(['ok', 'missing', 'busy', 'failed']),
});
export type ComposeStep = z.infer<typeof ComposeStepSchema>;

export { MAX_EXPORT_SEQS } from '../../processes';

export const scriptsContract = defineContract({
  list: {
    input: z.strictObject({}),
    output: z.object({
      scripts: z.array(ScriptInfoSchema),
      /** Root projects only; null for workspace packages. */
      runGroups: z.array(RunGroupSchema).nullable(),
      /** Root projects only: every package's scripts, for the run group editor. */
      packages: z.array(PackageScriptsSchema).nullable(),
      /** The package's env files right now, for the Env choice of each row. */
      envFiles: z.array(z.string()),
      /** Detected commands the user hid in this package, to restore. */
      hidden: z.array(z.object({ name: z.string(), command: z.string() })),
      /**
       * A Python package's environment (null elsewhere): the choice, the virtualenv in use and the one auto
       * would use. Paths are posix from the project folder, or absolute; null = system Python.
       */
      python: z
        .object({ choice: z.enum(VENV_MODES), venv: z.string().nullable(), auto: z.string().nullable() })
        .nullable(),
    }),
  },
  start: { input: ScriptInput, output: ProcessSummarySchema },
  stop: { input: ScriptInput, output: ProcessSummarySchema },
  restart: { input: ScriptInput, output: ProcessSummarySchema },
  setAutoRestart: {
    input: z.strictObject({ script: ScriptName, enabled: z.boolean() }),
    output: z.object({ enabled: z.boolean() }),
  },
  getLogs: {
    input: z.strictObject({ script: ScriptName, afterSeq: z.number().int().nonnegative().optional() }),
    output: LogSnapshotSchema,
  },
  clearLogs: { input: ScriptInput, output: z.void() },
  exportLogs: {
    input: z.strictObject({
      script: ScriptName,
      seqs: z.union([z.literal('all'), z.array(z.number().int().positive()).max(MAX_EXPORT_SEQS)]),
    }),
    output: z.object({ saved: z.boolean() }),
  },
  openFileAt: {
    input: z.strictObject({ path: z.string().min(1).max(4096), line: z.number().int().positive() }),
    output: z.void(),
  },
  /**
   * Adds a custom command, or replaces `previousName` (a rename keeps auto-restart, run groups, the env file
   * and main). `main: true` also makes it the package's main command.
   */
  saveCommand: {
    input: z.strictObject({
      previousName: CommandName.optional(),
      name: CommandName,
      argv: CommandArgvSchema,
      main: z.boolean().optional(),
    }),
    output: z.void(),
  },
  /** The env file a script or command gets; null = none. */
  setEnvFile: {
    input: z.strictObject({ script: ScriptName, file: EnvFileNameSchema.nullable() }),
    output: z.void(),
  },
  /** Makes a script or command the package's main one (`main: false` clears it). */
  setMain: { input: z.strictObject({ script: ScriptName, main: z.boolean() }), output: z.void() },
  deleteCommand: { input: z.strictObject({ name: CommandName }), output: z.void() },
  saveRunGroup: {
    input: z.strictObject({ previousName: GroupName.optional(), group: RunGroupSchema }),
    output: z.array(RunGroupSchema),
  },
  deleteRunGroup: { input: z.strictObject({ name: GroupName }), output: z.array(RunGroupSchema) },
  startRunGroup: {
    input: z.strictObject({ name: GroupName }),
    output: z.object({
      started: z.array(ProcessSummarySchema),
      skipped: z.array(SkippedEntrySchema),
      /** Compose steps run before the scripts, one per package, in the group's order. */
      compose: z.array(ComposeStepSchema),
    }),
  },
  stopRunGroup: { input: z.strictObject({ name: GroupName }), output: z.void() },
  /** Hides a detected command (ecosystem task). */
  hideCommand: { input: z.strictObject({ name: CommandName }), output: z.void() },
  /** Shows a hidden detected command. */
  showCommand: { input: z.strictObject({ name: CommandName }), output: z.void() },
  /** Files the package's ecosystems offer to run (the Add command dialog's picker), with their argv. */
  files: {
    input: z.strictObject({}),
    output: z.object({ files: z.array(z.object({ path: z.string(), argv: CommandArgvSchema })) }),
  },
  /** Virtualenvs inside the project (posix paths from the project folder), for the environment choice. */
  pythonEnvs: { input: z.strictObject({}), output: z.object({ envs: z.array(z.string()) }) },
  /** Which virtualenv a Python package's commands use: the default, none, or a path (VALIDATION without pyvenv.cfg). */
  setVenv: {
    input: z.strictObject({
      mode: z.enum(VENV_MODES),
      path: z
        .string()
        .min(1)
        .max(4096)
        .refine((p) => !p.includes('\0'))
        .optional(),
    }),
    output: z.void(),
  },
});

export const scriptsEvents = defineEvents({
  /** A batch of new lines for one script, about every 50 ms. */
  logs: z.object({ script: z.string(), lines: z.array(LogLineSchema) }),
});
