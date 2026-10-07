import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, type BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, session, shell, systemPreferences, Tray } from 'electron';
import { splitProjectId } from '@shared/detected';
import { NestboxError } from '@shared/errors';
import type { EventChannel } from '@shared/ipc-names';
import { healthDefinition } from '@shared/tools/health/contract';
import { brandAsset } from './assets';
import { detectProject } from './detection/detect-project';
import { isDirectory } from './detection/fs-utils';
import { createCoreHandlers } from './ipc/core-handlers';
import { registerIpc } from './ipc/register';
import { createRouter } from './ipc/router';
import { createConsoleLogger } from './logger';
import { spawnRunner } from './platform/command-runner';
import { createPlatformAdapter } from './platform';
import { ProjectService } from './projects/project-service';
import { buildCsp } from './security/csp';
import { applySessionSecurity, hardenAllWebContents } from './security/harden';
import { isAppUrl } from './security/origin';
import { createElectronStoreBackend } from './store/electron-store-backend';
import { StoreService } from './store/store-service';
import { createPidLedger } from './processes/pid-ledger';
import { type ProcessEvent, ProcessManager } from './processes/process-manager';
import { isToolEnabled } from '@shared/tools';
import { PortService } from './ports/port-service';
import { throttle } from './processes/throttle';
import { createMainTools } from './tools';
import { createClaudeCli } from './tools/claude/cli';
import { createClaudeDocs } from './tools/claude/docs';
import { entries, parseEnv } from './tools/env/dotenv';
import { createEnvFileAccess } from './tools/env/env-files';
import { watchDir } from './fs/watch-dir';
import { createCertStore, generateWithSelfsigned } from './tools/static/cert-store';
import { firstFreePort, lanAddresses } from './tools/net';
import { checkReachable } from './tools/database/reach';
import { checkUrl } from './tools/health/check';
import { ENV_FILE_PATTERN } from './detection/detect-project';
import { createSharedContext } from './tools/shared-context';
import { READY_SCRIPT_TIMEOUT_MS, waitForScript } from './tools/deploy/run-script';
import { createDepsCache } from './tools/deps/cache';
import { createDepsScheduler } from './tools/deps/scheduler';
import { createToolHost, type ToolHost } from './tools/tool-host';
import { handleOrphans } from './lifecycle/orphan-prompt';
import { createQuitController, SHUTDOWN_TIMEOUT_MS } from './lifecycle/quit-controller';
import { appMenuTemplate } from './app-menu';
import { crashNotice } from './tray/crash-notifier';
import { createTrayController, type TrayController } from './tray/tray-controller';
import { buildTrayModel, type TrayActions } from './tray/tray-menu';
import { createMainWindow } from './window';
import { applyWindowTheme } from './window-theme';

const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];

// End-to-end tests run against an isolated profile. Only honoured unpackaged, and before the
// single-instance lock, which is keyed on the userData folder.
const userDataOverride = app.isPackaged ? undefined : process.env['NESTBOX_USER_DATA_DIR'];
if (userDataOverride) app.setPath('userData', userDataOverride);
// End-to-end tests (unpackaged only): windows show without taking focus, and on macOS the app stays out of the
// Dock and never comes to the front, so a test run doesn't steal the screen.
const quietWindow = !app.isPackaged && process.env['NESTBOX_E2E_QUIET'] === '1';
if (quietWindow) app.dock?.hide();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  const logger = createConsoleLogger();

  /** Brings the window back from the tray, the taskbar or behind other windows. */
  const showWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (quietWindow) {
      mainWindow.showInactive();
      return;
    }
    mainWindow.show();
    mainWindow.focus();
  };

  app.on('second-instance', showWindow);

  // Closing the window hides it or runs the quit flow (quit controller); never quit implicitly.
  app.on('window-all-closed', () => {});

  void app.whenReady().then(() => {
    const store = new StoreService(createElectronStoreBackend(app.getPath('userData')), logger);
    /** Settings → Tools (v1.17): the core is always on. */
    const toolEnabled = (toolId: string) => isToolEnabled(store.getSettings().disabledTools, toolId);
    const platform = createPlatformAdapter({
      // Development only, like NESTBOX_USER_DATA_DIR: the end-to-end tests' fake commands.
      ...(app.isPackaged || !process.env['NESTBOX_PATH_PREPEND'] ? {} : { pathPrepend: process.env['NESTBOX_PATH_PREPEND'] }),
      runner: spawnRunner,
      getEditorCommand: () => store.getSettings().editorCommand,
      getTerminalApp: () => store.getSettings().terminalApp,
      logger,
    });
    // Before any window exists: Windows ties a window's taskbar button (and its icon) to the AppUserModelID it
    // had when created. Set later, the button no longer matches the installer's shortcut and shows Electron's icon.
    const appId = platform.notificationAppId();
    if (appId) app.setAppUserModelId(appId);
    /** False until the renderer has loaded, and again after its process died (until the reload finishes). */
    let rendererReady = false;
    const emit = (channel: EventChannel, payload?: unknown): void => {
      if (!rendererReady || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
      mainWindow.webContents.send(channel, payload);
    };
    let tray: TrayController | null = null;
    const refreshTray = throttle(() => tray?.refresh(), 250);

    const projects = new ProjectService({
      store,
      samePath: platform.samePath,
      resolvePath: (p) => resolve(p),
      isDirectory,
      detect: (input) =>
        detectProject(input, {
          onWarning: (file, reason) => logger.warn('detection skipped a file', { file, reason }),
        }),
      newId: randomUUID,
      onChanged: () => {
        emit('projects:changed');
        refreshTray();
      },
      logger,
    });
    // Not awaited: the window opens while detection runs; projects:list joins the in-flight work.
    void projects.init();

    const ledger = createPidLedger(join(app.getPath('userData'), 'processes.json'), logger);
    const processes = new ProcessManager({
      platform,
      ledger,
      bufferLines: () => store.getSettings().logBufferLines,
      logger,
    });
    const notifyProcesses = throttle(() => emit('processes:changed'), 100);
    processes.on((event) => {
      if (event.type === 'changed') notifyProcesses();
    });

    const ports = new PortService({ platform, processes, ownPid: process.pid, now: Date.now, logger });

    const assetEnv = { isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath };
    const shared = createSharedContext();
    const envFiles = createEnvFileAccess();
    // Scripts ask the Node tool and drive the Compose tool through the host (created below), so validation applies.
    let toolHostRef: ToolHost | null = null;
    const invokeCompose = async (projectId: string, method: 'up' | 'stop', input: object) => {
      if (!toolHostRef) throw new NestboxError('INTERNAL', 'Tools are not ready');
      return (await toolHostRef.invoke('compose', projectId, method, input)) as { ok: boolean };
    };
    const invokeTool = async (toolId: string, projectId: string, method: string, input: unknown) => {
      if (!toolHostRef) throw new NestboxError('INTERNAL', 'Tools are not ready');
      return toolHostRef.invoke(toolId, projectId, method, input);
    };
    /** "Run checks": a normal script start (Node advice, its own log), watched until it ends. */
    const runScriptToEnd = (projectId: string, script: string) =>
      waitForScript({
        processes: { on: (l) => processes.on(l), get: () => processes.get(projectId, script) },
        start: () => invokeTool('scripts', projectId, 'start', { script }),
        stop: () => invokeTool('scripts', projectId, 'stop', { script }),
        timeoutMs: READY_SCRIPT_TIMEOUT_MS,
      });
    const healthListeners = new Set<(event: ProcessEvent) => void>();
    processes.on((event) => {
      for (const listener of healthListeners) listener(event);
    });
    const depsCache = createDepsCache(join(app.getPath('userData'), 'deps-cache.json'), logger);
    const depsRunning = new Set<string>();
    const tools = createMainTools({
      scripts: {
        processes,
        runGroups: {
          get: (rootId) => projects.getRunGroups(rootId),
          set: (rootId, groups) => projects.setRunGroups(rootId, groups),
        },
        getDetected: (id) => projects.getDetected(id),
        shared,
        platform,
        saveFile: async (defaultName) => {
          const options = {
            defaultPath: join(app.getPath('downloads'), defaultName),
            filters: [{ name: 'Log', extensions: ['log', 'txt'] }],
          };
          const result = mainWindow
            ? await dialog.showSaveDialog(mainWindow, options)
            : await dialog.showSaveDialog(options);
          return result.canceled || !result.filePath ? null : result.filePath;
        },
        writeFile: (path, text) => writeFile(path, text, 'utf8'),
        isFile: async (path) => {
          try {
            return (await stat(path)).isFile();
          } catch {
            return false;
          }
        },
        emit: (projectId, event, payload) => emit('tools:event', { toolId: 'scripts', projectId, event, payload }),
        logger,
        envFiles: {
          list: async (dir) => (await envFiles.list(dir)).map((f) => f.name),
          // Values go to the script's process only (ProcessManager): never logged or kept.
          read: async (dir, file) => {
            try {
              return Object.fromEntries(entries(parseEnv((await envFiles.read(dir, file)).text)));
            } catch (error) {
              if (error instanceof NestboxError && error.code === 'NOT_FOUND') return null;
              throw error;
            }
          },
        },
        node: {
          advice: async (projectId) => {
            if (!toolHostRef) throw new NestboxError('INTERNAL', 'Tools are not ready');
            return (await toolHostRef.invoke('node', projectId, 'startAdvice', {})) as {
              warning: string | null;
              pathPrepend: string | null;
              note: string | null;
            };
          },
        },
        compose: {
          up: (projectId, services, { wait }) =>
            invokeCompose(projectId, 'up', services.length > 0 ? { services, wait } : { wait }),
          stop: (projectId, services) => invokeCompose(projectId, 'stop', services.length > 0 ? { services } : {}),
        },
      },
      env: {
        files: envFiles,
        clipboard: { writeText: (text) => clipboard.writeText(text) },
        watch: (dir, onChange) => {
          try {
            const watcher = watch(dir, { persistent: false }, (_event, name) => {
              if (name === null || ENV_FILE_PATTERN.test(String(name))) onChange(name === null ? null : String(name));
            });
            watcher.on('error', () => watcher.close());
            return () => watcher.close();
          } catch {
            // A folder that can't be watched still works; the panel refreshes after its own edits.
            return null;
          }
        },
        logger,
      },
      static: {
        certStore: createCertStore({
          file: join(app.getPath('userData'), 'static-cert.json'),
          generate: generateWithSelfsigned,
          now: Date.now,
        }),
        pickFolder: async (defaultPath) => {
          const options = { properties: ['openDirectory' as const], title: 'Folder to serve', defaultPath };
          const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
        lanAddresses: () => lanAddresses(),
        logger,
      },
      claude: {
        cli: createClaudeCli({ platform, now: Date.now }),
        docs: createClaudeDocs(),
        envFiles,
        runGroups: { get: (rootId) => projects.getRunGroups(rootId) },
        logger,
      },
      git: { watch: watchDir, logger },
      database: { envFiles, checkReachable, firstFreePort, logger },
      todos: { logger },
      health: {
        // Gated: while Health is off it sees no live scripts, so no checks run.
        processes: {
          list: () => (toolEnabled('health') ? processes.list() : []),
          on: (listener) => {
            healthListeners.add(listener);
            return () => healthListeners.delete(listener);
          },
        },
        getDetected: (id) => {
          try {
            return projects.getDetected(id);
          } catch {
            return null;
          }
        },
        readSettings: (rootId) => {
          const parsed = healthDefinition.settingsSchema.safeParse(projects.getToolSettings(rootId, 'health') ?? {});
          return parsed.success ? parsed.data : healthDefinition.settingsSchema.parse({});
        },
        envFiles,
        check: checkUrl,
        emit: (projectId, event) => emit('tools:event', { toolId: 'health', projectId, event, payload: undefined }),
        notify: ({ projectId, title, body }) => {
          if (!Notification.isSupported()) return;
          const notification = new Notification({ title, body, icon: brandAsset(assetEnv, 'png/app-icon-64.png') });
          notification.on('click', () => {
            showWindow();
            emit('app:navigate', { projectId, tab: 'health' });
          });
          notification.show();
        },
        logger,
      },
      compose: { logger },
      mock: { logger },
      inspector: { logger, envFiles, clipboard: { writeText: (text) => clipboard.writeText(text) } },
      node: { logger, getDetected: (id) => projects.getDetected(id) },
      deps: { logger, cache: depsCache, running: depsRunning, clipboard: { writeText: (text) => clipboard.writeText(text) } },
      deploy: { logger, envFiles, tools: { invoke: invokeTool }, runScript: runScriptToEnd },
      ci: { logger },
    });
    const toolHost = createToolHost({
      tools,
      getProject: (id) => projects.getDetectedAsync(id),
      shared,
      platform,
      emit: (payload) => emit('tools:event', payload),
      logger,
      isEnabled: toolEnabled,
      toolSettings: {
        get: (rootId, toolId) => projects.getToolSettings(rootId, toolId),
        set: (rootId, toolId, value) => projects.setToolSettings(rootId, toolId, value),
      },
    });
    toolHostRef = toolHost;
    let disabledBefore: readonly string[] = [...store.getSettings().disabledTools];
    const depsScheduler = createDepsScheduler({
      rootIds: async () => (await projects.list()).map((p) => p.id),
      schedule: () => (toolEnabled('deps') ? store.getSettings().depsSchedule : 'off'),
      lastChecked: (rootId) => depsCache.get(rootId)?.checkedAt ?? null,
      check: async (rootId) => {
        await toolHost.invoke('deps', rootId, 'check', {});
      },
      onChange: () => undefined,
      logger,
    });
    depsScheduler.start();

    /** "shop" for a root, "shop · api" for a workspace package. Names only, never paths. */
    const projectLabel = (projectId: string): string | null => {
      const { rootId, relPath } = splitProjectId(projectId);
      const root = store.getProjects().find((p) => p.id === rootId);
      if (!root) return null;
      if (relPath === '') return root.name;
      let name = relPath.split('/').at(-1) ?? relPath;
      try {
        name = projects.getDetected(projectId).name;
      } catch {
        // not detected yet: the folder name will do
      }
      return `${root.name} · ${name}`;
    };

    const quitController = createQuitController({
      liveCount: () => processes.liveCount(),
      confirmQuit: async (n) => {
        const options = {
          type: 'question' as const,
          buttons: ['Stop and quit', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          message: `Stop ${n} running ${n === 1 ? 'script' : 'scripts'} and quit?`,
          detail: 'NestBox stops the scripts it started before quitting.',
        };
        const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
        return result.response === 0;
      },
      shutdown: async () => {
        depsScheduler.stop();
        const [, disposed] = await Promise.allSettled([processes.stopAll(), toolHost.disposeAll(SHUTDOWN_TIMEOUT_MS - 500)]);
        if (disposed.status === 'fulfilled' && disposed.value.failed.length + disposed.value.timedOut.length > 0) {
          logger.warn('tools did not dispose cleanly', {
            failed: disposed.value.failed.join(','),
            timedOut: disposed.value.timedOut.join(','),
          });
        }
        // No ledger.clear(): each process removes its own entry when it closes. Entries that remain belong to
        // trees that did not exit (or to the previous session, not yet answered) and are offered next start.
      },
      quit: () => app.quit(),
      // Without a tray icon a hidden window could not be brought back, so closing quits instead.
      closeToTray: () => tray !== null && store.getSettings().closeToTray,
      hideWindow: () => mainWindow?.hide(),
      logger,
    });
    app.on('before-quit', (event) => quitController.onBeforeQuit(event));

    if (platform.id === 'darwin') {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(
          appMenuTemplate({
            appName: app.name,
            isDev: !app.isPackaged,
            actions: {
              settings: () => {
                showWindow();
                emit('app:openSettings');
              },
              quit: () => void quitController.requestQuit(),
            },
          }),
        ),
      );
      // A click on the Dock icon brings the (hidden) window back.
      app.on('activate', showWindow);
    }

    const showLogs = (projectId: string, script: string): void => {
      showWindow();
      emit('app:navigate', { projectId, tab: 'scripts', script });
    };

    const trayActions: TrayActions = {
      show: showWindow,
      quit: () => void quitController.requestQuit(),
      stop: (projectId, script) => void processes.stop(projectId, script).catch(() => undefined),
      restart: (projectId, script) =>
        void processes.restartExisting(projectId, script).catch(() => logger.warn('tray restart failed', { script })),
      showLogs,
      startRunGroup: (rootId, name) =>
        void toolHost.invoke('scripts', rootId, 'startRunGroup', { name }).catch(() => logger.warn('tray run group failed')),
      openInEditor: (rootId) => {
        const open = async () => platform.openInEditor(projects.getDetected(rootId).path);
        open().catch((error: unknown) =>
          dialog.showErrorBox('Could not open the editor', error instanceof Error ? error.message : 'Unexpected error'),
        );
      },
    };

    const entryFileUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href;
    const isTrusted = (url: string): boolean => isAppUrl(url, { devServerUrl, entryFileUrl });
    const dispatch = createRouter({
      handlers: createCoreHandlers({
        projects,
        toolHost,
        platform,
        isDirectory,
        settings: store,
        processes,
        ports,
        deps: {
          overview: async () => ({
            projects: (await projects.list()).map((p) => ({
              id: p.id,
              name: p.name,
              packages: [p.id, ...p.detected.workspaces.map((w) => w.id)]
                .map((id) => depsCache.get(id))
                .filter((r) => r !== undefined),
              checking: depsRunning.has(p.id),
            })),
            runningAll: depsScheduler.running(),
            schedule: store.getSettings().depsSchedule,
          }),
          checkAll: () => {
            if (toolEnabled('deps')) void depsScheduler.runAll();
          },
        },
        onSettingsChanged: (settings) => {
          nativeTheme.themeSource = settings.theme;
          tray?.refresh();
          // A tool turned off lets go of every project (its servers, followers and watchers stop).
          const off = settings.disabledTools.filter((id) => !disabledBefore.includes(id) && !toolEnabled(id));
          const rootIds = store.getProjects().map((p) => p.id);
          for (const toolId of off) toolHost.deactivate(toolId, rootIds);
          if (off.includes('health') || (disabledBefore.includes('health') && toolEnabled('health')))
            for (const listener of healthListeners) listener({ type: 'changed' });
          if (off.length > 0) logger.info('tools turned off', { count: off.length });
          disabledBefore = [...settings.disabledTools];
        },
        appInfo: () => ({ version: app.getVersion(), platform: platform.id }),
        openExternal: (url) => shell.openExternal(url),
        pickFolder: async () => {
          const options = { properties: ['openDirectory' as const], title: 'Add project folder' };
          const result = mainWindow
            ? await dialog.showOpenDialog(mainWindow, options)
            : await dialog.showOpenDialog(options);
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
      }),
      isTrustedSender: isTrusted,
      logger,
    });
    registerIpc(ipcMain, dispatch);

    hardenAllWebContents(app, isTrusted);
    applySessionSecurity(session.defaultSession, devServerUrl ? { devCsp: buildCsp({ dev: true }) } : {});

    // The renderer's light and dark tokens follow prefers-color-scheme, which follows themeSource.
    nativeTheme.themeSource = store.getSettings().theme;
    mainWindow = createMainWindow({
      platform,
      dark: nativeTheme.shouldUseDarkColors,
      devServerUrl,
      icon: brandAsset(assetEnv, 'png/nestbox.ico'),
      onQuitShortcut: () => void quitController.requestQuit(),
      quiet: quietWindow,
    });
    const hasOverlay = 'titleBarOverlay' in platform.windowChrome({ color: '', symbolColor: '', height: 0 });
    nativeTheme.on('updated', () => {
      if (mainWindow && !mainWindow.isDestroyed()) applyWindowTheme(mainWindow, { hasOverlay }, nativeTheme.shouldUseDarkColors);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      rendererReady = true;
    });
    // A renderer killed from Task Manager (or crashed) is reloaded; scripts keep running in main meanwhile.
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      rendererReady = false;
      logger.warn('renderer process gone', { reason: details.reason, exitCode: details.exitCode });
      if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    });
    mainWindow.on('close', (event) => quitController.onWindowClose(event));
    mainWindow.on('session-end', () => quitController.onSessionEnd());
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    // Everything below is independent of the window and of each other: a failure is logged, not fatal.
    try {
      tray = createTrayController({
        electron: {
          createTray: (image) => new Tray(image),
          buildMenu: (template) => Menu.buildFromTemplate(template),
          imageFromPath: (path) => nativeImage.createFromPath(path),
          nativeTheme,
        },
        assetPath: (rel) => brandAsset(assetEnv, rel),
        getModel: async () =>
          buildTrayModel(await projects.list(), processes.list(), (rootId) => projects.getRunGroups(rootId)),
        getProcesses: () => processes.list(),
        // The macOS menu bar follows the system appearance, so the icon does too.
        getTheme: () => (platform.id === 'darwin' ? 'auto' : store.getSettings().trayIconTheme),
        // The system's appearance, not the app's theme setting (themeSource changes shouldUseDarkColors). On macOS
        // Electron's system-UI flag equals shouldUseDarkColors, so read the user default the menu bar follows.
        systemDark: () =>
          platform.id === 'darwin'
            ? systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark'
            : nativeTheme.shouldUseDarkColorsForSystemIntegratedUI,
        clickShowsWindow: platform.id !== 'darwin',
        actions: trayActions,
        logger,
      });
    } catch {
      logger.error('tray unavailable');
    }
    processes.on((event) => {
      if (event.type === 'changed') refreshTray();
      if (event.type !== 'crashed' || !event.final || !Notification.isSupported()) return;
      const label = projectLabel(event.summary.projectId) ?? 'a removed project';
      const notification = new Notification({
        ...crashNotice(event.summary, label),
        icon: brandAsset(assetEnv, 'png/app-icon-64.png'),
      });
      notification.on('click', () => showLogs(event.summary.projectId, event.summary.script));
      notification.show();
    });

    mainWindow.once('ready-to-show', () => {
      void handleOrphans({
        ledger,
        listProcesses: () => platform.listProcesses(),
        killTree: (pid) => platform.killTree(pid),
        projectLabel,
        ask: async (message, detail) => {
          const options = {
            type: 'warning' as const,
            buttons: ['Stop them', 'Leave running'],
            defaultId: 0,
            cancelId: 1,
            message,
            detail,
          };
          const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
          return result.response === 0;
        },
        logger,
      });
    });
  });
}
