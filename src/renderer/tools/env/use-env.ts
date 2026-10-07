import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { NestboxError } from '@shared/errors';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { queryKeys } from '@/lib/queries';
import { useToolEvent } from '@/lib/tool-events';

export const envMatrixKey = (projectId: string) => queryKeys.tool('env', projectId, 'matrix');
export const envFactsKey = (projectId: string) => queryKeys.tool('env', projectId, 'facts');

/** Keys × files (presence only), refetched when the env tool reports a change on disk. */
export function useEnvMatrix(projectId: string) {
  const queryClient = useQueryClient();
  useToolEvent('env', projectId, 'changed', () => {
    void queryClient.invalidateQueries({ queryKey: envMatrixKey(projectId) });
    void queryClient.invalidateQueries({ queryKey: envFactsKey(projectId) });
  });
  return useQuery({ queryKey: envMatrixKey(projectId), queryFn: () => api.tools.invoke('env', projectId, 'matrix', {}) });
}

export function useEnvFacts(projectId: string) {
  return useQuery({ queryKey: envFactsKey(projectId), queryFn: () => api.tools.invoke('env', projectId, 'facts', {}) });
}

type EnvEdit =
  | { method: 'setValue'; file: string; key: string; value: string; version: string }
  | { method: 'addKey'; file: string; key: string; value: string; version: string | null }
  | { method: 'removeKey'; file: string; key: string; version: string }
  | { method: 'switchProfile'; file: string; envVersion: string | null };

/** Every write: refetches afterwards; a CONFLICT (the file changed on disk) says so and reloads. */
export function useEnvEdit(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (edit: EnvEdit): Promise<void> => {
      switch (edit.method) {
        case 'setValue':
          await api.tools.invoke('env', projectId, 'setValue', { file: edit.file, key: edit.key, value: edit.value, version: edit.version });
          return;
        case 'addKey':
          await api.tools.invoke('env', projectId, 'addKey', { file: edit.file, key: edit.key, value: edit.value, version: edit.version });
          return;
        case 'removeKey':
          await api.tools.invoke('env', projectId, 'removeKey', { file: edit.file, key: edit.key, version: edit.version });
          return;
        case 'switchProfile':
          await api.tools.invoke('env', projectId, 'switchProfile', { file: edit.file, envVersion: edit.envVersion });
      }
    },
    onError: (error) => {
      toast.error(error instanceof NestboxError && error.code === 'CONFLICT' ? 'The file changed on disk. It has been reloaded.' : errorMessage(error));
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: envMatrixKey(projectId) }),
        queryClient.invalidateQueries({ queryKey: envFactsKey(projectId) }),
      ]),
  });
}

/** Env variable names the package's code reads. Scanned when the tab opens, and again on Rescan. */
export function useCodeKeys(projectId: string) {
  return useQuery({
    queryKey: queryKeys.tool('env', projectId, 'codeKeys'),
    queryFn: () => api.tools.invoke('env', projectId, 'codeKeys', {}),
    staleTime: 60_000,
  });
}

/** A new env file holding the given keys with empty values. */
export function useCreateEnvFile(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { file: string; keys: string[] }) => api.tools.invoke('env', projectId, 'createFile', input),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: envMatrixKey(projectId) }),
  });
}

export function useEnvCopy(projectId: string) {
  return useMutation({
    mutationFn: (cell: { file: string; key: string }) => api.tools.invoke('env', projectId, 'copy', cell),
    onSuccess: () => toast.success('Copied'),
    onError: (error) => toast.error(errorMessage(error)),
  });
}

/** One value on demand. Not cached: revealed values live only in the cell that shows them. */
export function revealValue(projectId: string, file: string, key: string): Promise<string> {
  return api.tools.invoke('env', projectId, 'reveal', { file, key }).then((r) => r.value);
}
