import { z } from "zod";
import { OverviewSchema } from "../stepsArtifact";

export const RawAuthoredStepSchema = z
  .object({
    source_segment_ids: z.array(z.string()),
    title: z.string(),
    instruction: z.string(),
    expected_result: z.string(),
    operation: z.string(),
    description: z.string(),
    narration: z.string(),
    cited_ui_labels: z.array(z.string()),
  })
  .strict();

export const RawAuthoringResponseSchema = z
  .object({
    overview: OverviewSchema,
    steps: z.array(RawAuthoredStepSchema),
    discarded_segments: z.array(
      z
        .object({
          segment_id: z.string(),
          reason: z.string(),
        })
        .strict()
    ),
  })
  .strict();

export type RawAuthoredStep = z.infer<typeof RawAuthoredStepSchema>;
export type RawAuthoringResponse = z.infer<typeof RawAuthoringResponseSchema>;

export const AUTHORING_JSON_SCHEMA = {
  name: "tutorial_authoring",
  strict: true,
  schema: {
    type: "object",
    properties: {
      overview: {
        type: "object",
        properties: {
          task_title: { type: "string" },
          preconditions: { type: "array", items: { type: "string" } },
          completion_criteria: { type: "string" },
        },
        required: ["task_title", "preconditions", "completion_criteria"],
        additionalProperties: false,
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source_segment_ids: { type: "array", items: { type: "string" } },
            title: { type: "string" },
            instruction: { type: "string" },
            expected_result: { type: "string" },
            operation: { type: "string" },
            description: { type: "string" },
            narration: { type: "string" },
            cited_ui_labels: { type: "array", items: { type: "string" } },
          },
          required: [
            "source_segment_ids",
            "title",
            "instruction",
            "expected_result",
            "operation",
            "description",
            "narration",
            "cited_ui_labels",
          ],
          additionalProperties: false,
        },
      },
      discarded_segments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            segment_id: { type: "string" },
            reason: { type: "string" },
          },
          required: ["segment_id", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["overview", "steps", "discarded_segments"],
    additionalProperties: false,
  },
} as const;

export function parseRawAuthoringResponse(
  value: unknown
): RawAuthoringResponse {
  return RawAuthoringResponseSchema.parse(value);
}
