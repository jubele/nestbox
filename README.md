<p align="center">
  <img src="resources/brand/svg/nestbox-lockup-outlined.svg" alt="NestBox" width="340">
</p>

A desktop toolbox for Node.js, .NET, and other development projects. You add a project folder once, and NestBox gives you what a browser can't: run its scripts and read their logs, see which process holds port 3000 and stop it, keep `.env` files in step, serve a build to your phone, and hand the project to Claude Code with the right context.

Built with Electron, React and Vite. Runs on Windows and macOS (macOS is a preview for now). Linux is not planned.

<!-- GIF placeholder: a 30-second capture (add a project, run scripts, kill a port, serve a build on a phone) goes here. -->

![Scripts and logs](docs/screenshots/scripts.png)

## What it does

| | |
| --- | --- |
| **Projects** | Detects the package manager, scripts, workspace packages, env files, Prisma, Docker Compose, the build output and Claude Code files. Supports Node.js, .NET, and other languages via the ecosystem framework. Workspace packages appear as sub-projects. |
| **Scripts and logs** | Start, stop and restart scripts (the whole process tree), run groups (which can bring Docker Compose services up first and wait until they're healthy), auto-restart with backoff, your own commands (any program with arguments, run without a shell, with the env file you pick) and a main command per package (a project with packages lists each one's main command in its Scripts tab), and a virtualised log viewer with ANSI colours, JSON log levels, search and split panes. A tray icon shows what is running. |
| **Ports** | Every listening port on the machine, with the NestBox script that owns it. Stop the script, or kill a foreign process after confirming. "Port in use" errors in a log offer the fix. |
| **Env** | A matrix of keys across `.env`, `.env.example` and profiles (`.env.staging`, …): what is missing, empty or undocumented. Values stay masked until revealed. Edits keep comments and formatting, and profiles switch with a backup. Variables the code reads (`process.env.X`, `const { X } = process.env`, `import.meta.env.X`, `os.getenv("X")`) show up even when no file has them. |
| **Static** | Serves the build output with SPA fallback, CORS, no-cache and simulated latency. It can share on the LAN with a QR code, and HTTPS uses a self-signed certificate. Dotfiles are never served. |
| **Claude Code** | Shows whether the CLI is installed, previews and edits `CLAUDE.md`/`CLAUDE.local.md`, and lists commands, agents, skills, settings and MCP servers. It runs a quick `claude -p` prompt, and it writes a generated project-context block into `CLAUDE.md` after showing a diff. |
| **Git** | A read-only glance on the overview: branch (or detached commit), a merge or rebase in progress, uncommitted changes, ahead/behind the upstream as of the last fetch, and the last commit. The Git tab lists the changed files and opens them in the editor. NestBox never fetches or writes. |
| **Database** | Where `DATABASE_URL` points (provider, host, port and database; never the user or password) and whether the server answers. Test login runs `SELECT 1` through Prisma. Prisma buttons: migrate status and generate with their output, migrate dev in a terminal, and Prisma Studio. |
| **TODOs** | `TODO`, `FIXME`, `HACK`, `XXX` and `BUG` comments (the tags are editable per project), grouped by file, with counts on the overview. Files come from git (so `.gitignore` applies), or a folder walk outside git. A click opens the file at that line in the editor. |
| **Health** | HTTP checks that run while a package's scripts run: a URL, or the host of a `.env` key such as `API_URL` plus a path (the value never leaves the app). Green when it answers 2xx/3xx (or the status you expect) within 5 s, with the latency on the overview, and a desktop notification when a check that was green starts failing. `localhost:<PORT>` and URL-like keys are one-click suggestions. |
| **Compose** | For a package with a compose file: each service's state, health and published ports. Start, stop and restart one service, Up all or Stop all, and Down after a confirmation (volumes are never removed). One service's logs stream into the log viewer, and the output of the actions has its own log. A run group can include services, so one click starts the database and then the API. Docker runs the containers, so quitting NestBox leaves them as they are. |
| **Mock API** | JSON (or text) routes you define in the UI, served on a local port: `:params` and `*` in paths, `{{params.x}}`/`{{query.x}}` in the body, headers, a delay and a fail switch per route, plus an extra delay and "fail every request" for the whole server. CORS is always on, and a request log shows method, path, status and time (never headers, bodies or query strings). Routes are saved per project in NestBox. |
| **Inspector** | A proxy in front of your local API (`localhost:<PORT>` from `.env`, or an address you set). Point a client or webhook at the inspector port and every request and response is recorded: headers, bodies (gzip/br decoded) and timing. Secret headers (`Authorization`, cookies, API keys, tokens) stay masked until you reveal them. Replay a request, edit it and send, or copy it as curl. Recordings live in memory only (the last 200). **Share publicly** (with `cloudflared` installed) gives the inspector a temporary `trycloudflare.com` address for webhooks, after a confirmation. |
| **Node** | Which Node version a package needs (`.nvmrc`, `.node-version`, `engines.node` or `volta.node`, with the root as a fallback for workspace packages), whether those sources agree, and whether the Node and package manager that run its scripts match, including the `packageManager` field. A script started on the wrong version gets a warning in its log and a badge. With fnm, a per-project switch runs the scripts on the required version. NestBox only warns with nvm and nvm-windows, and never downloads anything (Corepack stays offline). |
| **Dependencies** | Outdated and vulnerable dependencies through the package manager's own `outdated` and `audit` commands (npm, pnpm, Yarn 1, Yarn 2+ and Bun; where a manager has no JSON outdated, NestBox reads the installed versions and asks the registry through it). Rows show installed, wanted and latest versions, major updates and advisories with their links. "Copy update command" is the only action: NestBox never changes `package.json` or the lockfile. Workspace packages are checked one by one and added up on the root. A **Dependencies** page in the sidebar shows which projects have high or critical advisories and which projects use a given package. Checks run only on Check or on a daily/weekly schedule you turn on in Settings; the last results are kept in the app's data folder. |
| **Deploy** | Vercel, Netlify, Cloudflare (Workers and Pages) and Fly.io, detected from their config files. The tab lists recent deployments (state, environment, branch, age) with links to each deployment, its logs and the dashboard. **Deploy preview** runs at once with its output in a log; **Deploy to production** asks first, naming the project and the platform. Everything goes through the platform's own CLI and its login: NestBox keeps no tokens, and a project's own CLI (a devDependency) wins over a global one. **Env** compares a local env file with the platform's variables for an environment you pick (production first) and lists the keys missing on either side: names only, never values. **Ready to deploy** runs the scripts you pick (build, test, lint and typecheck preselected) plus quick checks (the Node version the platform will use against yours, high or critical advisories from the last dependency check, env keys missing in production, git clean and pushed, and CI passing on the branch), and sums them up green, amber or red. Rollbacks stay in the platform's dashboard. |
| **CI** | GitHub Actions or GitLab CI, from the repository's remote. The tab lists the current branch's runs (or every branch's) with their state, workflow and age; pick one to see its jobs, open a failed job's log tail (the last 200 lines), or **Re-run failed jobs**. While a run is queued or running, the open tab follows it every 20 seconds. Everything goes through `gh` or `glab` and its login: NestBox keeps no token. The overview card shows the newest run the tab has seen, and **Ready to deploy** adds a CI check (passed, failed or still running on your branch). |
| **Sidebar** | Projects in one-level groups you create; drag projects and groups to reorder them or move a project between groups (each row's menu does the same from the keyboard). Double-click or F2 renames a project inline; a workspace package gets an alias. A folder with app/ and api/ (each with a package.json) and no workspaces config shows up as one project with both as packages. |
| **Tools on or off** | Every tool except projects, scripts and ports can be turned off in Settings → Tools; a turned-off tool leaves the tabs, overview cards and palette, and stops running. A new install picks its tools on first start (Everything, Essentials or just the core). |
| **Themes** | Dark and light, following the system by default (Settings → Theme). |
| **Command palette** | `Ctrl+K`: jump to a project or tool, run or stop any script, start run groups, open Claude in a terminal. |

<table>
  <tr>
    <td><img src="docs/screenshots/overview.png" alt="Project overview"></td>
    <td><img src="docs/screenshots/ports.png" alt="Ports"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/env.png" alt="Env files"></td>
    <td><img src="docs/screenshots/static.png" alt="Static server"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/claude.png" alt="Claude Code"></td>
    <td><img src="docs/screenshots/palette.png" alt="Command palette"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/git.png" alt="Git"></td>
    <td><img src="docs/screenshots/todos.png" alt="TODOs"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/database.png" alt="Database"></td>
    <td><img src="docs/screenshots/compose.png" alt="Docker Compose"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/mock.png" alt="Mock API"></td>
    <td><img src="docs/screenshots/inspector.png" alt="Request inspector"></td>
  </tr>
</table>

## Install

The installers are built by GitHub Actions from the tagged commit ([release workflow](.github/workflows/release.yml)), so you can check what went into them. They are not code-signed yet.

**Windows.** Download `NestBox-Setup-<version>.exe` from [Releases](https://github.com/dnovacik/nestbox/releases) and run it. SmartScreen says "Windows protected your PC": choose **More info → Run anyway**.

**macOS (preview).** Download `NestBox-<version>-arm64.dmg` (Apple Silicon) or `NestBox-<version>-x64.dmg` (Intel), open it and drag NestBox to Applications. The app is ad-hoc signed but not notarized, so the first launch needs one extra step:
- macOS 14 and earlier: right-click NestBox in Applications → **Open** → **Open**.
- macOS 15 and later: open it once, then **System Settings → Privacy & Security → Open Anyway**.
- Or, if you prefer the terminal: `xattr -dr com.apple.quarantine /Applications/NestBox.app`.

The macOS build is tested in CI (unit, integration and end-to-end tests on `macos-latest`) but has seen little use on real Macs yet: please [open an issue](https://github.com/dnovacik/nestbox/issues) if something misbehaves. Ports of other users' processes need admin rights and are not listed.

## Development

Requirements: Node 22.12+, pnpm 10, Windows or macOS. On Linux the app runs with the macOS adapter for development (no ports list), and the end-to-end tests run under `xvfb-run`.

```bash
pnpm install
pnpm dev          # the app with hot reload
pnpm test         # Vitest: main/shared (node) and renderer (jsdom)
pnpm lint && pnpm typecheck
pnpm build        # main, preload and renderer into out/
pnpm e2e          # Playwright against the built app (Windows)
```

`node scripts/screenshots.mjs` (after `pnpm build`) recreates the screenshots above with demo projects. Run it under `xvfb-run` on Linux.

[CONTRIBUTING.md](CONTRIBUTING.md) covers the checks and rules for a pull request. [CLAUDE.md](CLAUDE.md) has the folder layout, conventions and gotchas. [docs/nestbox-spec.md](docs/nestbox-spec.md) is the source of truth for scope.

### Releasing

1. Set `version` in `package.json` and merge to `main`.
2. Tag the commit `v<version>` and push the tag.
3. The release workflow tests, builds and attaches the installer to a **draft** GitHub Release. Review it and publish.

## Architecture

```text
┌──────────────── main process (Node) ─────────────────┐       ┌──────── renderer (sandboxed) ────────┐
│ ProjectService · StoreService (electron-store + Zod) │       │ React + TanStack Query + Zustand     │
│ ProcessManager · PortService · quit controller · tray│       │ shell: sidebar, tabs, palette        │
│ Tool host ── tools: scripts, env, static, claude, …  │◀─────▶│ tool panels (lazy) + overview cards  │
│ PlatformAdapter (win32 | darwin)                     │  IPC  │ window.nestbox (preload bridge)      │
└──────────────────────────────────────────────────────┘       └──────────────────────────────────────┘
```

- **Typed IPC.** Every channel has a Zod input and output schema in `src/shared/channels.ts`. The router checks the sender's origin and validates each payload, then answers with an envelope (`{ ok, data }` or `{ ok: false, error: { code, message } }`). The renderer's typed client turns errors back into exceptions with a code.
- **Tools are modules.** A tool is a contract (methods with Zod schemas, plus events), a main half (handlers that get a `ToolContext`) and a renderer half (a panel and an optional overview card). The core routes `tools:invoke` to them generically: adding a tool never touches the channel list, the router or the shell.
- **Shared context.** Tools publish facts that other tools read. Scripts publishes running PIDs, which Ports uses to name the owner of a port; Env publishes `PORT`, which the overview shows.
- **One platform adapter.** Every OS-specific call lives behind `PlatformAdapter`: on Windows `cmd.exe`, `taskkill /T`, `netstat` and PowerShell; on macOS process groups, `lsof`, `ps`, the login-shell `PATH` and `open -a` for terminals. Lint rejects `process.platform` anywhere else. [Stopping a dev server for real](docs/writeups/process-trees.md) explains how process trees are stopped and cleaned up on both systems.
- **Logs flow one way.** Main keeps a ring buffer per process and sends batches every 50 ms. The renderer virtualises the list. Exports send sequence numbers back, never text.

### How to write a tool

The smallest tool is `project-info`. Three files make it:

1. **Contract** (`src/shared/tools/project-info/contract.ts`): the definition and the methods.

   ```ts
   export const projectInfoDefinition: ToolDefinition<{}> = {
     id: 'project-info', name: 'Project info', icon: 'info',
     appliesTo: () => true, settingsSchema: z.strictObject({}),
   };
   export const projectInfoContract = defineContract({
     getFacts: { input: z.strictObject({}), output: DetectedProjectSchema },
   });
   ```

   Register both in `src/shared/tools/index.ts`.

2. **Main half** (`src/main/tools/project-info/index.ts`): handlers receive the project, shared facts, the platform adapter, the tool's own settings and an `emit` for events.

   ```ts
   export const projectInfoTool = defineMainTool({
     ...projectInfoDefinition,
     contract: projectInfoContract,
     handlers: { getFacts: async (ctx) => ctx.project },
   });
   ```

   Add it to `createMainTools` in `src/main/tools/index.ts`. A tool that needs core services (the process manager, a native dialog) is a factory; see `createScriptsTool(deps)`.

3. **Renderer half** (`src/renderer/tools/project-info/`): a lazy `Panel`, an optional `OverviewCard` and a hook that calls `api.tools.invoke('project-info', projectId, 'getFacts', {})`, fully typed from the contract. Register it in `src/renderer/tools/registry.ts`.

Events (`defineEvents`) push data from main, as the static server's request log does. Settings (`settingsSchema` plus `ctx.settings`) persist per project. [CLAUDE.md](CLAUDE.md#adding-a-tool) has the full checklist.

## Security model

- The renderer is sandboxed with `contextIsolation` and no Node integration, under a strict CSP. It reaches main only through a whitelist of channels, and main checks the sender's origin on every call.
- Env values are never stored or logged. The renderer gets one value only when you reveal or edit it, and copying puts the value on the clipboard from main.
- Arguments that pass through `cmd.exe` are restricted and escaped. Free text, such as a Claude prompt, goes through stdin and never a command line.
- The static server binds to localhost unless LAN sharing is on, never serves dotfiles, and leaves query strings out of its log.
- The app makes no network calls of its own: no telemetry, no update checks, and fonts are bundled. The exceptions run other programs that you installed and logged in to, and only when you act: the Dependencies check runs your package manager's outdated and audit commands (so your registry and its auth apply) when you click Check or turn on the schedule, and the Deploy tab runs the platform's CLI to list deployments (when the tab opens or you click Refresh) to deploy, and to list variable names when you click Compare, and the CI tab runs `gh` or `glab` to list runs and jobs (when the tab opens, on Refresh, and every 20 seconds while a run is in progress), to show a job's log and to re-run failed jobs when you click.

## Roadmap

v1: projects, scripts and logs, ports, env, static server, Claude Code, command palette, Windows installer.

v2 started with the macOS build (v1.1.0, preview), git glance (v1.2.0), the database panel (v1.3.0), the TODO scanner (v1.4.0), health checks (v1.5.0), Docker Compose (v1.6.0), the mock API (v1.7.0), the request inspector (v1.8.0), its public tunnel (v1.9.0) Compose services in run groups (v1.10.0) the Node version check (v1.11.0), dependency health (v1.12.0), a light theme (v1.13.0) deployments (v1.14.0), env vs production (v1.15.0) the ready-to-deploy check (v1.16.0) tool toggles (v1.17.0), sidebar groups (v1.18.0), CI status (v1.19.0), multi-folder adding (v1.20.0) custom commands (v1.21.0) and favorites in a project's Scripts tab (v1.23.0). See [the spec](docs/nestbox-spec.md#v2-tools-out-of-scope-for-v1).

## License

[MIT](LICENSE)
