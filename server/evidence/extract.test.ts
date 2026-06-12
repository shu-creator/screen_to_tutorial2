import { describe, expect, it } from "vitest";
import { assignTranscriptSnippets, computeOcrFocus } from "./extract";

describe("assignTranscriptSnippets", () => {
  const segments = [
    { transitionStartMs: 5000, tEndMs: 7000 },
    { transitionStartMs: 12000, tEndMs: 14000 },
  ];

  it("操作に先行する発話をリードウィンドウで拾う", () => {
    // 発話は操作開始の2.5秒前（「次に保存を押します」→クリックのパターン）
    const transcript = [
      { startMs: 2500, endMs: 4200, text: "次に保存ボタンを押します", confidence: 0.9 },
    ];
    const snippets = assignTranscriptSnippets(segments, transcript, 3000);
    expect(snippets[0]).toBe("次に保存ボタンを押します");
    expect(snippets[1]).toBe("");
  });

  it("リードウィンドウ外の発話は割り当てない", () => {
    const transcript = [
      { startMs: 0, endMs: 1500, text: "今日はこのアプリを説明します", confidence: 0.9 },
    ];
    // セグメント1のウィンドウは [2000, 7000]
    const snippets = assignTranscriptSnippets(segments, transcript, 3000);
    expect(snippets[0]).toBe("");
  });

  it("複数ウィンドウに重なる発話は操作開始に最も近い方へ一意に割り当てる", () => {
    // [transition-lead, tEnd]: seg1=[2000,7000], seg2=[9000,14000]
    // 発話 [6500, 9500] は両方に重なる。開始時刻6500は seg1開始(5000)から1500、
    // seg2開始(12000)から5500 → seg1へ
    const transcript = [
      { startMs: 6500, endMs: 9500, text: "結果を確認します", confidence: 0.9 },
    ];
    const snippets = assignTranscriptSnippets(segments, transcript, 3000);
    expect(snippets[0]).toBe("結果を確認します");
    expect(snippets[1]).toBe("");
  });

  it("複数発話は時系列順に連結される", () => {
    const transcript = [
      { startMs: 3000, endMs: 4000, text: "ログイン画面を開いて", confidence: 0.9 },
      { startMs: 4200, endMs: 5200, text: "ボタンを押します", confidence: 0.9 },
    ];
    const snippets = assignTranscriptSnippets(segments, transcript, 3000);
    expect(snippets[0]).toBe("ログイン画面を開いて ボタンを押します");
  });

  it("発話なしなら全セグメント空文字", () => {
    expect(assignTranscriptSnippets(segments, [], 3000)).toEqual(["", ""]);
  });
});

describe("computeOcrFocus", () => {
  const regions = [
    { text: "保存", x: 0.4, y: 0.5, w: 0.08, h: 0.05 },
    { text: "キャンセル", x: 0.55, y: 0.5, w: 0.1, h: 0.05 },
    { text: "ヘッダー", x: 0.0, y: 0.0, w: 0.3, h: 0.05 },
  ];

  it("差分bboxに重なるOCR行のみ返す", () => {
    const focus = computeOcrFocus(regions, { x: 0.38, y: 0.48, w: 0.1, h: 0.08 });
    expect(focus).toContain("保存");
    expect(focus).not.toContain("ヘッダー");
  });

  it("パディングにより隣接ラベルも拾う", () => {
    // bbox は保存ボタンのみだがパディング4%でキャンセルにも届く
    const focus = computeOcrFocus(regions, { x: 0.4, y: 0.5, w: 0.08, h: 0.05 }, 0.08);
    expect(focus).toEqual(expect.arrayContaining(["保存", "キャンセル"]));
  });

  it("bboxがnullなら空配列", () => {
    expect(computeOcrFocus(regions, null)).toEqual([]);
  });
});
