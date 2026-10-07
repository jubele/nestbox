import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { NestboxError } from '@shared/errors';
import type { PortKillInput, PortList, PortRow } from '@shared/ports';
import { useUiStore } from '@/state/ui-store';
import { installMockBridge } from '@/test/mock-bridge';
import { makeSummary } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { PortsPage } from './PortsPage';

const row = (port: number, pid: number, extra: Partial<PortRow> = {}): PortRow => ({
  port,
  pid,
  addresses: ['0.0.0.0', '::'],
  processName: 'node.exe',
  command: `node server.js --port ${port}`,
  owner: null,
  ...extra,
});

const ROWS = [
  row(3000, 40, { owner: { projectId: 'p1', script: 'dev' } }),
  row(5432, 77, { processName: 'postgres.exe', command: null, addresses: ['127.0.0.1'] }),
];

function setup(
  list: () => PortList = () => ({ rows: ROWS, scannedAt: Date.now(), stale: false }),
  kill?: (i: PortKillInput) => unknown,
  platform: 'win32' | 'darwin' = 'win32',
) {
  const bridge = installMockBridge({
    'app:getInfo': () => ({ version: '1', platform }),
    'ports:list': list,
    'ports:kill': (input) => {
      if (kill) kill(input);
      if (input.pid === 77 && !input.confirmed) return { result: 'needs-confirm', processName: 'postgres.exe' };
      return { result: input.pid === 40 ? 'stopped-script' : 'killed', processName: 'x' };
    },
    'projects:list': () => [makeSummary({ id: 'p1', name: 'shop' })],
  });
  renderWithProviders(<PortsPage />);
  return bridge;
}

describe('PortsPage', () => {
  it("says on macOS that other users' ports need admin rights", async () => {
    setup(undefined, undefined, 'darwin');
    await screen.findByRole('table', { name: 'Listening ports' });
    expect(await screen.findByText(/other users' processes/)).toBeInTheDocument();
  });

  it('has no such note on Windows', async () => {
    setup();
    await screen.findByRole('table', { name: 'Listening ports' });
    expect(screen.queryByText(/other users' processes/)).toBeNull();
  });

  it('lists ports with their process, owner and command', async () => {
    setup();
    const table = await screen.findByRole('table', { name: 'Listening ports' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('3000');
    expect(rows[0]).toHaveTextContent('node.exe');
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: 'shop · dev' })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('postgres.exe');
    expect(rows[1]).toHaveTextContent('127.0.0.1');
  });

  it('filters by text and by NestBox ownership', async () => {
    setup();
    const table = await screen.findByRole('table', { name: 'Listening ports' });
    await userEvent.type(screen.getByRole('textbox', { name: 'Filter ports' }), 'postgres');
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2));
    expect(table).toHaveTextContent('5432');
    await userEvent.clear(screen.getByRole('textbox', { name: 'Filter ports' }));
    await userEvent.click(screen.getByRole('switch', { name: 'Only NestBox' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2));
    expect(table).toHaveTextContent('3000');
  });

  it('stops a NestBox port without asking', async () => {
    const bridge = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Kill port 3000' }));
    await waitFor(() => expect(bridge.callsTo('ports:kill')).toEqual([{ pid: 40, port: 3000, confirmed: false }]));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks before killing a process NestBox did not start', async () => {
    const bridge = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Kill port 5432' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Kill postgres.exe (PID 77) listening on 5432?');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Kill' }));
    await waitFor(() =>
      expect(bridge.callsTo('ports:kill')).toEqual([
        { pid: 77, port: 5432, confirmed: false },
        { pid: 77, port: 5432, confirmed: true },
      ]),
    );
  });

  it('kills nothing when the confirm is cancelled', async () => {
    const bridge = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Kill port 5432' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(bridge.callsTo('ports:kill')).toHaveLength(1);
  });

  it('opens the owning script from the owner link', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'shop · dev' }));
    expect(useUiStore.getState()).toMatchObject({ view: 'project', selectedProjectId: 'p1', activeTab: { p1: 'scripts' } });
    expect(useUiStore.getState().scriptPanes['p1']?.scripts).toEqual([
      { projectId: 'p1', script: 'dev' },
    ]);
  });

  it('warns when the list is stale and says when nothing listens', async () => {
    setup(() => ({ rows: [], scannedAt: 1, stale: true }));
    expect(await screen.findByText("Couldn't refresh the port list")).toBeInTheDocument();
    expect(screen.getByText('Nothing is listening')).toBeInTheDocument();
  });

  it('explains when port listing is not available on this platform', async () => {
    setup(() => {
      throw new NestboxError('NOT_IMPLEMENTED', 'listListeningPorts is not implemented on this platform yet');
    });
    expect(await screen.findByText("Port listing isn't available on this platform yet.")).toBeInTheDocument();
  });
});
