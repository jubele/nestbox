import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTree, removeTree } from '../../detection/test-fixtures';
import { findEnvKeys, scanCodeKeys } from './code-keys';

describe('findEnvKeys', () => {
  it('finds the names Python reads', () => {
    const text = [
      'import os',
      'from os import getenv, environ',
      'DB = os.getenv("DATABASE_URL")',
      "SECRET = os.environ['SECRET_KEY']",
      'debug = os.environ.get( "DEBUG", "0")',
      "port = int(getenv('PORT', 8000))",
      'environ.setdefault("DJANGO_SETTINGS_MODULE", "app.settings")',
      'os.environ.setdefault("REDIS_URL", "redis://")',
      'name = os.getenv(KEY_NAME)  # not a literal',
    ].join('\n');
    expect(findEnvKeys(text)).toEqual([
      'DATABASE_URL',
      'SECRET_KEY',
      'DEBUG',
      'PORT',
      'DJANGO_SETTINGS_MODULE',
      'REDIS_URL',
    ]);
  });

  it('finds the names JavaScript reads, and drops toolchain ones', () => {
    const text = [
      'const url = process.env.API_URL;',
      "const key = process.env['STRIPE_KEY'];",
      'const base = import.meta.env.VITE_API_BASE;',
      'if (process.env.NODE_ENV === "production") {}',
      'const p = process.env.PATH; const h = os.getenv("HOME")',
      'const again = process.env.API_URL;',
    ].join('\n');
    expect(findEnvKeys(text)).toEqual(['API_URL', 'STRIPE_KEY', 'VITE_API_BASE']);
  });

  it('finds TypeScript destructuring, optional chaining, Bun and Deno', () => {
    const text = [
      'const { DATABASE_URL, PORT: port = "3000", JWT_SECRET } = process.env;',
      'const {',
      '  REDIS_URL,',
      '  // a comment',
      '  SMTP_HOST = "localhost",',
      '  ...rest',
      '} = process.env as Record<string, string>;',
      'const a = process.env?.SENTRY_DSN ?? "";',
      "const b = process.env?.['S3_BUCKET'];",
      'const c = process.env!.AWS_REGION;',
      'const d = Bun.env.BUN_KEY;',
      'const e = Deno.env.get("DENO_KEY");',
      'const { VITE_TITLE } = import.meta.env;',
      'const { NODE_ENV } = process.env;',
      'const { notEnv } = config;',
    ].join('\n');
    expect(findEnvKeys(text)).toEqual([
      'DATABASE_URL',
      'PORT',
      'JWT_SECRET',
      'REDIS_URL',
      'SMTP_HOST',
      'SENTRY_DSN',
      'S3_BUCKET',
      'AWS_REGION',
      'BUN_KEY',
      'DENO_KEY',
      'VITE_TITLE',
    ]);
  });
});

describe('scanCodeKeys', () => {
  let dir = '';
  afterEach(async () => removeTree(dir));

  it('counts the files reading each key, skipping virtualenvs and non-source files', async () => {
    dir = await makeTree({
      'main.py': 'os.getenv("DATABASE_URL")\nos.getenv("PORT")\n',
      'app/settings.py': 'os.environ["DATABASE_URL"]\n',
      'README.md': 'set os.getenv("NOT_CODE")',
      '.venv/lib/site.py': 'os.getenv("FROM_VENV")',
      'venv/lib/x.py': 'os.getenv("FROM_VENV")',
      'lib/site-packages/y.py': 'os.getenv("FROM_VENV")',
    });
    const paths = [
      'main.py',
      'app/settings.py',
      'README.md',
      '.venv/lib/site.py',
      'venv/lib/x.py',
      'lib/site-packages/y.py',
    ];
    expect(await scanCodeKeys(dir, paths)).toEqual({
      keys: [
        { key: 'DATABASE_URL', files: 2 },
        { key: 'PORT', files: 1 },
      ],
      files: 2,
      truncated: false,
    });
  });

  it('never follows a symlink out of the package', async (ctx) => {
    dir = await makeTree({
      'pkg/main.py': 'os.getenv("INSIDE")\n',
      'secret/leak.py': 'os.getenv("OUTSIDE")\n',
    });
    try {
      await symlink(join(dir, 'secret', 'leak.py'), join(dir, 'pkg', 'leak.py'));
    } catch {
      ctx.skip(); // no symlink permission (Windows without developer mode)
    }
    await mkdir(join(dir, 'pkg', 'sub'), { recursive: true });
    await writeFile(join(dir, 'pkg', 'sub', 'ok.ts'), 'process.env.ALSO_INSIDE');
    expect(
      (await scanCodeKeys(join(dir, 'pkg'), ['main.py', 'leak.py', 'sub/ok.ts'])).keys.map(
        (k) => k.key,
      ),
    ).toEqual(['ALSO_INSIDE', 'INSIDE']);
  });

  it('stops at the file limit and says so', async () => {
    dir = await makeTree({ 'a.py': 'os.getenv("A")', 'b.py': 'os.getenv("B")' });
    expect(await scanCodeKeys(dir, ['a.py', 'b.py'], { maxFiles: 1 })).toEqual({
      keys: [{ key: 'A', files: 1 }],
      files: 1,
      truncated: true,
    });
  });
});
