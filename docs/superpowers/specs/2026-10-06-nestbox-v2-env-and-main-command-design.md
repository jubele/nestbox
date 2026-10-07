# NestBox v2: env for commands, env keys from code, main command (1.22.0)

The owner's answers (2026-10-06), after Python backends (1.21.0):

- A Python backend often has no `.env`; its variables are read in code (`os.getenv`). NestBox should show them and
  let the user create and fill the file.
- Commands should get a package's env file: a per-command switch.
- A package's "main script": pick a `.py` file to run, and mark one command as the package's main one.

## Env tab

- **Add variable** (always there): key, file (the package's env files, or a new `.env`), value. `addKey` with
  version null creates the file. A key already in the file is CONFLICT ("Edit it instead").
- **Keys from code.** New method `codeKeys` lists env variable names the package's source reads, with the number
  of files each appears in. Files come from the TODOs tool's listing (`git ls-files`, else a walk applying the root
  `.gitignore`); only source files are read (`.py`, `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.vue`,
  `.svelte`), never inside virtualenvs, `site-packages` or `__pycache__`; at most 5,000 files, 1 MiB each, 10 s.
  Patterns (string literal names only):
  - Python: `os.getenv("X"`, `getenv("X"`, `os.environ.get("X"`, `environ.get("X"`, `os.environ["X"]`,
    `environ["X"]`, `os.environ.setdefault("X"`;
  - JS/TS: `process.env.X`, `process.env["X"]`, `import.meta.env.X`.
  Names the system or the toolchain sets (`PATH`, `HOME`, `NODE_ENV`, `CI`, `PYTHONPATH`, …) are left out. Results
  live in the renderer's query cache only (names are file content: shown, never logged or stored).
- Rows: every key in code gets an `in code` chip; a key in code that no env file has becomes a row of its own.
  "Flagged only" also shows keys in code that `.env` lacks (`in code, not in .env`).
- No env file yet: **Create .env** writes the keys found in code with empty values (`createFile`, refused when the
  file exists), next to **Add variable**.

## Env for commands

- `toolSettings.scripts.envFiles`: `{ relPath, script, file | null }[]` overrides. Default: `.env` for detected
  and custom commands, none for package.json scripts (Vite, Next and friends load `.env` themselves).
- Each Scripts row has an **Env** select: none, or one of the package's env files.
- At every spawn (auto-restart too, so edits apply) main reads the file through env file access and `dotenv.ts`.
  The child's env is: shell env, then the file's variables, then the virtualenv's PATH entry and NestBox's own
  (`VIRTUAL_ENV`, `PYTHONUNBUFFERED`, `FORCE_COLOR`). The log says `▸ env: .env (N variables)`, or
  `▸ .env not found: started without it`; values are never logged, stored or sent to the renderer.

## Follow-ups (same release)

- **Remove a detected command**: `hideCommand` adds it to `toolSettings.scripts.hidden` (detection would find it
  again); the list's `hidden` shows "Removed: … Restore" (`showCommand`). Only detected commands, never while running.
  The command palette takes commands from the selected root's Scripts list, so a removed one never appears there.
- **Raw editor**: `readRaw` returns a file's text and version; `writeRaw` replaces it at that version (1 MiB, no NUL).
  A CONFLICT keeps the user's text in the editor with Reload. Symlinked files open view-only.

- **Virtualenv choice**: a Python package without its own virtualenv uses the project folder's (`../.venv`).
  `toolSettings.scripts.venvs` overrides it per package: none (system Python) or a folder with `pyvenv.cfg`, stored
  as a path from the project folder or absolute outside it. The Scripts tab's **Python environment** picker lists
  Auto, the virtualenvs in the project (`pythonEnvs`), system Python and "Other folder…". The log names the one used.

## Main command

- `toolSettings.scripts.main`: `{ relPath, script }[]`, one per package. `ScriptInfo.main`; `setMain`; the main row
  comes first with a `main` chip and a star toggle. Renames and deletes carry `main` and `envFiles` along with
  auto-restart.
- **Python file picker**: `pythonFiles` lists the package's `.py` files (three levels deep at most, no virtualenvs,
  tests, migrations or caches; 300 at most). The Add command dialog in a Python package offers them: picking one
  fills `python <file>` and the name. The dialog's **Main command** checkbox saves both (`saveCommand { main }`).
- Uses: the Scripts overview card offers **Start <main>** for the package (and each package's main on a root),
  and a new run group starts with every package's main command ticked.
