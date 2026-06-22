import type { Frame, InsertStep, Project, Step } from "../drizzle/schema";
import { createLogger } from "./_core/logger";
import * as db from "./db";
import type { RegeneratedStepData } from "./stepGenerator";
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

export type ProjectStepRenderState = {
  project: Project;
  frames: Frame[];
  artifact: StepsArtifact | null;
  steps: StepListItem[];
  source: StepSourceKind;
  warnings: string[];
  invalidArtifactFallbackUsed: boolean;
};

export type LoadProjectStepRenderStateOptions = {
  /**
   * Render/export paths keep the pre-Phase-6 v1 compatibility behavior:
   * corrupt artifacts can still render from DB rows, without overwriting the
   * corrupt artifact. Edit routes should keep the strict default.
   */
  invalidArtifactFallback?: boolean;
};

export class InvalidStepsArtifactError extends Error {
  readonly projectId: number;
  readonly reason: string;

  constructor(projectId: number, reason: string, message: string) {
    super(`steps artifactが不正です (${reason}): ${message}`);
    this.name = "InvalidStepsArtifactError";
    this.projectId = projectId;
    this.reason = reason;
  }
}

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

export type UpdateProjectStepResult = {
  artifactUpdated: boolean;
  dbUpdated: boolean;
};

export type DeleteProjectStepResult = {
  artifactUpdated: boolean;
  dbDeleted: boolean;
};

export type ReorderProjectStepsResult = {
  artifactUpdated: boolean;
  dbReordered: boolean;
};

export type RegenerateProjectStepResult = {
  artifactUpdated: boolean;
  dbUpdated: boolean;
};

function buildDbStepPatch(data: ArtifactStepUpdate): Partial<InsertStep> {
  return {
    ...(data.title !== undefined ? { title: data.title } : {}),
    ...(data.operation !== undefined ? { operation: data.operation } : {}),
    ...(data.description !== undefined ? { description: data.description } : {}),
    ...(data.narration !== undefined ? { narration: data.narration } : {}),
  };
}

function hasArtifactOnlyUpdateFields(data: ArtifactStepUpdate): boolean {
  return (
    data.tStart !== undefined ||
    data.tEnd !== undefined ||
    data.audioMode !== undefined ||
    data.markReviewed !== undefined
  );
}

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
  data: ArtifactStepUpdate,
): { artifact: StepsArtifact; matched: boolean } {
  let matched = false;
  const steps = artifact.steps.map((step) => {
    const matchesLegacyId = step.legacy_step_db_id === stepId;
    if (!matchesLegacyId) {
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

export function artifactContainsStepTarget(
  artifact: StepsArtifact,
  stepId: number,
): boolean {
  return artifact.steps.some((step) => step.legacy_step_db_id === stepId);
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
    throw new InvalidStepsArtifactError(projectId, loadResult.reason, loadResult.message);
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

export async function loadProjectStepRenderState(
  projectId: number,
  userId?: number,
  options: LoadProjectStepRenderStateOptions = {},
): Promise<ProjectStepRenderState> {
  let state: StepSourceState;
  const warnings: string[] = [];
  let invalidArtifactFallbackUsed = false;
  try {
    state = await loadOrCreateStepsArtifactForProject(projectId, userId);
  } catch (error) {
    if (
      !options.invalidArtifactFallback ||
      !(error instanceof InvalidStepsArtifactError)
    ) {
      throw error;
    }

    const project = await db.getProjectById(projectId, userId);
    if (!project) {
      throw new Error("プロジェクトが見つかりません");
    }
    const frames = await db.getFramesByProjectId(projectId, userId);
    const dbSteps = await db.getStepsByProjectId(projectId, userId);
    const artifact = dbSteps.length > 0 ? buildStepsArtifactFromDb(project, frames, dbSteps) : null;
    invalidArtifactFallbackUsed = true;
    warnings.push(
      `Invalid steps artifact ignored for render fallback (${error.reason}): ${error.message}`,
    );
    state = {
      project,
      frames,
      artifact,
      dbSteps,
      source: dbSteps.length > 0 ? "db_steps" : "none",
    };
  }

  return {
    project: state.project,
    frames: state.frames,
    artifact: state.artifact,
    steps: state.artifact
      ? buildStepListFromArtifact(projectId, state.artifact, state.frames)
      : buildStepListFromDbRows(state.dbSteps),
    source: state.source,
    warnings,
    invalidArtifactFallbackUsed,
  };
}

export async function updateProjectStepArtifactFirst(
  input: {
    projectId?: number;
    stepId: number;
    data: ArtifactStepUpdate;
  },
  userId?: number,
): Promise<UpdateProjectStepResult> {
  const existingStep = await db.getStepById(input.stepId, userId);
  const projectId = input.projectId ?? existingStep?.projectId;
  if (projectId === undefined) {
    throw new Error("ステップが見つかりません");
  }
  if (existingStep && existingStep.projectId !== projectId) {
    throw new Error("ステップが見つかりません");
  }

  const dbData = buildDbStepPatch(input.data);
  const hasDbFields = Object.keys(dbData).length > 0;
  const hasArtifactOnlyFields = hasArtifactOnlyUpdateFields(input.data);
  const hasArtifactFields = hasDbFields || hasArtifactOnlyFields;

  const state = await loadOrCreateStepsArtifactForProject(projectId, userId);

  if (!state.artifact || !hasArtifactFields) {
    if (hasArtifactOnlyFields) {
      throw new Error("steps artifactが存在しないため、時刻/音声モード/レビュー状態を保存できません");
    }
    if (hasDbFields && existingStep) {
      await db.updateStep(input.stepId, dbData, userId);
      return { artifactUpdated: false, dbUpdated: true };
    }
    if (!existingStep) {
      throw new Error("ステップが見つかりません");
    }
    return { artifactUpdated: false, dbUpdated: false };
  }

  const patchResult = patchArtifactStepForUpdate(
    state.artifact,
    input.stepId,
    input.data,
  );
  if (!patchResult.matched) {
    if (!existingStep) {
      throw new Error("ステップが見つかりません");
    }
    throw new Error("ステップがsteps artifact内に見つかりませんでした");
  }

  await saveStepsArtifact(projectId, patchResult.artifact);

  let dbUpdated = false;
  if (hasDbFields && existingStep) {
    try {
      await db.updateStep(input.stepId, dbData, userId);
      dbUpdated = true;
    } catch (error) {
      logger.warn("Failed to mirror artifact-first step update into DB", {
        projectId,
        stepId: input.stepId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { artifactUpdated: true, dbUpdated };
}

export async function deleteProjectStepArtifactFirst(
  input: {
    projectId?: number;
    stepId: number;
  },
  userId?: number,
): Promise<DeleteProjectStepResult> {
  const existingStep = await db.getStepById(input.stepId, userId);
  const projectId = input.projectId ?? existingStep?.projectId;
  if (projectId === undefined) {
    throw new Error("ステップが見つかりません");
  }
  if (existingStep && existingStep.projectId !== projectId) {
    throw new Error("ステップが見つかりません");
  }

  const state = await loadOrCreateStepsArtifactForProject(projectId, userId);
  if (!state.artifact) {
    throw new Error("steps artifactを作成できないため、ステップを削除できません");
  }

  const deleted = deleteArtifactStepByLegacyId(state.artifact, input.stepId);
  if (!deleted.matched) {
    if (!existingStep) {
      throw new Error("ステップが見つかりません");
    }
    throw new Error("ステップがsteps artifact内に見つかりませんでした");
  }

  await saveStepsArtifact(projectId, deleted.artifact);

  let dbDeleted = false;
  if (existingStep) {
    try {
      await db.deleteStep(input.stepId, userId);
      const remainingSteps = await db.getStepsByProjectId(projectId, userId);
      const sortedRemaining = remainingSteps
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder);
      if (sortedRemaining.length > 0) {
        await db.reorderSteps(
          projectId,
          sortedRemaining.map((item) => item.id),
        );
      }
      dbDeleted = true;
    } catch (error) {
      logger.warn("Failed to mirror artifact-first step delete into DB", {
        projectId,
        stepId: input.stepId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { artifactUpdated: true, dbDeleted };
}

export async function reorderProjectStepsArtifactFirst(
  input: {
    projectId: number;
    stepIds: number[];
  },
  userId?: number,
): Promise<ReorderProjectStepsResult> {
  const state = await loadOrCreateStepsArtifactForProject(input.projectId, userId);
  if (!state.artifact) {
    throw new Error("steps artifactを作成できないため、順序を保存できません");
  }

  const reordered = reorderArtifactStepsByLegacyIds(state.artifact, input.stepIds);
  if (!reordered.matched) {
    throw new Error("artifactのステップ順序を解決できませんでした");
  }

  await saveStepsArtifact(input.projectId, reordered.artifact);

  let dbReordered = false;
  try {
    await db.reorderSteps(input.projectId, input.stepIds);
    dbReordered = true;
  } catch (error) {
    logger.warn("Failed to mirror artifact-first step reorder into DB", {
      projectId: input.projectId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return { artifactUpdated: true, dbReordered };
}

export async function regenerateProjectStepArtifactFirst(
  input: {
    projectId?: number;
    stepId: number;
    frame: Frame;
    data: RegeneratedStepData;
    state?: StepSourceState;
    existingStep?: Step | null;
  },
  userId?: number,
): Promise<RegenerateProjectStepResult> {
  const existingStep = input.existingStep ?? await db.getStepById(input.stepId, userId);
  const projectId = input.projectId ?? existingStep?.projectId ?? input.state?.project.id;
  if (projectId === undefined) {
    throw new Error("ステップが見つかりません");
  }
  if (existingStep && existingStep.projectId !== projectId) {
    throw new Error("ステップが見つかりません");
  }
  if (input.frame.projectId !== projectId) {
    throw new Error("フレームが見つかりません");
  }

  const state = input.state ?? await loadOrCreateStepsArtifactForProject(projectId, userId);
  if (!state.artifact) {
    throw new Error("steps artifactを作成できないため、ステップを再生成できません");
  }

  let matched = false;
  const steps = state.artifact.steps.map((step) => {
    if (step.legacy_step_db_id !== input.stepId) {
      return step;
    }

    matched = true;
    return {
      ...step,
      frame_id: input.frame.id,
      representative_frames: [
        {
          frame_id: input.frame.id,
          frame_number: input.frame.frameNumber,
          timestamp: input.frame.timestamp,
          image_url: input.frame.imageUrl,
        },
      ],
      title: input.data.title,
      operation: input.data.operation,
      description: input.data.description,
      narration: input.data.narration,
      instruction: input.data.instruction,
      expected_result: input.data.expected_result,
      warnings: input.data.warnings,
      confidence: input.data.confidence,
    };
  });

  if (!matched) {
    throw new Error("ステップがsteps artifact内に見つかりませんでした");
  }

  await saveStepsArtifact(projectId, { ...state.artifact, steps });

  let dbUpdated = false;
  if (existingStep) {
    try {
      await db.updateStep(input.stepId, {
        frameId: input.frame.id,
        title: input.data.title,
        operation: input.data.operation,
        description: input.data.description,
        narration: input.data.narration,
      }, userId);
      dbUpdated = true;
    } catch (error) {
      logger.warn("Failed to mirror artifact-first step regenerate into DB", {
        projectId,
        stepId: input.stepId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { artifactUpdated: true, dbUpdated };
}
