import { NestboxError } from '@shared/errors';
import { belongsTo } from '@shared/processes';
import { envContract, envDefinition } from '@shared/tools/env/contract';
import type { Logger } from '../../logger';
import { LS_MAX_BYTES, listFiles } from '../todos/files';
import { type AnyMainTool, defineMainTool, type ToolContext } from '../types';
import { MAX_CODE_FILES, scanCodeKeys } from './code-keys';
import { addEntry, entries, parseEnv, removeEntry, serializeEnv, setValue } from './dotenv';
import type { EnvFileAccess } from './env-files';
import { activeProfile, BACKUP_FILE, buildMatrix, profileFiles } from './matrix';

export interface EnvToolDeps {
  files: EnvFileAccess;
  /** Electron's clipboard in production: copy never sends the value to the renderer. */
  clipboard: { writeText(text: string): void };
  /** Watches a folder (not recursive); returns a function that stops watching, or null when it can't watch. */
  watch(dir: string, onChange: (fileName: string | null) => void): (() => void) | null;
  logger: Logger;
}

/**
 * The shared-context fact the env tool publishes per project: PORT as a number (the only value ever
 * published) and the names of URL-like keys.
 */
export const ENV_FACTS = 'env.facts';

const WATCH_DEBOUNCE_MS = 200;
const LS_TIMEOUT_MS = 15_000;
const URL_KEY = /^DATABASE_URL$|_(URL|URI)$/;

/** PORT as a port number, or null when it is not one. */
export function portOf(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,5}$/.test(value.trim())) return null;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : null;
}

export function createEnvTool(deps: EnvToolDeps): AnyMainTool {
  /** One watcher per project (root or workspace package), started by its first matrix() call. */
  const watchers = new Map<string, { dir: string; ctx: ToolContext; stop(): void }>();

  function ensureWatcher(ctx: ToolContext): void {
    const id = ctx.project.id;
    const dir = ctx.project.path;
    const existing = watchers.get(id);
    if (existing && existing.dir === dir) {
      existing.ctx = ctx;
      return;
    }
    existing?.stop();
    watchers.delete(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const entry = { dir, ctx, stop: () => {} };
    const stop = deps.watch(dir, () => {
      clearTimeout(timer);
      timer = setTimeout(() => entry.ctx.emit('changed', undefined), WATCH_DEBOUNCE_MS);
    });
    // Couldn't watch (the folder may be missing): try again on the next matrix() call.
    if (!stop) return;
    entry.stop = () => {
      clearTimeout(timer);
      stop();
    };
    watchers.set(id, entry);
  }

  async function readEntries(ctx: ToolContext, file: string): Promise<Map<string, string>> {
    return entries(parseEnv((await deps.files.read(ctx.project.path, file)).text));
  }

  async function valueOf(ctx: ToolContext, file: string, key: string): Promise<string> {
    const value = (await readEntries(ctx, file)).get(key);
    if (value === undefined) throw new NestboxError('NOT_FOUND', 'That key is not in this file');
    return value;
  }

  /** Reads the file, applies edit to its document and writes it back if it is still at version. */
  async function edit(
    ctx: ToolContext,
    file: string,
    version: string | null,
    change: (doc: ReturnType<typeof parseEnv>) => ReturnType<typeof parseEnv>,
    method: string,
  ): Promise<{ version: string }> {
    const text = version === null ? '' : (await deps.files.read(ctx.project.path, file)).text;
    const written = await deps.files.write(ctx.project.path, file, serializeEnv(change(parseEnv(text))), version);
    deps.logger.info('env write', { method, file });
    ctx.emit('changed', undefined);
    return written;
  }

  return defineMainTool({
    ...envDefinition,
    contract: envContract,
    handlers: {
      matrix: async (ctx) => {
        ensureWatcher(ctx);
        const listed = await deps.files.list(ctx.project.path);
        const read = await Promise.all(
          listed.map(async (f) => {
            const file = await deps.files.read(ctx.project.path, f.name).catch(() => null);
            return file && { ...f, ...file, doc: parseEnv(file.text) };
          }),
        );
        const files = read.filter((f): f is NonNullable<typeof f> => f !== null);
        const envText = files.find((f) => f.name === '.env')?.text ?? null;
        const profiles = profileFiles(files.map((f) => f.name)).map((file) => ({
          file,
          text: files.find((f) => f.name === file)?.text ?? '',
        }));
        const env = files.find((f) => f.name === '.env');
        const envEntries = env ? entries(env.doc) : new Map<string, string>();
        ctx.shared.publish(ENV_FACTS, {
          port: portOf(envEntries.get('PORT')),
          urls: [...envEntries.keys()].filter((k) => URL_KEY.test(k)),
        });
        return buildMatrix(files, activeProfile(envText, profiles));
      },

      reveal: async (ctx, { file, key }) => ({ value: await valueOf(ctx, file, key) }),

      copy: async (ctx, { file, key }) => {
        deps.clipboard.writeText(await valueOf(ctx, file, key));
        return {};
      },

      setValue: (ctx, { file, key, value, version }) => edit(ctx, file, version, (doc) => setValue(doc, key, value), 'setValue'),
      addKey: (ctx, { file, key, value, version }) => edit(ctx, file, version, (doc) => addEntry(doc, key, value), 'addKey'),
      removeKey: (ctx, { file, key, version }) => edit(ctx, file, version, (doc) => removeEntry(doc, key), 'removeKey'),

      switchProfile: async (ctx, { file, envVersion }) => {
        const dir = ctx.project.path;
        const listed = await deps.files.list(dir);
        if (!profileFiles(listed.map((f) => f.name)).includes(file)) throw new NestboxError('NOT_FOUND', 'That profile does not exist');
        // Checked before the backup is written, so a switch that can't happen never replaces the old backup.
        if (listed.find((f) => f.name === '.env')?.readOnly) throw new NestboxError('FORBIDDEN', 'Symlinked env files are read-only');
        const profile = await deps.files.read(dir, file);
        if (envVersion !== null) {
          const current = await deps.files.read(dir, '.env');
          if (current.version !== envVersion) throw new NestboxError('CONFLICT', 'The file changed on disk. Reload and try again.');
          await deps.files.write(dir, BACKUP_FILE, current.text, 'any');
        }
        await deps.files.write(dir, '.env', profile.text, envVersion);
        deps.logger.info('env profile switched', { file });
        ctx.emit('changed', undefined);
        return {};
      },

      readRaw: async (ctx, { file }) => deps.files.read(ctx.project.path, file),

      writeRaw: async (ctx, { file, text, version }) => {
        const written = await deps.files.write(ctx.project.path, file, text, version);
        deps.logger.info('env write', { method: 'writeRaw', file });
        ctx.emit('changed', undefined);
        return written;
      },

      codeKeys: async (ctx) => {
        const dir = ctx.project.path;
        const list = await listFiles(dir, {
          // Every file git knows plus untracked ones that aren't ignored; capped well past the scan's limit.
          maxFiles: MAX_CODE_FILES * 4,
          exec: (args) => ctx.platform.execCommand('git', args, { cwd: dir, timeoutMs: LS_TIMEOUT_MS, maxBytes: LS_MAX_BYTES }),
        });
        const found = await scanCodeKeys(dir, list.files);
        deps.logger.info('env code keys', { keys: found.keys.length, files: found.files, truncated: found.truncated });
        return found;
      },

      createFile: async (ctx, { file, keys }) => {
        const unique = [...new Set(keys)];
        return edit(ctx, file, null, (doc) => unique.reduce((d, key) => addEntry(d, key, ''), doc), 'createFile');
      },

      facts: async (ctx) => {
        const env = await readEntries(ctx, '.env').catch(() => new Map<string, string>());
        return { port: portOf(env.get('PORT')) };
      },
    },
    async dispose() {
      for (const w of watchers.values()) w.stop();
      watchers.clear();
    },
    forgetProject(rootId) {
      for (const [id, w] of watchers) {
        if (belongsTo(id, rootId)) {
          w.stop();
          watchers.delete(id);
        }
      }
    },
  });
}
