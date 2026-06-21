import { describe, expect, it } from "vitest";
import { evaluateCandidate, validateCaseId } from "../scripts/eval-candidate";
import type { GroundTruthStep } from "./eval/metrics";

const groundTruth: GroundTruthStep[] = [
  {
    t_start: 0,
    t_end: 1000,
    title: "保存する",
    ui_labels: ["保存"],
  },
  {
    t_start: 1000,
    t_end: 2000,
    title: "待機",
    non_step: true,
  },
];

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    steps: [
      {
        t_start: 0,
        t_end: 1000,
        title: "「保存」をクリックする",
        operation: "保存を実行する",
        instruction: "「保存」をクリックします。",
        cited_ui_labels: ["保存"],
        review_reasons: [],
        ...overrides,
      },
    ],
  };
}

describe("eval candidate", () => {
  it("passes when candidate improves G2 without adding G3 or fallback reasons", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: artifact(),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 0.5 },
          g3: { rate: 0 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: true,
      },
    );

    expect(result.pass).toBe(true);
    expect(result.g2Accuracy).toBe(1);
    expect(result.g2Delta).toBe(0.5);
    expect(result.g3Rate).toBe(0);
    expect(result.invalidReasons).toEqual([]);
  });

  it("fails candidates with fallback review reasons", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: artifact({ review_reasons: ["fallback:unassigned_segment"] }),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 1 },
          g3: { rate: 0 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.fallbackReasonCount).toBe(1);
    expect(result.invalidReasons).toContain("fallback_reasons_present");
  });

  it("fails when G2 improvement is required but candidate only matches baseline", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: artifact(),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 1 },
          g3: { rate: 0 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: true,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.g2Delta).toBe(0);
    expect(result.invalidReasons).toContain("g2_not_improved");
  });

  it("rejects path-like case ids before resolving dataset paths", () => {
    expect(() => validateCaseId("..")).toThrow("directory reference");
    expect(() => validateCaseId(".")).toThrow("directory reference");
    expect(() => validateCaseId("nested/case")).toThrow("path separators");
    expect(() => validateCaseId("   ")).toThrow("empty");
  });
});
