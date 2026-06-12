import { describe, expect, it } from "vitest";
import {
  classifyWaitingRuns,
  coalesceTransitions,
  computeDiffTimeline,
  computeFrameDiff,
  computeFullFrameDHash,
  detectSegments,
  detectTransitions,
  hammingDistance,
  rectsIntersect,
  unionBBox,
  type GrayFrame,
} from "./segmentation";

const W = 100;
const H = 50;

/** 一様な明るさのフレームを作る */
function flatFrame(value: number): GrayFrame {
  return { pixels: Buffer.alloc(W * H, value) };
}

/** baseフレームに矩形変化を加えたフレームを作る */
function withRect(
  base: GrayFrame,
  rect: { x: number; y: number; w: number; h: number },
  value: number
): GrayFrame {
  const pixels = Buffer.from(base.pixels);
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      pixels[y * W + x] = value;
    }
  }
  return { pixels };
}

describe("computeFrameDiff", () => {
  it("同一フレームで diffRate=0 / bbox=null", () => {
    const a = flatFrame(100);
    const result = computeFrameDiff(a.pixels, a.pixels, W, H, 24);
    expect(result.diffRate).toBe(0);
    expect(result.changedBBox).toBeNull();
  });

  it("矩形変化の位置とサイズをbboxとして返す", () => {
    const a = flatFrame(100);
    const b = withRect(a, { x: 10, y: 5, w: 20, h: 10 }, 200);
    const result = computeFrameDiff(a.pixels, b.pixels, W, H, 24);
    expect(result.diffRate).toBeCloseTo((20 * 10) / (W * H));
    expect(result.changedBBox).toEqual({
      x: 10 / W,
      y: 5 / H,
      w: 20 / W,
      h: 10 / H,
    });
  });

  it("pixelThreshold 以下のノイズは無視する", () => {
    const a = flatFrame(100);
    const b = flatFrame(110); // 差10 < 閾値24
    const result = computeFrameDiff(a.pixels, b.pixels, W, H, 24);
    expect(result.diffRate).toBe(0);
  });
});

describe("detectTransitions", () => {
  const opts = { highThreshold: 0.002, lowThreshold: 0.0008, stableFrames: 2 };

  it("安定→変化→安定 で1遷移を検出する", () => {
    const base = flatFrame(100);
    const changed = withRect(base, { x: 0, y: 0, w: 50, h: 25 }, 200);
    // frames: 安定3枚 → 変化1枚 → (変化後)安定3枚
    const frames = [base, base, base, changed, changed, changed, changed];
    const diffs = computeDiffTimeline(frames, W, H);
    const transitions = detectTransitions(diffs, frames.length, opts);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].startIndex).toBe(3); // 変化が現れたフレーム
    expect(transitions[0].stabilizedIndex).toBe(4); // 変化後最初の安定フレーム
  });

  it("動画末尾まで安定しない場合は最終フレームで強制安定化する", () => {
    const base = flatFrame(100);
    const frames: GrayFrame[] = [base, base];
    // 毎フレーム変化し続ける
    for (let i = 0; i < 4; i++) {
      frames.push(
        withRect(base, { x: i * 10, y: 0, w: 50, h: 25 }, 200 + i * 10)
      );
    }
    const diffs = computeDiffTimeline(frames, W, H);
    const transitions = detectTransitions(diffs, frames.length, opts);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].stabilizedIndex).toBe(frames.length - 1);
  });

  it("変化がなければ遷移なし", () => {
    const base = flatFrame(100);
    const frames = [base, base, base, base];
    const diffs = computeDiffTimeline(frames, W, H);
    expect(detectTransitions(diffs, frames.length, opts)).toHaveLength(0);
  });
});

describe("coalesceTransitions", () => {
  const opts = { fps: 4, coalesceMaxGapMs: 1000, coalesceBBoxPadRatio: 0.04 };
  const bboxAt = (
    x: number
  ): { x: number; y: number; w: number; h: number } => ({
    x,
    y: 0.3,
    w: 0.05,
    h: 0.05,
  });

  it("近接時間+近接bboxの遷移を合体する（タイピング想定）", () => {
    // 250ms間隔（fps=4で1フレームギャップ）、bboxが横に少しずつ進む
    const transitions = [
      { startIndex: 4, stabilizedIndex: 5, changedBBox: bboxAt(0.3) },
      { startIndex: 7, stabilizedIndex: 8, changedBBox: bboxAt(0.36) },
      { startIndex: 10, stabilizedIndex: 11, changedBBox: bboxAt(0.42) },
    ];
    const result = coalesceTransitions(transitions, opts);
    expect(result).toHaveLength(1);
    expect(result[0].coalescedFrom).toBe(3);
    expect(result[0].startIndex).toBe(4);
    expect(result[0].stabilizedIndex).toBe(11);
  });

  it("時間が近くてもbboxが離れていれば合体しない（別操作）", () => {
    const transitions = [
      { startIndex: 4, stabilizedIndex: 5, changedBBox: bboxAt(0.1) },
      { startIndex: 7, stabilizedIndex: 8, changedBBox: bboxAt(0.8) },
    ];
    const result = coalesceTransitions(transitions, opts);
    expect(result).toHaveLength(2);
  });

  it("時間ギャップが大きければ合体しない", () => {
    const transitions = [
      { startIndex: 4, stabilizedIndex: 5, changedBBox: bboxAt(0.3) },
      { startIndex: 15, stabilizedIndex: 16, changedBBox: bboxAt(0.33) }, // 2.5s後
    ];
    const result = coalesceTransitions(transitions, opts);
    expect(result).toHaveLength(2);
  });

  it("bboxが無い遷移は誤合体を避けるため合体しない", () => {
    const transitions = [
      { startIndex: 4, stabilizedIndex: 5, changedBBox: null },
      { startIndex: 7, stabilizedIndex: 8, changedBBox: bboxAt(0.3) },
    ];
    const result = coalesceTransitions(transitions, opts);
    expect(result).toHaveLength(2);
  });
});

describe("detectSegments (end-to-end pure)", () => {
  it("2操作の動画から2セグメントを検出し、区間規約に従う", () => {
    const base = flatFrame(100);
    const after1 = withRect(base, { x: 0, y: 0, w: 50, h: 25 }, 200);
    const after2 = withRect(after1, { x: 60, y: 30, w: 30, h: 15 }, 30);
    const frames = [
      base,
      base,
      base,
      base, // 0-3: 初期安定
      after1,
      after1,
      after1,
      after1, // 4: 遷移 → 5から安定
      after2,
      after2,
      after2,
      after2, // 8: 遷移 → 9から安定
    ];
    const segments = detectSegments(frames, W, H, { fps: 4 });
    expect(segments).toHaveLength(2);

    // セグメント1: 0ms 〜 安定化(フレーム5=1250ms)
    expect(segments[0].tStartMs).toBe(0);
    expect(segments[0].beforeFrameIndex).toBe(3);
    expect(segments[0].afterFrameIndex).toBe(5);

    // セグメント2: 前の安定化 〜 自分の安定化
    expect(segments[1].tStartMs).toBe(segments[0].tEndMs);
    expect(segments[1].beforeFrameIndex).toBe(7);
    expect(segments[1].afterFrameIndex).toBe(9);
    expect(segments[1].changedBBox).not.toBeNull();
  });

  it("変化のない動画は先頭フレームの単一セグメント", () => {
    const base = flatFrame(100);
    const segments = detectSegments([base, base, base], W, H, { fps: 4 });
    expect(segments).toHaveLength(1);
    expect(segments[0].beforeFrameIndex).toBeNull();
    expect(segments[0].afterFrameIndex).toBe(0);
  });

  it("low >= high の設定はエラー", () => {
    expect(() =>
      detectSegments([flatFrame(0)], W, H, {
        highThreshold: 0.001,
        lowThreshold: 0.001,
      })
    ).toThrow();
  });

  it("小領域スピナーが動き続ける区間をstall closeし waiting セグメントにする", () => {
    const base = flatFrame(100);
    const action = withRect(base, { x: 0, y: 0, w: 50, h: 25 }, 150);
    const spinnerA = withRect(action, { x: 40, y: 18, w: 6, h: 6 }, 220);
    const spinnerB = withRect(action, { x: 41, y: 18, w: 6, h: 6 }, 220);
    const frames = [
      base,
      base,
      base,
      base,
      action,
      spinnerA,
      spinnerB,
      spinnerA,
      spinnerB,
      spinnerA,
      spinnerB,
      spinnerA,
      action,
      action,
      action,
    ];

    const segments = detectSegments(frames, W, H, {
      fps: 4,
      stallWindowFrames: 3,
      stallAfterMs: 1000,
      stallAreaRatio: 0.02,
    });

    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments[0].activity).toBe("action");
    expect(segments[1].activity).toBe("waiting");
    expect(segments[1].transitionStartMs).toBeGreaterThanOrEqual(1000);
    expect(segments[1].changedBBox?.w).toBeLessThan(0.15);
  });
});

describe("classifyWaitingRuns", () => {
  const segment = (
    index: number,
    bbox: { x: number; y: number; w: number; h: number },
    overrides: Partial<ReturnType<typeof detectSegments>[number]> = {}
  ): ReturnType<typeof detectSegments>[number] => ({
    tStartMs: index * 4000,
    tEndMs: (index + 1) * 4000,
    transitionStartMs: index * 4000 + 250,
    beforeFrameIndex: index,
    afterFrameIndex: index + 1,
    changedBBox: bbox,
    coalescedFrom: 1,
    activity: "action",
    ...overrides,
  });

  it("同一bboxの進捗バー反復runを waiting にする", () => {
    const segments = [
      segment(0, { x: 0.3, y: 0.2, w: 0.32, h: 0.04 }),
      segment(1, { x: 0.3, y: 0.2, w: 0.32, h: 0.04 }),
      segment(2, { x: 0.3, y: 0.2, w: 0.32, h: 0.04 }),
    ];

    const classified = classifyWaitingRuns(segments, {
      waitingRunAreaRatio: 0.35,
      waitingRunMinSpanMs: 10000,
    });

    expect(classified.map(item => item.activity)).toEqual([
      "waiting",
      "waiting",
      "waiting",
    ]);
  });

  it("coalescing済みの1文字タイピング1セグメントは waiting にしない", () => {
    const classified = classifyWaitingRuns([
      segment(
        0,
        { x: 0.4, y: 0.4, w: 0.06, h: 0.06 },
        { tEndMs: 12000, coalescedFrom: 3 }
      ),
    ]);

    expect(classified[0].activity).toBe("action");
  });
});

describe("unionBBox / rectsIntersect", () => {
  it("unionBBox は2つの矩形を包含する", () => {
    const union = unionBBox(
      { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }
    );
    expect(union).toEqual({ x: 0.1, y: 0.1, w: 0.6, h: 0.6 });
  });

  it("unionBBox は null を恒等的に扱う", () => {
    const rect = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    expect(unionBBox(null, rect)).toEqual(rect);
    expect(unionBBox(rect, null)).toEqual(rect);
    expect(unionBBox(null, null)).toBeNull();
  });

  it("rectsIntersect は交差を判定する", () => {
    expect(
      rectsIntersect(
        { x: 0, y: 0, w: 0.5, h: 0.5 },
        { x: 0.4, y: 0.4, w: 0.5, h: 0.5 }
      )
    ).toBe(true);
    expect(
      rectsIntersect(
        { x: 0, y: 0, w: 0.3, h: 0.3 },
        { x: 0.5, y: 0.5, w: 0.3, h: 0.3 }
      )
    ).toBe(false);
  });
});

describe("computeFullFrameDHash（比較実験用）", () => {
  it("同一フレームのハッシュは一致する", () => {
    const a = flatFrame(100);
    expect(computeFullFrameDHash(a.pixels, W, H)).toBe(
      computeFullFrameDHash(a.pixels, W, H)
    );
  });

  it("微小変化（1文字相当）は全画面dHashでは検出できない — 一次信号に使わない根拠", () => {
    const base = flatFrame(100);
    // 100x50 中の 3x4 ピクセル変化 ≒ 1280px幅画面の1文字タイピング相当
    const typed = withRect(base, { x: 40, y: 20, w: 3, h: 4 }, 220);

    const dhashDistance = hammingDistance(
      computeFullFrameDHash(base.pixels, W, H),
      computeFullFrameDHash(typed.pixels, W, H)
    );
    const pixelDiff = computeFrameDiff(base.pixels, typed.pixels, W, H, 24);

    // 全画面dHash: 現行の重複判定閾値（6）を下回り「同一フレーム」扱いになる
    expect(dhashDistance).toBeLessThanOrEqual(6);
    // ピクセル差分率: 検出閾値（0.002）を上回り遷移として検出できる
    expect(pixelDiff.diffRate).toBeGreaterThan(0.002);
  });
});
