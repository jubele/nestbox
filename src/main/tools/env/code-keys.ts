// Env variable names a package's source reads (os.getenv("X"), process.env.X, const { X } = process.env, …). File contents stay in
// memory: only the names leave this module, for display; they are never logged or stored.
import { realpath } from 'node:fs/promises';
import { resolveInside } from '../../fs/inside';
import { readSourceText } from '../../fs/source-text';

export const MAX_CODE_FILES = 5_000;
const TIME_LIMIT_MS = 10_000;

const SOURCE_FILE = /\.(py|js|jsx|ts|tsx|mjs|cjs|mts|cts|vue|svelte)$/i;
/** Third-party code in a package folder: a virtualenv at its top, installed packages, caches. */
const SKIP_PATH = /^(\.venv|venv|env)\/|(^|\/)(\.venv|site-packages|__pycache__|node_modules)\//;

const NAME = String.raw`(?<name>[A-Za-z_][A-Za-z0-9_]*)`;
const QUOTED = String.raw`\s*(?<quote>['"])${NAME}\k<quote>`;
/** The env object of Node, Vite and Bun. */
const ENV_OBJECT = String.raw`(?:process\.env|import\.meta\.env|Bun\.env)`;
const PATTERNS = [
  // os.getenv("X", getenv("X", os.environ.get("X", environ.setdefault("X", Deno.env.get("X"
  new RegExp(
    String.raw`\b(?:getenv|environ\.get|environ\.setdefault|Deno\.env\.get)\(${QUOTED}`,
    'g',
  ),
  // os.environ["X"], process.env["X"], process.env?.["X"], process.env!["X"]
  new RegExp(String.raw`\b(?:environ|${ENV_OBJECT}(?:\?\.|!)?)\[${QUOTED}\s*\]`, 'g'),
  // process.env.X, process.env?.X, process.env!.X, import.meta.env.X, Bun.env.X
  new RegExp(String.raw`\b${ENV_OBJECT}(?:\?|!)?\.${NAME}`, 'g'),
];

/** `const { A, B: b, C = "x", ...rest } = process.env`: the braces' text, one destructuring at a time. */
const DESTRUCTURING = new RegExp(String.raw`\{(?<body>[^{}]{1,4000})\}\s*=\s*${ENV_OBJECT}\b`, 'g');
const DESTRUCTURED_KEY =
  /^(?:(?<quote>['"])(?<quoted>[A-Za-z_][A-Za-z0-9_]*)\k<quote>|(?<name>[A-Za-z_][A-Za-z0-9_]*))\s*(?:[:=]|$)/;

/** The keys a destructuring pattern names (renamed or defaulted ones too; rest elements skipped). */
function destructuredKeys(body: string): string[] {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .split(',')
    .flatMap((part) => {
      const groups = DESTRUCTURED_KEY.exec(part.trim())?.groups;
      const key = groups?.['quoted'] ?? groups?.['name'];
      return key === undefined ? [] : [key];
    });
}

/** Set by the system, the shell or the toolchain, not by the project's env files. */
const NOT_PROJECT_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'USERNAME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'SHELL',
  'PWD',
  'LANG',
  'TERM',
  'CI',
  'NODE_ENV',
  'DEV',
  'PROD',
  'MODE',
  'SSR',
  'BASE_URL',
  'PYTHONPATH',
  'VIRTUAL_ENV',
  'PYTHONUNBUFFERED',
]);

/** The names a source text reads, in order of first appearance. */
export function findEnvKeys(text: string): string[] {
  const found: { key: string; at: number }[] = [];
  const add = (key: string | undefined, at: number) => {
    if (key !== undefined && !NOT_PROJECT_KEYS.has(key)) found.push({ key, at });
  };
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) add(match.groups?.['name'], match.index);
  }
  for (const match of text.matchAll(DESTRUCTURING)) {
    for (const key of destructuredKeys(match.groups?.['body'] ?? '')) add(key, match.index);
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.key))];
}

export interface CodeKeys {
  /** Sorted by name; `files` is how many source files read the key. */
  keys: { key: string; files: number }[];
  /** Source files read. */
  files: number;
  truncated: boolean;
}

export async function scanCodeKeys(
  dir: string,
  paths: readonly string[],
  opts: { maxFiles?: number; now?: () => number } = {},
): Promise<CodeKeys> {
  const maxFiles = opts.maxFiles ?? MAX_CODE_FILES;
  const now = opts.now ?? Date.now;
  const started = now();
  const realRoot = await realpath(dir).catch(() => dir);
  const sources = paths.filter(
    (p) => SOURCE_FILE.test(p) && !SKIP_PATH.test(p.replace(/\\/g, '/')),
  );
  const counts = new Map<string, number>();
  let files = 0;
  let truncated = sources.length > maxFiles;
  for (const path of sources.slice(0, maxFiles)) {
    if (now() - started > TIME_LIMIT_MS) {
      truncated = true;
      break;
    }
    let abs: string;
    try {
      abs = resolveInside(dir, path);
    } catch {
      continue;
    }
    const text = await readSourceText(realRoot, abs);
    if (text === null) continue;
    files++;
    for (const key of findEnvKeys(text)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const keys = [...counts]
    .map(([key, n]) => ({ key, files: n }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { keys, files, truncated };
}
