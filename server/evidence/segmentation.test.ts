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

  it("stall領域外の中間diffが stableFrames 回連続したら waiting をクローズして遷移再開する（P2-1）", () => {
    // W=100, H=50 (5000px)
    // fps=4, stableFrames=2, stallWindowFrames=3, stallAfterMs=1000, stallAreaRatio=0.02
    // highThreshold=0.01 に上げることで中間diff(diffRate=0.002)がisTransitionStart=falseになる
    //
    // 中間diffはスピナーAにy=40の変化を重ねて作る。
    // midOnA: spinnerA + (x=0,y=40,w=10,h=1)=200 → diff vs spinnerA: 10px only at y=40
    //   diffRate=10/5000=0.002, bbox=(0,0.8,0.1,0.02), area=0.002
    //   isTransitionStart=false: diffRate(0.002)<=highThreshold(0.01), area(0.002)<mediumStartAreaRatio(0.005)
    // midOnB: spinnerA + (x=10,y=40,w=10,h=1)=200 → diff vs midOnA: 20px
    //   diffRate=20/5000=0.004, isTransitionStart=false (area=0.004<0.005)
    const base = flatFrame(100);
    const action = withRect(base, { x: 0, y: 0, w: 50, h: 25 }, 150);
    const spinnerA = withRect(action, { x: 40, y: 18, w: 6, h: 6 }, 220);
    const spinnerB = withRect(action, { x: 41, y: 18, w: 6, h: 6 }, 220);
    // stall領域外の中間diff: スピナーAにy=40の変化を重ねる（spinner部分はそのまま維持）
    const midOnA = withRect(spinnerA, { x: 0, y: 40, w: 10, h: 1 }, 200);
    const midOnB = withRect(spinnerA, { x: 10, y: 40, w: 10, h: 1 }, 200);

    const frames = [
      base,     // 0
      base,     // 1
      base,     // 2
      base,     // 3
      action,   // 4  ← diff[4] action大変化(50x25px=0.25) → transition開始(transitionStart=4)
      spinnerA, // 5  ← diff[5]
      spinnerB, // 6  ← diff[6]
      spinnerA, // 7  ← diff[7] stallWindow=[5,6,7], stallCandidateStart=5, stalledForMs=500ms
      spinnerB, // 8  ← diff[8] stalledForMs=750ms
      spinnerA, // 9  ← diff[9] stalledForMs=(9-5)*250=1000ms >= 1000ms
                //     actionBBox=(0,0,0.5,0.5) area=0.25>preStallActionAreaRatio(0.05) → hasPreStallAction=true
                //     action{start=4,stabilized=5}をpush、stalledStart=5でstalled状態へ
      midOnA,   // 10 ← diff[10] 中間diff1回目: spinnerA→midOnA = 10px at y=40
                //     changedBBox=(0,0.8,0.1,0.02), not inside stalledRegion(0.36..0.51, 0.32..0.52)
                //     isTransitionStart=false → stalledEscapeDiffs=[diff[10]]
      midOnB,   // 11 ← diff[11] 中間diff2回目: midOnA→midOnB = 20px at y=40
                //     isTransitionStart=false → stalledEscapeDiffs=[diff[10],diff[11]]
                //     .length=2 >= stableFrames=2 → escape!
                //     waiting{start=5,stabilized=stalledEscapeDiffs[0].index=10}をpush
                //     transition再開(transitionStart=10)
      base,     // 12 ← diff[12] calmRun=0（midOnB→base は大きい変化）
      base,     // 13 ← diff[13] calm1
      base,     // 14 ← diff[14] calm2 → action{start=10,stabilized=13}
    ];

    const segments = detectSegments(frames, W, H, {
      fps: 4,
      highThreshold: 0.01,
      lowThreshold: 0.0005,
      stableFrames: 2,
      stallWindowFrames: 3,
      stallAfterMs: 1000,
      stallAreaRatio: 0.02,
    });

    // waiting セグメントが存在し、tEndMs が中間diff開始フレーム付近でクローズされている
    const waitingSeg = segments.find(s => s.activity === "waiting");
    expect(waitingSeg).toBeDefined();
    // stabilizedIndex=10 → tEndMs=10*(1000/4)=2500ms（動画末尾まで延長されていない）
    expect(waitingSeg!.tEndMs).toBeLessThan(frames.length * (1000 / 4));
    expect(waitingSeg!.tEndMs).toBe(10 * (1000 / 4)); // 2500ms

    // waiting の直後に別セグメントが存在し、その transitionStartMs が waiting の tEndMs と一致する
    const waitingIdx = segments.indexOf(waitingSeg!);
    const nextSeg = segments[waitingIdx + 1];
    expect(nextSeg).toBeDefined();
    expect(nextSeg.transitionStartMs).toBe(waitingSeg!.tEndMs);
  });

  it("遷移開始直後からスピナーのみの場合は遷移全体を waiting にする（P2-2）", () => {
    // W=100, H=50 (5000px)
    // fps=4, stableFrames=2, stallWindowFrames=3, stallAfterMs=1000, stallAreaRatio=0.02
    // スピナーのみ（pre-stall action なし）: actionBBox面積(0.0072) < preStallActionAreaRatio(0.05)
    const base = flatFrame(100);
    const spinnerA = withRect(base, { x: 40, y: 18, w: 6, h: 6 }, 220);
    const spinnerB = withRect(base, { x: 41, y: 18, w: 6, h: 6 }, 220);

    // spinnerA - base: diffRate=36/5000=0.0072, bbox=(0.4,0.36,0.06,0.12), area=0.0072
    // mediumLocalChange: diffRate(0.0072)>0.0005 && area(0.0072)>=0.005 && area<=0.02 → true
    // → isTransitionStart=true → transition開始（pre-stall action なし）
    const frames = [
      base,     // 0
      base,     // 1
      base,     // 2
      base,     // 3
      spinnerA, // 4  ← diff[4]: isTransitionStart=true → transition開始(transitionStart=4)
      spinnerB, // 5  ← diff[5]
      spinnerA, // 6  ← diff[6]
                //     stallWindow=[4,5,6], windowBBox≈(0.4,0.36,0.07,0.12), area=0.0084<=0.02
                //     stallCandidateStart = max(4, transitionStart+1=5) = 5
                //     stalledForMs=(6-5)*250=250ms
      spinnerB, // 7  ← diff[7]: stalledForMs=500ms
      spinnerA, // 8  ← diff[8]: stalledForMs=750ms
      spinnerB, // 9  ← diff[9]: stalledForMs=(9-5)*250=1000ms >= 1000ms
                //     actionBBox=bboxFromDiffs(transitionDiffs,4,4)=spinner bbox, area=0.0072
                //     hasPreStallAction: 0.0072 > 0.05? No → フォールバック
                //     stalledStart=transitionStart=4, 遷移全体をwaitingとしてstalled状態へ
      base,     // 10 ← diff[10]: calm1
      base,     // 11 ← diff[11]: calm2 → waiting{start=4, stabilized=10} push
    ];

    const segments = detectSegments(frames, W, H, {
      fps: 4,
      highThreshold: 0.01,
      lowThreshold: 0.0005,
      stableFrames: 2,
      stallWindowFrames: 3,
      stallAfterMs: 1000,
      stallAreaRatio: 0.02,
    });

    // action セグメントとして分割されず、当該区間が activity="waiting" の1個のみ
    expect(segments).toHaveLength(1);
    expect(segments[0].activity).toBe("waiting");

    // waiting の changedBBox がスピナー領域相当の小ささ
    const waitingBBox = segments[0].changedBBox;
    expect(waitingBBox).not.toBeNull();
    expect(waitingBBox!.w).toBeLessThan(0.15);
    expect(waitingBBox!.h).toBeLessThan(0.20);
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
