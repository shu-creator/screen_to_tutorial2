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
  /** 停滞判定に使う直近フレーム数。fps=4で約3秒を見てスピナー周期を吸収する */
  stallWindowFrames: number;
  /** 停滞とみなす直近変化bbox合併領域の最大面積比。画面の約1/3以下を待機UI扱いする */
  stallAreaRatio: number;
  /** 小領域変化が待機として継続したとみなす最短時間。短いクリック/入力とは分離する */
  stallAfterMs: number;
  /** 反復待機runに含める各bboxの最大面積比。stallAreaRatioと揃え小領域待機に限定する */
  waitingRunAreaRatio: number;
  /** 反復待機runの最短スパン。短いタイピング連続をwaiting化しない */
  waitingRunMinSpanMs: number;
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
  stallWindowFrames: 12,
  stallAreaRatio: 0.35,
  stallAfterMs: 6000,
  waitingRunAreaRatio: 0.35,
  waitingRunMinSpanMs: 10000,
};

export type OperationActivity = "action" | "waiting";

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
  /** 操作セグメントか、進捗バー・スピナー等の待機区間か */
  activity: OperationActivity;
}

/** 2フレーム間の変化率と変化領域bboxを計算する */
export function computeFrameDiff(
  prev: Buffer,
  curr: Buffer,
  width: number,
  height: number,
  pixelThreshold: number
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
  pixelThreshold = 24
): FrameDiff[] {
  const diffs: FrameDiff[] = [];
  for (let i = 1; i < frames.length; i++) {
    const { diffRate, changedBBox } = computeFrameDiff(
      frames[i - 1].pixels,
      frames[i].pixels,
      width,
      height,
      pixelThreshold
    );
    diffs.push({ index: i, diffRate, changedBBox });
  }
  return diffs;
}

export function unionBBox(
  a: NormalizedRect | null,
  b: NormalizedRect | null
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

function rectArea(rect: NormalizedRect | null): number {
  return rect ? rect.w * rect.h : 0;
}

function rectContains(outer: NormalizedRect, inner: NormalizedRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

function bboxFromDiffs(
  diffs: FrameDiff[],
  startIndex: number,
  endIndex: number
): NormalizedRect | null {
  let bbox: NormalizedRect | null = null;
  for (const diff of diffs) {
    if (diff.index >= startIndex && diff.index <= endIndex) {
      bbox = unionBBox(bbox, diff.changedBBox);
    }
  }
  return bbox;
}

function recentUnionBBox(diffs: FrameDiff[]): NormalizedRect | null {
  return diffs.reduce<NormalizedRect | null>(
    (bbox, diff) => unionBBox(bbox, diff.changedBBox),
    null
  );
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
  activity?: OperationActivity;
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
  options: Pick<
    SegmentationOptions,
    "highThreshold" | "lowThreshold" | "stableFrames"
  > &
    Partial<
      Pick<
        SegmentationOptions,
        | "fps"
        | "stallWindowFrames"
        | "stallAreaRatio"
        | "stallAfterMs"
        | "coalesceBBoxPadRatio"
      >
    >
): RawTransition[] {
  const transitions: RawTransition[] = [];
  const fps = options.fps ?? DEFAULT_SEGMENTATION_OPTIONS.fps;
  const stallWindowFrames =
    options.stallWindowFrames ?? DEFAULT_SEGMENTATION_OPTIONS.stallWindowFrames;
  const stallAreaRatio =
    options.stallAreaRatio ?? DEFAULT_SEGMENTATION_OPTIONS.stallAreaRatio;
  const stallAfterMs =
    options.stallAfterMs ?? DEFAULT_SEGMENTATION_OPTIONS.stallAfterMs;
  const coalesceBBoxPadRatio =
    options.coalesceBBoxPadRatio ??
    DEFAULT_SEGMENTATION_OPTIONS.coalesceBBoxPadRatio;
  const frameMs = 1000 / fps;
  const mediumStartAreaRatio = 0.005;
  const microInputDiffRate = 0.00005;
  const microInputAreaRatio = 0.001;
  // stall前の変化を独立したactionセグメントとして分割する価値があるとみなす経験的下限（画面面積の5%）。
  // メニュー展開・画面遷移は通常これを超え、スピナー・カーソル残像は下回る。
  // stallAreaRatio（待機UI bboxの上限）とは役割が異なる独立基準のため連動させない
  // （旧実装の min(stallAreaRatio, 0.05) は stallAreaRatio を小さく設定すると
  // 分割基準まで連動して下がる意図外相互作用があった）。
  // 下限未満の場合は遷移全体を waiting 扱いにする（フォールバック）。
  const preStallActionAreaRatio = 0.05;
  const isMicroInputCandidate = (diff: FrameDiff): boolean => {
    const area = rectArea(diff.changedBBox);
    return (
      diff.diffRate > microInputDiffRate &&
      area > 0 &&
      area <= microInputAreaRatio
    );
  };
  const microStartIndices = new Set<number>();
  for (let i = 0; i < diffs.length; i++) {
    const diff = diffs[i];
    if (!isMicroInputCandidate(diff) || diff.changedBBox === null) continue;
    const padded = padRect(diff.changedBBox, coalesceBBoxPadRatio);
    for (
      let j = i + 1;
      j < diffs.length && diffs[j].index - diff.index <= fps;
      j++
    ) {
      const next = diffs[j];
      if (
        isMicroInputCandidate(next) &&
        next.changedBBox !== null &&
        rectsIntersect(padded, padRect(next.changedBBox, coalesceBBoxPadRatio))
      ) {
        microStartIndices.add(diff.index);
        break;
      }
    }
  }
  const isTransitionStart = (diff: FrameDiff): boolean => {
    if (diff.diffRate > options.highThreshold) return true;
    const area = rectArea(diff.changedBBox);
    const mediumLocalChange =
      diff.diffRate > options.lowThreshold &&
      area >= mediumStartAreaRatio &&
      area <= stallAreaRatio;
    const microInputChange = microStartIndices.has(diff.index);
    return mediumLocalChange || microInputChange;
  };
  let state: "stable" | "transition" | "stalled" = "stable";
  let transitionStart = 0;
  let bbox: NormalizedRect | null = null;
  let calmRun = 0;
  let transitionDiffs: FrameDiff[] = [];
  let stallWindow: FrameDiff[] = [];
  let stallCandidateStart: number | null = null;
  let stalledStart = 0;
  let stalledRegion: NormalizedRect | null = null;
  let stalledBBox: NormalizedRect | null = null;
  let stalledCalmRun = 0;
  // stall領域外の中間diffを蓄積し、stableFrames回連続でwaitingをエスケープする（P2-1）
  let stalledEscapeDiffs: FrameDiff[] = [];

  for (const diff of diffs) {
    if (state === "stable") {
      if (isTransitionStart(diff)) {
        state = "transition";
        transitionStart = diff.index;
        bbox = diff.changedBBox;
        calmRun = 0;
        transitionDiffs = [diff];
        stallWindow = [diff];
        stallCandidateStart = null;
      }
      continue;
    }

    if (state === "stalled") {
      // (1) calm: 安定化方向
      if (diff.diffRate < options.lowThreshold) {
        stalledCalmRun += 1;
        stalledEscapeDiffs = []; // calm時はエスケープrun をリセット
        if (stalledCalmRun >= options.stableFrames) {
          transitions.push({
            startIndex: stalledStart,
            stabilizedIndex: diff.index - options.stableFrames + 1,
            changedBBox: stalledBBox,
            activity: "waiting",
          });
          state = "stable";
          stalledRegion = null;
          stalledBBox = null;
        }
        continue;
      }

      stalledCalmRun = 0;
      // (2) stall領域内の変化
      const insideStallRegion =
        stalledRegion !== null &&
        diff.changedBBox !== null &&
        rectContains(stalledRegion, diff.changedBBox);
      if (insideStallRegion) {
        stalledBBox = unionBBox(stalledBBox, diff.changedBBox);
        stalledEscapeDiffs = []; // stall領域内ならエスケープrun をリセット
        continue;
      }
      // (3) isTransitionStart: 明確な遷移開始でwaitingをクローズ
      if (isTransitionStart(diff)) {
        transitions.push({
          startIndex: stalledStart,
          stabilizedIndex: diff.index,
          changedBBox: stalledBBox,
          activity: "waiting",
        });
        state = "transition";
        transitionStart = diff.index;
        bbox = diff.changedBBox;
        calmRun = 0;
        transitionDiffs = [diff];
        stallWindow = [diff];
        stallCandidateStart = null;
        stalledEscapeDiffs = []; // 遷移移行時もリセット
        continue;
      }
      // (4) 中間diff: stall領域外かつisTransitionStart未満の変化
      // stableFrames回連続したらwaitingをクローズして遷移再開する
      // （stableFramesは「状態遷移を確定させる連続フレーム数」として流用する）
      stalledEscapeDiffs.push(diff);
      if (stalledEscapeDiffs.length >= options.stableFrames) {
        transitions.push({
          startIndex: stalledStart,
          stabilizedIndex: stalledEscapeDiffs[0].index, // エスケープrun先頭でwaitingをクローズ
          changedBBox: stalledBBox,
          activity: "waiting",
        });
        state = "transition";
        transitionStart = stalledEscapeDiffs[0].index;
        bbox = stalledEscapeDiffs.reduce<NormalizedRect | null>(
          (acc, d) => unionBBox(acc, d.changedBBox),
          null
        );
        calmRun = 0;
        transitionDiffs = [...stalledEscapeDiffs];
        stallWindow = [...stalledEscapeDiffs];
        stallCandidateStart = null;
        stalledRegion = null;
        stalledBBox = null;
        stalledEscapeDiffs = [];
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
          activity: "action",
        });
        state = "stable";
        bbox = null;
      }
    } else {
      calmRun = 0;
      transitionDiffs.push(diff);
      stallWindow.push(diff);
      if (stallWindow.length > stallWindowFrames) {
        stallWindow.shift();
      }

      const windowBBox = recentUnionBBox(stallWindow);
      const smallStallWindow =
        stallWindow.length >= stallWindowFrames &&
        windowBBox !== null &&
        rectArea(windowBBox) <= stallAreaRatio;
      if (smallStallWindow) {
        const windowStart = Math.max(stallWindow[0].index, transitionStart + 1);
        stallCandidateStart = stallCandidateStart ?? windowStart;
        const stalledForMs = (diff.index - stallCandidateStart) * frameMs;
        if (stalledForMs >= stallAfterMs) {
          const actionBBox = bboxFromDiffs(
            transitionDiffs,
            transitionStart,
            stallCandidateStart - 1
          );
          const hasPreStallAction =
            actionBBox !== null &&
            rectArea(actionBBox) > preStallActionAreaRatio;
          if (stallCandidateStart > transitionStart && hasPreStallAction) {
            // pre-stall actionあり: actionセグメントをpushしてstalled状態へ
            transitions.push({
              startIndex: transitionStart,
              stabilizedIndex: stallCandidateStart,
              changedBBox: actionBBox,
              activity: "action",
            });
            stalledStart = stallCandidateStart;
            stalledBBox = bboxFromDiffs(
              transitionDiffs,
              stallCandidateStart,
              diff.index
            );
            stalledRegion =
              stalledBBox !== null
                ? padRect(stalledBBox, coalesceBBoxPadRatio)
                : windowBBox;
            stalledCalmRun = 0;
            state = "stalled";
            bbox = null;
            transitionDiffs = [];
            stallWindow = [];
            stallCandidateStart = null;
            stalledEscapeDiffs = [];
            continue;
          } else {
            // pre-stall actionなし（スピナーのみ等）: 遷移全体をwaitingとしてstalled状態へ
            stalledStart = transitionStart;
            stalledBBox = bboxFromDiffs(
              transitionDiffs,
              transitionStart,
              diff.index
            );
            stalledRegion =
              stalledBBox !== null
                ? padRect(stalledBBox, coalesceBBoxPadRatio)
                : windowBBox;
            stalledCalmRun = 0;
            state = "stalled";
            bbox = null;
            transitionDiffs = [];
            stallWindow = [];
            stallCandidateStart = null;
            stalledEscapeDiffs = [];
            continue;
          }
        }
      } else {
        stallCandidateStart = null;
      }
      bbox = unionBBox(bbox, diff.changedBBox);
    }
  }

  if (state === "transition") {
    transitions.push({
      startIndex: transitionStart,
      stabilizedIndex: frameCount - 1,
      changedBBox: bbox,
      activity: "action",
    });
  } else if (state === "stalled") {
    transitions.push({
      startIndex: stalledStart,
      stabilizedIndex: frameCount - 1,
      changedBBox: stalledBBox,
      activity: "waiting",
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
  options: Pick<
    SegmentationOptions,
    "fps" | "coalesceMaxGapMs" | "coalesceBBoxPadRatio"
  >
): Array<RawTransition & { coalescedFrom: number }> {
  const result: Array<RawTransition & { coalescedFrom: number }> = [];
  const frameMs = 1000 / options.fps;

  for (const transition of transitions) {
    const last = result[result.length - 1];
    if (last) {
      const gapMs = (transition.startIndex - last.stabilizedIndex) * frameMs;
      const bothHaveBBox =
        last.changedBBox !== null && transition.changedBBox !== null;
      const sameActivity =
        (last.activity ?? "action") === (transition.activity ?? "action");
      const nearby =
        bothHaveBBox &&
        rectsIntersect(
          padRect(
            last.changedBBox as NormalizedRect,
            options.coalesceBBoxPadRatio
          ),
          padRect(
            transition.changedBBox as NormalizedRect,
            options.coalesceBBoxPadRatio
          )
        );
      if (sameActivity && gapMs < options.coalesceMaxGapMs && nearby) {
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

function rectIoU(a: NormalizedRect, b: NormalizedRect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = rectArea(a) + rectArea(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * detectTransitions の stall 検出とは独立した第二のヒューリスティック（セグメント単位の反復小領域 run の検出）。
 * stall 起源で既に activity="waiting" のセグメントも再走査対象に含める。
 * 理由:
 *   (1) markRun は waiting を付与するのみで action へ格下げしないため安全。
 *   (2) stall 起源 waiting の前後にある小領域 action セグメントを同一 run として束ねて
 *       waiting に分類できるようにするため。
 */
export function classifyWaitingRuns(
  segments: OperationSegment[],
  options: Partial<
    Pick<SegmentationOptions, "waitingRunAreaRatio" | "waitingRunMinSpanMs">
  > = {}
): OperationSegment[] {
  const waitingRunAreaRatio =
    options.waitingRunAreaRatio ??
    DEFAULT_SEGMENTATION_OPTIONS.waitingRunAreaRatio;
  const waitingRunMinSpanMs =
    options.waitingRunMinSpanMs ??
    DEFAULT_SEGMENTATION_OPTIONS.waitingRunMinSpanMs;
  const result = segments.map(segment => ({
    ...segment,
    activity: segment.activity ?? "action",
  }));
  let runStart = 0;

  function isSmall(segment: OperationSegment): boolean {
    return (
      segment.changedBBox !== null &&
      rectArea(segment.changedBBox) <= waitingRunAreaRatio
    );
  }

  function markRun(endExclusive: number): void {
    const runLength = endExclusive - runStart;
    if (runLength < 3) return;
    const spanMs = result[endExclusive - 1].tEndMs - result[runStart].tStartMs;
    if (spanMs < waitingRunMinSpanMs) return;
    for (let i = runStart; i < endExclusive; i++) {
      result[i] = { ...result[i], activity: "waiting" };
    }
  }

  for (let i = 0; i < result.length; i++) {
    const current = result[i];
    if (!isSmall(current)) {
      markRun(i);
      runStart = i + 1;
      continue;
    }

    if (i > runStart) {
      const previous = result[i - 1];
      const adjacent =
        previous.changedBBox !== null &&
        current.changedBBox !== null &&
        rectIoU(previous.changedBBox, current.changedBBox) >= 0.4;
      if (!adjacent) {
        markRun(i);
        runStart = i;
      }
    }
  }
  markRun(result.length);

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
  options: Partial<SegmentationOptions> & { pixelThreshold?: number } = {}
): OperationSegment[] {
  const opts: SegmentationOptions = {
    ...DEFAULT_SEGMENTATION_OPTIONS,
    ...options,
  };
  if (opts.lowThreshold >= opts.highThreshold) {
    throw new Error("lowThreshold は highThreshold より小さい必要があります");
  }
  const frameMs = 1000 / opts.fps;

  const diffs = computeDiffTimeline(
    frames,
    width,
    height,
    options.pixelThreshold ?? 24
  );
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
      activity: transition.activity ?? "action",
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
      activity: "action",
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

  return classifyWaitingRuns(segments, opts);
}

/**
 * 全画面dHash（9x8ダウンサンプル→64bit）。
 * 比較実験用に残す: 一次信号としては微小変化を無視するため不適
 * （signalComparison.test.ts で実証）。
 */
export function computeFullFrameDHash(
  pixels: Buffer,
  width: number,
  height: number
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
