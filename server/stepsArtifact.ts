import { z } from "zod";
import { readBinaryFromSource, storageGet, storagePut } from "./storage";
import type { Frame, Project, Step } from "../drizzle/schema";

export const STEPS_ARTIFACT_VERSION = "1.0";

const NormalizedBBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});

const RepresentativeFrameSchema = z.object({
  frame_id: z.number().int().positive().optional(),
  frame_number: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(),
  image_url: z.string().min(1),
});

export const StepArtifactSchema = z.object({
  step_id: z.string().min(1),
  sort_order: z.number().int().nonnegative(),
  frame_id: z.number().int().positive().optional(),
  legacy_step_db_id: z.number().int().positive().optional(),
  t_start: z.number().int().nonnegative(),
  t_end: z.number().int().nonnegative(),
  representative_frames: z.array(RepresentativeFrameSchema).min(1),
  changed_region_bbox: NormalizedBBoxSchema.nullable(),
  ocr_text: z.array(z.string()),
  transcript_snippet: z.string(),
  instruction: z.string().min(1),
  expected_result: z.string().min(1),
  warnings: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  title: z.string().min(1),
  operation: z.string().min(1),
  description: z.string().min(1),
  narration: z.string().optional().default(""),
  audio_url: z.string().optional(),
  audio_key: z.string().optional(),
});

export type StepArtifact = z.infer<typeof StepArtifactSchema>;

export const StepsArtifactSchema = z.object({
  version: z.string().min(1),
  project_id: z.number().int().positive(),
  generated_at: z.string().min(1),
  config: z.object({
    asr_provider: z.string(),
    ocr_provider: z.string(),
    llm_provider: z.string(),
    llm_model: z.string(),
    prompt_version: z.string(),
  }),
  steps: z.array(StepArtifactSchema),
});

export type StepsArtifact = z.infer<typeof StepsArtifactSchema>;

export interface LegacyRenderableStep {
  id: number;
  projectId: number;
  frameId: number;
  sortOrder: number;
  title: string;
  operation: string;
  description: string;
  narration: string;
  audioUrl: string | null;
  audioKey: string | null;
}

export function getStepsArtifactStorageKey(projectId: number): string {
  return `projects/${projectId}/artifacts/steps.json`;
}

export async function loadStepsArtifact(projectId: number): Promise<StepsArtifact | null> {
  const key = getStepsArtifactStorageKey(projectId);
  try {
    const file = await storageGet(key);
    const buffer = await readBinaryFromSource(file.url);
    const parsed = JSON.parse(buffer.toString("utf8"));
    return StepsArtifactSchema.parse(parsed);
  } catch {
    return null;
  }
}

export async function saveStepsArtifact(
  projectId: number,
  artifact: StepsArtifact,
): Promise<{ key: string; url: string }> {
  const normalized = StepsArtifactSchema.parse({
    ...artifact,
    version: artifact.version || STEPS_ARTIFACT_VERSION,
    project_id: projectId,
  });
  const key = getStepsArtifactStorageKey(projectId);
  return storagePut(key, JSON.stringify(normalized, null, 2), "application/json");
}

export function buildLegacyRenderableStepsFromArtifact(
  projectId: number,
  artifact: StepsArtifact,
  fallbackFramesByTimestamp: Frame[],
): LegacyRenderableStep[] {
  const framesSorted = [...fallbackFramesByTimestamp].sort((a, b) => a.timestamp - b.timestamp);

  return artifact.steps
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((step, index) => {
      const frameId =
        step.frame_id ??
        step.representative_frames[0]?.frame_id ??
        framesSorted.find((frame) => frame.timestamp >= step.t_start)?.id ??
        framesSorted[index]?.id ??
        framesSorted[0]?.id;

      if (!frameId) {
        throw new Error(`Could not resolve frame for step ${step.step_id}`);
      }

      return {
        id: step.legacy_step_db_id ?? index + 1,
        projectId,
        frameId,
        sortOrder: step.sort_order,
        title: step.title,
        operation: step.operation,
        description: step.description,
        narration: step.narration ?? "",
        audioUrl: step.audio_url ?? null,
        audioKey: step.audio_key ?? null,
      };
    });
}

export function buildStepsArtifactFromDb(
  project: Project,
  frames: Frame[],
  steps: Step[],
): StepsArtifact {
  const frameById = new Map(frames.map((frame) => [frame.id, frame]));
  const orderedSteps = [...steps].sort((a, b) => a.sortOrder - b.sortOrder);

  const artifactSteps: StepArtifact[] = orderedSteps.map((step, index) => {
    const frame = frameById.get(step.frameId);
    const nextFrame = frameById.get(orderedSteps[index + 1]?.frameId ?? -1);
    const tStart = frame?.timestamp ?? index * 1_000;
    const tEnd = nextFrame?.timestamp ?? tStart + 1_500;

    return {
      step_id: `step-${index + 1}`,
      sort_order: step.sortOrder,
      frame_id: step.frameId,
      legacy_step_db_id: step.id,
      t_start: tStart,
      t_end: Math.max(tEnd, tStart + 1),
      representative_frames: [
        {
          frame_id: step.frameId,
          frame_number: frame?.frameNumber ?? index,
          timestamp: tStart,
          image_url: frame?.imageUrl ?? "",
        },
      ],
      changed_region_bbox: null,
      ocr_text: [],
      transcript_snippet: "",
      instruction: step.operation,
      expected_result: step.description,
      warnings: [],
      confidence: 0.5,
      title: step.title,
      operation: step.operation,
      description: step.description,
      narration: step.narration ?? "",
      audio_url: step.audioUrl ?? undefined,
      audio_key: step.audioKey ?? undefined,
    };
  });

  return {
    version: STEPS_ARTIFACT_VERSION,
    project_id: project.id,
    generated_at: new Date().toISOString(),
    config: {
      asr_provider: "none",
      ocr_provider: "none",
      llm_provider: "legacy",
      llm_model: "legacy",
      prompt_version: "legacy-adapter-v1",
    },
    steps: artifactSteps,
  };
}

export async function patchStepArtifact(
  projectId: number,
  patcher: (artifact: StepsArtifact) => StepsArtifact,
): Promise<void> {
  const artifact = await loadStepsArtifact(projectId);
  if (!artifact) {
    return;
  }
  const patched = patcher(artifact);
  await saveStepsArtifact(projectId, patched);
}
