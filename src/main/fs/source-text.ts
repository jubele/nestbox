// Reads project source files for scans (TODOs, env keys in code). Contents stay in the caller's memory.
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

export const MAX_SOURCE_BYTES = 1024 * 1024;
const SNIFF_BYTES = 8 * 1024;

/** Inside realRoot once every symlink on the way is resolved: a linked folder can lead anywhere. */
async function staysInside(realRoot: string, abs: string): Promise<boolean> {
  const real = await realpath(abs).catch(() => null);
  if (real === null) return false;
  const rel = relative(realRoot, real);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * A project file's text, or null when it isn't a regular file inside realRoot (symlinks are never followed),
 * is over 1 MiB or looks binary (a NUL in its first 8 KiB). The caller keeps the text in memory only.
 */
export async function readSourceText(realRoot: string, abs: string): Promise<string | null> {
  // lstat: a symlinked file is never followed, since it can point outside the project.
  const info = await lstat(abs).catch(() => null);
  if (!info?.isFile() || info.size > MAX_SOURCE_BYTES) return null;
  if (!(await staysInside(realRoot, abs))) return null;
  const handle = await open(abs, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = await handle.readFile();
    if (buffer.subarray(0, SNIFF_BYTES).includes(0)) return null;
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
