import type { Frame, Project, Step } from "../drizzle/schema";
import { createLogger } from "./_core/logger";
import * as db from "./db";
import {
  buildLegacyRenderableStepsFromArtifact,
  buildStepsArtifactFromDb,
  loadStepsArtifactResult,
  saveStepsArtifact,
  type LegacyRenderableStep,
  type StepAudioMode,
  type StepsArtifact,
} from "./stepsArtifact";

const logger = createLogger("StepSource");

export type StepListItem = LegacyRenderableStep;

export type StepSourceKind = "steps_artifact" | "db_steps" | "none";

export type StepSourceState = {
  project: Project;
  frames: Frame[];
  artifact: StepsArtifact | null;
  dbSteps: Step[];
  source: StepSourceKind;
};

export type ArtifactStepUpdate = {
  title?: string;
  operation?: string;
  description?: string;
  narration?: string;
  tStart?: number;
  tEnd?: number;
  audioMode?: StepAudioMode;
  markReviewed?: true;
};

export function buildStepListFromArtifact(
  projectId: number,
  artifact: StepsArtifact,
  frames: Frame[],
): StepListItem[] {
  return buildLegacyRenderableStepsFromArtifact(projectId, artifact, frames);
}

export function buildStepListFromDbRows(steps: Step[]): StepListItem[] {
  return steps
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((step) => ({
      id: step.id,
      projectId: step.projectId,
      frameId: step.frameId,
      sortOrder: step.sortOrder,
      title: step.title,
      operation: step.operation,
      description: step.description,
      narration: step.narration ?? "",
      audioUrl: step.audioUrl ?? null,
      audioKey: step.audioKey ?? null,
    }));
}

export function patchArtifactStepForUpdate(
  artifact: StepsArtifact,
  stepId: number,
  sortOrder: number | undefined,
  data: ArtifactStepUpdate,
): { artifact: StepsArtifact; matched: boolean } {
  let matched = false;
  const steps = artifact.steps.map((step) => {
    const matchesLegacyId = step.legacy_step_db_id === stepId;
    const matchesSortOrder = step.legacy_step_db_id === undefined && step.sort_order === sortOrder;
    if (!matchesLegacyId && !matchesSortOrder) {
      return step;
    }

    matched = true;
    const nextTStart = data.tStart ?? step.t_start;
    const nextTEnd = data.tEnd ?? step.t_end;
    if ((data.tStart !== undefined || data.tEnd !== undefined) && nextTEnd <= nextTStart) {
      throw new Error("t_end は t_start より後にしてください");
    }

    return {
      ...step,
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.operation !== undefined
        ? { operation: data.operation, instruction: data.operation }
        : {}),
      ...(data.description !== undefined
        ? { description: data.description, expected_result: data.description }
        : {}),
      ...(data.narration !== undefined ? { narration: data.narration } : {}),
      t_start: nextTStart,
      t_end: nextTEnd,
      ...(data.audioMode !== undefined ? { audio_mode: data.audioMode } : {}),
      ...(data.markReviewed
        ? { needs_review: false, review_reasons: [], warnings: [] }
        : {}),
    };
  });

  return matched
    ? { artifact: { ...artifact, steps }, matched }
    : { artifact, matched };
}

export function deleteArtifactStepByLegacyId(
  artifact: StepsArtifact,
  stepId: number,
): { artifact: StepsArtifact; matched: boolean } {
  const remaining = artifact.steps.filter((step) => step.legacy_step_db_id !== stepId);
  if (remaining.length === artifact.steps.length) {
    return { artifact, matched: false };
  }

  const steps = remaining
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((step, index) => ({
      ...step,
      sort_order: index,
      step_id: `step-${index + 1}`,
    }));

  return {
    artifact: { ...artifact, steps },
    matched: true,
  };
}

export function reorderArtifactStepsByLegacyIds(
  artifact: StepsArtifact,
  stepIds: number[],
): { artifact: StepsArtifact; matched: boolean } {
  if (new Set(stepIds).size !== stepIds.length) {
    return { artifact, matched: false };
  }

  const byLegacyId = new Map(
    artifact.steps
      .filter((step) => typeof step.legacy_step_db_id === "number")
      .map((step) => [step.legacy_step_db_id as number, step]),
  );

  const reordered = stepIds.map((id) => byLegacyId.get(id));
  if (
    byLegacyId.size !== artifact.steps.length ||
    reordered.length !== artifact.steps.length ||
    reordered.some((step) => step === undefined)
  ) {
    return { artifact, matched: false };
  }
  const orderedSteps = reordered as StepsArtifact["steps"];

  return {
    artifact: {
      ...artifact,
      steps: orderedSteps.map((step, index) => ({
        ...step,
        sort_order: index,
        step_id: `step-${index + 1}`,
      })),
    },
    matched: true,
  };
}

export async function loadOrCreateStepsArtifactForProject(
  projectId: number,
  userId?: number,
): Promise<StepSourceState> {
  const project = await db.getProjectById(projectId, userId);
  if (!project) {
    throw new Error("プロジェクトが見つかりません");
  }

  const frames = await db.getFramesByProjectId(projectId, userId);
  const loadResult = await loadStepsArtifactResult(projectId);
  if (loadResult.status === "invalid") {
    throw new Error(`steps artifactが不正なためDB fallbackを作成できません: ${loadResult.message}`);
  }
  if (loadResult.status === "loaded") {
    return {
      project,
      frames,
      artifact: loadResult.artifact,
      dbSteps: [],
      source: "steps_artifact",
    };
  }

  const dbSteps = await db.getStepsByProjectId(projectId, userId);
  if (dbSteps.length === 0) {
    return {
      project,
      frames,
      artifact: null,
      dbSteps,
      source: "none",
    };
  }

  const artifact = buildStepsArtifactFromDb(project, frames, dbSteps);
  try {
    await saveStepsArtifact(projectId, artifact);
  } catch (error) {
    logger.warn("Failed to persist compatibility artifact; continuing with in-memory state", {
      projectId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    project,
    frames,
    artifact,
    dbSteps,
    source: "db_steps",
  };
}

export async function listProjectStepsArtifactFirst(
  projectId: number,
  userId?: number,
): Promise<StepListItem[]> {
  const state = await loadOrCreateStepsArtifactForProject(projectId, userId);
  if (!state.artifact || state.artifact.steps.length === 0) {
    return [];
  }
  return buildStepListFromArtifact(projectId, state.artifact, state.frames);
}
