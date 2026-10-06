import { belongsTo, isLive } from '@shared/processes';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useProcesses, useRemoveProject } from '@/lib/queries';

/** Confirms removing a root project from NestBox (the project header's menu and the sidebar row's). */
export function RemoveProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: { id: string; name: string };
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const remove = useRemoveProject();
  const { data: processes = [] } = useProcesses();
  const live = processes.filter(
    (p) => isLive(p.state) && belongsTo(p.projectId, project.id),
  ).length;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove “{project.name}” from NestBox?</AlertDialogTitle>
          <AlertDialogDescription>
            NestBox forgets this project and its settings. The folder on disk is not touched.
            {live > 0 && ` ${live} running ${live === 1 ? 'script' : 'scripts'} will be stopped.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-err text-fg hover:bg-err/90"
            onClick={() => remove.mutate(project.id)}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
