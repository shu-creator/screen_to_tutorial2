import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const invokeLLMMock = vi.hoisted(() => vi.fn());
const loadEvidenceArtifactMock = vi.hoisted(() => vi.fn(async () => null));
const getProjectByIdMock = vi.hoisted(() =>
  vi.fn(async () => ({
    id: 123,
    userId: 1,
    title: "Codex smoke",
    description: null,
    videoUrl: "/api/storage/projects/123/videos/demo.mp4",
    videoKey: "projects/123/videos/demo.mp4",
    status: "processing",
    processingProgress: 70,
    processingMessage: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }))
);
const updateProjectProgressMock = vi.hoisted(() => vi.fn(async () => {}));
const getFramesByProjectIdMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock("./_core/llm", () => ({ invokeLLM: invokeLLMMock }));
vi.mock("./_core/pipelineCache", () => ({
  ensurePipelineCacheDir: vi.fn(async () => {}),
  getCachedJson: vi.fn(async () => null),
  hashBinary: vi.fn(() => "hash"),
  setCachedJson: vi.fn(async () => {}),
}));
vi.mock("./evidence/artifactStore", () => ({
  loadEvidenceArtifact: loadEvidenceArtifactMock,
}));
vi.mock("./db", () => ({
  getProjectById: getProjectByIdMock,
  updateProjectProgress: updateProjectProgressMock,
  getFramesByProjectId: getFramesByProjectIdMock,
}));

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
  invokeLLMMock.mockReset();
  loadEvidenceArtifactMock.mockReset();
  loadEvidenceArtifactMock.mockResolvedValue(null);
  getProjectByIdMock.mockClear();
  updateProjectProgressMock.mockClear();
  getFramesByProjectIdMock.mockClear();
});

describe("generateStepsForProject with codex_app_server provider", () => {
  it("throws on missing evidence before legacy frame LLM authoring", async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      AUTHORING_PROVIDER: "codex_app_server",
      OCR_PROVIDER: "engine",
      ASR_PROVIDER: "none",
    };
    vi.resetModules();

    const { generateStepsForProject } = await import("./stepGenerator");

    await expect(generateStepsForProject(123)).rejects.toThrow(
      "AUTHORING_PROVIDER=codex_app_server requires evidence.json"
    );
    expect(loadEvidenceArtifactMock).toHaveBeenCalledWith(123);
    expect(getFramesByProjectIdMock).not.toHaveBeenCalled();
    expect(invokeLLMMock).not.toHaveBeenCalled();
  });
});
