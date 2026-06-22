import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import type { TrpcContext } from "./_core/context";
import type { Frame, Project, Step } from "../drizzle/schema";
import type { StepsArtifact } from "./stepsArtifact";

const storageRoot = vi.hoisted(() => {
  const dir = require("path").join(
    require("os").tmpdir(),
    `step_source_router_test_${Date.now()}`,
  );
  process.env.STORAGE_DIR = dir;
  return dir;
});

const dbMocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  getFramesByProjectId: vi.fn(),
  getStepsByProjectId: vi.fn(),
  getFrameById: vi.fn(),
  getStepById: vi.fn(),
  updateStep: vi.fn(),
  deleteStep: vi.fn(),
  reorderSteps: vi.fn(),
}));

const stepGeneratorMocks = vi.hoisted(() => ({
  analyzeFrameForStepRegeneration: vi.fn(),
  generateStepsForProject: vi.fn(),
  regenerateStep: vi.fn(),
}));

const slideGeneratorMocks = vi.hoisted(() => ({
  generateSlides: vi.fn(),
}));

const videoGeneratorMocks = vi.hoisted(() => ({
  generateAudioForProject: vi.fn(),
  generateVideo: vi.fn(),
}));

vi.mock("./db", () => dbMocks);
vi.mock("./stepGenerator", () => stepGeneratorMocks);
vi.mock("./slideGenerator", () => slideGeneratorMocks);
vi.mock("./videoGenerator", () => videoGeneratorMocks);

import { appRouter } from "./routers";
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
  {
    id: 101,
    projectId: 50,
    frameNumber: 1,
    timestamp: 1000,
    imageUrl: "/api/storage/projects/50/frames/1.jpg",
    imageKey: "projects/50/frames/1.jpg",
    diffScore: 1,
    sortOrder: 1,
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

const dbStep2: Step = {
  ...dbStep,
  id: 502,
  frameId: 101,
  title: "DB title 2",
  operation: "DB op 2",
  description: "DB desc 2",
  narration: "DB narration 2",
  sortOrder: 1,
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
    overview: {
      task_title: "Artifact task",
      preconditions: ["ログイン済み"],
      completion_criteria: "保存できる",
    },
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
        warnings: ["check this"],
        confidence: 0.4,
        title: "Artifact title",
        operation: "Artifact op",
        description: "Artifact desc",
        narration: "Artifact narration",
        audio_mode: "silent",
        audio_url: "/api/storage/projects/50/audio/1.mp3",
        audio_key: "projects/50/audio/1.mp3",
        source_segment_ids: ["seg-1"],
        cited_ui_labels: [],
        needs_review: true,
        review_reasons: ["verification:low_confidence"],
      },
    ],
  };
}

function makeTwoStepArtifact(): StepsArtifact {
  const artifact = makeArtifact();
  return {
    ...artifact,
    steps: [
      artifact.steps[0],
      {
        ...artifact.steps[0],
        step_id: "step-2",
        sort_order: 1,
        frame_id: 101,
        legacy_step_db_id: 502,
        t_start: 1000,
        t_end: 2500,
        representative_frames: [
          {
            frame_id: 101,
            frame_number: 1,
            timestamp: 1000,
            image_url: "/api/storage/projects/50/frames/1.jpg",
          },
        ],
        instruction: "Artifact op 2",
        expected_result: "Artifact desc 2",
        title: "Artifact title 2",
        operation: "Artifact op 2",
        description: "Artifact desc 2",
        narration: "Artifact narration 2",
        audio_url: undefined,
        audio_key: undefined,
        source_segment_ids: ["seg-2"],
      },
    ],
  };
}

function createCaller() {
  const now = new Date();
  const ctx: TrpcContext = {
    user: {
      id: 1,
      openId: "route-test-user",
      email: "route-test@example.com",
      name: "Route Test",
      loginMethod: "local",
      role: "user",
      createdAt: now,
      updatedAt: now,
      lastSignedIn: now,
    },
    req: {
      protocol: "http",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as unknown as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}

async function writeMalformedArtifact(projectId: number): Promise<string> {
  const filePath = path.join(storageRoot, `projects/${projectId}/artifacts/steps.json`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "{ not valid json");
  return filePath;
}

describe("step router artifact-first read routes", () => {
  beforeEach(async () => {
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.mkdir(storageRoot, { recursive: true });
    vi.clearAllMocks();
    dbMocks.getProjectById.mockResolvedValue(project);
    dbMocks.getFramesByProjectId.mockResolvedValue(frames);
    dbMocks.getStepsByProjectId.mockResolvedValue([dbStep]);
    dbMocks.getFrameById.mockImplementation((frameId: number) => (
      Promise.resolve(frames.find((frame) => frame.id === frameId))
    ));
    dbMocks.getStepById.mockResolvedValue(dbStep);
    dbMocks.updateStep.mockResolvedValue(undefined);
    dbMocks.deleteStep.mockResolvedValue(undefined);
    dbMocks.reorderSteps.mockResolvedValue(undefined);
    stepGeneratorMocks.analyzeFrameForStepRegeneration.mockResolvedValue({
      title: "Regenerated title",
      operation: "Regenerated op",
      description: "Regenerated desc",
      narration: "Regenerated narration",
      instruction: "Regenerated instruction",
      expected_result: "Regenerated expected",
      warnings: ["regenerated warning"],
      confidence: 0.72,
    });
    stepGeneratorMocks.generateStepsForProject.mockResolvedValue(undefined);
    stepGeneratorMocks.regenerateStep.mockResolvedValue(undefined);
    slideGeneratorMocks.generateSlides.mockResolvedValue("/api/storage/projects/50/slides/demo.pptx");
    videoGeneratorMocks.generateAudioForProject.mockResolvedValue({ silentFallbackCount: 0 });
    videoGeneratorMocks.generateVideo.mockResolvedValue({
      videoUrl: "/api/storage/projects/50/videos/demo.mp4",
      warnings: [],
      stillImageFallbackCount: 0,
    });
  });

  it("lists artifact-backed steps and exposes review metadata through the same artifact", async () => {
    await saveStepsArtifact(50, makeArtifact());
    const caller = createCaller();

    const steps = await caller.step.listByProject({ projectId: 50 });
    expect(steps).toEqual([
      expect.objectContaining({
        id: 501,
        frameId: 100,
        title: "Artifact title",
        operation: "Artifact op",
        audioUrl: "/api/storage/projects/50/audio/1.mp3",
      }),
    ]);
    expect(dbMocks.getStepsByProjectId).not.toHaveBeenCalled();

    const artifactInfo = await caller.step.artifactInfo({ projectId: 50 });
    expect(artifactInfo.overview).toEqual({
      task_title: "Artifact task",
      preconditions: ["ログイン済み"],
      completion_criteria: "保存できる",
    });
    expect(artifactInfo.reviewByStepId[501]).toEqual({
      needsReview: true,
      reviewReasons: ["verification:low_confidence"],
      warnings: ["check this"],
      confidence: 0.4,
      tStart: 0,
      tEnd: 1000,
      audioMode: "silent",
    });
  });

  it("creates a compatibility artifact from DB steps when listing a DB-only project", async () => {
    const caller = createCaller();

    const steps = await caller.step.listByProject({ projectId: 50 });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 501,
        title: "DB title",
        operation: "DB op",
      }),
    ]);
    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [expect.objectContaining({ legacy_step_db_id: 501, title: "DB title" })],
    });

    await expect(caller.step.artifactInfo({ projectId: 50 })).resolves.toEqual({
      overview: null,
      reviewByStepId: {},
    });
  });

  it("returns empty artifactInfo when compatibility artifact persistence fails", async () => {
    const writeSpy = vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("storage full"));
    const caller = createCaller();

    try {
      await expect(caller.step.artifactInfo({ projectId: 50 })).resolves.toEqual({
        overview: null,
        reviewByStepId: {},
      });
      await expect(loadStepsArtifact(50)).resolves.toBeNull();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("keeps read routes lenient for invalid artifacts without overwriting them", async () => {
    const filePath = await writeMalformedArtifact(50);
    const caller = createCaller();

    await expect(caller.step.listByProject({ projectId: 50 })).resolves.toEqual([
      expect.objectContaining({
        id: 501,
        title: "DB title",
      }),
    ]);
    await expect(caller.step.artifactInfo({ projectId: 50 })).resolves.toEqual({
      overview: null,
      reviewByStepId: {},
    });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("{ not valid json");
  });

  it("returns an empty step list for inaccessible projects to preserve the legacy list contract", async () => {
    dbMocks.getProjectById.mockResolvedValue(undefined);
    const caller = createCaller();

    await expect(caller.step.listByProject({ projectId: 50 })).resolves.toEqual([]);
  });

  it("updates steps.json first and mirrors text fields to the legacy DB row", async () => {
    await saveStepsArtifact(50, makeArtifact());
    const caller = createCaller();

    await expect(caller.step.update({
      projectId: 50,
      id: 501,
      title: "Edited title",
      operation: "Edited op",
      description: "Edited desc",
      narration: "Edited narration",
      tStart: 100,
      tEnd: 900,
      audioMode: "tts",
      markReviewed: true,
    })).resolves.toEqual({ success: true });

    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 501,
          title: "Edited title",
          operation: "Edited op",
          instruction: "Edited op",
          description: "Edited desc",
          expected_result: "Edited desc",
          narration: "Edited narration",
          t_start: 100,
          t_end: 900,
          audio_mode: "tts",
          needs_review: false,
          review_reasons: [],
          warnings: [],
        }),
      ],
    });
    expect(dbMocks.updateStep).toHaveBeenCalledWith(501, {
      title: "Edited title",
      operation: "Edited op",
      description: "Edited desc",
      narration: "Edited narration",
    }, 1);
  });

  it("promotes a DB-only project to steps.json when text fields are updated", async () => {
    const caller = createCaller();

    await expect(caller.step.update({
      projectId: 50,
      id: 501,
      title: "Promoted title",
    })).resolves.toEqual({ success: true });

    expect(dbMocks.updateStep).toHaveBeenCalledWith(501, { title: "Promoted title" }, 1);
    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      config: expect.objectContaining({ prompt_version: "legacy-adapter-v1" }),
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 501,
          title: "Promoted title",
        }),
      ],
    });
  });

  it("fails DB-only text updates when artifact promotion cannot be persisted", async () => {
    const writeSpy = vi.spyOn(fs, "writeFile").mockRejectedValue(new Error("storage gone"));
    const caller = createCaller();

    try {
      await expect(caller.step.update({
        projectId: 50,
        id: 501,
        title: "Cannot promote",
      })).rejects.toThrow("storage gone");
      expect(dbMocks.updateStep).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("updates an artifact step when no legacy DB row exists and projectId scopes ownership", async () => {
    dbMocks.getStepById.mockResolvedValue(undefined);
    await saveStepsArtifact(50, makeArtifact());
    const caller = createCaller();

    await expect(caller.step.update({
      projectId: 50,
      id: 501,
      title: "Artifact only",
      tStart: 100,
      tEnd: 900,
    })).resolves.toEqual({ success: true });

    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 501,
          title: "Artifact only",
          operation: "Artifact op",
          description: "Artifact desc",
          narration: "Artifact narration",
          t_start: 100,
          t_end: 900,
        }),
      ],
    });
    expect(dbMocks.updateStep).not.toHaveBeenCalled();
  });

  it("rejects text updates when the existing artifact has no matching step without changing DB", async () => {
    const artifact = makeArtifact();
    await saveStepsArtifact(50, {
      ...artifact,
      steps: artifact.steps.map((step) => ({
        ...step,
        legacy_step_db_id: 777,
      })),
    });
    const caller = createCaller();

    await expect(caller.step.update({
      projectId: 50,
      id: 501,
      title: "Bridge mismatch rejected",
    })).rejects.toThrow("steps artifact内に見つかりません");

    expect(dbMocks.updateStep).not.toHaveBeenCalled();
    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 777,
          title: "Artifact title",
        }),
      ],
    });
  });

  it("rejects artifact-only updates when the existing artifact has no matching step", async () => {
    const artifact = makeArtifact();
    await saveStepsArtifact(50, {
      ...artifact,
      steps: artifact.steps.map((step) => ({
        ...step,
        legacy_step_db_id: 777,
      })),
    });
    const caller = createCaller();

    await expect(caller.step.update({
      projectId: 50,
      id: 501,
      tStart: 100,
      tEnd: 900,
    })).rejects.toThrow("steps artifact内に見つかりません");

    expect(dbMocks.updateStep).not.toHaveBeenCalled();
    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 777,
          t_start: 0,
          t_end: 1000,
        }),
      ],
    });
  });

  it("rejects updates when the artifact step only matches by sort_order", async () => {
    const artifact = makeArtifact();
    await saveStepsArtifact(50, {
      ...artifact,
      steps: artifact.steps.map((step) => ({
        ...step,
        legacy_step_db_id: undefined,
      })),
    });
    const caller = createCaller();

    await expect(caller.step.update({
      projectId: 50,
      id: 501,
      title: "Sort order fallback rejected",
    })).rejects.toThrow("steps artifact内に見つかりません");

    expect(dbMocks.updateStep).not.toHaveBeenCalled();
    const restoredArtifact = await loadStepsArtifact(50);
    expect(restoredArtifact?.steps[0]).toMatchObject({ title: "Artifact title" });
    expect(restoredArtifact?.steps[0]).not.toHaveProperty("legacy_step_db_id");
  });

  it("rejects updates as missing when neither DB nor artifact contains the step", async () => {
    dbMocks.getStepById.mockResolvedValue(undefined);
    const artifact = makeArtifact();
    await saveStepsArtifact(50, {
      ...artifact,
      steps: artifact.steps.map((step) => ({
        ...step,
        legacy_step_db_id: 777,
      })),
    });
    const caller = createCaller();

    await expect(caller.step.update({
      projectId: 50,
      id: 501,
      title: "Missing everywhere",
    })).rejects.toThrow("ステップが見つかりません");

    expect(dbMocks.updateStep).not.toHaveBeenCalled();
    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 777,
          title: "Artifact title",
        }),
      ],
    });
  });

  it("rejects updates for inaccessible projectIds before writing", async () => {
    dbMocks.getStepById.mockResolvedValue(undefined);
    dbMocks.getProjectById.mockResolvedValue(undefined);
    const caller = createCaller();

    await expect(caller.step.update({
      projectId: 50,
      id: 501,
      title: "Unauthorized",
    })).rejects.toThrow("プロジェクトが見つかりません");
    expect(dbMocks.updateStep).not.toHaveBeenCalled();
  });

  it("rejects update requests when the DB step belongs to another project", async () => {
    dbMocks.getStepById.mockResolvedValue({ ...dbStep, projectId: 99 });
    const caller = createCaller();

    await expect(caller.step.update({
      projectId: 50,
      id: 501,
      title: "Wrong project",
    })).rejects.toThrow("ステップが見つかりません");
    expect(dbMocks.updateStep).not.toHaveBeenCalled();
  });

  it("keeps artifact updates visible when the legacy DB mirror fails", async () => {
    await saveStepsArtifact(50, makeArtifact());
    dbMocks.updateStep.mockRejectedValueOnce(new Error("DB gone"));
    const caller = createCaller();

    await expect(caller.step.update({
      projectId: 50,
      id: 501,
      title: "Artifact wins",
    })).resolves.toEqual({ success: true });

    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 501,
          title: "Artifact wins",
        }),
      ],
    });
    await expect(caller.step.listByProject({ projectId: 50 })).resolves.toEqual([
      expect.objectContaining({
        id: 501,
        title: "Artifact wins",
      }),
    ]);
  });

  it("rejects invalid artifact timing edits before saving", async () => {
    await saveStepsArtifact(50, makeArtifact());
    const caller = createCaller();

    await expect(caller.step.update({
      projectId: 50,
      id: 501,
      tStart: 900,
      tEnd: 100,
    })).rejects.toThrow("t_end");
    expect(dbMocks.updateStep).not.toHaveBeenCalled();
    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 501,
          t_start: 0,
          t_end: 1000,
        }),
      ],
    });
  });

  it("rejects text updates when an existing artifact is invalid without changing DB", async () => {
    const filePath = await writeMalformedArtifact(50);
    const caller = createCaller();

    await expect(caller.step.update({
      id: 501,
      title: "DB fallback title",
    })).rejects.toThrow("steps artifactが不正");

    expect(dbMocks.updateStep).not.toHaveBeenCalled();
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("{ not valid json");
  });

  it("rejects mixed text and artifact-only updates when an existing artifact is invalid without changing DB", async () => {
    const filePath = await writeMalformedArtifact(50);
    const caller = createCaller();

    await expect(caller.step.update({
      id: 501,
      title: "Mixed rejected",
      tStart: 100,
      tEnd: 900,
      markReviewed: true,
    })).rejects.toThrow("steps artifactが不正");

    expect(dbMocks.updateStep).not.toHaveBeenCalled();
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("{ not valid json");
  });

  it("deletes from steps.json first and mirrors the legacy DB delete", async () => {
    await saveStepsArtifact(50, makeTwoStepArtifact());
    dbMocks.getStepsByProjectId.mockResolvedValue([dbStep2]);
    const caller = createCaller();

    await expect(caller.step.delete({ projectId: 50, id: 501 })).resolves.toEqual({ success: true });

    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          step_id: "step-1",
          sort_order: 0,
          legacy_step_db_id: 502,
          title: "Artifact title 2",
        }),
      ],
    });
    expect(dbMocks.deleteStep).toHaveBeenCalledWith(501, 1);
    expect(dbMocks.reorderSteps).toHaveBeenCalledWith(50, [502]);
  });

  it("keeps delete backward-compatible when projectId is omitted", async () => {
    await saveStepsArtifact(50, makeTwoStepArtifact());
    dbMocks.getStepsByProjectId.mockResolvedValue([dbStep2]);
    const caller = createCaller();

    await expect(caller.step.delete({ id: 501 })).resolves.toEqual({ success: true });

    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 502,
          sort_order: 0,
        }),
      ],
    });
    expect(dbMocks.deleteStep).toHaveBeenCalledWith(501, 1);
    expect(dbMocks.reorderSteps).toHaveBeenCalledWith(50, [502]);
  });

  it("deletes an artifact step even when the legacy DB row no longer exists", async () => {
    dbMocks.getStepById.mockResolvedValue(undefined);
    await saveStepsArtifact(50, makeTwoStepArtifact());
    const caller = createCaller();

    await expect(caller.step.delete({ projectId: 50, id: 501 })).resolves.toEqual({ success: true });

    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 502,
          sort_order: 0,
        }),
      ],
    });
    expect(dbMocks.deleteStep).not.toHaveBeenCalled();
  });

  it("promotes a DB-only project to steps.json before deleting", async () => {
    dbMocks.getStepsByProjectId
      .mockResolvedValueOnce([dbStep, dbStep2])
      .mockResolvedValueOnce([dbStep2]);
    const caller = createCaller();

    await expect(caller.step.delete({ projectId: 50, id: 501 })).resolves.toEqual({ success: true });

    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      config: expect.objectContaining({ prompt_version: "legacy-adapter-v1" }),
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 502,
          sort_order: 0,
          title: "DB title 2",
        }),
      ],
    });
    expect(dbMocks.deleteStep).toHaveBeenCalledWith(501, 1);
    expect(dbMocks.reorderSteps).toHaveBeenCalledWith(50, [502]);
  });

  it("rejects delete when the artifact has no matching step without changing DB", async () => {
    const artifact = makeTwoStepArtifact();
    await saveStepsArtifact(50, {
      ...artifact,
      steps: artifact.steps.map((step) => ({
        ...step,
        legacy_step_db_id: step.legacy_step_db_id === 501 ? 777 : step.legacy_step_db_id,
      })),
    });
    dbMocks.getStepsByProjectId.mockResolvedValue([dbStep2]);
    const caller = createCaller();

    await expect(caller.step.delete({ projectId: 50, id: 501 })).rejects.toThrow("steps artifact内に見つかりません");

    expect(dbMocks.deleteStep).not.toHaveBeenCalled();
    expect(dbMocks.reorderSteps).not.toHaveBeenCalled();
    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({ legacy_step_db_id: 777 }),
        expect.objectContaining({ legacy_step_db_id: 502 }),
      ],
    });
  });

  it("rejects delete with inferred projectId when the artifact has no matching step", async () => {
    const artifact = makeTwoStepArtifact();
    await saveStepsArtifact(50, {
      ...artifact,
      steps: artifact.steps.map((step) => ({
        ...step,
        legacy_step_db_id: step.legacy_step_db_id === 501 ? 777 : step.legacy_step_db_id,
      })),
    });
    const caller = createCaller();

    await expect(caller.step.delete({ id: 501 })).rejects.toThrow("steps artifact内に見つかりません");

    expect(dbMocks.deleteStep).not.toHaveBeenCalled();
    expect(dbMocks.reorderSteps).not.toHaveBeenCalled();
  });

  it("rejects delete as missing when neither DB nor artifact contains the step", async () => {
    dbMocks.getStepById.mockResolvedValue(undefined);
    const artifact = makeTwoStepArtifact();
    await saveStepsArtifact(50, {
      ...artifact,
      steps: artifact.steps.map((step) => ({
        ...step,
        legacy_step_db_id: step.legacy_step_db_id === 501 ? 777 : step.legacy_step_db_id,
      })),
    });
    const caller = createCaller();

    await expect(caller.step.delete({ projectId: 50, id: 501 })).rejects.toThrow("ステップが見つかりません");

    expect(dbMocks.deleteStep).not.toHaveBeenCalled();
    expect(dbMocks.reorderSteps).not.toHaveBeenCalled();
  });

  it("rejects deletes for inaccessible projectIds before writing", async () => {
    dbMocks.getStepById.mockResolvedValue(undefined);
    dbMocks.getProjectById.mockResolvedValue(undefined);
    const caller = createCaller();

    await expect(caller.step.delete({
      projectId: 50,
      id: 501,
    })).rejects.toThrow("プロジェクトが見つかりません");
    expect(dbMocks.deleteStep).not.toHaveBeenCalled();
  });

  it("rejects delete requests when the DB step belongs to another project", async () => {
    dbMocks.getStepById.mockResolvedValue({ ...dbStep, projectId: 99 });
    const caller = createCaller();

    await expect(caller.step.delete({
      projectId: 50,
      id: 501,
    })).rejects.toThrow("ステップが見つかりません");
    expect(dbMocks.deleteStep).not.toHaveBeenCalled();
  });

  it("does not delete DB rows when artifact deletion cannot be persisted", async () => {
    await saveStepsArtifact(50, makeTwoStepArtifact());
    const writeSpy = vi.spyOn(fs, "writeFile").mockRejectedValue(new Error("storage gone"));
    const caller = createCaller();

    try {
      await expect(caller.step.delete({ projectId: 50, id: 501 })).rejects.toThrow("storage gone");
      expect(dbMocks.deleteStep).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("keeps artifact deletion visible when the legacy DB mirror fails", async () => {
    await saveStepsArtifact(50, makeTwoStepArtifact());
    dbMocks.deleteStep.mockRejectedValueOnce(new Error("DB gone"));
    const caller = createCaller();

    await expect(caller.step.delete({ projectId: 50, id: 501 })).resolves.toEqual({ success: true });

    await expect(caller.step.listByProject({ projectId: 50 })).resolves.toEqual([
      expect.objectContaining({
        id: 502,
        title: "Artifact title 2",
      }),
    ]);
  });

  it("keeps artifact deletion visible when legacy DB reorder fails after delete", async () => {
    await saveStepsArtifact(50, makeTwoStepArtifact());
    dbMocks.getStepsByProjectId.mockResolvedValue([dbStep2]);
    dbMocks.reorderSteps.mockRejectedValueOnce(new Error("DB reorder gone"));
    const caller = createCaller();

    await expect(caller.step.delete({ projectId: 50, id: 501 })).resolves.toEqual({ success: true });

    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 502,
          sort_order: 0,
        }),
      ],
    });
    expect(dbMocks.deleteStep).toHaveBeenCalledWith(501, 1);
    expect(dbMocks.reorderSteps).toHaveBeenCalledWith(50, [502]);
  });

  it("rejects artifact-first deletes for invalid artifacts without changing DB", async () => {
    const filePath = await writeMalformedArtifact(50);
    const caller = createCaller();

    await expect(caller.step.delete({ projectId: 50, id: 501 })).rejects.toThrow("steps artifactが不正");

    expect(dbMocks.deleteStep).not.toHaveBeenCalled();
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("{ not valid json");
  });

  it("rejects artifact-first reorder for invalid artifacts without changing DB", async () => {
    const filePath = await writeMalformedArtifact(50);
    const caller = createCaller();

    await expect(caller.step.reorder({
      projectId: 50,
      stepIds: [502, 501],
    })).rejects.toThrow("steps artifactが不正");

    expect(dbMocks.reorderSteps).not.toHaveBeenCalled();
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("{ not valid json");
  });

  it("rejects reorders for inaccessible projectIds before writing", async () => {
    dbMocks.getProjectById.mockResolvedValue(undefined);
    const caller = createCaller();

    await expect(caller.step.reorder({
      projectId: 50,
      stepIds: [502, 501],
    })).rejects.toThrow("プロジェクトが見つかりません");
    expect(dbMocks.reorderSteps).not.toHaveBeenCalled();
  });

  it("reorders steps.json first and mirrors legacy DB order", async () => {
    await saveStepsArtifact(50, makeTwoStepArtifact());
    const caller = createCaller();

    await expect(caller.step.reorder({
      projectId: 50,
      stepIds: [502, 501],
    })).resolves.toEqual({ success: true });

    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          step_id: "step-1",
          sort_order: 0,
          legacy_step_db_id: 502,
        }),
        expect.objectContaining({
          step_id: "step-2",
          sort_order: 1,
          legacy_step_db_id: 501,
        }),
      ],
    });
    expect(dbMocks.reorderSteps).toHaveBeenCalledWith(50, [502, 501]);
  });

  it("promotes a DB-only project to steps.json before reordering", async () => {
    dbMocks.getStepsByProjectId.mockResolvedValue([dbStep, dbStep2]);
    const caller = createCaller();

    await expect(caller.step.reorder({
      projectId: 50,
      stepIds: [502, 501],
    })).resolves.toEqual({ success: true });

    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      config: expect.objectContaining({ prompt_version: "legacy-adapter-v1" }),
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 502,
          sort_order: 0,
          title: "DB title 2",
        }),
        expect.objectContaining({
          legacy_step_db_id: 501,
          sort_order: 1,
          title: "DB title",
        }),
      ],
    });
    expect(dbMocks.reorderSteps).toHaveBeenCalledWith(50, [502, 501]);
  });

  it("rejects incomplete or duplicate reorder inputs before DB sync", async () => {
    await saveStepsArtifact(50, makeTwoStepArtifact());
    const caller = createCaller();

    await expect(caller.step.reorder({
      projectId: 50,
      stepIds: [502],
    })).rejects.toThrow("artifactのステップ順序を解決できませんでした");
    await expect(caller.step.reorder({
      projectId: 50,
      stepIds: [501, 501],
    })).rejects.toThrow("artifactのステップ順序を解決できませんでした");
    expect(dbMocks.reorderSteps).not.toHaveBeenCalled();
  });

  it("does not reorder DB rows when artifact reorder cannot be persisted", async () => {
    await saveStepsArtifact(50, makeTwoStepArtifact());
    const writeSpy = vi.spyOn(fs, "writeFile").mockRejectedValue(new Error("storage gone"));
    const caller = createCaller();

    try {
      await expect(caller.step.reorder({
        projectId: 50,
        stepIds: [502, 501],
      })).rejects.toThrow("storage gone");
      expect(dbMocks.reorderSteps).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("keeps artifact reorder visible when the legacy DB mirror fails", async () => {
    await saveStepsArtifact(50, makeTwoStepArtifact());
    dbMocks.reorderSteps.mockRejectedValueOnce(new Error("DB gone"));
    const caller = createCaller();

    await expect(caller.step.reorder({
      projectId: 50,
      stepIds: [502, 501],
    })).resolves.toEqual({ success: true });

    await expect(caller.step.listByProject({ projectId: 50 })).resolves.toEqual([
      expect.objectContaining({ id: 502, sortOrder: 0 }),
      expect.objectContaining({ id: 501, sortOrder: 1 }),
    ]);
  });

  it("regenerates steps.json first and mirrors regenerated text to the legacy DB row", async () => {
    await saveStepsArtifact(50, makeArtifact());
    const caller = createCaller();

    await expect(caller.step.regenerate({
      projectId: 50,
      stepId: 501,
      frameId: 101,
    })).resolves.toEqual({ success: true });

    expect(stepGeneratorMocks.analyzeFrameForStepRegeneration).toHaveBeenCalledWith(
      expect.objectContaining({ id: 101, projectId: 50 }),
    );
    expect(dbMocks.getStepById).toHaveBeenCalledTimes(1);
    expect(dbMocks.getProjectById).toHaveBeenCalledTimes(1);
    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 501,
          frame_id: 101,
          representative_frames: [
            expect.objectContaining({
              frame_id: 101,
              frame_number: 1,
              timestamp: 1000,
              image_url: "/api/storage/projects/50/frames/1.jpg",
            }),
          ],
          title: "Regenerated title",
          operation: "Regenerated op",
          description: "Regenerated desc",
          narration: "Regenerated narration",
          instruction: "Regenerated instruction",
          expected_result: "Regenerated expected",
          warnings: ["regenerated warning"],
          confidence: 0.72,
        }),
      ],
    });
    expect(dbMocks.updateStep).toHaveBeenCalledWith(501, {
      frameId: 101,
      title: "Regenerated title",
      operation: "Regenerated op",
      description: "Regenerated desc",
      narration: "Regenerated narration",
    }, 1);
  });

  it("keeps regenerate backward-compatible when projectId is omitted", async () => {
    await saveStepsArtifact(50, makeArtifact());
    const caller = createCaller();

    await expect(caller.step.regenerate({
      stepId: 501,
      frameId: 101,
    })).resolves.toEqual({ success: true });

    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 501,
          frame_id: 101,
          title: "Regenerated title",
        }),
      ],
    });
  });

  it("rejects backward-compatible regenerate calls when no DB step resolves project scope", async () => {
    dbMocks.getStepById.mockResolvedValue(undefined);
    const caller = createCaller();

    await expect(caller.step.regenerate({
      stepId: 501,
      frameId: 101,
    })).rejects.toThrow("ステップが見つかりません");

    expect(stepGeneratorMocks.analyzeFrameForStepRegeneration).not.toHaveBeenCalled();
    expect(dbMocks.updateStep).not.toHaveBeenCalled();
  });

  it("regenerates an artifact step when no legacy DB row exists and projectId scopes ownership", async () => {
    dbMocks.getStepById.mockResolvedValue(undefined);
    await saveStepsArtifact(50, makeArtifact());
    const caller = createCaller();

    await expect(caller.step.regenerate({
      projectId: 50,
      stepId: 501,
      frameId: 101,
    })).resolves.toEqual({ success: true });

    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 501,
          frame_id: 101,
          title: "Regenerated title",
        }),
      ],
    });
    expect(dbMocks.updateStep).not.toHaveBeenCalled();
  });

  it("promotes a DB-only project to steps.json before regenerating", async () => {
    const caller = createCaller();

    await expect(caller.step.regenerate({
      projectId: 50,
      stepId: 501,
      frameId: 101,
    })).resolves.toEqual({ success: true });

    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      config: expect.objectContaining({ prompt_version: "legacy-adapter-v1" }),
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 501,
          frame_id: 101,
          title: "Regenerated title",
        }),
      ],
    });
    expect(dbMocks.updateStep).toHaveBeenCalledWith(501, expect.objectContaining({
      frameId: 101,
      title: "Regenerated title",
    }), 1);
  });

  it("rejects regenerate when the existing artifact has no matching step without changing DB", async () => {
    const artifact = makeArtifact();
    await saveStepsArtifact(50, {
      ...artifact,
      steps: artifact.steps.map((step) => ({
        ...step,
        legacy_step_db_id: 777,
      })),
    });
    const caller = createCaller();

    await expect(caller.step.regenerate({
      projectId: 50,
      stepId: 501,
      frameId: 101,
    })).rejects.toThrow("steps artifact内に見つかりません");

    expect(stepGeneratorMocks.analyzeFrameForStepRegeneration).not.toHaveBeenCalled();
    expect(dbMocks.updateStep).not.toHaveBeenCalled();
    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 777,
          title: "Artifact title",
        }),
      ],
    });
  });

  it("rejects regenerate before frame analysis when the artifact step only matches by sort_order", async () => {
    const artifact = makeArtifact();
    await saveStepsArtifact(50, {
      ...artifact,
      steps: artifact.steps.map((step) => ({
        ...step,
        legacy_step_db_id: undefined,
      })),
    });
    const caller = createCaller();

    await expect(caller.step.regenerate({
      projectId: 50,
      stepId: 501,
      frameId: 101,
    })).rejects.toThrow("steps artifact内に見つかりません");

    expect(stepGeneratorMocks.analyzeFrameForStepRegeneration).not.toHaveBeenCalled();
    expect(dbMocks.updateStep).not.toHaveBeenCalled();
    const restoredArtifact = await loadStepsArtifact(50);
    expect(restoredArtifact?.steps[0]).toMatchObject({ title: "Artifact title" });
    expect(restoredArtifact?.steps[0]).not.toHaveProperty("legacy_step_db_id");
  });

  it("rejects regenerate before frame analysis when no artifact can be created", async () => {
    dbMocks.getStepsByProjectId.mockResolvedValue([]);
    const caller = createCaller();

    await expect(caller.step.regenerate({
      projectId: 50,
      stepId: 501,
      frameId: 101,
    })).rejects.toThrow("steps artifactを作成できないため");

    expect(stepGeneratorMocks.analyzeFrameForStepRegeneration).not.toHaveBeenCalled();
    expect(dbMocks.updateStep).not.toHaveBeenCalled();
  });

  it("does not update DB when regenerated artifact cannot be persisted", async () => {
    await saveStepsArtifact(50, makeArtifact());
    const writeSpy = vi.spyOn(fs, "writeFile").mockRejectedValue(new Error("storage gone"));
    const caller = createCaller();

    try {
      await expect(caller.step.regenerate({
        projectId: 50,
        stepId: 501,
        frameId: 101,
      })).rejects.toThrow("storage gone");
      expect(dbMocks.updateStep).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("leaves artifact and DB unchanged when frame analysis fails", async () => {
    await saveStepsArtifact(50, makeArtifact());
    stepGeneratorMocks.analyzeFrameForStepRegeneration.mockRejectedValueOnce(new Error("LLM timeout"));
    const caller = createCaller();

    await expect(caller.step.regenerate({
      projectId: 50,
      stepId: 501,
      frameId: 101,
    })).rejects.toThrow("LLM timeout");

    expect(dbMocks.updateStep).not.toHaveBeenCalled();
    await expect(loadStepsArtifact(50)).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          legacy_step_db_id: 501,
          frame_id: 100,
          title: "Artifact title",
        }),
      ],
    });
  });

  it("keeps regenerated artifact visible when the legacy DB mirror fails", async () => {
    await saveStepsArtifact(50, makeArtifact());
    dbMocks.updateStep.mockRejectedValueOnce(new Error("DB gone"));
    const caller = createCaller();

    await expect(caller.step.regenerate({
      projectId: 50,
      stepId: 501,
      frameId: 101,
    })).resolves.toEqual({ success: true });

    await expect(caller.step.listByProject({ projectId: 50 })).resolves.toEqual([
      expect.objectContaining({
        id: 501,
        frameId: 101,
        title: "Regenerated title",
      }),
    ]);
  });

  it("rejects regenerate for invalid artifacts before analyzing the frame", async () => {
    const filePath = await writeMalformedArtifact(50);
    const caller = createCaller();

    await expect(caller.step.regenerate({
      projectId: 50,
      stepId: 501,
      frameId: 101,
    })).rejects.toThrow("steps artifactが不正");

    expect(stepGeneratorMocks.analyzeFrameForStepRegeneration).not.toHaveBeenCalled();
    expect(dbMocks.updateStep).not.toHaveBeenCalled();
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("{ not valid json");
  });

  it("rejects regenerate requests when the DB step belongs to another project", async () => {
    dbMocks.getStepById.mockResolvedValue({ ...dbStep, projectId: 99 });
    const caller = createCaller();

    await expect(caller.step.regenerate({
      projectId: 50,
      stepId: 501,
      frameId: 101,
    })).rejects.toThrow("ステップが見つかりません");
    expect(stepGeneratorMocks.analyzeFrameForStepRegeneration).not.toHaveBeenCalled();
    expect(dbMocks.updateStep).not.toHaveBeenCalled();
  });

  it("rejects regenerate for inaccessible projects before analyzing the frame", async () => {
    dbMocks.getStepById.mockResolvedValue(undefined);
    dbMocks.getProjectById.mockResolvedValue(undefined);
    const caller = createCaller();

    await expect(caller.step.regenerate({
      projectId: 50,
      stepId: 501,
      frameId: 101,
    })).rejects.toThrow("プロジェクトが見つかりません");
    expect(stepGeneratorMocks.analyzeFrameForStepRegeneration).not.toHaveBeenCalled();
    expect(dbMocks.updateStep).not.toHaveBeenCalled();
  });

  it("rejects regenerate when the selected frame belongs to another project", async () => {
    dbMocks.getFrameById.mockResolvedValue({ ...frames[1], projectId: 99 });
    const caller = createCaller();

    await expect(caller.step.regenerate({
      projectId: 50,
      stepId: 501,
      frameId: 101,
    })).rejects.toThrow("フレームが見つかりません");
    expect(stepGeneratorMocks.analyzeFrameForStepRegeneration).not.toHaveBeenCalled();
    expect(dbMocks.updateStep).not.toHaveBeenCalled();
  });
});
