import { z } from 'zod';

export const PACKAGE_MANAGERS = ['pnpm', 'yarn', 'npm', 'bun'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export const DEPLOY_PLATFORMS = ['vercel', 'netlify', 'cloudflare', 'fly'] as const;
export type DeployPlatform = (typeof DEPLOY_PLATFORMS)[number];

export const PYTHON_FRAMEWORKS = ['django', 'fastapi', 'flask', 'script'] as const;
export type PythonFramework = (typeof PYTHON_FRAMEWORKS)[number];

/** A script or command name as NestBox accepts it (run groups, the tray, log file names). */
export const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,59}$/;

/** A command NestBox found in a package: a program and its arguments, run without a shell. */
export interface DetectedCommand {
  name: string;
  argv: string[];
}

export interface PythonInfo {
  /** The virtualenv as a posix path from the package (`.venv`, or the project folder's `../.venv`), or null. */
  venv: string | null;
  framework: PythonFramework | null;
  /** The program is the bare 'python'; the scripts tool decides which interpreter that means. */
  commands: DetectedCommand[];
}

export interface GitInfo {
  /** Current branch, or null when HEAD is detached or unreadable. */
  branch: string | null;
  /** 7-char commit hash when HEAD is detached, otherwise null. */
  head: string | null;
}

export interface ClaudeFiles {
  claudeMd: boolean;
  claudeLocalMd: boolean;
  claudeDir: boolean;
  mcpJson: boolean;
}

export interface DetectedProject {
  id: string;
  rootId: string;
  path: string;
  /** '' for the root, posix-style relative path for workspace packages. */
  relPath: string;
  name: string;
  missing: boolean;
  packageJson: { name?: string; scripts: Record<string, string> } | null;
  packageManager: PackageManager | null;
  /** null when the folder has no Python markers. */
  python: PythonInfo | null;
  /** File names only — env files are never opened. */
  envFiles: string[];
  /** The env files that are symlinks; the env tool treats them as read-only. */
  envSymlinks: string[];
  workspaces: DetectedProject[];
  prismaSchema: string | null;
  dockerCompose: string | null;
  /** Deployment platforms with a config file or link folder in this package, in DEPLOY_PLATFORMS order. */
  deploy: DeployPlatform[];
  /** null when the folder is not a git repository. */
  git: GitInfo | null;
  buildOutput: 'dist' | 'build' | null;
  claude: ClaudeFiles;
}

export const DetectedProjectSchema: z.ZodType<DetectedProject> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    rootId: z.string().min(1),
    path: z.string().min(1),
    relPath: z.string(),
    name: z.string().min(1),
    missing: z.boolean(),
    packageJson: z
      .object({ name: z.string().optional(), scripts: z.record(z.string(), z.string()) })
      .nullable(),
    packageManager: z.enum(PACKAGE_MANAGERS).nullable(),
    python: z
      .object({
        venv: z.string().nullable(),
        framework: z.enum(PYTHON_FRAMEWORKS).nullable(),
        commands: z.array(z.object({ name: z.string().regex(COMMAND_NAME), argv: z.array(z.string()).min(1) })),
      })
      .nullable(),
    envFiles: z.array(z.string()),
    envSymlinks: z.array(z.string()),
    workspaces: z.array(DetectedProjectSchema),
    prismaSchema: z.string().nullable(),
    dockerCompose: z.string().nullable(),
    deploy: z.array(z.enum(DEPLOY_PLATFORMS)),
    git: z.object({ branch: z.string().nullable(), head: z.string().nullable() }).nullable(),
    buildOutput: z.enum(['dist', 'build']).nullable(),
    claude: z.object({
      claudeMd: z.boolean(),
      claudeLocalMd: z.boolean(),
      claudeDir: z.boolean(),
      mcpJson: z.boolean(),
    }),
  }),
);

export const ProjectSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  pinned: z.boolean(),
  tags: z.array(z.string()),
  /** The sidebar group (v1.18); null = ungrouped. */
  groupId: z.string().nullable(),
  detected: DetectedProjectSchema,
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const WORKSPACE_ID_SEPARATOR = '::';

export function workspaceId(rootId: string, relPath: string): string {
  return `${rootId}${WORKSPACE_ID_SEPARATOR}${relPath}`;
}

export function splitProjectId(id: string): { rootId: string; relPath: string } {
  const at = id.indexOf(WORKSPACE_ID_SEPARATOR);
  if (at === -1) return { rootId: id, relPath: '' };
  return { rootId: id.slice(0, at), relPath: id.slice(at + WORKSPACE_ID_SEPARATOR.length) };
}

export function findDetected(root: DetectedProject, id: string): DetectedProject | null {
  if (root.id === id) return root;
  return root.workspaces.find((w) => w.id === id) ?? null;
}
