import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeProcess } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { RunGroups } from './RunGroups';
import { installScriptsBridge } from './test-bridge';

const packages = [
  { relPath: '', name: 'shop', scripts: ['dev', 'build'], compose: true, main: null },
  { relPath: 'packages/api', name: '@shop/api', scripts: ['dev'], compose: false, main: null },
];
const composeOk = () => ({
  state: 'ok',
  file: 'compose.yaml',
  services: ['db', 'redis'].map((name) => ({ name, state: 'running', health: null, exitCode: null, ports: [] })),
  action: null,
  following: null,
});
const group = { name: 'dev', entries: [{ relPath: 'packages/api', script: 'dev' }], compose: [] };

describe('RunGroups', () => {
  it('is absent on a workspace package', async () => {
    const { calls } = installScriptsBridge({ runGroups: null, packages: null });
    renderWithProviders(<RunGroups projectId="p1::packages/api" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByRole('region', { name: 'Run groups' })).toBeNull();
  });

  it('starts a group and reports skipped scripts', async () => {
    const { callsTo } = installScriptsBridge({
      runGroups: [group],
      packages,
      methods: {
        startRunGroup: () => ({ started: [], skipped: [{ relPath: 'packages/gone', script: 'dev', reason: 'missing' }] }),
      },
    });
    renderWithProviders(<RunGroups projectId="p1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start group dev' }));
    await waitFor(() => expect(callsTo('startRunGroup')).toEqual([{ name: 'dev' }]));
    expect(await screen.findByText('Skipped 1 script: packages/gone dev (missing)')).toBeInTheDocument();
  });

  it('offers Stop while one of its scripts runs', async () => {
    const { callsTo } = installScriptsBridge({
      runGroups: [group],
      packages,
      processes: [makeProcess({ projectId: 'p1::packages/api', script: 'dev', state: 'running' })],
    });
    renderWithProviders(<RunGroups projectId="p1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Stop group dev' }));
    await waitFor(() => expect(callsTo('stopRunGroup')).toEqual([{ name: 'dev' }]));
  });

  it('creates a group from checked scripts in order', async () => {
    const { callsTo } = installScriptsBridge({ runGroups: [], packages });
    renderWithProviders(<RunGroups projectId="p1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'New group' }));
    const dialog = await screen.findByRole('dialog', { name: 'New run group' });
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Group name' }), 'all');
    expect(save).toBeDisabled();
    const api = within(within(dialog).getByRole('group', { name: 'packages/api' })).getByRole('checkbox', { name: 'dev' });
    const rootBuild = within(within(dialog).getByRole('group', { name: 'Root' })).getByRole('checkbox', { name: 'build' });
    await userEvent.click(api);
    await userEvent.click(rootBuild);
    await userEvent.click(save);
    await waitFor(() =>
      expect(callsTo('saveRunGroup')).toEqual([
        {
          group: {
            name: 'all',
            entries: [
              { relPath: 'packages/api', script: 'dev' },
              { relPath: '', script: 'build' },
            ],
            compose: [],
          },
        },
      ]),
    );
  });

  it("starts a new group with each package's main command ticked", async () => {
    installScriptsBridge({
      runGroups: [],
      packages: packages.map((p) => (p.relPath === 'packages/api' ? { ...p, main: 'dev' } : p)),
    });
    renderWithProviders(<RunGroups projectId="p1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'New group' }));
    const dialog = await screen.findByRole('dialog', { name: 'New run group' });
    expect(within(within(dialog).getByRole('group', { name: 'packages/api' })).getByRole('checkbox', { name: 'dev' })).toBeChecked();
    expect(within(within(dialog).getByRole('group', { name: 'Root' })).getByRole('checkbox', { name: 'dev' })).not.toBeChecked();
  });

  it('edits with the previous name', async () => {
    const { callsTo } = installScriptsBridge({ runGroups: [group], packages });
    renderWithProviders(<RunGroups projectId="p1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit group dev' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit run group' });
    const name = within(dialog).getByRole('textbox', { name: 'Group name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'backend');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(callsTo('saveRunGroup')).toEqual([{ previousName: 'dev', group: { ...group, name: 'backend' } }]),
    );
  });

  it('deletes only after confirming', async () => {
    const { callsTo } = installScriptsBridge({ runGroups: [group], packages });
    renderWithProviders(<RunGroups projectId="p1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete group dev' }));
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(callsTo('deleteRunGroup')).toEqual([{ name: 'dev' }]));
  });

  it('creates a compose-only group with some of the services', async () => {
    const { callsTo } = installScriptsBridge({ runGroups: [], packages, methods: { status: composeOk } });
    renderWithProviders(<RunGroups projectId="p1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'New group' }));
    const dialog = await screen.findByRole('dialog', { name: 'New run group' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Group name' }), 'services');
    expect(within(dialog).queryByRole('group', { name: 'Compose: packages/api' })).toBeNull();
    const compose = within(dialog).getByRole('group', { name: 'Compose: Root' });
    await userEvent.click(within(compose).getByRole('checkbox', { name: 'Start compose services' }));
    await userEvent.click(within(compose).getByRole('radio', { name: 'Some services' }));
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.click(await within(compose).findByRole('checkbox', { name: 'redis' }));
    await userEvent.click(save);
    await waitFor(() =>
      expect(callsTo('saveRunGroup')).toEqual([
        { group: { name: 'services', entries: [], compose: [{ relPath: '', services: ['redis'] }] } },
      ]),
    );
  });

  it('offers only all services when Docker cannot list them', async () => {
    const { callsTo } = installScriptsBridge({
      runGroups: [],
      packages,
      methods: { status: () => ({ state: 'daemon-down', file: 'compose.yaml' }) },
    });
    renderWithProviders(<RunGroups projectId="p1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'New group' }));
    const dialog = await screen.findByRole('dialog', { name: 'New run group' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Group name' }), 'db');
    const compose = within(dialog).getByRole('group', { name: 'Compose: Root' });
    await userEvent.click(within(compose).getByRole('checkbox', { name: 'Start compose services' }));
    expect(await within(compose).findByText(/Docker can't list the services/)).toBeInTheDocument();
    expect(within(compose).queryByRole('radio', { name: 'Some services' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(callsTo('saveRunGroup')).toEqual([
        { group: { name: 'db', entries: [], compose: [{ relPath: '', services: [] }] } },
      ]),
    );
  });

  it('summarises compose services and offers Start and Stop for a compose-only group', async () => {
    installScriptsBridge({
      runGroups: [
        { ...group, compose: [{ relPath: '', services: ['db', 'redis'] }] },
        { name: 'stack', entries: [], compose: [{ relPath: 'packages/api', services: [] }] },
      ],
      packages,
    });
    renderWithProviders(<RunGroups projectId="p1" />);
    expect(await screen.findByText('packages/api dev · compose: db, redis')).toBeInTheDocument();
    expect(screen.getByText('compose: packages/api all')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start group stack' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop group stack' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop group dev' })).toBeNull();
  });

  it('warns about compose steps that did not work', async () => {
    installScriptsBridge({
      runGroups: [group],
      packages,
      methods: {
        startRunGroup: () => ({
          started: [],
          skipped: [],
          compose: [
            { relPath: '', result: 'ok' },
            { relPath: 'packages/api', result: 'failed' },
          ],
        }),
      },
    });
    renderWithProviders(<RunGroups projectId="p1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start group dev' }));
    expect(
      await screen.findByText("Compose in packages/api didn't start its services: see its Compose tab"),
    ).toBeInTheDocument();
  });
});
