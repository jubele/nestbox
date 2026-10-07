import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export const REPO_ROOT = resolve(__dirname, '..');

/** A fresh copy of a fixture project, so tests never write into the repository. */
export async function copyFixture(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `nestbox-e2e-${name}-`));
  await cp(join(__dirname, 'fixtures', name), dir, { recursive: true });
  return dir;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readPid(project: string): Promise<number> {
  return Number((await readFile(join(project, 'server.pid'), 'utf8')).trim());
}

/**
 * Launches the built app with an isolated profile (a new one unless `userData` is given). The folder
 * picker returns `project`; native message boxes answer with their default (first) button and their
 * messages are recorded in `globalThis.__messageBoxes` in the main process (see messageBoxes()).
 */
export async function launch(
  project: string,
  opts: {
    userData?: string;
    /** Put first on PATH, e.g. a fake command. */ pathPrepend?: string;
    /** Start like a new install, with the first-run tool picker (by default the profile has answered it). */
    firstRun?: boolean;
  } = {},
): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = opts.userData ?? (await mkdtemp(join(tmpdir(), 'nestbox-e2e-profile-')));
  // A fresh profile is a new install, which opens the tool picker: answer it ahead unless the test wants it.
  if (!opts.userData && !opts.firstRun) {
    await writeFile(
      join(userData, 'config.json'),
      JSON.stringify({ schemaVersion: 2, settings: { toolsChosen: true }, projects: [] }),
    );
  }
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const path = opts.pathPrepend
    ? `${opts.pathPrepend}${delimiter}${process.env[pathKey] ?? ''}`
    : process.env[pathKey];
  // A dev-server URL in the environment would point the built app at a server that isn't running.
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      [pathKey]: path,
      NESTBOX_USER_DATA_DIR: userData,
      // The window shows without taking focus (and stays out of the macOS Dock); NESTBOX_E2E_SHOW=1 to watch.
      ...(process.env['NESTBOX_E2E_SHOW'] ? {} : { NESTBOX_E2E_QUIET: '1' }),
      // macOS and Linux build PATH from a login shell, which puts system folders first: prepend there too.
      ...(opts.pathPrepend ? { NESTBOX_PATH_PREPEND: opts.pathPrepend } : {}),
    }).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RENDERER_URL',
    ),
  );
  const app = await electron.launch({ args: [REPO_ROOT], cwd: REPO_ROOT, env });
  // The app's own log lines ('[nestbox] …') go to the test output, to diagnose failures in CI.
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/))
        if (line.includes('[nestbox]')) console.log(line);
    });
  }
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    const seen: string[] = [];
    (globalThis as unknown as { __messageBoxes: string[] }).__messageBoxes = seen;
    const answer = async (...args: unknown[]) => {
      const options = args.find(
        (a): a is { message: string } => typeof a === 'object' && a !== null && 'message' in a,
      );
      seen.push(options?.message ?? '');
      return { response: 0, checkboxChecked: false };
    };
    dialog.showMessageBox = answer as typeof dialog.showMessageBox;
  }, project);
  const page = await app.firstWindow();
  // Closing the window must quit (not hide to the tray) so app.close() can finish.
  // The node tsconfig has no DOM types: reach window.nestbox through globalThis.
  await page.evaluate(() =>
    (
      globalThis as unknown as {
        nestbox: { invoke(channel: string, input: unknown): Promise<unknown> };
      }
    ).nestbox.invoke('settings:update', { closeToTray: false }),
  );
  return { app, page, userData };
}

/** Messages of the native message boxes the app has shown so far. */
export async function messageBoxes(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => [
    ...((globalThis as unknown as { __messageBoxes?: string[] }).__messageBoxes ?? []),
  ]);
}

export async function addProjectAndOpenScripts(page: Page): Promise<void> {
  await page
    .getByRole('complementary', { name: 'Projects' })
    .getByRole('button', { name: 'Add project' })
    .click();
  await page.getByRole('tab', { name: 'Scripts' }).click();
}
