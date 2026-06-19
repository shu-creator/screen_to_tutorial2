import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { getStepById, getStepsByProjectId, updateStep } from "../server/db";
import { loadStepsArtifact, saveStepsArtifact, type StepsArtifact } from "../server/stepsArtifact";
import type { AudioMode } from "../server/videoClips";

type Options = {
  projectId?: number;
  stepId?: number;
  outdir: string;
};

type SmokeCheck = {
  name: string;
  pass: boolean;
  expected: unknown;
  actual: unknown;
};

const repoRoot = path.resolve(import.meta.dirname, "..");

function parseArgs(argv: string[]): Options {
  const options: Options = {
    outdir: path.join(repoRoot, "outputs", "edit-smoke"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--project-id") {
      if (!next || next.startsWith("--")) throw new Error("--project-id requires a value");
      options.projectId = Number(next);
      i += 1;
    } else if (arg === "--step-id") {
      if (!next || next.startsWith("--")) throw new Error("--step-id requires a value");
      options.stepId = Number(next);
      i += 1;
    } else if (arg === "--outdir") {
      if (!next || next.startsWith("--")) throw new Error("--outdir requires a value");
      options.outdir = path.resolve(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.projectId) || (options.projectId ?? 0) <= 0) {
    throw new Error("--project-id <positive integer> is required");
  }
  if (options.stepId !== undefined && (!Number.isInteger(options.stepId) || options.stepId <= 0)) {
    throw new Error("--step-id must be a positive integer");
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage:
  pnpm edit:smoke -- --project-id <id> [--step-id <id>] [--outdir ./outputs/edit-smoke]

This temporarily edits one step, verifies DB and steps.json artifact sync, then restores the original state.
`);
}

function cloneArtifact(artifact: StepsArtifact): StepsArtifact {
  return JSON.parse(JSON.stringify(artifact)) as StepsArtifact;
}

async function selectStep(projectId: number, requestedStepId?: number) {
  if (requestedStepId !== undefined) {
    const step = await getStepById(requestedStepId);
    if (!step || step.projectId !== projectId) {
      throw new Error(`Step ${requestedStepId} was not found in project ${projectId}`);
    }
    return step;
  }
  const steps = await getStepsByProjectId(projectId);
  const step = steps[0];
  if (!step) {
    throw new Error(`Project ${projectId} has no DB steps`);
  }
  return step;
}

function patchArtifactStep(
  artifact: StepsArtifact,
  stepId: number,
  sortOrder: number,
  patch: {
    title: string;
    operation: string;
    description: string;
    narration: string;
    tStart: number;
    tEnd: number;
    audioMode: AudioMode;
  },
): StepsArtifact {
  let matched = false;
  const steps = artifact.steps.map((step) => {
    const matchesLegacyId = step.legacy_step_db_id === stepId;
    const matchesSortOrder = step.legacy_step_db_id === undefined && step.sort_order === sortOrder;
    if (!matchesLegacyId && !matchesSortOrder) return step;
    matched = true;
    return {
      ...step,
      title: patch.title,
      operation: patch.operation,
      instruction: patch.operation,
      description: patch.description,
      expected_result: patch.description,
      narration: patch.narration,
      t_start: patch.tStart,
      t_end: patch.tEnd,
      audio_mode: patch.audioMode,
      needs_review: false,
      review_reasons: [],
      warnings: [],
    };
  });

  if (!matched) {
    throw new Error(`steps artifact did not contain step ${stepId} or sort_order ${sortOrder}`);
  }
  return { ...artifact, steps };
}

function findArtifactStep(artifact: StepsArtifact, stepId: number, sortOrder: number) {
  return artifact.steps.find((step) => step.legacy_step_db_id === stepId)
    ?? artifact.steps.find((step) => step.legacy_step_db_id === undefined && step.sort_order === sortOrder);
}

function check(name: string, expected: unknown, actual: unknown): SmokeCheck {
  return { name, expected, actual, pass: Object.is(expected, actual) };
}

async function verifyRestored(options: {
  projectId: number;
  stepId: number;
  sortOrder: number;
  originalDbStep: Awaited<ReturnType<typeof getStepById>>;
  originalArtifactStep: ReturnType<typeof findArtifactStep>;
}): Promise<string[]> {
  const { projectId, stepId, sortOrder, originalDbStep, originalArtifactStep } = options;
  const issues: string[] = [];
  const restoredDbStep = await getStepById(stepId);
  const restoredArtifact = await loadStepsArtifact(projectId);
  const restoredArtifactStep = restoredArtifact ? findArtifactStep(restoredArtifact, stepId, sortOrder) : undefined;

  if (!originalDbStep) {
    issues.push("original DB step was unavailable during restore verification");
  } else if (!restoredDbStep) {
    issues.push("restored DB step could not be loaded");
  } else {
    for (const field of ["title", "operation", "description", "narration"] as const) {
      if (!Object.is(restoredDbStep[field] ?? null, originalDbStep[field] ?? null)) {
        issues.push(`DB ${field} was not restored`);
      }
    }
  }

  if (!originalArtifactStep) {
    issues.push("original artifact step was unavailable during restore verification");
  } else if (!restoredArtifactStep) {
    issues.push("restored artifact step could not be loaded");
  } else {
    const comparisons: Array<[string, unknown, unknown]> = [
      ["title", originalArtifactStep.title, restoredArtifactStep.title],
      ["operation", originalArtifactStep.operation, restoredArtifactStep.operation],
      ["instruction", originalArtifactStep.instruction, restoredArtifactStep.instruction],
      ["description", originalArtifactStep.description, restoredArtifactStep.description],
      ["expected_result", originalArtifactStep.expected_result, restoredArtifactStep.expected_result],
      ["narration", originalArtifactStep.narration ?? "", restoredArtifactStep.narration ?? ""],
      ["t_start", originalArtifactStep.t_start, restoredArtifactStep.t_start],
      ["t_end", originalArtifactStep.t_end, restoredArtifactStep.t_end],
      ["audio_mode", originalArtifactStep.audio_mode, restoredArtifactStep.audio_mode],
      ["needs_review", originalArtifactStep.needs_review, restoredArtifactStep.needs_review],
      ["review_reasons.length", originalArtifactStep.review_reasons.length, restoredArtifactStep.review_reasons.length],
      ["warnings.length", originalArtifactStep.warnings.length, restoredArtifactStep.warnings.length],
    ];
    for (const [field, expected, actual] of comparisons) {
      if (!Object.is(expected, actual)) {
        issues.push(`artifact ${field} was not restored`);
      }
    }
  }

  return issues;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await fs.mkdir(options.outdir, { recursive: true });

  const projectId = options.projectId as number;
  const step = await selectStep(projectId, options.stepId);
  const artifact = await loadStepsArtifact(projectId);
  if (!artifact) {
    throw new Error(`Project ${projectId} has no steps artifact`);
  }
  const originalArtifact = cloneArtifact(artifact);
  const originalDbStep = { ...step };

  const originalArtifactStep = findArtifactStep(artifact, step.id, step.sortOrder);
  if (!originalArtifactStep) {
    throw new Error(`Project ${projectId} artifact has no matching step for DB step ${step.id}`);
  }

  const tStart = originalArtifactStep.t_start + 50;
  const tEnd = Math.max(tStart + 1, originalArtifactStep.t_end + 50);
  const marker = `smoke-${Date.now()}`;
  const edit = {
    title: `編集スモーク ${marker}`,
    operation: `操作スモーク ${marker}`,
    description: `説明スモーク ${marker}`,
    narration: `ナレーションスモーク ${marker}`,
    tStart,
    tEnd,
    audioMode: "silent" as AudioMode,
  };

  const summaryPath = path.join(options.outdir, `project_${projectId}_edit_smoke_summary.json`);
  const startedAt = new Date().toISOString();
  let restored = false;
  let restoreError: string | null = null;

  try {
    await updateStep(step.id, {
      title: edit.title,
      operation: edit.operation,
      description: edit.description,
      narration: edit.narration,
    });
    await saveStepsArtifact(projectId, patchArtifactStep(artifact, step.id, step.sortOrder, edit));

    const updatedDbStep = await getStepById(step.id);
    const updatedArtifact = await loadStepsArtifact(projectId);
    const updatedArtifactStep = updatedArtifact ? findArtifactStep(updatedArtifact, step.id, step.sortOrder) : undefined;
    if (!updatedDbStep || !updatedArtifact || !updatedArtifactStep) {
      throw new Error("Updated DB step or artifact step could not be loaded");
    }

    const checks = [
      check("db.title", edit.title, updatedDbStep.title),
      check("db.operation", edit.operation, updatedDbStep.operation),
      check("db.description", edit.description, updatedDbStep.description),
      check("db.narration", edit.narration, updatedDbStep.narration ?? ""),
      check("artifact.title", edit.title, updatedArtifactStep.title),
      check("artifact.operation", edit.operation, updatedArtifactStep.operation),
      check("artifact.instruction", edit.operation, updatedArtifactStep.instruction),
      check("artifact.description", edit.description, updatedArtifactStep.description),
      check("artifact.expected_result", edit.description, updatedArtifactStep.expected_result),
      check("artifact.narration", edit.narration, updatedArtifactStep.narration ?? ""),
      check("artifact.t_start", edit.tStart, updatedArtifactStep.t_start),
      check("artifact.t_end", edit.tEnd, updatedArtifactStep.t_end),
      check("artifact.audio_mode", edit.audioMode, updatedArtifactStep.audio_mode),
      check("artifact.needs_review", false, updatedArtifactStep.needs_review),
      check("artifact.review_reasons.length", 0, updatedArtifactStep.review_reasons.length),
      check("artifact.warnings.length", 0, updatedArtifactStep.warnings.length),
    ];

    const pass = checks.every((item) => item.pass);
    const summary = {
      project_id: projectId,
      step_id: step.id,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      pass,
      checks,
      restored_after_check: false,
      restore_error: null as string | null,
      note: "This smoke temporarily edits DB and steps.json, verifies sync, then restores the original state in finally and verifies restored values by re-read.",
    };
    await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    if (!pass) {
      throw new Error(`edit smoke failed; see ${path.relative(repoRoot, summaryPath)}`);
    }
  } finally {
    try {
      await updateStep(step.id, {
        title: originalDbStep.title,
        operation: originalDbStep.operation,
        description: originalDbStep.description,
        narration: originalDbStep.narration ?? null,
      });
      await saveStepsArtifact(projectId, originalArtifact);
      const restoreIssues = await verifyRestored({
        projectId,
        stepId: step.id,
        sortOrder: step.sortOrder,
        originalDbStep,
        originalArtifactStep,
      });
      restored = restoreIssues.length === 0;
      if (!restored) {
        restoreError = restoreIssues.join("; ");
      }
    } catch (error) {
      restoreError = error instanceof Error ? error.message : String(error);
    }

    try {
      const raw = await fs.readFile(summaryPath, "utf8");
      const summary = JSON.parse(raw) as Record<string, unknown>;
      summary.restored_after_check = restored;
      summary.restore_error = restoreError;
      await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    } catch {
      const summary = {
        project_id: projectId,
        step_id: step.id,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        pass: false,
        checks: [],
        restored_after_check: restored,
        restore_error: restoreError,
        note: "Summary was written from finally because the smoke failed before normal summary creation. If restore_error references saveStepsArtifact, the artifact may still contain smoke values and should be regenerated.",
      };
      await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    }
  }

  if (!restored) {
    throw new Error(`edit smoke could not restore original state: ${restoreError}`);
  }
  console.log(`edit smoke summary: ${path.relative(repoRoot, summaryPath)}`);
  console.log(await fs.readFile(summaryPath, "utf8"));
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
