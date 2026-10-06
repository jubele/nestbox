import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ProjectGroup } from '@shared/types';
import { installMockBridge } from '@/test/mock-bridge';
import { makeDetected, makeSummary } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { Sidebar } from './Sidebar';

const ws = makeDetected({ id: 'p1::api', rootId: 'p1', relPath: 'api', name: 'api' });
const shop = makeSummary({
  id: 'p1',
  name: 'shop',
  groupId: 'g1',
  detected: makeDetected({ id: 'p1', name: 'shop', workspaces: [ws] }),
});
const blog = makeSummary({
  id: 'p2',
  name: 'blog',
  groupId: 'g1',
  detected: makeDetected({ id: 'p2', rootId: 'p2', name: 'blog' }),
});
const notes = makeSummary({
  id: 'p3',
  name: 'notes',
  detected: makeDetected({ id: 'p3', rootId: 'p3', name: 'notes' }),
});

function setup(groups: ProjectGroup[] = [{ id: 'g1', name: 'Work', collapsed: false }]) {
  const bridge = installMockBridge({
    'groups:list': () => groups,
    'groups:create': ({ name }) => ({ id: 'g9', name, collapsed: false }),
    'groups:rename': ({ id, name }) => ({ id, name, collapsed: false }),
    'groups:setCollapsed': ({ id, collapsed }) => ({ id, name: 'Work', collapsed }),
    'groups:delete': () => undefined,
    'groups:move': () => undefined,
    'projects:move': () => undefined,
    'projects:rename': () => shop,
    'projects:setPinned': () => shop,
    'projects:remove': () => undefined,
  });
  renderWithProviders(<Sidebar projects={[shop, blog, notes]} selectedId={null} />);
  return bridge;
}

/** jsdom has no DataTransfer: a small stand-in that keeps types and data. */
function dataTransfer() {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    effectAllowed: 'move',
    dropEffect: 'move',
  };
}

describe('Sidebar groups', () => {
  it('shows each group with its projects, then the ungrouped ones', async () => {
    setup();
    const work = await screen.findByRole('region', { name: 'Work' });
    expect(within(work).getByRole('button', { name: 'shop' })).toBeInTheDocument();
    expect(within(work).getByRole('button', { name: 'blog' })).toBeInTheDocument();
    const other = screen.getByRole('region', { name: 'Other projects' });
    expect(within(other).getByRole('button', { name: 'notes' })).toBeInTheDocument();
    expect(within(other).queryByRole('button', { name: 'shop' })).toBeNull();
  });

  it('collapses a group in the store', async () => {
    const bridge = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Collapse group Work' }));
    await waitFor(() =>
      expect(bridge.callsTo('groups:setCollapsed')).toEqual([{ id: 'g1', collapsed: true }]),
    );
  });

  it('creates a group and names it inline', async () => {
    const bridge = setup([]);
    await userEvent.click(await screen.findByRole('button', { name: 'New project group' }));
    await waitFor(() => expect(bridge.callsTo('groups:create')).toEqual([{ name: 'New group' }]));
  });

  it('renames a project inline with a double-click, and a package gets an alias', async () => {
    const bridge = setup();
    await screen.findByRole('region', { name: 'Work' });
    await userEvent.dblClick(screen.getByRole('button', { name: 'shop' }));
    const input = await screen.findByRole('textbox', { name: 'Project name' });
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.clear(input);
    await userEvent.type(input, 'Shop app{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Rename api' }));
    const alias = await screen.findByRole('textbox', { name: 'Project name' });
    await waitFor(() => expect(alias).toHaveFocus());
    await userEvent.clear(alias);
    await userEvent.type(alias, 'Backend{Enter}');
    await waitFor(() =>
      expect(bridge.callsTo('projects:rename')).toEqual([
        { id: 'p1', name: 'Shop app' },
        { id: 'p1::api', name: 'Backend' },
      ]),
    );
  });

  it('renames with F2 and cancels with Escape', async () => {
    const bridge = setup();
    const row = await screen.findByRole('button', { name: 'notes' });
    row.focus();
    await userEvent.keyboard('{F2}');
    const input = await screen.findByRole('textbox', { name: 'Project name' });
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.type(input, 'x{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Project name' })).toBeNull();
    expect(bridge.callsTo('projects:rename')).toEqual([]);
  });

  it('removes a project from its menu after asking', async () => {
    const bridge = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for notes' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove…' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove “notes” from NestBox?' });
    expect(dialog).toHaveTextContent('The folder on disk is not touched.');
    expect(bridge.callsTo('projects:remove')).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(bridge.callsTo('projects:remove')).toEqual([{ id: 'p3' }]));
    // The sidebar stays usable after the dialog closes.
    await userEvent.click(screen.getByRole('button', { name: 'Actions for blog' }));
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
  });

  it('moves a project to a group and up or down from its menu', async () => {
    const bridge = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for notes' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to group' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Work' }));
    await userEvent.click(screen.getByRole('button', { name: 'Actions for blog' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move up' }));
    await waitFor(() =>
      expect(bridge.callsTo('projects:move')).toEqual([
        { id: 'p3', groupId: 'g1', beforeId: null },
        { id: 'p2', groupId: 'g1', beforeId: 'p1' },
      ]),
    );
  });

  it('drags a project before another, into a group, and a group before another', async () => {
    const bridge = setup([
      { id: 'g1', name: 'Work', collapsed: false },
      { id: 'g2', name: 'Side', collapsed: false },
    ]);
    await screen.findByRole('region', { name: 'Side' });
    const notesRow = screen.getByRole('button', { name: 'notes' }).closest('li') as HTMLElement;
    const shopRow = screen.getByRole('button', { name: 'shop' }).closest('li') as HTMLElement;
    let dt = dataTransfer();
    fireEvent.dragStart(notesRow, { dataTransfer: dt });
    fireEvent.dragOver(shopRow, { dataTransfer: dt });
    fireEvent.drop(shopRow, { dataTransfer: dt });

    dt = dataTransfer();
    fireEvent.dragStart(notesRow, { dataTransfer: dt });
    fireEvent.drop(
      within(screen.getByRole('region', { name: 'Side' })).getByText('Drag projects here'),
      { dataTransfer: dt },
    );

    dt = dataTransfer();
    const sideHeader = screen.getByRole('heading', { name: 'Side' }).parentElement as HTMLElement;
    const workHeader = screen.getByRole('heading', { name: 'Work' }).parentElement as HTMLElement;
    fireEvent.dragStart(sideHeader, { dataTransfer: dt });
    fireEvent.drop(workHeader, { dataTransfer: dt });

    await waitFor(() => {
      expect(bridge.callsTo('projects:move')).toEqual([
        { id: 'p3', groupId: 'g1', beforeId: 'p1' },
        { id: 'p3', groupId: 'g2', beforeId: null },
      ]);
      expect(bridge.callsTo('groups:move')).toEqual([{ id: 'g2', beforeId: 'g1' }]);
    });
  });

  it('deletes a group from its menu', async () => {
    const bridge = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for group Work' }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Delete group (keeps its projects)' }),
    );
    await waitFor(() => expect(bridge.callsTo('groups:delete')).toEqual([{ id: 'g1' }]));
  });
});
