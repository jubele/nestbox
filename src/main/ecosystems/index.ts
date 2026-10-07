import type { EcosystemModule } from './types';
import { dotnetModule } from './dotnet';
import { pythonModule } from './python';

// Registry of all ecosystem modules
// Modules are checked in order during detection
export const ECOSYSTEM_MODULES: ReadonlyArray<EcosystemModule<unknown, unknown>> = [
  pythonModule as EcosystemModule<unknown, unknown>,
  dotnetModule as EcosystemModule<unknown, unknown>,
];

// Re-export types
export * from './types';
