import { describe, expect, it } from "vitest";
import { extractJsonObjectText, parseAuthoringResponseText } from "./json";

const validPayload = {
  overview: {
    task_title: "ログイン",
    preconditions: [],
    completion_criteria: "ホームが表示される",
  },
  steps: [
    {
      source_segment_ids: ["seg-1"],
      title: "保存する",
      instruction: "保存する",
      expected_result: "保存される",
      operation: "クリック",
      description: "保存ボタンを押す",
      narration: "保存します",
      cited_ui_labels: [],
    },
  ],
  discarded_segments: [],
};

describe("authoring JSON extraction", () => {
  it("extracts plain JSON", () => {
    const raw = JSON.stringify(validPayload);
    expect(extractJsonObjectText(raw)).toBe(raw);
  });

  it("extracts fenced JSON", () => {
    const raw = `説明\n\n\`\`\`json\n${JSON.stringify(validPayload)}\n\`\`\``;
    expect(parseAuthoringResponseText(raw).overview.task_title).toBe(
      "ログイン"
    );
  });

  it("extracts the first balanced JSON object from prose", () => {
    const raw = `結果です: ${JSON.stringify(validPayload)}\n以上です。`;
    expect(parseAuthoringResponseText(raw).steps[0].source_segment_ids).toEqual(
      ["seg-1"]
    );
  });

  it("rejects schema-invalid JSON", () => {
    expect(() =>
      parseAuthoringResponseText(JSON.stringify({ steps: [] }))
    ).toThrow();
  });
});
