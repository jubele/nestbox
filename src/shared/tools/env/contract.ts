import { z } from 'zod';
import { defineContract, defineEvents, type ToolDefinition } from '../../tool';

const settingsSchema = z.strictObject({});

export const envDefinition: ToolDefinition<z.infer<typeof settingsSchema>> = {
  id: 'env',
  name: 'Env',
  icon: 'key-round',
  // Always: a project without env files still shows "No .env files".
  appliesTo: () => true,
  settingsSchema,
};

export const EnvFileNameSchema = z.string().regex(/^\.env(\..+)?$/).max(200);
export const EnvKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/).max(200);
/** Values are typed by the user; NUL never belongs in a .env file. */
export const EnvValueSchema = z
  .string()
  .max(64 * 1024)
  .refine((v) => !v.includes('\0'), { message: 'nul' });
const Version = z.string().min(1).max(100);
/** A whole env file from the raw editor: the env file size cap (1 MiB), no NUL. */
const EnvTextSchema = z
  .string()
  .max(1024 * 1024)
  .refine((v) => !v.includes('\0'), { message: 'nul' });

export const CELL_STATES = ['set', 'empty', 'absent'] as const;

/** Presence only: the matrix never carries values. */
export const EnvMatrixSchema = z.object({
  /** Columns: the example first, then .env, then the rest alphabetically. */
  files: z.array(
    z.object({
      name: z.string(),
      version: z.string(),
      /** Symlinked files are read-only. */
      readOnly: z.boolean(),
      entries: z.number().int().nonnegative(),
      duplicates: z.array(z.string()),
    }),
  ),
  keys: z.array(
    z.object({
      key: z.string(),
      cells: z.record(z.string(), z.enum(CELL_STATES)),
      /** In the example, not in .env. */
      missing: z.boolean(),
      /** In .env, not in the example. */
      undocumented: z.boolean(),
    }),
  ),
  /** The example file used for the flags, or null. */
  example: z.string().nullable(),
  profiles: z.array(z.object({ name: z.string(), file: z.string(), active: z.boolean() })),
});
export type EnvMatrix = z.infer<typeof EnvMatrixSchema>;

const CellInput = z.strictObject({ file: EnvFileNameSchema, key: EnvKeySchema });

export const envContract = defineContract({
  matrix: { input: z.strictObject({}), output: EnvMatrixSchema },
  /** One value, shown on request. */
  reveal: { input: CellInput, output: z.object({ value: z.string() }) },
  /** Main writes the clipboard: the value never reaches the renderer. */
  copy: { input: CellInput, output: z.object({}) },
  setValue: {
    input: z.strictObject({ file: EnvFileNameSchema, key: EnvKeySchema, value: EnvValueSchema, version: Version }),
    output: z.object({ version: z.string() }),
  },
  /** version null creates the file. */
  addKey: {
    input: z.strictObject({ file: EnvFileNameSchema, key: EnvKeySchema, value: EnvValueSchema, version: Version.nullable() }),
    output: z.object({ version: z.string() }),
  },
  removeKey: {
    input: z.strictObject({ file: EnvFileNameSchema, key: EnvKeySchema, version: Version }),
    output: z.object({ version: z.string() }),
  },
  /** Copies the profile over .env after saving the old .env as .env.backup. envVersion null: .env is absent. */
  switchProfile: {
    input: z.strictObject({ file: EnvFileNameSchema, envVersion: Version.nullable() }),
    output: z.object({}),
  },
  /** The whole file as text, for the raw editor (the user asked to see every value). */
  readRaw: { input: z.strictObject({ file: EnvFileNameSchema }), output: z.object({ text: z.string(), version: z.string() }) },
  /** Replaces the whole file, if it is still at version (CONFLICT otherwise). */
  writeRaw: {
    input: z.strictObject({ file: EnvFileNameSchema, text: EnvTextSchema, version: Version }),
    output: z.object({ version: z.string() }),
  },
  /** Env variable names the package's source reads (`os.getenv("X")`, `process.env.X`): names only. */
  codeKeys: {
    input: z.strictObject({}),
    output: z.object({
      keys: z.array(z.object({ key: z.string(), files: z.number().int().positive() })),
      files: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
  },
  /** A new env file with these keys and empty values; CONFLICT when it exists. */
  createFile: {
    input: z.strictObject({ file: EnvFileNameSchema, keys: z.array(EnvKeySchema).max(500) }),
    output: z.object({ version: z.string() }),
  },
  /** PORT from .env (for the Ports card), never other values. */
  facts: { input: z.strictObject({}), output: z.object({ port: z.number().int().nullable() }) },
});

export const envEvents = defineEvents({
  /** An env file in the package folder changed (on disk or through NestBox). */
  changed: z.undefined(),
});
