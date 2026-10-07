import { useQuery, useQueryClient } from '@tanstack/react-query';
import { defaultFilter } from 'cmdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { queryKeys, useProcesses, useProjects, useSettings, useTools } from '@/lib/queries';
import { isToolEnabled } from '@shared/tools';
import { useUiStore } from '@/state/ui-store';
import { composeStepMessage } from '@/tools/scripts/compose-steps';
import { scriptListKey } from '@/tools/scripts/use-scripts';
import { findProjectNode } from './find-project';
import { PALETTE_GROUPS, type PaletteAction, paletteEntries } from './palette-entries';

/**
 * Matches the label and keywords only. Item values are entry ids, which hold project ids: letters of a
 * random id would otherwise match a search.
 */
const filterByLabel = (_value: string, search: string, keywords?: string[]) => defaultFilter(keywords?.[0] ?? '', search, keywords?.slice(1));

/** Ctrl+K (⌘K on macOS) from anywhere, unless the focused element already handled the key. */
function usePaletteShortcut(toggle: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  // Without a trigger, Radix would leave focus on the body when the palette closes: put it back.
  const returnFocus = useRef<HTMLElement | null>(null);
  const toggle = useMemo(
    () => () =>
      setOpen((o) => {
        if (!o) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        return !o;
      }),
    [],
  );
  usePaletteShortcut(toggle);

  const queryClient = useQueryClient();
  const { data: projects = [] } = useProjects();
  const { data: processes = [] } = useProcesses();
  const view = useUiStore((s) => s.view);
  const selectedId = useUiStore((s) => s.selectedProjectId);
  const selected = view === 'project' ? (findProjectNode(projects, selectedId) ?? findProjectNode(projects, projects[0]?.id ?? null)) : null;
  const { data: tools = [] } = useTools(open && selected ? selected.detected.id : null);
  const { data: settings } = useSettings();
  const claudeOn = isToolEnabled(settings?.disabledTools ?? [], 'claude');
  const rootId = selected?.summary.id ?? '';
  const { data: list } = useQuery({
    queryKey: scriptListKey(rootId),
    queryFn: () => api.tools.invoke('scripts', rootId, 'list', {}),
    enabled: open && rootId !== '',
  });

  const entries = useMemo(
    () =>
      open
        ? paletteEntries({
            projects,
            selected,
            processes,
            runGroups: list?.runGroups ?? [],
            runnables: list?.packages ?? [],
            tools,
            claudeOn,
          })
        : [],
    [open, projects, selected, processes, list, tools, claudeOn],
  );

  const run = async (action: PaletteAction) => {
    setOpen(false);
    const ui = useUiStore.getState();
    const show = (projectId: string, tab: string) => {
      ui.select(projectId);
      ui.setActiveTab(projectId, tab);
    };
    try {
      switch (action.kind) {
        case 'select':
          ui.select(action.projectId);
          return;
        case 'tab':
          show(action.projectId, action.tab);
          return;
        case 'script':
          await api.tools.invoke('scripts', action.projectId, action.op, { script: action.script });
          if (action.op === 'start') {
            show(action.projectId, 'scripts');
            ui.showScript(action.projectId, action.script);
          }
          return;
        case 'group':
          if (action.op === 'stop') {
            await api.tools.invoke('scripts', action.rootId, 'stopRunGroup', { name: action.name });
            return;
          }
          for (const step of (await api.tools.invoke('scripts', action.rootId, 'startRunGroup', { name: action.name })).compose) {
            const message = composeStepMessage(step);
            if (message) toast.warning(message);
          }
          return;
        case 'claude':
          await api.tools.invoke('claude', action.projectId, action.op, {});
          return;
        case 'ports':
          ui.showPorts();
          return;
        case 'settings':
          ui.setSettingsOpen(true);
          return;
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      if (action.kind === 'script' || action.kind === 'group') void queryClient.invalidateQueries({ queryKey: queryKeys.processes });
    }
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search projects, scripts and actions"
      showCloseButton={false}
      filter={filterByLabel}
      onCloseAutoFocus={(e) => {
        const target = returnFocus.current;
        if (target?.isConnected) {
          e.preventDefault();
          target.focus();
        }
      }}
    >
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        {PALETTE_GROUPS.map((group) => {
          const items = entries.filter((e) => e.group === group);
          if (items.length === 0) return null;
          return (
            <CommandGroup key={group} heading={group}>
              {items.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={entry.id}
                  keywords={[entry.label, ...entry.keywords]}
                  disabled={entry.disabled ?? false}
                  onSelect={() => void run(entry.action)}
                >
                  <span className="truncate">{entry.label}</span>
                  {entry.detail && <CommandShortcut className="max-w-[45%] truncate font-mono tracking-normal">{entry.detail}</CommandShortcut>}
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}
