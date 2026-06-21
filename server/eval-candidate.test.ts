import { describe, expect, it } from "vitest";
import {
  currentGeneratedStepsPath,
  evaluateCandidate,
  validateCaseId,
} from "../scripts/eval-candidate";
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

function unmatchedArtifact() {
  return artifact({
    title: "削除する",
    operation: "削除を実行する",
    instruction: "「削除」をクリックします。",
    cited_ui_labels: ["削除"],
  });
}

function noCitationArtifact() {
  return artifact({
    title: "保存する",
    operation: "保存を実行する",
    instruction: "保存します。",
    cited_ui_labels: [],
  });
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

  it("reports current artifact deltas without failing by default", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: unmatchedArtifact(),
        currentArtifact: artifact(),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 0 },
          g3: { rate: 0 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
      },
    );

    expect(result.pass).toBe(true);
    expect(result.g2Accuracy).toBe(0);
    expect(result.currentG2Accuracy).toBe(1);
    expect(result.currentG2Delta).toBe(-1);
    expect(result.invalidReasons).toEqual([]);
  });

  it("fails current-artifact G2 regressions when requested", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: unmatchedArtifact(),
        currentArtifact: artifact(),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 0 },
          g3: { rate: 0 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
        maxCurrentG2Regression: 0,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.currentG2Delta).toBe(-1);
    expect(result.invalidReasons).toContain("current_g2_regression");
  });

  it("requires a current artifact when current improvement is requested", () => {
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
        requireG2Improvement: false,
        requireCurrentG2Improvement: true,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.invalidReasons).toContain("missing_current_artifact");
    expect(result.invalidReasons).toContain("current_g2_not_improved");
  });

  it("requires a current artifact when current G3 improvement is requested", () => {
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
        requireG2Improvement: false,
        requireCurrentG3Improvement: true,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.invalidReasons).toEqual(["missing_current_artifact", "current_g3_not_improved"]);
  });

  it("requires a current artifact when current regression limits are requested", () => {
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
        requireG2Improvement: false,
        maxCurrentG2Regression: 0,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.invalidReasons).toEqual(["missing_current_artifact"]);
  });

  it("requires a current artifact when current G3 regression limits are requested", () => {
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
        requireG2Improvement: false,
        maxCurrentG3Regression: 0,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.invalidReasons).toEqual(["missing_current_artifact"]);
  });

  it("requires a current artifact when current no-citation regression limits are requested", () => {
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
        requireG2Improvement: false,
        maxCurrentNoCitationRegression: 0,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.invalidReasons).toEqual(["missing_current_artifact"]);
  });

  it("passes when current G2 improvement is required and candidate beats current", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: artifact(),
        currentArtifact: unmatchedArtifact(),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 0.5 },
          g3: { rate: 0 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
        requireCurrentG2Improvement: true,
      },
    );

    expect(result.pass).toBe(true);
    expect(result.currentG2Accuracy).toBe(0);
    expect(result.currentG2Delta).toBe(1);
    expect(result.invalidReasons).toEqual([]);
  });

  it("requires a strict current G2 improvement instead of a tie", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: artifact(),
        currentArtifact: artifact(),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 0.5 },
          g3: { rate: 0 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
        requireCurrentG2Improvement: true,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.currentG2Delta).toBe(0);
    expect(result.invalidReasons).toContain("current_g2_not_improved");
  });

  it("fails current-artifact G3 regressions when requested", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: artifact({ t_start: 1000, t_end: 2000 }),
        currentArtifact: artifact(),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 1 },
          g3: { rate: 1 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
        maxCurrentG3Regression: 0,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.currentG3Delta).toBe(1);
    expect(result.invalidReasons).toContain("current_g3_regression");
  });

  it("fails current-artifact no-citation regressions when requested", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: noCitationArtifact(),
        currentArtifact: artifact(),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 0 },
          g3: { rate: 0 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
        maxCurrentNoCitationRegression: 0,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.g2NoCitationRate).toBe(1);
    expect(result.currentG2NoCitationRate).toBe(0);
    expect(result.currentNoCitationDelta).toBe(1);
    expect(result.invalidReasons).toEqual(["current_no_citation_regression"]);
  });

  it("includes candidate G2 label diagnostics when requested", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: artifact({ cited_ui_labels: ["保存", "処理中"] }),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 0.5 },
          g3: { rate: 0 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
        includeG2Details: true,
      },
    );

    expect(result.g2Details?.allowedLabels).toEqual(["保存"]);
    expect(result.g2Details?.unmatchedLabels).toEqual([
      {
        stepNumber: 1,
        source: "cited_ui_labels",
        label: "処理中",
        normalized: "処理中",
        matched: false,
      },
    ]);
    expect(result.g2Details?.noCitationStepNumbers).toEqual([]);
  });

  it("tracks steps with no valid citations in candidate G2 diagnostics", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: noCitationArtifact(),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 0 },
          g3: { rate: 0 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
        includeG2Details: true,
      },
    );

    expect(result.g2NoCitationRate).toBe(1);
    expect(result.g2Details?.noCitationStepNumbers).toEqual([1]);
    expect(result.g2Details?.labels).toEqual([]);
    expect(result.g2Details?.unmatchedLabels).toEqual([]);
  });

  it("omits candidate G2 label diagnostics by default", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: artifact({ cited_ui_labels: ["保存", "処理中"] }),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 0.5 },
          g3: { rate: 0 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
      },
    );

    expect(result.g2Details).toBeUndefined();
  });

  it("allows equal current-artifact no-citation rates at zero tolerance", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: noCitationArtifact(),
        currentArtifact: noCitationArtifact(),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 0 },
          g3: { rate: 0 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
        maxCurrentNoCitationRegression: 0,
      },
    );

    expect(result.pass).toBe(true);
    expect(result.currentNoCitationDelta).toBe(0);
    expect(result.invalidReasons).toEqual([]);
  });

  it("allows current-artifact no-citation increases within tolerance", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: noCitationArtifact(),
        currentArtifact: artifact(),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 0 },
          g3: { rate: 0 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
        maxCurrentNoCitationRegression: 1,
      },
    );

    expect(result.pass).toBe(true);
    expect(result.currentNoCitationDelta).toBe(1);
    expect(result.invalidReasons).toEqual([]);
  });

  it("passes current-artifact no-citation checks when no-citation rate does not increase", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: artifact(),
        currentArtifact: noCitationArtifact(),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 0.5 },
          g3: { rate: 0 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
        maxCurrentNoCitationRegression: 0,
      },
    );

    expect(result.pass).toBe(true);
    expect(result.g2NoCitationRate).toBe(0);
    expect(result.currentG2NoCitationRate).toBe(1);
    expect(result.currentNoCitationDelta).toBe(-1);
    expect(result.invalidReasons).toEqual([]);
  });

  it("passes when current G3 improvement is required and candidate beats current", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: artifact(),
        currentArtifact: artifact({ t_start: 1000, t_end: 2000 }),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 1 },
          g3: { rate: 1 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
        requireCurrentG3Improvement: true,
      },
    );

    expect(result.pass).toBe(true);
    expect(result.currentG3Rate).toBe(1);
    expect(result.currentG3Delta).toBe(-1);
    expect(result.invalidReasons).toEqual([]);
  });

  it("requires a strict current G3 improvement instead of a tie", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: artifact(),
        currentArtifact: artifact(),
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
        requireCurrentG3Improvement: true,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.currentG3Delta).toBe(0);
    expect(result.invalidReasons).toContain("current_g3_not_improved");
  });

  it("fails when current G3 improvement is required but candidate regresses", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: artifact({ t_start: 1000, t_end: 2000 }),
        currentArtifact: artifact(),
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
        requireCurrentG3Improvement: true,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.currentG3Delta).toBe(1);
    expect(result.invalidReasons).toContain("current_g3_not_improved");
  });

  it("passes the post-v1 promotion gate when fixed baseline and current checks pass", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: artifact(),
        currentArtifact: artifact({ t_start: 1000, t_end: 2000 }),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 0.5 },
          g3: { rate: 1 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
        postV1PromotionGate: true,
      },
    );

    expect(result.pass).toBe(true);
    expect(result.g2Delta).toBe(0.5);
    expect(result.currentG2Delta).toBe(0);
    expect(result.currentNoCitationDelta).toBe(0);
    expect(result.currentG3Delta).toBe(-1);
    expect(result.invalidReasons).toEqual([]);
  });

  it("uses the post-v1 promotion gate as a fixed-baseline G2 improvement check", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: artifact(),
        currentArtifact: artifact({ t_start: 1000, t_end: 2000 }),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 1 },
          g3: { rate: 1 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
        postV1PromotionGate: true,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.g2Delta).toBe(0);
    expect(result.invalidReasons).toContain("g2_not_improved");
  });

  it("uses the post-v1 promotion gate as a current G2 regression check", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: unmatchedArtifact(),
        currentArtifact: artifact(),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 0 },
          g3: { rate: 0 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
        postV1PromotionGate: true,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.currentG2Delta).toBe(-1);
    expect(result.invalidReasons).toContain("current_g2_regression");
  });

  it("uses the post-v1 promotion gate as a current no-citation regression check", () => {
    const result = evaluateCandidate(
      {
        caseId: "case-01",
        groundTruth,
        artifact: noCitationArtifact(),
        currentArtifact: artifact({ t_start: 1000, t_end: 2000 }),
        baseline: {
          caseId: "case-01",
          g2: { accuracy: 0 },
          g3: { rate: 1 },
        },
      },
      {
        maxG2Regression: 0,
        maxG3Regression: 0,
        requireG2Improvement: false,
        postV1PromotionGate: true,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.currentNoCitationDelta).toBe(1);
    expect(result.invalidReasons).toContain("current_no_citation_regression");
  });

  it("requires current artifact data for the post-v1 promotion gate", () => {
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
        requireG2Improvement: false,
        postV1PromotionGate: true,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.invalidReasons).toEqual(["missing_current_artifact", "current_g3_not_improved"]);
  });

  it("rejects path-like case ids before resolving dataset paths", () => {
    expect(() => validateCaseId("..")).toThrow("directory reference");
    expect(() => validateCaseId(".")).toThrow("directory reference");
    expect(() => validateCaseId("nested/case")).toThrow("path separators");
    expect(() => validateCaseId("   ")).toThrow("empty");
  });

  it("resolves current generated artifact paths from safe case ids", () => {
    expect(currentGeneratedStepsPath("case-01")).toMatch(
      /eval\/results\/generated\/case-01\/steps\.json$/,
    );
    expect(() => currentGeneratedStepsPath("../case-01")).toThrow("path separators");
  });
});
