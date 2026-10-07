# Nestbox — Local Developer Toolbox (Spec)

Spec version: 2026-10-01. This file is the source of truth for scope and architecture.

## Overview

Nestbox is a desktop app where you add your local projects and get a set of tools for each one: run scripts and read their logs, free up ports, manage `.env` files, serve a folder over HTTP, and open it in Claude Code with the right context. It targets Node.js and TypeScript developers, both backend and frontend, and is built with Electron, React and Vite.

The app exists to do the things a browser cannot: read the filesystem, spawn and kill processes, open ports. Every tool should lean on that access, otherwise it belongs on a website.

**Goals**

- A tool I use every day on my own projects.
- A portfolio piece that shows clean Electron architecture: typed IPC, a module system, and tools that share context.
- Small, finished v1 over a large, half-built one.

**Non-goals**

- Not an API client (Postman, Bruno and Insomnia own that space).
- Not a generic utility box of JWT decoders and JSON formatters (DevToys, DevUtils).
- Not a replacement for the IDE, terminal or Docker Desktop. Nestbox sits beside them.
- No monetization, accounts, telemetry or cloud sync in v1.

**Decisions**

- Name: Nestbox. npm/CLI name `nestbox`. Repo under the author's personal GitHub account.
- Platforms: Windows for the MVP, macOS next, Linux not planned. All OS-specific code behind one adapter from day one.
- Tray icon: yes, in v1.
- Licence: MIT, open source from day one.

## Name and logo

- Display name and wordmark "NestBox" (owner's decision, M1 review); npm/CLI name stays `nestbox`.
- Logo: a nest box drawn as one solid shape whose round entrance hole doubles as a status light.
- Tray states (hole colour): green = all processes running, amber = a script is starting, red = a process crashed, grey = nothing running.
- Tray icon: monochrome shape (`.ico` on Windows, template image on macOS); the hole carries the only colour.

## Core concept

The project is the center of the app, and every tool is a tab inside it. You add a folder once; Nestbox detects what it is and shows only the tools that apply.

**Project detection** runs when a folder is added and on refresh. It reads:

- `package.json`: name, scripts, package manager (from the lockfile: `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `bun.lockb`).
- `.env*` files and `.env.example`.
- `prisma/schema.prisma`, `docker-compose.yml`, `.git`, a `dist` or `build` folder.
- Workspaces (`pnpm-workspace.yaml`, `workspaces` in `package.json`): each package becomes a sub-project.

**Shared context** is what makes this more than a bundle of utilities. Each tool publishes facts about the project, and other tools read them:

| Producer | Fact | Consumers |
| --- | --- | --- |
| Env manager | `PORT`, `DATABASE_URL`, `API_URL` | Port manager, DB panel, health checks |
| Scripts runner | running processes and their PIDs | Port manager, log viewer |
| Port manager | which port belongs to which project | Project overview, static server |
| Project detection | framework, build output folder, Claude Code files | Static server, mock API, Claude panel |

Example: the port manager does not just say "PID 41233 listens on 3000". It says "3000 is `api` in project shop-backend, started by `pnpm start:dev`", because the scripts runner told it so.

## Tech stack and architecture

The renderer is a plain React app with no Node access; everything that touches the OS runs in the main process behind a typed, validated IPC layer. Tools are modules with a main half and a renderer half, so new tools plug in without changing the core.

**Layers (top to bottom)**

1. Renderer (React + Vite): app shell (sidebar, overview, command palette), tool panels (one lazy-loaded React panel per tool), state (TanStack Query for IPC calls, Zustand for UI state).
2. Preload bridge: exposes `window.nestbox` via `contextBridge`; whitelisted channels only.
3. Main process (Node): IPC router (Zod-validates every payload, routes to tool handlers, pushes events to the renderer) → tool modules (handlers per tool, publish shared context, own their settings slice) → core services (ProcessManager, PortScanner, EnvFile parser/writer, StaticServer, Store).
4. Operating system: filesystem, child processes, TCP ports, network.

The renderer talks to main only through typed invoke calls and event subscriptions (`ipcMain.handle` / `webContents.send`). Tool modules are the extension point; router, services and shell stay the same as tools are added.

**Stack**

| Area | Choice |
| --- | --- |
| Shell and build | Electron with `electron-vite`, packaged by `electron-builder` |
| UI | React, Vite, TypeScript (strict), Tailwind, shadcn/ui |
| State | TanStack Query for IPC calls, Zustand for UI state |
| Validation | Zod schemas shared between main and renderer |
| Logs | `@tanstack/react-virtual` for the list, an ANSI-to-HTML converter for colours |
| Processes | `child_process.spawn`, `tree-kill` (or `taskkill` via the adapter) |
| Static server | Node `http`/`https` with `sirv`, `selfsigned` for certificates, `qrcode` for the LAN QR |
| Storage | `electron-store` |
| Tests | Vitest for main and shared code, Playwright's Electron support for end-to-end |

**IPC contract.** One shared file defines every channel with its input and output schema. The preload exposes a typed `window.nestbox` object generated from that file, and the main router validates each payload before calling the handler. Streams (log lines, port changes) go the other way as events, batched every ~50 ms.

**Tool interface.** A tool is two small objects that share an id:

```ts
// shared/tool.ts
export interface ToolDefinition<S> {
  id: string;                 // 'scripts', 'ports', 'env', 'static', 'claude'
  name: string;
  icon: string;
  appliesTo(p: DetectedProject): boolean;
  settingsSchema: z.ZodType<S>;
}

// main/tools/<id>/index.ts
export interface MainTool<S> extends ToolDefinition<S> {
  handlers: Record<string, (ctx: ToolContext, input: unknown) => Promise<unknown>>;
  activate?(ctx: ToolContext): void;      // start watchers
  dispose?(): Promise<void>;              // kill processes, close servers
}

export interface ToolContext {
  project: DetectedProject;
  shared: { get(key: string): unknown; publish(key: string, value: unknown): void };
  emit(event: string, payload: unknown): void;
  platform: PlatformAdapter;              // OS-specific port and process calls
  settings: { get(): S; update(fn: (s: S) => S): S }; // the tool's slice of toolSettings
}
// Tools that need core services (ProcessManager, dialogs) are built by factories: createScriptsTool(deps).

// renderer/tools/<id>/index.tsx
export interface RendererTool {
  id: string;
  Panel: React.FC<{ projectId: string }>;
  OverviewCard?: React.FC<{ projectId: string }>;
}
```

**Folder structure**

```text
src/
  main/
    index.ts              app lifecycle, window, tray, single-instance lock
    ipc/router.ts         validates and dispatches
    services/             process-manager, port-scanner, env-file, static-server, store
    platform/             adapter.ts, win32.ts, darwin.ts (stub until macOS phase)
    tools/                scripts/, ports/, env/, static/, claude/  (main halves)
  preload/
    index.ts              contextBridge -> window.nestbox
  renderer/
    app/                  shell, sidebar, command palette
    tools/                scripts/, ports/, env/, static/, claude/  (panels)
    components/           shared UI, log viewer
  shared/
    channels.ts           IPC channel schemas
    tool.ts               tool interfaces
    types.ts              Project, AppSettings
```

**Platform strategy: Windows first, macOS designed in.** All OS-specific code sits behind one interface. The Windows implementation ships in v1; the macOS one fills the same interface later, so no tool code changes.

```ts
// main/platform/adapter.ts
export interface PlatformAdapter {
  listListeningPorts(): Promise<PortEntry[]>;     // port, pid, processName, command
  killTree(pid: number): Promise<void>;
  spawnScript(opts: SpawnOpts): ChildProcess;     // handles .cmd shims and PATH
  openTerminal(cwd: string, command?: string): Promise<void>;
  openInEditor(path: string, line?: number): Promise<void>;
  resolveShellEnv(): Promise<NodeJS.ProcessEnv>;  // PATH as the user's shell sees it
  processStartTime(pid: number): Promise<number | null>; // tells a reused PID apart (orphan cleanup)
  notificationAppId(): string | null;             // Windows AppUserModelID for toasts
}

export const platform: PlatformAdapter =
  process.platform === 'win32' ? win32Adapter : darwinAdapter;
```

| Concern | Windows (v1) | macOS (later) |
| --- | --- | --- |
| Listening ports | `netstat -ano`, process names from `tasklist /FO CSV` | `lsof -iTCP -sTCP:LISTEN -P -n` |
| Kill process tree | `taskkill /PID <pid> /T /F` | spawn with `detached: true`, then kill the process group |
| Spawning npm, pnpm, yarn | They are `.cmd` shims; spawn through the shell, since current Node refuses to run `.cmd` files directly | Direct spawn |
| PATH | Inherited from the Windows environment | GUI apps miss the login shell's PATH; load it once from the user's shell |
| Terminal | Windows Terminal (`wt -d <path>`), fallback `cmd /K` | Terminal or iTerm via `open -a` |
| Tray icon | `.ico` in the notification area | Monochrome template image in the menu bar |
| Installer | NSIS via electron-builder; unsigned builds show a SmartScreen warning | DMG; notarization needs a paid Apple Developer account |

Two rules keep macOS cheap later: no `process.platform` checks outside `main/platform/`, and CI runs the unit tests on both Windows and macOS runners from the first commit, with the macOS adapter stubbed until its phase.

## v1 tools

v1 ships six tools that cover a normal dev day: start things, read their output, free stuck ports, keep env files in order, serve a build, and hand the project to Claude Code.

### 1. Project manager

The home screen. A sidebar lists projects; the main view shows an overview card per project.

- Add a folder by picker or drag-and-drop; remove, rename, pin, and tag projects.
- Overview card: name, package manager, running processes, used ports, git branch (read-only).
- "Open in VS Code" and "Open terminal here" actions.
- Command palette (`Ctrl/Cmd+K`): jump to a project or tool, run a script by name.

**Tray icon.** The app keeps running in the tray, so scripts survive closing the window.

- The menu lists projects with running processes; each has stop, restart and "Show logs".
- Start a saved run group; open a project in VS Code or Claude Code.
- The icon changes when a process crashes, and a native notification names it.
- Closing the window hides to the tray (setting `closeToTray`); Quit from the tray stops all tracked processes after a confirm.
- Single-instance lock: a second launch focuses the existing window.

### 2. Scripts runner and log viewer

One click starts any `package.json` script (or, since v1.21, a detected Python command or a custom command); its output streams into a log pane.

- Spawn with the detected package manager via the platform adapter, with `FORCE_COLOR=1` so colours survive.
- Several scripts per project at once, each in its own pane; split view to watch API and frontend side by side.
- Start, stop, restart. Stop kills the whole process tree, because `pnpm dev` spawns children that otherwise linger.
- Optional auto-restart on crash, with a backoff and a crash counter.
- "Run groups": a saved set of scripts that start together (for example API + web + worker).

The log viewer has two modes, picked per line:

- **Plain text**: ANSI colours rendered, search with highlight, clickable `file:line` links that open in the editor.
- **Structured JSON** (pino, NestJS with a JSON logger): parsed into rows with level, time, context and message; filter by level, context or `requestId`; expand a row to see the full object.
- Virtualised list, capped buffer (for example 50,000 lines per process) so long sessions stay fast.
- Export the visible lines to a file.

### 3. Port manager

Shows every listening TCP port on the machine and kills the owner in one click.

- List: port, PID, process name, command, and the Nestbox project and script that own it, when known.
- Kill, with a confirm step for processes Nestbox did not start.
- Watch list of common ports (3000, 5173, 5432, 6379, 8080) shown on the overview.
- Data source behind the platform adapter (see the platform table).
- On "EADDRINUSE" in a script's log, offer "Kill the process on port N and restart".

### 4. Env manager

Compares env files and keeps secrets out of sight.

- Table view of every `.env*` file side by side: keys as rows, files as columns.
- Flags keys missing from `.env` that exist in `.env.example`, and keys in `.env` that the example does not document.
- Values masked by default; reveal one at a time; copy without revealing.
- Profiles: switch the active `.env` between saved sets (local, staging) by copying, with a backup of the old file.
- Edits write back to the file and keep comments and key order.
- Publishes `PORT`, `DATABASE_URL` and URL-like keys to shared context.

### 5. Static server

Serves any folder over HTTP, by default the project's build output.

- Pick folder and port; start and stop; a list of running servers.
- SPA fallback: unknown routes return `index.html`, so React Router works.
- LAN access: binds to `0.0.0.0` and shows the LAN URL plus a QR code to open it on a phone.
- Optional HTTPS with a locally generated self-signed certificate (service workers need a secure context, which `localhost` gets for free but a LAN IP does not).
- Toggles: CORS headers, no-cache headers, simulated latency.
- Request log for the server, shown in the same log viewer.

### 6. Claude Code panel

Makes each project ready for Claude Code: shows what context the project already has, fills the gaps, and starts a session in the right folder in one click. It reads Claude Code's own project files and calls the `claude` CLI; it sends nothing anywhere itself.

**What it shows**

- Status: whether `claude` is on the PATH, and its version (`claude --version`).
- `CLAUDE.md` and `CLAUDE.local.md`: rendered preview, edit in place, create if missing.
- The `.claude/` folder: custom slash commands (`.claude/commands/`), subagents (`.claude/agents/`), skills, and the permissions and hooks in `settings.json` and `settings.local.json`.
- `.mcp.json`: the project's MCP servers, by name and command.
- A warning when `CLAUDE.local.md` or `settings.local.json` is not gitignored.

**Actions**

- Open in Claude Code: opens the configured terminal in the project folder, running `claude`.
- Continue last session: the same, with `claude --continue`.
- Open terminal here: a plain shell in the project folder.
- Quick prompt: a one-line prompt run headless with `claude -p`, its output streamed into the log viewer. It runs with the project's own permission settings; Nestbox adds no flags that skip them.
- Command palette entries: "Claude: open <project>" and "Claude: continue <project>".

**Context generator.** Builds a "Project runtime" block for `CLAUDE.md` from what Nestbox already knows, shown as a diff before anything is written: package manager, scripts and run groups; ports from the env and port managers; env key names from `.env.example` (never values); stack facts from detection (Prisma schema location, Docker services, workspace packages). The block sits between `<!-- nestbox:start -->` and `<!-- nestbox:end -->` markers, so regenerating it never touches hand-written text.

**Implementation notes.** Terminal launch is a `PlatformAdapter` method. Claude Code's file layout can change between versions: keep the reader in one module, parse defensively, and show unknown files as raw text.

## v2 tools (out of scope for v1)

v2 starts with the macOS build, then adds one tool per release, smallest first. Each is a new module, not a change to the core.

| Tool | What it does | Reads from shared context | Size |
| --- | --- | --- | --- |
| Database panel | Checks `DATABASE_URL` is reachable; one-click `prisma migrate status`, `migrate dev`, `generate`, Prisma Studio | `DATABASE_URL` | S |
| Git glance | Branch, uncommitted count, ahead/behind, last commit; read-only on the overview card | none | S |
| TODO scanner | `TODO`/`FIXME`/`HACK` comments grouped by file, linked via `vscode://file/...`; respects `.gitignore` | none | S |
| Health checks | URLs per project pinged every N seconds; green or red dot on the overview | `PORT`, `API_URL` | S |
| Docker Compose | Services from `docker-compose.yml` with status, start, stop, logs into the log viewer | Log viewer | S |
| Mock API | UI-defined routes returning JSON with latency and error toggles; saved per project | Free port | M |
| Request inspector | Records incoming requests and replays them to the API; later a `cloudflared` tunnel | API port | M |

### Next in v2: Node version check and dependency health

Both tools work with npm, pnpm, yarn and bun, using the package manager that project detection already found.

**Node version check (S).**
- Reads the required version from `.nvmrc`, `.node-version`, `engines.node` and `volta.node`. The first one found wins, and conflicts between them are flagged.
- Checks the `packageManager` field (for example `pnpm@10.30.2`) against the package manager version actually installed.
- Compares both with the Node and package manager that will really run the scripts, resolved through the platform adapter's shell environment, using semver ranges.
- Warns before a script starts on the wrong version.
- Fix actions depend on the version manager:
  - with fnm, scripts run on the required version;
  - Volta switches per project on its own;
  - nvm-windows switches for the whole machine, so NestBox only warns and never changes it silently.

**Dependency health (M).**
- One adapter per package manager runs that manager's own outdated and audit commands with JSON output, so private registries and `.npmrc` authentication keep working.
- Results are normalised into one shape: package, current, wanted, latest, a major-bump flag, vulnerability severity and an advisory link.
- Where a package manager has no JSON output for a command (for example Yarn Berry's outdated), the adapter falls back to reading installed versions and asking the configured registry.
- `npm outdated` exits non-zero when it finds outdated packages; that is a result, not a failure.
- Workspaces: results per package, rolled up to the root.
- A cross-project view shows which projects use a given package and at which versions, and which projects have high or critical advisories.
- Runs only when the user clicks Check, or on a schedule the user turns on. Results are cached with a timestamp.
- **This is the one exception to NestBox's no-network rule:** it reaches the network through the package manager, and only then.
- Exact command flags are verified against each package manager's current version when the tool is built.

### Next in v2: deployment tools

Three tools for the step after "it works locally", one release each. They reach the platforms only through their official CLIs (Vercel, Netlify, Wrangler for Cloudflare, flyctl), which the user installs and logs in to. NestBox stores no token or account, and goes to the network only when the user acts: the same exception as dependency health. Render and Railway come later.

**Deployments (M, v1.14.0).**
- Detects `vercel.json`/`.vercel`, `netlify.toml`/`.netlify`, `wrangler.toml`/`wrangler.json(c)` (Workers or Pages) and `fly.toml`.
- Lists recent deployments (state, environment, branch, age, URL) when the tab opens and on Refresh, with links to the deployment, its logs and the dashboard. Netlify shows the linked site and links to its deploy history (its deploy list needs a JSON argument that can't pass through cmd.exe safely).
- Deploy preview runs at once and streams its output into a log; production asks first, naming the package and the platform. Fly.io has no previews. Rollback stays in the dashboard.
- Logged-out and unlinked CLIs get **Log in** and **Link** buttons that open a terminal with the CLI's own command.

**Env vs production (S, v1.15.0).** Compares the keys in the local `.env` files with the platform's variables for an environment picked from a selector (production preselected): missing on either side, key names only, never values.

**Ready to deploy (M, v1.16.0).** "Run checks" runs the scripts the user picks (build, test, lint and typecheck preselected when present) in the log viewer, plus instant checks: the Node version against the platform's runtime, high or critical advisories from the dependency cache, env keys present in production, and git clean and pushed. The result is a green, amber or red summary.

### Next in v2: Python backends (S, v1.21.0)

Many projects pair a React (or other Node) frontend with a Python backend. NestBox finds the backend and starts it next to the frontend.

- A folder is a Python package when it has `pyproject.toml`, `requirements.txt`, `setup.py`, `setup.cfg`, `Pipfile`, `manage.py`, or any `.py` file at its top. Helper folders (`scripts`, `tools`, `bin`, `docs`, `migrations`) don't count through loose `.py` files.
- Python packages one or two folders down are packages of the project, beside `package.json` ones. "Add project" on a folder holding `frontend/` and `backend/` offers **Add as one project**, so one run group starts both.
- Detected commands: Django (`runserver`, `migrate`), a module-level FastAPI app (`python -m uvicorn <module>:<app> --reload`), a Flask app (`python -m flask --app <module> run --debug`), else each script with a `__main__` guard.
- Custom commands for any package: a program and its arguments, run without a shell.
- A local virtualenv (`.venv`, `venv`, `env`) goes first on PATH with `VIRTUAL_ENV` set; output is unbuffered UTF-8. Without one, `python` is the platform's (`python3` on macOS).
- A `.py` file picker for custom commands. Detected commands can be removed (hidden, with Restore). A package without its own virtualenv uses the project folder's, and the Scripts tab can pick another (one found in the project, a folder anywhere, or system Python).
- Later: uv/poetry runners, `[tool.poe]`/`[tool.pdm]` tasks, `.python-version` checks, pip-audit.

## Data model and persistence

All state lives on the user's machine in one JSON store; project files stay the source of truth. Nestbox stores only what it cannot re-read from the project folder.

- Store: `electron-store` (JSON in the app's user-data folder), validated with Zod on load, with a `schemaVersion` field and migrations.
- Not stored: env values, script lists, ports. These are read live from the folder or the OS.
- Logs: in memory only, in a ring buffer per process; export on demand.

```ts
type Project = {
  id: string;
  name: string;
  path: string;
  tags: string[];
  pinned: boolean;
  runGroups: { name: string; entries: { relPath: string; script: string }[] }[]; // relPath '' = root package
  envProfiles: { name: string; file: string }[];
  staticServer?: { folder: string; port: number; spa: boolean; https: boolean };
  toolSettings: Record<string, unknown>; // per tool id, owned by the tool
};

type AppSettings = { // schemaVersion lives at the store root, next to settings and projects
  theme: 'system' | 'light' | 'dark';
  editorCommand: string; // e.g. 'code'
  terminalApp: string;   // e.g. 'wt', 'iTerm'
  logBufferLines: number;
  closeToTray: boolean;  // closing the window keeps the app in the tray
  trayIconTheme: 'auto' | 'dark-taskbar' | 'light-taskbar';
};
```

Each tool owns its slice of `toolSettings` and validates it with its own schema, so adding a tool never touches the core types.

## Roadmap

v1 is four milestones, each ending in a tagged release; v2 starts only once v1 has been used daily on real projects.

| Milestone | Scope |
| --- | --- |
| M0 Skeleton | electron-vite + React scaffold, typed IPC + preload, project list + persistent store, project detection, platform adapter interface (Windows impl + macOS stub), CI on windows-latest and macos-latest |
| M1 Scripts + logs | Run/stop/restart scripts, process-tree kill, plain + JSON log viewer, run groups, tray icon |
| M2 Ports + env | Port list (Windows), kill + EADDRINUSE fix, env diff + masking, env profiles |
| M3 Static + ship | Static server with SPA fallback, LAN QR + HTTPS, Claude Code panel, command palette, Windows NSIS installer, README |
| Gate: v1 release | Used daily on own projects |
| v2 | macOS build first, then one v2 tool per release, smallest first |

## Risks

- **Cross-platform process handling.** Mitigation: one `PlatformAdapter` interface, Windows first, macOS second, both tested on GitHub Actions runners.
- **Zombie processes.** Mitigation: kill all tracked trees on quit; record PIDs and clean up on next start.
- **Secrets exposure.** Mitigation: mask by default; never write env values to the store or the app's own logs.
- **Electron shell security.** Mitigation: `contextIsolation` on, `nodeIntegration` off, sandboxed renderer, strict CSP, whitelist of IPC channels.
- **Log performance.** Mitigation: batch log lines in main, send every ~50 ms, virtualise the list.
- **Scope.** Six v1 tools is the ceiling; v2 tools wait for the gate.

## Portfolio presentation

- Public GitHub repo with a README that leads with a 30-second GIF: add project, run scripts, kill port, serve build on a phone.
- Architecture section in the README and a short "how to write a tool" guide.
- Windows installer on GitHub Releases, built by GitHub Actions; macOS DMG once that phase lands.
- MIT `LICENSE` and a short `CONTRIBUTING.md`.
- A short write-up of one hard problem solved (process trees across OSes, or the log pipeline).
