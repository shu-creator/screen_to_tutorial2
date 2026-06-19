import { describe, expect, it } from "vitest";
import { auditEvalReadiness, type CaseMeta } from "../scripts/eval-audit";

describe("eval-audit", () => {
  it("reports Sprint 1 gaps when real cases, tags, generated steps, or G4 records are missing", async () => {
    const result = await auditEvalReadiness({
      caseMetas: [
        {
          case_id: "real-app-workflow-01",
          synthetic: false,
          scenario_tags: ["silent", "load_wait"],
        },
        {
          case_id: "synth-form-typing-01",
          synthetic: true,
          scenario_tags: ["form_input"],
        },
      ],
      g4Records: [],
      generatedCaseIds: [],
      generatedRoot: "/path/that/does/not/exist",
      requiredRealCaseCount: 5,
    });

    expect(result.pass).toBe(false);
    expect(result.realCaseCount).toBe(1);
    expect(result.missingTags).toEqual(["narrated", "form_input", "modal_or_dropdown"]);
    expect(result.casesMissingGeneratedSteps).toEqual(["real-app-workflow-01"]);
    expect(result.casesMissingG4).toEqual(["real-app-workflow-01"]);
    expect(result.invalidG4Records).toEqual([]);
  });

  it("passes when five real cases cover all required tags and have G4 records", async () => {
    const caseMetas: CaseMeta[] = [
      { case_id: "real-01", synthetic: false, scenario_tags: ["silent"] },
      { case_id: "real-02", synthetic: false, scenario_tags: ["narrated"] },
      { case_id: "real-03", synthetic: false, scenario_tags: ["form_input"] },
      { case_id: "real-04", synthetic: false, scenario_tags: ["load_wait"] },
      { case_id: "real-05", synthetic: false, scenario_tags: ["modal_or_dropdown"] },
    ];
    const result = await auditEvalReadiness({
      caseMetas,
      g4Records: caseMetas.map((meta) => ({
        case_id: meta.case_id,
        reviewer: "reviewer",
        reviewed_at: "2026-06-20",
        source_artifact: `eval/results/generated/${meta.case_id}/steps.json`,
        counts: {
          title_edits: 0,
          description_edits: 0,
          narration_edits: 0,
          timing_edits: 0,
          citation_edits: 0,
          step_structure_edits: 0,
          export_artifact_edits: 0,
          other_edits: 0,
        },
        total_manual_edits: 0,
      })),
      generatedCaseIds: caseMetas.map((meta) => meta.case_id),
      requiredRealCaseCount: 5,
    });

    expect(result.pass).toBe(true);
    expect(result.notes).toEqual([]);
  });

  it("rejects an unfilled G4 template record", async () => {
    const result = await auditEvalReadiness({
      caseMetas: [{ case_id: "real-01", synthetic: false, scenario_tags: ["silent"] }],
      g4Records: [{
        case_id: "real-01",
        reviewer: "",
        reviewed_at: "YYYY-MM-DD",
        source_artifact: "eval/results/generated/<case-id>/steps.json",
        counts: { title_edits: 0 },
        total_manual_edits: 0,
      }],
      generatedCaseIds: ["real-01"],
      requiredRealCaseCount: 1,
    });

    expect(result.pass).toBe(false);
    expect(result.invalidG4Records).toEqual(["real-01: reviewer is empty"]);
  });

  it("rejects G4 records without the required edit-count categories", async () => {
    const result = await auditEvalReadiness({
      caseMetas: [{ case_id: "real-01", synthetic: false, scenario_tags: ["silent"] }],
      g4Records: [{
        case_id: "real-01",
        reviewer: "reviewer",
        reviewed_at: "2026-06-20",
        source_artifact: "eval/results/generated/real-01/steps.json",
        counts: {},
        total_manual_edits: 0,
      }],
      generatedCaseIds: ["real-01"],
      requiredRealCaseCount: 1,
    });

    expect(result.pass).toBe(false);
    expect(result.invalidG4Records[0]).toContain("counts missing required keys");
  });
});
