import { z } from "zod";

export const ToolCallRecordSchema = z.object({
  toolName: z.string(),
  args: z.unknown(),
});

export const ToolResultRecordSchema = z.object({
  toolName: z.string(),
  result: z.unknown(),
});

export const StepRecordSchema = z.object({
  stepIndex: z.number(),
  stepType: z.string().optional(),
  text: z.string().optional(),
  reasoning: z.string().optional(),
  toolCalls: z.array(ToolCallRecordSchema),
  toolResults: z.array(ToolResultRecordSchema),
  usage: z.object({
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number(),
  }).optional(),
  finishReason: z.string().optional(),
});

export const CallRecordSchema = z.object({
  phase: z.string(),
  attemptIndex: z.number(),
  wallMs: z.number(),
  usage: z.object({
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number(),
  }).optional(),
  finishReason: z.string().optional(),
  warnings: z.array(z.unknown()).optional(),
  text: z.string().optional(),
  reasoning: z.string().optional(),
  steps: z.array(StepRecordSchema),
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
  }).optional(),
});

export const ChangedFilesSchema = z.object({
  staged: z.array(z.string()),
  modified: z.array(z.string()),
  deleted: z.array(z.string()),
  created: z.array(z.string()),
  untracked: z.array(z.string()),
  renamed: z.array(z.object({ from: z.string(), to: z.string() })),
});

export const DiffSectionSchema = z.object({
  path: z.string(),
  diff: z.string(),
  truncated: z.boolean(),
  omitted: z.boolean().optional(),
});

export const CommitEntrySchema = z.object({
  type: z.string(),
  scope: z.string().nullable().optional(),
  description: z.string(),
  files: z.array(z.string()),
});

export const StatsReportSchema = z.object({
  schemaVersion: z.literal(1),
  ok: z.boolean(),
  model: z.string(),
  generatedAt: z.string(),
  workdir: z.string(),
  context: z.union([
    z.null(),
    z.object({
      systemPromptChars: z.number(),
      userPromptChars: z.number(),
      changedFiles: ChangedFilesSchema,
      allChangedPaths: z.array(z.string()),
      diffSections: z.array(DiffSectionSchema),
      diffCapHit: z.boolean(),
    }),
  ]),
  calls: z.array(CallRecordSchema),
  metrics: z.object({
    totalMs: z.number(),
  }),
  result: z.union([
    z.object({
      schemaValid: z.literal(true),
      coverageValid: z.literal(true),
      formatRepairs: z.number(),
      coverageRetries: z.number(),
      commits: z.array(CommitEntrySchema),
    }),
    z.object({
      error: z.object({
        phase: z.string(),
        message: z.string(),
        rawOutput: z.string().optional(),
      }),
    }),
  ]),
});

export type StatsReport = z.infer<typeof StatsReportSchema>;
