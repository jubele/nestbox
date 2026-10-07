import { z } from 'zod';
import { DetectedProjectSchema, ECOSYSTEM_IDS } from '../../detected';
import { defineContract, type ToolDefinition } from '../../tool';

const settingsSchema = z.strictObject({});

export const projectInfoDefinition: ToolDefinition<z.infer<typeof settingsSchema>> = {
  id: 'project-info',
  name: 'Project info',
  icon: 'info',
  appliesTo: () => true,
  settingsSchema,
};

export const projectInfoContract = defineContract({
  getFacts: { input: z.strictObject({}), output: DetectedProjectSchema },
  /** Each detected ecosystem's one-line summary (its module's `summary`, e.g. "Python · Django · .venv"). */
  summaries: {
    input: z.strictObject({}),
    output: z.object({ ecosystems: z.array(z.object({ id: z.enum(ECOSYSTEM_IDS), summary: z.string() })) }),
  },
});
