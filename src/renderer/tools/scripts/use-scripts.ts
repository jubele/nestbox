import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { RunGroup } from '@shared/types';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { queryKeys } from '@/lib/queries';
import { composeStepMessage } from './compose-steps';

const showError = (error: unknown): void => {
  toast.error(errorMessage(error));
};

export const scriptListKey = (projectId: string) => queryKeys.tool('scripts', projectId, 'list');

export function useScriptList(projectId: string) {
  return useQuery({
    queryKey: scriptListKey(projectId),
    queryFn: () => api.tools.invoke('scripts', projectId, 'list', {}),
  });
}

/** Every Scripts list, since a root's favorites show its packages' rows. */
function useRefreshAfter() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.processes }),
      queryClient.invalidateQueries({ queryKey: ['tool', 'scripts'] }),
    ]);
}

export type ScriptAction = 'start' | 'stop' | 'restart';

export function useScriptAction(projectId: string) {
  const refresh = useRefreshAfter();
  return useMutation({
    mutationFn: ({ action, script }: { action: ScriptAction; script: string }) =>
      api.tools.invoke('scripts', projectId, action, { script }),
    onSettled: refresh,
    onError: showError,
  });
}

export function useSetAutoRestart(projectId: string) {
  const refresh = useRefreshAfter();
  return useMutation({
    mutationFn: ({ script, enabled }: { script: string; enabled: boolean }) =>
      api.tools.invoke('scripts', projectId, 'setAutoRestart', { script, enabled }),
    onSettled: refresh,
    onError: showError,
  });
}

/** Every package's script list: the root's feeds the run group editor and the overview card. */
function useRefreshAllLists() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['tool', 'scripts'] });
}

/** Custom commands. */
export function useCommandActions(projectId: string) {
  const refresh = useRefreshAllLists();
  const save = useMutation({
    mutationFn: (input: { previousName?: string; name: string; argv: string[]; main: boolean }) =>
      api.tools.invoke('scripts', projectId, 'saveCommand', input),
    onSuccess: refresh,
    onError: showError,
  });
  const remove = useMutation({
    mutationFn: (name: string) => api.tools.invoke('scripts', projectId, 'deleteCommand', { name }),
    onSuccess: refresh,
    onError: showError,
  });
  /** A detected command: hidden, since detection would find it again. */
  const hide = useMutation({
    mutationFn: (script: string) => api.tools.invoke('scripts', projectId, 'hideCommand', { script }),
    onSuccess: refresh,
    onError: showError,
  });
  const show = useMutation({
    mutationFn: (script: string) => api.tools.invoke('scripts', projectId, 'showCommand', { script }),
    onSuccess: refresh,
    onError: showError,
  });
  return { save, remove, hide, show };
}

export function useSetEnvFile(projectId: string) {
  const refresh = useRefreshAfter();
  return useMutation({
    mutationFn: ({ script, file }: { script: string; file: string | null }) =>
      api.tools.invoke('scripts', projectId, 'setEnvFile', { script, file }),
    onSettled: refresh,
    onError: showError,
  });
}

export function useSetMain(projectId: string) {
  const refresh = useRefreshAllLists();
  return useMutation({
    mutationFn: ({ script, main }: { script: string; main: boolean }) =>
      api.tools.invoke('scripts', projectId, 'setMain', { script, main }),
    onSettled: refresh,
    onError: showError,
  });
}

/** The package's .py files, for "run a Python file" (empty outside Python packages). */
export function usePythonFiles(projectId: string) {
  return useQuery({
    queryKey: queryKeys.tool('scripts', projectId, 'pythonFiles'),
    queryFn: () => api.tools.invoke('scripts', projectId, 'pythonFiles', {}),
    staleTime: 30_000,
  });
}

/** Virtualenvs inside the project, for the Python environment choice. */
export function usePythonEnvs(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.tool('scripts', projectId, 'pythonEnvs'),
    queryFn: () => api.tools.invoke('scripts', projectId, 'pythonEnvs', {}),
    staleTime: 30_000,
    enabled,
  });
}

export function useSetVenv(projectId: string) {
  const refresh = useRefreshAfter();
  return useMutation({
    mutationFn: (input: { mode: 'auto' | 'none' | 'path'; path?: string }) =>
      api.tools.invoke('scripts', projectId, 'setVenv', input),
    onSettled: refresh,
    onError: showError,
  });
}

/** Starts a script in any package (the overview card starts each package's main command). */
export function useStartIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, script }: { projectId: string; script: string }) =>
      api.tools.invoke('scripts', projectId, 'start', { script }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.processes }),
    onError: showError,
  });
}

export function useRunGroupActions(projectId: string) {
  const refresh = useRefreshAfter();
  const save = useMutation({
    mutationFn: (input: { previousName?: string; group: RunGroup }) =>
      api.tools.invoke('scripts', projectId, 'saveRunGroup', input),
    onSuccess: refresh,
    onError: showError,
  });
  const remove = useMutation({
    mutationFn: (name: string) => api.tools.invoke('scripts', projectId, 'deleteRunGroup', { name }),
    onSuccess: refresh,
    onError: showError,
  });
  const start = useMutation({
    mutationFn: (name: string) => api.tools.invoke('scripts', projectId, 'startRunGroup', { name }),
    onSuccess: (result) => {
      if (result.skipped.length > 0) {
        const list = result.skipped
          .map((e) => `${e.relPath === '' ? '' : `${e.relPath} `}${e.script} (${e.reason})`)
          .join(', ');
        toast.warning(`Skipped ${result.skipped.length} ${result.skipped.length === 1 ? 'script' : 'scripts'}: ${list}`);
      }
      for (const step of result.compose) {
        const message = composeStepMessage(step);
        if (message) toast.warning(message);
      }
    },
    onSettled: refresh,
    onError: showError,
  });
  const stop = useMutation({
    mutationFn: (name: string) => api.tools.invoke('scripts', projectId, 'stopRunGroup', { name }),
    onSettled: refresh,
    onError: showError,
  });
  return { save, remove, start, stop };
}

export function useOpenFileAt(projectId: string) {
  return useMutation({
    mutationFn: ({ path, line }: { path: string; line: number }) =>
      api.tools.invoke('scripts', projectId, 'openFileAt', { path, line }),
    onError: showError,
  });
}

export function useExportLogs(projectId: string) {
  return useMutation({
    mutationFn: ({ script, seqs }: { script: string; seqs: number[] | 'all' }) =>
      api.tools.invoke('scripts', projectId, 'exportLogs', { script, seqs }),
    onSuccess: (result) => {
      if (result.saved) toast.success('Log exported');
    },
    onError: showError,
  });
}
