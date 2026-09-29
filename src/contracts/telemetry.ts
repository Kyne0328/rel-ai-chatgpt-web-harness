import { z } from 'zod';

export const telemetrySettingsPatchSchema = z.object({
  diagnosticsEnabled: z.boolean()
}).strict();
