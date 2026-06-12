/**
 * 操作セグメンテーションコア（Phase 1）
 *
 * 一様サンプリングしたグレースケールフレーム列から、
 * 「安定 → 遷移 → 安定」の状態機械で操作セグメントを検出する。
 * すべて純関数（ファイルI/O・ffmpeg非依存）でテスト可能。
 *
 * 一次信号の選定について（docs/plans/phase-1-evidence-extraction.md）:
 * 全画面dHashは小変化を無視するよう設計されたハッシュのため一次信号には使わず、
 * ピクセル差分率を一次信号とする。比較検証は signalComparison.test.ts を参照。
 */

export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GrayFrame {
  /** width*height バイトのグレースケールピクセル */
  pixels: Buffer;
}

export interface FrameDiff {
  /** 後フレーム側のサンプルインデックス（diffs[i] = frame[i-1] と frame[i] の差分） */
  index: number;
  /** 変化ピクセル率 0..1 */
  diffRate: number;
  /** 変化ピクセルのバウンディングボックス（正規化座標、変化なしなら null） */
  changedBBox: NormalizedRect | null;
}

export interface SegmentationOptions {
  /** 遷移開始とみなす変化率の閾値 */
  highThreshold: number;
  /** 遷移終了（安定）とみなす変化率の閾値（highより小さいこと） */
  lowThreshold: number;
  /** 安定とみなすのに必要な連続フレーム数 */
  stableFrames: number;
  /** サンプリングfps（インデックス→時刻変換用） */
  fps: number;
  /** この時間以内の安定ギャップを挟む変化はcoalescing候補（ms） */
  coalesceMaxGapMs: number;
  /** coalescing時のbbox近接判定: 各bboxをこの比率だけ拡張して交差判定 */
  coalesceBBoxPadRatio: number;
}

export const DEFAULT_SEGMENTATION_OPTIONS: SegmentationOptions = {
  // 1文字タイピングの変化率は画面の約0.07%（解像度に依らずほぼ一定）。
  // これを検出するため high はそれより低く設定する。
  // pixelThreshold=24 が圧縮ノイズを除去するため、この感度でも
  // 静的画面で誤検出しない（合成データセットで較正済み）。
  highThreshold: 0.0004,
  lowThreshold: 0.00015,
  stableFrames: 2,
  fps: 4,
  coalesceMaxGapMs: 1000,
  coalesceBBoxPadRatio: 0.04,
};

export interface OperationSegment {
  /** セグメント区間: 直前の安定開始（または0）〜 遷移後の安定化時刻（ms） */
  tStartMs: number;
  tEndMs: number;
  /** 操作（画面変化）が始まった時刻（ms）。クリップ切り出しや境界評価の基準 */
  transitionStartMs: number;
  /** 遷移開始直前の安定フレームのインデックス（before画像、先頭は null） */
  beforeFrameIndex: number | null;
  /** 遷移後に安定化した最初のフレームのインデックス（after画像 = 代表） */
  afterFrameIndex: number;
  /** 遷移中の変化領域の合併bbox */
  changedBBox: NormalizedRect | null;
  /** coalescingで合体した変化点の数（1 = 合体なし） */
  coalescedFrom: number;
}

/** 2フレーム間の変化率と変化領域bboxを計算する */
export function computeFrameDiff(
  prev: Buffer,
  curr: Buffer,
  width: number,
  height: number,
  pixelThreshold: number,
): { diffRate: number; changedBBox: NormalizedRect | null } {
  const total = width * height;
  let changed = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let i = 0; i < total; i++) {
    const delta = Math.abs(prev[i] - curr[i]);
    if (delta > pixelThreshold) {
      changed += 1;
      const x = i % width;
      const y = (i / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (changed === 0) {
    return { diffRate: 0, changedBBox: null };
  }

  return {
    diffRate: changed / total,
    changedBBox: {
      x: minX / width,
      y: minY / height,
      w: (maxX - minX + 1) / width,
      h: (maxY - minY + 1) / height,
    },
  };
}

/** フレーム列から差分タイムラインを構築する */
export function computeDiffTimeline(
  frames: GrayFrame[],
  width: number,
  height: number,
  pixelThreshold = 24,
): FrameDiff[] {
  const diffs: FrameDiff[] = [];
  for (let i = 1; i < frames.length; i++) {
    const { diffRate, changedBBox } = computeFrameDiff(
      frames[i - 1].pixels,
      frames[i].pixels,
      width,
      height,
      pixelThreshold,
    );
    diffs.push({ index: i, diffRate, changedBBox });
  }
  return diffs;
}

export function unionBBox(
  a: NormalizedRect | null,
  b: NormalizedRect | null,
): NormalizedRect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

function padRect(rect: NormalizedRect, padRatio: number): NormalizedRect {
  return {
    x: rect.x - padRatio,
    y: rect.y - padRatio,
    w: rect.w + padRatio * 2,
    h: rect.h + padRatio * 2,
  };
}

export function rectsIntersect(a: NormalizedRect, b: NormalizedRect): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

/** 遷移区間の生検出結果（coalescing前） */
interface RawTransition {
  /** 遷移開始フレーム（このフレームで最初にhighを超えた） */
  startIndex: number;
  /** 安定化フレーム（このフレーム以降 stableFrames 連続で low 未満） */
  stabilizedIndex: number;
  changedBBox: NormalizedRect | null;
}

/**
 * 状態機械による遷移検出。
 * stable 中に diffRate > high → 遷移開始。
 * 遷移中に diffRate < low が stableFrames 連続 → その先頭フレームで安定化。
 * 動画末尾まで安定化しない場合は最終フレームで強制安定化する。
 */
export function detectTransitions(
  diffs: FrameDiff[],
  frameCount: number,
  options: Pick<SegmentationOptions, "highThreshold" | "lowThreshold" | "stableFrames">,
): RawTransition[] {
  const transitions: RawTransition[] = [];
  let inTransition = false;
  let transitionStart = 0;
  let bbox: NormalizedRect | null = null;
  let calmRun = 0;

  for (const diff of diffs) {
    if (!inTransition) {
      if (diff.diffRate > options.highThreshold) {
        inTransition = true;
        transitionStart = diff.index;
        bbox = diff.changedBBox;
        calmRun = 0;
      }
      continue;
    }

    if (diff.diffRate < options.lowThreshold) {
      calmRun += 1;
      if (calmRun >= options.stableFrames) {
        // 安定化点 = calm run の先頭フレーム
        transitions.push({
          startIndex: transitionStart,
          stabilizedIndex: diff.index - options.stableFrames + 1,
          changedBBox: bbox,
        });
        inTransition = false;
        bbox = null;
      }
    } else {
      calmRun = 0;
      bbox = unionBBox(bbox, diff.changedBBox);
    }
  }

  if (inTransition) {
    transitions.push({
      startIndex: transitionStart,
      stabilizedIndex: frameCount - 1,
      changedBBox: bbox,
    });
  }

  return transitions;
}

/**
 * 近接する遷移のcoalescing。
 * 安定ギャップが coalesceMaxGapMs 未満かつ変化領域が近接
 * （bboxをpadRatio拡張して交差）する遷移を1操作に合体する（タイピング等）。
 * bboxが欠けている場合は誤合体を避けるため合体しない。
 */
export function coalesceTransitions(
  transitions: RawTransition[],
  options: Pick<SegmentationOptions, "fps" | "coalesceMaxGapMs" | "coalesceBBoxPadRatio">,
): Array<RawTransition & { coalescedFrom: number }> {
  const result: Array<RawTransition & { coalescedFrom: number }> = [];
  const frameMs = 1000 / options.fps;

  for (const transition of transitions) {
    const last = result[result.length - 1];
    if (last) {
      const gapMs = (transition.startIndex - last.stabilizedIndex) * frameMs;
      const bothHaveBBox = last.changedBBox !== null && transition.changedBBox !== null;
      const nearby =
        bothHaveBBox &&
        rectsIntersect(
          padRect(last.changedBBox as NormalizedRect, options.coalesceBBoxPadRatio),
          padRect(transition.changedBBox as NormalizedRect, options.coalesceBBoxPadRatio),
        );
      if (gapMs < options.coalesceMaxGapMs && nearby) {
        last.stabilizedIndex = transition.stabilizedIndex;
        last.changedBBox = unionBBox(last.changedBBox, transition.changedBBox);
        last.coalescedFrom += 1;
        continue;
      }
    }
    result.push({ ...transition, coalescedFrom: 1 });
  }

  return result;
}

/**
 * フレーム列から操作セグメントを検出する（エントリーポイント）。
 *
 * セグメント区間の規約: 各操作セグメントは
 * 「直前の操作の安定化時刻（先頭は0）〜 この操作の遷移後の安定化時刻」。
 * before = 遷移開始直前の安定フレーム、after = 安定化した最初のフレーム。
 */
export function detectSegments(
  frames: GrayFrame[],
  width: number,
  height: number,
  options: Partial<SegmentationOptions> & { pixelThreshold?: number } = {},
): OperationSegment[] {
  const opts: SegmentationOptions = { ...DEFAULT_SEGMENTATION_OPTIONS, ...options };
  if (opts.lowThreshold >= opts.highThreshold) {
    throw new Error("lowThreshold は highThreshold より小さい必要があります");
  }
  const frameMs = 1000 / opts.fps;

  const diffs = computeDiffTimeline(frames, width, height, options.pixelThreshold ?? 24);
  const transitions = detectTransitions(diffs, frames.length, opts);
  const coalesced = coalesceTransitions(transitions, opts);

  const segments: OperationSegment[] = [];
  let prevStabilized = 0;

  for (const transition of coalesced) {
    segments.push({
      tStartMs: Math.round(prevStabilized * frameMs),
      tEndMs: Math.round(transition.stabilizedIndex * frameMs),
      transitionStartMs: Math.round(transition.startIndex * frameMs),
      beforeFrameIndex: Math.max(0, transition.startIndex - 1),
      afterFrameIndex: transition.stabilizedIndex,
      changedBBox: transition.changedBBox,
      coalescedFrom: transition.coalescedFrom,
    });
    prevStabilized = transition.stabilizedIndex;
  }

  // 操作が一つもない動画: 先頭フレームのみの単一セグメント
  if (segments.length === 0 && frames.length > 0) {
    segments.push({
      tStartMs: 0,
      tEndMs: Math.round((frames.length - 1) * frameMs),
      transitionStartMs: 0,
      beforeFrameIndex: null,
      afterFrameIndex: 0,
      changedBBox: null,
      coalescedFrom: 1,
    });
  } else if (segments.length > 0) {
    // 先頭セグメントの before は「初期画面」なので null 扱いにしない
    // （初期画面 = before、操作後 = after が成立する）。
    // ただし遷移開始が0フレーム目ならbeforeは存在しない。
    const first = segments[0];
    if (first.beforeFrameIndex !== null && first.beforeFrameIndex < 0) {
      first.beforeFrameIndex = null;
    }
  }

  return segments;
}

/**
 * 全画面dHash（9x8ダウンサンプル→64bit）。
 * 比較実験用に残す: 一次信号としては微小変化を無視するため不適
 * （signalComparison.test.ts で実証）。
 */
export function computeFullFrameDHash(
  pixels: Buffer,
  width: number,
  height: number,
): string {
  // 9x8 に平均プーリング
  const gw = 9;
  const gh = 8;
  const cellW = width / gw;
  const cellH = height / gh;
  const grid: number[] = [];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let sum = 0;
      let count = 0;
      const x0 = Math.floor(gx * cellW);
      const x1 = Math.min(width, Math.ceil((gx + 1) * cellW));
      const y0 = Math.floor(gy * cellH);
      const y1 = Math.min(height, Math.ceil((gy + 1) * cellH));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += pixels[y * width + x];
          count += 1;
        }
      }
      grid.push(count > 0 ? sum / count : 0);
    }
  }

  let bits = "";
  for (let row = 0; row < gh; row++) {
    for (let col = 0; col < gw - 1; col++) {
      bits += grid[row * gw + col] > grid[row * gw + col + 1] ? "1" : "0";
    }
  }
  return bits;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) distance += 1;
  }
  return distance;
}
