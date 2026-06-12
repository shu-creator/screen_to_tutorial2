import { describe, expect, it } from "vitest";
import {
  checkCrossStepIntegrity,
  checkSegmentIntegrity,
  computeCalibratedConfidence,
  needsReview,
  normalizeLabel,
  verifyCitedLabels,
} from "./verification";

const segment = (lines: string[], focus: string[] = []) => ({
  ocr_lines: lines,
  ocr_focus: focus,
});

describe("verifyCitedLabels", () => {
  it("OCR実測に存在するラベルを verified にする", () => {
    const result = verifyCitedLabels(["保存"], [segment(["保存", "キャンセル"])]);
    expect(result.verified).toEqual(["保存"]);
    expect(result.unverified).toEqual([]);
    expect(result.verifiedRatio).toBe(1);
  });

  it("OCRにないラベルを unverified にする", () => {
    const result = verifyCitedLabels(
      ["保存", "存在しないボタン"],
      [segment(["保存"])],
    );
    expect(result.unverified).toEqual(["存在しないボタン"]);
    expect(result.verifiedRatio).toBe(0.5);
  });

  it("OCR行の部分文字列一致を許容する（周辺文字の巻き込み対策）", () => {
    const result = verifyCitedLabels(["保存"], [segment(["変更を保存する"])]);
    expect(result.verified).toEqual(["保存"]);
  });

  it("全半角・空白・大小文字の差を吸収する", () => {
    const result = verifyCitedLabels(["ＯＫ"], [segment(["O K"])]);
    expect(result.verified).toEqual(["ＯＫ"]);
  });

  it("ocr_focus も照合対象に含める", () => {
    const result = verifyCitedLabels(["設定"], [segment([], ["設定"])]);
    expect(result.verified).toEqual(["設定"]);
  });

  it("引用なしは ratio=1（ペナルティはconfidence式の労働分担）", () => {
    expect(verifyCitedLabels([], [segment(["保存"])]).verifiedRatio).toBe(1);
  });
});

describe("checkSegmentIntegrity", () => {
  const order = new Map([
    ["seg-1", 0],
    ["seg-2", 1],
    ["seg-3", 2],
  ]);

  it("正常な参照はOK", () => {
    expect(checkSegmentIntegrity(["seg-1", "seg-2"], order).ok).toBe(true);
  });

  it("空はNG", () => {
    expect(checkSegmentIntegrity([], order).ok).toBe(false);
  });

  it("未知IDはNG", () => {
    expect(checkSegmentIntegrity(["seg-9"], order).ok).toBe(false);
  });

  it("重複はNG", () => {
    expect(checkSegmentIntegrity(["seg-1", "seg-1"], order).ok).toBe(false);
  });

  it("順序逆転はNG", () => {
    expect(checkSegmentIntegrity(["seg-2", "seg-1"], order).ok).toBe(false);
  });
});

describe("checkCrossStepIntegrity", () => {
  it("ステップ間のセグメント重複を検出する", () => {
    expect(checkCrossStepIntegrity([["seg-1"], ["seg-2"]]).ok).toBe(true);
    expect(checkCrossStepIntegrity([["seg-1"], ["seg-1"]]).ok).toBe(false);
  });
});

describe("computeCalibratedConfidence / needsReview", () => {
  it("全ラベル検証通過+発話あり+OCR良好で高confidence", () => {
    const confidence = computeCalibratedConfidence({
      labelVerifiedRatio: 1,
      citedLabelCount: 2,
      ocrConfidence: 0.9,
      hasTranscript: true,
    });
    expect(confidence).toBeGreaterThan(0.85);
    expect(needsReview(confidence, 0)).toBe(false);
  });

  it("ラベル不一致があると低下し needsReview になる", () => {
    const confidence = computeCalibratedConfidence({
      labelVerifiedRatio: 0,
      citedLabelCount: 1,
      ocrConfidence: 0.9,
      hasTranscript: true,
    });
    expect(confidence).toBeLessThan(0.5);
    expect(needsReview(confidence, 1)).toBe(true);
  });

  it("不一致ラベルが1つでもあれば confidence が高くても needsReview", () => {
    expect(needsReview(0.9, 1)).toBe(true);
  });

  it("引用なしは中庸なconfidence（根拠が薄い）", () => {
    const confidence = computeCalibratedConfidence({
      labelVerifiedRatio: 1,
      citedLabelCount: 0,
      ocrConfidence: null,
      hasTranscript: false,
    });
    expect(confidence).toBeGreaterThan(0.3);
    expect(confidence).toBeLessThan(0.6);
  });

  it("normalizeLabel は eval/metrics.ts と同一規則", () => {
    expect(normalizeLabel("Ｏ Ｋ")).toBe("ok");
  });
});
