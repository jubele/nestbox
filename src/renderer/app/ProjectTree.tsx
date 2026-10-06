import { ChevronDown, ChevronRight, MoreHorizontal, Plus } from 'lucide-react';
import { type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { aggregateState, belongsTo, type AggregateState } from '@shared/processes';
import type { DetectedProject, ProjectSummary } from '@shared/detected';
import type { ProjectGroup } from '@shared/types';
import { StateDot } from '@/components/StateDot';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useGroups, useLayoutActions, useProcesses } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/state/ui-store';
import { RemoveProjectDialog } from './RemoveProjectDialog';

const PROJECT_TYPE = 'application/x-nestbox-project';
const GROUP_TYPE = 'application/x-nestbox-group';
const NEW_GROUP_NAME = 'New group';

type Actions = ReturnType<typeof useLayoutActions>;

interface TreeState {
  actions: Actions;
  groups: ProjectGroup[];
  selectedId: string | null;
  /** 'p:<project or package id>' or 'g:<group id>' while its name is edited inline. */
  renaming: string | null;
  setRenaming(key: string | null): void;
  /** What is being dragged, for drop targets that need to know before the drop. */
  dragging: { type: 'project' | 'group'; id: string } | null;
  setDragging(value: { type: 'project' | 'group'; id: string } | null): void;
}

/** Focus a brand-new editor can lose to the menu or click that opened it: it takes it back. */
const SETTLE_MS = 500;

/** An inline name editor: Enter or leaving saves, Escape cancels. */
function InlineName({
  initial,
  label,
  onSubmit,
  onDone,
}: {
  initial: string;
  label: string;
  onSubmit(name: string): void;
  onDone(): void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const openedAt = useRef(Date.now());
  const finished = useRef(false);
  // Focused after the click, double-click or menu that opened it has finished, so its own events don't blur it.
  useEffect(() => {
    const timer = setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const name = value.trim();
    if (save && name && name !== initial) onSubmit(name);
    onDone();
  };
  return (
    <Input
      ref={ref}
      aria-label={label}
      value={value}
      maxLength={100}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        // A menu closing or a row re-rendering can move focus just after the editor opened: take it back.
        if (Date.now() - openedAt.current < SETTLE_MS) {
          setTimeout(() => ref.current?.focus(), 0);
          return;
        }
        finish(true);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        }
      }}
      className="h-7 flex-1 text-xs"
    />
  );
}

/** Keeps a menu from handing focus back to its button when the chosen item opened an editor. */
function useRenameMenu(open: () => void) {
  const chosen = useRef(false);
  return {
    onSelectRename: () => {
      chosen.current = true;
      open();
    },
    onCloseAutoFocus: (event: Event) => {
      if (chosen.current) event.preventDefault();
      chosen.current = false;
    },
  };
}

/** Groups, their projects in order, and the ungrouped rest; drag and drop or each row's menu reorders them. */
export function ProjectTree({
  projects,
  total,
  selectedId,
  filtering,
}: {
  projects: ProjectSummary[];
  total: number;
  selectedId: string | null;
  filtering: boolean;
}) {
  const { data: groups = [], isSuccess: groupsLoaded } = useGroups();
  const actions = useLayoutActions();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragging, setDragging] = useState<TreeState['dragging']>(null);
  const state: TreeState = {
    actions,
    groups,
    selectedId,
    renaming,
    setRenaming,
    dragging,
    setDragging,
  };

  const known = new Set(groups.map((g) => g.id));
  const pinned = projects.filter((p) => p.pinned);
  const ofGroup = (id: string) => projects.filter((p) => !p.pinned && p.groupId === id);
  // Until the groups load, grouped projects wait instead of flashing in the ungrouped list.
  const ungrouped = projects.filter(
    (p) => !p.pinned && (p.groupId === null || (groupsLoaded && !known.has(p.groupId))),
  );

  const newGroup = async () => {
    const group = await actions.createGroup(NEW_GROUP_NAME);
    if (group) setRenaming(`g:${group.id}`);
  };

  return (
    <>
      {pinned.length > 0 && (
        <section aria-label="Pinned">
          <SectionTitle title="Pinned" count={String(pinned.length)} />
          <ul className="space-y-0.5">
            {pinned.map((p) => (
              <ProjectItem
                key={p.id}
                project={p}
                siblings={pinned}
                groupId={p.groupId}
                state={state}
              />
            ))}
          </ul>
        </section>
      )}
      {groups
        .filter((g) => !filtering || ofGroup(g.id).length > 0)
        .map((g) => (
          <GroupSection key={g.id} group={g} projects={ofGroup(g.id)} state={state} />
        ))}
      <ProjectSection
        title={groups.length > 0 ? 'Other projects' : 'All projects'}
        count={
          filtering
            ? `${projects.length} of ${total}`
            : String(groups.length > 0 ? ungrouped.length : total)
        }
        projects={ungrouped}
        state={state}
        onNewGroup={() => void newGroup()}
      />
    </>
  );
}

function SectionTitle({
  title,
  count,
  children,
}: {
  title: string;
  count: string;
  children?: React.ReactNode;
}) {
  return (
    <h2 className="mb-1.5 flex items-center gap-1 px-2 text-[10px] font-semibold tracking-wider text-fg-muted uppercase">
      <span className="flex-1 truncate">{title}</span>
      <span className="text-fg-faint">{count}</span>
      {children}
    </h2>
  );
}

/** Drop handling shared by section headers and empty lists: a project goes last into the group. */
function dropZone(
  state: TreeState,
  groupId: string | null,
  opts: { groupBefore?: string | null } = {},
) {
  const accepts = (e: DragEvent) =>
    e.dataTransfer.types.includes(PROJECT_TYPE) ||
    (opts.groupBefore !== undefined && e.dataTransfer.types.includes(GROUP_TYPE));
  return {
    onDragOver: (e: DragEvent) => {
      if (accepts(e)) e.preventDefault();
    },
    onDrop: (e: DragEvent) => {
      const project = e.dataTransfer.getData(PROJECT_TYPE);
      const group = e.dataTransfer.getData(GROUP_TYPE);
      state.setDragging(null);
      if (project) {
        e.preventDefault();
        void state.actions.moveProject(project, groupId, null);
      } else if (group && opts.groupBefore !== undefined && group !== opts.groupBefore) {
        e.preventDefault();
        void state.actions.moveGroup(group, opts.groupBefore);
      }
    },
  };
}

function ProjectSection({
  title,
  count,
  projects,
  state,
  onNewGroup,
}: {
  title: string;
  count: string;
  projects: ProjectSummary[];
  state: TreeState;
  onNewGroup(): void;
}) {
  return (
    <section aria-label={title} {...dropZone(state, null, { groupBefore: null })}>
      <SectionTitle title={title} count={count}>
        <button
          type="button"
          aria-label="New project group"
          title="New project group"
          onClick={onNewGroup}
          className="rounded p-0.5 text-fg-faint hover:text-fg"
        >
          <Plus className="size-3" aria-hidden />
        </button>
      </SectionTitle>
      <ul className="min-h-2 space-y-0.5">
        {projects.map((p) => (
          <ProjectItem key={p.id} project={p} siblings={projects} groupId={null} state={state} />
        ))}
      </ul>
    </section>
  );
}

function GroupSection({
  group,
  projects,
  state,
}: {
  group: ProjectGroup;
  projects: ProjectSummary[];
  state: TreeState;
}) {
  const { actions } = state;
  const renaming = state.renaming === `g:${group.id}`;
  const menu = useRenameMenu(() => state.setRenaming(`g:${group.id}`));
  return (
    <section
      aria-label={group.name}
      className={cn(state.dragging?.id === group.id && 'opacity-50')}
    >
      <div
        draggable={!renaming}
        onDragStart={(e) => {
          e.dataTransfer.setData(GROUP_TYPE, group.id);
          e.dataTransfer.effectAllowed = 'move';
          state.setDragging({ type: 'group', id: group.id });
        }}
        onDragEnd={() => state.setDragging(null)}
        {...dropZone(state, group.id, { groupBefore: group.id })}
        className="mb-1.5 flex items-center gap-1 px-1 text-[10px] font-semibold tracking-wider text-fg-muted uppercase"
      >
        <button
          type="button"
          aria-label={`${group.collapsed ? 'Expand' : 'Collapse'} group ${group.name}`}
          aria-expanded={!group.collapsed}
          onClick={() => void actions.setGroupCollapsed(group.id, !group.collapsed)}
          className="rounded p-0.5 text-fg-faint hover:text-fg"
        >
          {group.collapsed ? (
            <ChevronRight className="size-3" aria-hidden />
          ) : (
            <ChevronDown className="size-3" aria-hidden />
          )}
        </button>
        {renaming ? (
          <InlineName
            initial={group.name}
            label="Project group name"
            onSubmit={(name) => void actions.renameGroup(group.id, name)}
            onDone={() => state.setRenaming(null)}
          />
        ) : (
          <h2 className="flex-1 truncate" onDoubleClick={() => state.setRenaming(`g:${group.id}`)}>
            {group.name}
          </h2>
        )}
        <span className="text-fg-faint">{projects.length}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Actions for group ${group.name}`}
              className="rounded p-0.5 text-fg-faint hover:text-fg"
            >
              <MoreHorizontal className="size-3" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={menu.onCloseAutoFocus}>
            <DropdownMenuItem onSelect={menu.onSelectRename}>
              Rename group
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void actions.deleteGroup(group.id)}>
              Delete group (keeps its projects)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {!group.collapsed &&
        (projects.length === 0 ? (
          <p
            {...dropZone(state, group.id)}
            className="rounded-md border border-dashed border-line px-2.5 py-1.5 text-[11px] text-fg-faint"
          >
            Drag projects here
          </p>
        ) : (
          <ul className="space-y-0.5">
            {projects.map((p) => (
              <ProjectItem
                key={p.id}
                project={p}
                siblings={projects}
                groupId={group.id}
                state={state}
              />
            ))}
          </ul>
        ))}
    </section>
  );
}

interface ProjectItemProps {
  project: ProjectSummary;
  /** The projects in the same list, in order (for Move up / Move down and drops). */
  siblings: ProjectSummary[];
  groupId: string | null;
  state: TreeState;
}

function ProjectItem({ project, siblings, groupId, state }: ProjectItemProps) {
  const collapsed = useUiStore((s) => s.collapsed[project.id] ?? false);
  const toggleCollapsed = useUiStore((s) => s.toggleCollapsed);
  const workspaces = project.detected.workspaces;
  const { data: processes = [] } = useProcesses();
  const { actions } = state;
  const menu = useRenameMenu(() => state.setRenaming(`p:${project.id}`));
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** Remove was picked: focus goes to the confirmation, not back to the menu's trigger. */
  const removeChosen = useRef(false);
  const stateOf = (projectId: string, withWorkspaces: boolean): AggregateState =>
    aggregateState(
      processes
        .filter((p) =>
          withWorkspaces ? belongsTo(p.projectId, projectId) : p.projectId === projectId,
        )
        .map((p) => p.state),
    );
  const index = siblings.findIndex((p) => p.id === project.id);
  const movable = !project.pinned;
  const draggedProject = state.dragging?.type === 'project' ? state.dragging.id : null;

  return (
    <li
      draggable={movable && state.renaming === null}
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.setData(PROJECT_TYPE, project.id);
        e.dataTransfer.effectAllowed = 'move';
        state.setDragging({ type: 'project', id: project.id });
      }}
      onDragEnd={() => state.setDragging(null)}
      onDragOver={(e) => {
        if (movable && e.dataTransfer.types.includes(PROJECT_TYPE)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onDrop={(e) => {
        const dragged = e.dataTransfer.getData(PROJECT_TYPE);
        if (!movable || !dragged) return;
        e.preventDefault();
        e.stopPropagation();
        state.setDragging(null);
        if (dragged !== project.id) void actions.moveProject(dragged, groupId, project.id);
      }}
      className={cn(draggedProject === project.id && 'opacity-50')}
    >
      <div className="group/row flex items-center">
        <ProjectRow
          detected={project.detected}
          label={project.name}
          state={stateOf(project.id, collapsed)}
          tree={state}
        />
        {workspaces.length > 0 && (
          <button
            type="button"
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${project.name}`}
            aria-expanded={!collapsed}
            onClick={() => toggleCollapsed(project.id)}
            className="rounded p-1 text-fg-faint hover:text-fg"
          >
            {collapsed ? (
              <ChevronRight className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </button>
        )}
        {/* modal={false}: opening the confirmation from a menu item must not leave pointer-events locked. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Actions for ${project.name}`}
              className="rounded p-1 text-fg-faint opacity-0 group-hover/row:opacity-100 hover:text-fg focus-visible:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal className="size-3.5" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => {
              menu.onCloseAutoFocus(event);
              if (removeChosen.current) event.preventDefault();
              removeChosen.current = false;
            }}
          >
            <DropdownMenuItem onSelect={menu.onSelectRename}>
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void actions.setPinned(project.id, !project.pinned)}>
              {project.pinned ? 'Unpin' : 'Pin'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Move to group</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  disabled={project.groupId === null}
                  onSelect={() => void actions.moveProject(project.id, null, null)}
                >
                  No group
                </DropdownMenuItem>
                {state.groups.map((g) => (
                  <DropdownMenuItem
                    key={g.id}
                    disabled={project.groupId === g.id}
                    onSelect={() => void actions.moveProject(project.id, g.id, null)}
                  >
                    {g.name}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() =>
                    void (async () => {
                      const group = await actions.createGroup(NEW_GROUP_NAME);
                      if (!group) return;
                      await actions.moveProject(project.id, group.id, null);
                      state.setRenaming(`g:${group.id}`);
                    })()
                  }
                >
                  New group…
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {movable && (
              <>
                <DropdownMenuItem
                  disabled={index <= 0}
                  onSelect={() =>
                    void actions.moveProject(project.id, groupId, siblings[index - 1]?.id ?? null)
                  }
                >
                  Move up
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={index === -1 || index >= siblings.length - 1}
                  onSelect={() =>
                    void actions.moveProject(project.id, groupId, siblings[index + 2]?.id ?? null)
                  }
                >
                  Move down
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                removeChosen.current = true;
                setConfirmRemove(true);
              }}
            >
              Remove…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <RemoveProjectDialog project={project} open={confirmRemove} onOpenChange={setConfirmRemove} />
      </div>
      {workspaces.length > 0 && !collapsed && (
        <ul className="mt-0.5 ml-4 space-y-0.5 border-l border-line pl-2">
          {workspaces.map((ws) => (
            <li key={ws.id} className="group/row flex items-center">
              <ProjectRow
                detected={ws}
                label={ws.name}
                state={stateOf(ws.id, false)}
                tree={state}
              />
              <button
                type="button"
                aria-label={`Rename ${ws.name}`}
                title="Rename (alias)"
                onClick={() => state.setRenaming(`p:${ws.id}`)}
                className="rounded p-1 text-[10px] text-fg-faint opacity-0 group-hover/row:opacity-100 hover:text-fg focus-visible:opacity-100"
              >
                <MoreHorizontal className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function ProjectRow({
  detected,
  label,
  state,
  tree,
}: {
  detected: DetectedProject;
  label: string;
  state: AggregateState;
  tree: TreeState;
}) {
  const select = useUiStore((s) => s.select);
  const selected = tree.selectedId === detected.id;
  const key = `p:${detected.id}`;
  if (tree.renaming === key) {
    return (
      <InlineName
        initial={label}
        label="Project name"
        onSubmit={(name) => void tree.actions.renameProject(detected.id, name)}
        onDone={() => tree.setRenaming(null)}
      />
    );
  }
  return (
    <button
      type="button"
      aria-current={selected ? 'page' : undefined}
      title={state === 'idle' ? undefined : `${label}: ${state}`}
      onClick={() => select(detected.id)}
      onDoubleClick={() => tree.setRenaming(key)}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'F2') {
          e.preventDefault();
          tree.setRenaming(key);
        }
      }}
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-left text-xs font-medium transition-colors',
        selected
          ? 'border-line bg-surface text-fg'
          : 'border-transparent text-fg-muted hover:bg-surface/50 hover:text-fg',
        detected.missing && 'opacity-60',
      )}
    >
      <StateDot state={state} />
      <span className="truncate">{label}</span>
      {detected.missing && <span className="ml-auto text-[10px] text-err">missing</span>}
    </button>
  );
}
