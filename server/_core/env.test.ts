import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

function setEnv(overrides: Record<string, string | undefined>) {
  process.env = {
    ...originalEnv,
    NODE_ENV: "test",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe("ENV authoring provider", () => {
  it("defaults AUTHORING_PROVIDER to llm", async () => {
    setEnv({ AUTHORING_PROVIDER: undefined });
    vi.resetModules();

    const { ENV } = await import("./env");

    expect(ENV.authoringProvider).toBe("llm");
  });

  it("accepts AUTHORING_PROVIDER=codex_app_server", async () => {
    setEnv({
      AUTHORING_PROVIDER: "codex_app_server",
      CODEX_MODEL: "gpt-5.4-codex",
    });
    vi.resetModules();

    const { ENV } = await import("./env");

    expect(ENV.authoringProvider).toBe("codex_app_server");
    expect(ENV.codexModel).toBe("gpt-5.4-codex");
  });

  it("rejects invalid AUTHORING_PROVIDER values", async () => {
    setEnv({ AUTHORING_PROVIDER: "openai" });
    vi.resetModules();

    await expect(import("./env")).rejects.toThrow("AUTHORING_PROVIDER");
  });

  it("defaults OCR_ENGINE_FALLBACK to llm", async () => {
    setEnv({ OCR_ENGINE_FALLBACK: undefined });
    vi.resetModules();

    const { ENV } = await import("./env");

    expect(ENV.ocrEngineFallback).toBe("llm");
  });

  it("accepts OCR_ENGINE_FALLBACK=none", async () => {
    setEnv({ OCR_ENGINE_FALLBACK: "none" });
    vi.resetModules();

    const { ENV } = await import("./env");

    expect(ENV.ocrEngineFallback).toBe("none");
  });

  it("rejects invalid OCR_ENGINE_FALLBACK values", async () => {
    setEnv({ OCR_ENGINE_FALLBACK: "api" });
    vi.resetModules();

    await expect(import("./env")).rejects.toThrow("OCR_ENGINE_FALLBACK");
  });

  it("does not require an LLM API key in production for Codex authoring with non-LLM OCR", async () => {
    setEnv({
      NODE_ENV: "production",
      AUTH_MODE: "none",
      ALLOW_UNSAFE_AUTH_MODE_NONE: "true",
      JWT_SECRET: "x".repeat(32),
      DATABASE_URL: "mysql://user:pass@localhost:3306/db",
      AUTHORING_PROVIDER: "codex_app_server",
      OCR_PROVIDER: "engine",
      ASR_PROVIDER: "none",
      TTS_API_KEY: "tts-key",
      OPENAI_API_KEY: "",
      LLM_API_KEY: "",
    });
    vi.resetModules();

    const { ENV } = await import("./env");

    expect(ENV.authoringProvider).toBe("codex_app_server");
    expect(ENV.llmApiKey).toBe("");
  });
});
