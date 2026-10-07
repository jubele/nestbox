import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { copyFixture, launch } from './helpers';

let app: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  // frontend/ (package.json) + backend/ (FastAPI, no package.json) with a stand-in virtualenv.
  const project = await copyFixture('python-app');
  ({ app, page } = await launch(project));
});

test.afterEach(async () => {
  await app.close();
});

async function addAsOneProject() {
  const sidebar = page.getByRole('complementary', { name: 'Projects' });
  await sidebar.getByRole('button', { name: 'Add project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add under a group?' });
  await expect(dialog.getByText('python-app-web')).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Add as one project' }).click();
  await expect(dialog).toHaveCount(0);
  return sidebar;
}

test('one run group starts the frontend and the Python backend in its virtualenv', async () => {
  const sidebar = await addAsOneProject();
  await page.getByRole('tab', { name: 'Scripts' }).click();
  await page.getByRole('button', { name: 'New group' }).click();
  const editor = page.getByRole('dialog', { name: 'New run group' });
  await editor.getByRole('textbox', { name: 'Group name' }).fill('dev');
  await editor
    .getByRole('group', { name: 'backend' })
    .getByRole('checkbox', { name: 'dev' })
    .check();
  await editor
    .getByRole('group', { name: 'frontend' })
    .getByRole('checkbox', { name: 'dev' })
    .check();
  await editor.getByRole('button', { name: 'Save' }).click();
  const groups = page.getByRole('region', { name: 'Run groups' });
  await groups.getByRole('button', { name: 'Start group dev' }).click();

  await sidebar.getByRole('button', { name: 'backend', exact: true }).click();
  await page.getByRole('tab', { name: 'Scripts' }).click();
  await expect(page.getByTitle('Detected from the Python files')).toBeVisible();
  await page.getByRole('button', { name: 'dev', exact: true }).click();
  const log = page.getByRole('log', { name: 'dev output' });
  await expect(log).toContainText('fake python -m uvicorn main:app --reload', { timeout: 30_000 });
  await expect(log).toContainText('VIRTUAL_ENV set');

  await sidebar.getByRole('button', { name: 'python-app-web', exact: true }).click();
  await page.getByRole('tab', { name: 'Scripts' }).click();
  await expect(page.getByRole('button', { name: 'Stop dev' })).toBeVisible({ timeout: 30_000 });
});

test('a custom command runs in the backend folder', async () => {
  const sidebar = await addAsOneProject();
  await sidebar.getByRole('button', { name: 'backend', exact: true }).click();
  await page.getByRole('tab', { name: 'Scripts' }).click();
  await page.getByRole('button', { name: 'Add command' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add command' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('worker');
  await dialog
    .getByRole('textbox', { name: 'Command' })
    .fill('python worker.py --queue "high priority"');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole('button', { name: 'Start worker' }).click();
  await expect(page.getByRole('log', { name: 'worker output' })).toContainText(
    'fake python worker.py --queue high priority',
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: 'Stop worker' }).click();
  await expect(page.getByRole('button', { name: 'Start worker' })).toBeVisible({ timeout: 15_000 });
});
