import { describe, expect, it } from "vitest";
import {
  computeBoundaryRecall,
  computeG1,
  computeG2,
  computeG3,
  extractQuotedLabels,
  intervalIoU,
  normalizeLabel,
} from "./metrics";

describe("intervalIoU", () => {
  it("完全一致で1を返す", () => {
    expect(intervalIoU({ t_start: 0, t_end: 100 }, { t_start: 0, t_end: 100 })).toBe(1);
  });

  it("非重複で0を返す", () => {
    expect(intervalIoU({ t_start: 0, t_end: 100 }, { t_start: 200, t_end: 300 })).toBe(0);
  });

  it("半分重複で1/3を返す", () => {
    // [0,100] と [50,150]: 交差50、和150
    expect(intervalIoU({ t_start: 0, t_end: 100 }, { t_start: 50, t_end: 150 })).toBeCloseTo(
      1 / 3,
    );
  });

  it("無効区間（start >= end）で0を返す", () => {
    expect(intervalIoU({ t_start: 100, t_end: 100 }, { t_start: 0, t_end: 100 })).toBe(0);
    expect(intervalIoU({ t_start: 100, t_end: 50 }, { t_start: 0, t_end: 100 })).toBe(0);
  });

  it("接するだけの区間（交差0）で0を返す", () => {
    expect(intervalIoU({ t_start: 0, t_end: 100 }, { t_start: 100, t_end: 200 })).toBe(0);
  });
});

describe("computeG1", () => {
  const gt = [
    { t_start: 0, t_end: 1000, title: "A" },
    { t_start: 1000, t_end: 3000, title: "B" },
    { t_start: 3000, t_end: 5000, title: "C", non_step: true },
  ];

  it("完全一致で P=R=F1=1", () => {
    const generated = [
      { t_start: 0, t_end: 1000, title: "a" },
      { t_start: 1000, t_end: 3000, title: "b" },
    ];
    const result = computeG1(generated, gt);
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.f1).toBe(1);
    expect(result.matchedPairs).toHaveLength(2);
  });

  it("non_step の正解はマッチング対象から除外される", () => {
    const generated = [{ t_start: 3000, t_end: 5000, title: "scroll" }];
    const result = computeG1(generated, gt);
    expect(result.matchedPairs).toHaveLength(0);
    expect(result.precision).toBe(0);
  });

  it("1対1マッチング: 同じ正解に2つの生成ステップはマッチしない", () => {
    const generated = [
      { t_start: 0, t_end: 1000, title: "a1" },
      { t_start: 50, t_end: 1050, title: "a2" }, // Aに高IoUだがa1が先取
    ];
    const result = computeG1(generated, gt);
    expect(result.matchedPairs).toHaveLength(1);
    expect(result.precision).toBe(0.5);
    expect(result.recall).toBe(0.5);
  });

  it("IoU閾値未満はマッチしない", () => {
    const generated = [{ t_start: 800, t_end: 1200, title: "x" }]; // AにもBにもIoU < 0.5
    const result = computeG1(generated, gt, 0.5);
    expect(result.matchedPairs).toHaveLength(0);
  });

  it("生成・正解が空でもNaNにならない", () => {
    expect(computeG1([], gt).precision).toBe(0);
    expect(computeG1([{ t_start: 0, t_end: 1, title: "x" }], []).recall).toBe(0);
    expect(computeG1([], []).f1).toBe(0);
  });
});

describe("extractQuotedLabels / normalizeLabel", () => {
  it("「」と『』の両方から抽出する", () => {
    expect(extractQuotedLabels("「保存」をクリックし、『OK』を押す")).toEqual([
      "保存",
      "OK",
    ]);
  });

  it("引用がなければ空配列", () => {
    expect(extractQuotedLabels("保存をクリックする")).toEqual([]);
  });

  it("空の引用は無視する", () => {
    expect(extractQuotedLabels("「」を押す")).toEqual([]);
  });

  it("normalizeLabel は全半角・空白・大文字小文字を吸収する", () => {
    expect(normalizeLabel("ＯＫ")).toBe(normalizeLabel("ok"));
    expect(normalizeLabel("保 存")).toBe(normalizeLabel("保存"));
    expect(normalizeLabel("「保存」")).toBe("保存");
    expect(normalizeLabel("ステップ (12)")).toBe("ステップ");
  });
});

describe("computeG2", () => {
  it("引用ラベルが許容集合に含まれる率を計算する", () => {
    const generated = [
      { t_start: 0, t_end: 1, title: "「保存」を押す" },
      { t_start: 1, t_end: 2, title: "「存在しないボタン」を押す" },
    ];
    const result = computeG2(generated, ["保存", "キャンセル"]);
    expect(result.accuracy).toBe(0.5);
    expect(result.totalLabels).toBe(2);
    expect(result.matchedLabels).toBe(1);
    expect(result.citedStepCount).toBe(2);
    expect(result.noCitationRate).toBe(0);
  });

  it("引用0件のステップは分母から除外し noCitationRate に計上する", () => {
    const generated = [
      { t_start: 0, t_end: 1, title: "「保存」を押す" },
      { t_start: 1, t_end: 2, title: "画面を確認する" }, // 引用なし
    ];
    const result = computeG2(generated, ["保存"]);
    expect(result.accuracy).toBe(1);
    expect(result.citedStepCount).toBe(1);
    expect(result.noCitationRate).toBe(0.5);
  });

  it("全ステップ引用なしなら accuracy=0 / noCitationRate=1（見かけ100%の退化を防ぐ）", () => {
    const generated = [{ t_start: 0, t_end: 1, title: "操作する" }];
    const result = computeG2(generated, ["保存"]);
    expect(result.accuracy).toBe(0);
    expect(result.noCitationRate).toBe(1);
  });

  it("operation / instruction からも引用を拾い、全半角差を吸収する", () => {
    const generated = [
      {
        t_start: 0,
        t_end: 1,
        title: "確定する",
        operation: "「ＯＫ」をクリック",
        instruction: "『送信』を押す",
      },
    ];
    const result = computeG2(generated, ["OK", "送信"]);
    expect(result.accuracy).toBe(1);
    expect(result.totalLabels).toBe(2);
  });

  it("structured cited_ui_labels の幻覚も不一致として数える", () => {
    const generated = [
      {
        t_start: 0,
        t_end: 1,
        title: "「保存」を押す",
        cited_ui_labels: ["存在しないボタン"],
      },
    ];
    const result = computeG2(generated, ["保存"]);
    expect(result.accuracy).toBe(0.5);
    expect(result.totalLabels).toBe(2);
    expect(result.matchedLabels).toBe(1);
  });

  it("structured cited_ui_labels の外側引用符を照合時に吸収する", () => {
    const generated = [
      {
        t_start: 0,
        t_end: 1,
        title: "保存する",
        cited_ui_labels: ["「保存」"],
      },
    ];
    const result = computeG2(generated, ["保存"]);
    expect(result.accuracy).toBe(1);
    expect(result.totalLabels).toBe(1);
    expect(result.matchedLabels).toBe(1);
  });

  it("structured cited_ui_labels の動的件数サフィックスを照合時に吸収する", () => {
    const generated = [
      {
        t_start: 0,
        t_end: 1,
        title: "ステップを開く",
        cited_ui_labels: ["ステップ (0)"],
      },
    ];
    const result = computeG2(generated, ["ステップ"]);
    expect(result.accuracy).toBe(1);
    expect(result.totalLabels).toBe(1);
    expect(result.matchedLabels).toBe(1);
  });

  it("正規化後に空になる cited_ui_labels は分母から除外する", () => {
    const generated = [
      {
        t_start: 0,
        t_end: 1,
        title: "件数だけの表示を無視する",
        cited_ui_labels: ["(10)"],
      },
    ];
    const result = computeG2(generated, ["(10)"]);
    expect(normalizeLabel("(10)")).toBe("");
    expect(result.totalLabels).toBe(0);
    expect(result.matchedLabels).toBe(0);
    expect(result.citedStepCount).toBe(0);
    expect(result.noCitationRate).toBe(1);
    expect(result.accuracy).toBe(0);
  });
});

describe("computeG3", () => {
  const gt = [
    { t_start: 0, t_end: 1000, title: "A" },
    { t_start: 1000, t_end: 3000, title: "スクロール", non_step: true },
  ];

  it("非ステップ区間にマッチした生成ステップの率を返す", () => {
    const generated = [
      { t_start: 0, t_end: 1000, title: "a" },
      { t_start: 1000, t_end: 3000, title: "scroll" },
    ];
    const result = computeG3(generated, gt);
    expect(result.rate).toBe(0.5);
    expect(result.nonStepMatchedCount).toBe(1);
  });

  it("非ステップ混入がなければ0", () => {
    const generated = [{ t_start: 0, t_end: 1000, title: "a" }];
    expect(computeG3(generated, gt).rate).toBe(0);
  });

  it("生成0件でもNaNにならない", () => {
    expect(computeG3([], gt).rate).toBe(0);
  });
});

describe("computeBoundaryRecall", () => {
  const gt = [
    { t_start: 0, t_end: 2000, title: "A" },
    { t_start: 2000, t_end: 5000, title: "B" },
    { t_start: 5000, t_end: 6000, title: "scroll", non_step: true },
  ];
  // 正解境界（non_step除外）: 0, 2000, 5000

  it("許容誤差内の境界をマッチとして数える", () => {
    const result = computeBoundaryRecall([0, 2300, 4900], gt, 500);
    // 0→0 OK, 2000→2300 OK(300ms), 5000→4900 OK(100ms)
    expect(result.recall).toBe(1);
    expect(result.totalBoundaries).toBe(3);
  });

  it("許容誤差を超えた境界はマッチしない", () => {
    const result = computeBoundaryRecall([0, 2600], gt, 500);
    // 2000→2600 は600msずれでNG、5000は境界なし
    expect(result.matchedBoundaries).toBe(1);
    expect(result.recall).toBeCloseTo(1 / 3);
  });

  it("正解が空でもNaNにならない", () => {
    expect(computeBoundaryRecall([0], []).recall).toBe(0);
  });
});
