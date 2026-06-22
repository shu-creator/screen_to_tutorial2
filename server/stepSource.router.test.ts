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
    dbMocks.getFrameById.mockResolvedValue(frames[0]);
    dbMocks.getStepById.mockResolvedValue(dbStep);
    dbMocks.updateStep.mockResolvedValue(undefined);
    dbMocks.deleteStep.mockResolvedValue(undefined);
    dbMocks.reorderSteps.mockResolvedValue(undefined);
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
});
