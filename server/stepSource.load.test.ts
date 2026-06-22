import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import type { Frame, Project, Step } from "../drizzle/schema";
import type { StepsArtifact } from "./stepsArtifact";

const storageRoot = vi.hoisted(() => {
  const dir = require("path").join(
    require("os").tmpdir(),
    `step_source_load_test_${Date.now()}`,
  );
  process.env.STORAGE_DIR = dir;
  return dir;
});

const dbMocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  getFramesByProjectId: vi.fn(),
  getStepsByProjectId: vi.fn(),
  updateStep: vi.fn(),
}));

vi.mock("./db", () => dbMocks);

import {
  InvalidStepsArtifactError,
  loadOrCreateStepsArtifactForProject,
  loadProjectStepRenderState,
} from "./stepSource";
import { loadStepsArtifact, saveStepsArtifact } from "./stepsArtifact";

const project: Project = {
  id: 50,
  userId: 1,
  title: "Artifact Project",
  description: null,
  videoUrl: "/api/storage/projects/50/videos/demo.mp4",
  videoKey: "projects/50/videos/demo.mp4",
  status: "completed",
  processingProgress: 100,
  processingMessage: null,
  errorMessage: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const frames: Frame[] = [
  {
    id: 100,
    projectId: 50,
    frameNumber: 0,
    timestamp: 0,
    imageUrl: "/api/storage/projects/50/frames/0.jpg",
    imageKey: "projects/50/frames/0.jpg",
    diffScore: 0,
    sortOrder: 0,
    createdAt: new Date(),
  },
];

const dbStep: Step = {
  id: 501,
  projectId: 50,
  frameId: 100,
  title: "DB title",
  operation: "DB op",
  description: "DB desc",
  narration: "DB narration",
  audioUrl: null,
  audioKey: null,
  sortOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeArtifact(): StepsArtifact {
  return {
    version: "2.0",
    project_id: 50,
    generated_at: "2026-06-21T00:00:00.000Z",
    config: {
      asr_provider: "none",
      ocr_provider: "llm",
      llm_provider: "openai",
      llm_model: "gpt-5.4",
      prompt_version: "authoring-v2-grounded-3",
    },
    overview: null,
    steps: [
      {
        step_id: "step-1",
        sort_order: 0,
        frame_id: 100,
        legacy_step_db_id: 501,
        t_start: 0,
        t_end: 1000,
        representative_frames: [
          {
            frame_id: 100,
            frame_number: 0,
            timestamp: 0,
            image_url: "/api/storage/projects/50/frames/0.jpg",
          },
        ],
        changed_region_bbox: null,
        ocr_text: [],
        transcript_snippet: "",
        instruction: "Artifact op",
        expected_result: "Artifact desc",
        warnings: [],
        confidence: 0.9,
        title: "Artifact title",
        operation: "Artifact op",
        description: "Artifact desc",
        narration: "Artifact narration",
        audio_mode: "auto",
        source_segment_ids: ["seg-1"],
        cited_ui_labels: [],
        needs_review: false,
        review_reasons: [],
      },
    ],
  };
}

async function writeMalformedArtifact(projectId: number): Promise<string> {
  const filePath = path.join(storageRoot, `projects/${projectId}/artifacts/steps.json`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "{ not valid json");
  return filePath;
}

describe("step source loading", () => {
  beforeEach(async () => {
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.mkdir(storageRoot, { recursive: true });
    vi.clearAllMocks();
    dbMocks.getProjectById.mockResolvedValue(project);
    dbMocks.getFramesByProjectId.mockResolvedValue(frames);
    dbMocks.getStepsByProjectId.mockResolvedValue([dbStep]);
    dbMocks.updateStep.mockResolvedValue(undefined);
  });

  it("uses existing steps artifact without creating a DB fallback", async () => {
    await saveStepsArtifact(50, makeArtifact());

    const state = await loadOrCreateStepsArtifactForProject(50, 1);

    expect(state.source).toBe("steps_artifact");
    expect(state.artifact?.steps[0].title).toBe("Artifact title");
    expect(state.dbSteps).toEqual([]);
    expect(dbMocks.getStepsByProjectId).not.toHaveBeenCalled();
  });

  it("creates a compatibility artifact from DB steps when artifact is missing", async () => {
    const state = await loadOrCreateStepsArtifactForProject(50, 1);

    expect(state.source).toBe("db_steps");
    expect(state.dbSteps).toEqual([dbStep]);
    expect(state.artifact?.steps[0]).toMatchObject({
      legacy_step_db_id: 501,
      title: "DB title",
      operation: "DB op",
    });
    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [expect.objectContaining({ legacy_step_db_id: 501 })],
    });
  });

  it("continues with an in-memory compatibility artifact when persistence fails", async () => {
    const writeSpy = vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("storage full"));

    try {
      const state = await loadOrCreateStepsArtifactForProject(50, 1);

      expect(state.source).toBe("db_steps");
      expect(state.artifact?.steps[0]).toMatchObject({
        legacy_step_db_id: 501,
        title: "DB title",
      });
      await expect(loadStepsArtifact(50)).resolves.toBeNull();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("does not overwrite an invalid artifact with a DB fallback", async () => {
    const filePath = await writeMalformedArtifact(50);

    await expect(loadOrCreateStepsArtifactForProject(50, 1)).rejects.toThrow("不正");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("{ not valid json");
    expect(dbMocks.getStepsByProjectId).not.toHaveBeenCalled();
  });

  it("returns renderable steps from an existing artifact", async () => {
    await saveStepsArtifact(50, makeArtifact());

    const state = await loadProjectStepRenderState(50, 1);

    expect(state.source).toBe("steps_artifact");
    expect(state.artifact?.steps[0].title).toBe("Artifact title");
    expect(state.steps).toEqual([
      expect.objectContaining({
        id: 501,
        projectId: 50,
        frameId: 100,
        title: "Artifact title",
        operation: "Artifact op",
      }),
    ]);
    expect(dbMocks.getStepsByProjectId).not.toHaveBeenCalled();
  });

  it("returns renderable steps from a promoted DB compatibility artifact", async () => {
    const state = await loadProjectStepRenderState(50, 1);

    expect(state.source).toBe("db_steps");
    expect(state.warnings).toEqual([]);
    expect(state.invalidArtifactFallbackUsed).toBe(false);
    expect(state.artifact?.config.prompt_version).toBe("legacy-adapter-v1");
    expect(state.steps).toEqual([
      expect.objectContaining({
        id: 501,
        projectId: 50,
        frameId: 100,
        title: "DB title",
        operation: "DB op",
      }),
    ]);
    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [expect.objectContaining({ legacy_step_db_id: 501 })],
    });
  });

  it("can render from DB rows when an invalid artifact exists without overwriting it", async () => {
    const filePath = await writeMalformedArtifact(50);

    const state = await loadProjectStepRenderState(50, 1, {
      invalidArtifactFallback: true,
    });

    expect(state.source).toBe("db_steps");
    expect(state.warnings[0]).toContain("Invalid steps artifact ignored");
    expect(state.invalidArtifactFallbackUsed).toBe(true);
    expect(state.artifact?.steps[0]).toMatchObject({
      legacy_step_db_id: 501,
      title: "DB title",
    });
    expect(state.steps).toEqual([
      expect.objectContaining({
        id: 501,
        title: "DB title",
      }),
    ]);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("{ not valid json");
  });

  it("keeps render state strict for invalid artifacts unless fallback is requested", async () => {
    await writeMalformedArtifact(50);

    await expect(loadProjectStepRenderState(50, 1)).rejects.toThrow(InvalidStepsArtifactError);
  });

  it("returns empty render state with a warning when invalid artifact fallback has no DB steps", async () => {
    await writeMalformedArtifact(50);
    dbMocks.getStepsByProjectId.mockResolvedValue([]);

    const state = await loadProjectStepRenderState(50, 1, {
      invalidArtifactFallback: true,
    });

    expect(state.source).toBe("none");
    expect(state.artifact).toBeNull();
    expect(state.steps).toEqual([]);
    expect(state.warnings[0]).toContain("Invalid steps artifact ignored");
    expect(state.invalidArtifactFallbackUsed).toBe(true);
  });

  it("returns an empty render state when no artifact or DB steps exist", async () => {
    dbMocks.getStepsByProjectId.mockResolvedValue([]);

    const state = await loadProjectStepRenderState(50, 1);

    expect(state.source).toBe("none");
    expect(state.artifact).toBeNull();
    expect(state.steps).toEqual([]);
    expect(state.warnings).toEqual([]);
    expect(state.invalidArtifactFallbackUsed).toBe(false);
  });
});
