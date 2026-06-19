import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { detectInvalidReasons, readLogSignals, readStepStats } from "../scripts/model-rematch";

describe("model-rematch invalid-run detection", () => {
  it("flags fallback-heavy steps above the configured threshold", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-rematch-"));
    const stepsPath = path.join(dir, "steps.json");
    await fs.writeFile(
      stepsPath,
      JSON.stringify({
        steps: Array.from({ length: 10 }, (_, index) => ({ needs_review: index < 9 })),
      }),
    );

    const stats = await readStepStats(stepsPath, 0.8);

    expect(stats).toEqual({
      stepCount: 10,
      needsReviewCount: 9,
      fallbackSuspected: true,
    });
  });

  it("records zero-step, citation-collapse, and API-log invalid reasons", () => {
    const reasons = detectInvalidReasons(
      {
        model: "gpt-5.5",
        runIndex: 2,
        runId: "gpt-5.5-run-02",
        outDir: "output",
        cacheDir: "cache",
        status: "passed",
        stepCount: 0,
        needsReviewCount: 0,
        fallbackSuspected: false,
        metrics: {
          g2Accuracy: 0,
          g2NoCitationRate: 1,
        },
      },
      ["llm_invoke_failed", "openai_520"],
    );

    expect(reasons).toEqual(["zero_steps", "g2_zero_with_no_citations", "llm_invoke_failed", "openai_520"]);
  });

  it("records fallback-heavy invalid reasons", () => {
    const reasons = detectInvalidReasons(
      {
        model: "gpt-5.5",
        runIndex: 2,
        runId: "gpt-5.5-run-02",
        outDir: "output",
        cacheDir: "cache",
        status: "passed",
        stepCount: 23,
        needsReviewCount: 23,
        fallbackSuspected: true,
      },
      [],
    );

    expect(reasons).toEqual(["all_or_most_steps_need_review"]);
  });

  it("extracts API failure signals from logs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-rematch-"));
    const logPath = path.join(dir, "pipeline.log");
    await fs.writeFile(
      logPath,
      [
        "LLM invoke failed: 520 api.openai.com",
        'HTTP 429 {"code":"insufficient_quota"}',
        "step 520 processed without an HTTP error",
      ].join("\n"),
    );

    await expect(readLogSignals(logPath)).resolves.toEqual([
      "llm_invoke_failed",
      "openai_520",
      "openai_429",
      "insufficient_quota",
    ]);
  });
});
