import { projectInfoContract, projectInfoDefinition } from '@shared/tools/project-info/contract';
import { ECOSYSTEM_MODULES } from '../../ecosystems';
import { defineMainTool } from '../types';

export const projectInfoTool = defineMainTool({
  ...projectInfoDefinition,
  contract: projectInfoContract,
  handlers: {
    getFacts: async (ctx) => ctx.project,
    summaries: async (ctx) => ({
      ecosystems: ctx.project.ecosystems.flatMap((entry) => {
        const module = ECOSYSTEM_MODULES.find((m) => m.id === entry.id);
        const summary = module?.summary?.(entry.info) ?? null;
        return summary === null ? [] : [{ id: entry.id, summary }];
      }),
    }),
  },
});
