/**
 * スライドテキスト整形ユーティリティ
 *
 * PPTXスライド生成時にテキストを整形する純粋関数群。
 * - ホワイトスペース正規化
 * - 文境界を優先したトリム
 * - 文末補完
 * - UI由来ステップ番号の匿名化
 * - 重複タイトルのユニーク化
 * - 最終ステップの安全な補正
 */

// ---------------------------------------------------------------------------
// 0) ホワイトスペース正規化
// ---------------------------------------------------------------------------

/**
 * 連続する空白（全角スペース含む）を半角スペース1つに正規化し、
 * 前後の空白を除去する。
 */
export function normalizeWhitespace(text: string): string {
  if (!text) return "";
  return text.replace(/[\s\u3000]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 1) 文境界を優先したトリム
// ---------------------------------------------------------------------------

/** 文末を構成する句読点の集合 */
const SENTENCE_TERMINATORS = ["。", "！", "？", ".", "!", "?"] as const;

/**
 * maxChars 以内で文が途切れないようにトリムする。
 * - maxChars 以内ならそのまま返す
 * - 超える場合は maxChars 以内で最後に出現する句点位置で切る
 * - 句点が見つからない場合のみ文字数切り + "…"
 * - 切った場合は末尾に "…" を付与
 */
export function truncateAtSentence(text: string, maxChars: number): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;

  // maxChars 以内の部分文字列を取得
  const sub = text.substring(0, maxChars);

  // 句点で最も後ろにある位置を探す
  let lastTerminatorIdx = -1;
  for (const t of SENTENCE_TERMINATORS) {
    const idx = sub.lastIndexOf(t);
    if (idx > lastTerminatorIdx) {
      lastTerminatorIdx = idx;
    }
  }

  if (lastTerminatorIdx >= 0) {
    // 句点の直後で切る（句点自体は含める）
    return text.substring(0, lastTerminatorIdx + 1) + "…";
  }

  // 句点が無い場合は単純な文字数切り
  return text.substring(0, maxChars - 1) + "…";
}

// ---------------------------------------------------------------------------
// 2) 文末補完
// ---------------------------------------------------------------------------

/** 文末として許容する文字 */
const ACCEPTABLE_ENDINGS = ["。", "！", "？", "…", ".", "!", "?"] as const;

/**
 * テキストが句点で終わっていなければ「。」を付与する。
 */
export function ensureTerminalPunctuation(text: string): string {
  if (!text) return "";
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return "";

  const lastChar = trimmed[trimmed.length - 1];
  if ((ACCEPTABLE_ENDINGS as readonly string[]).includes(lastChar)) {
    return trimmed;
  }
  return trimmed + "。";
}

// ---------------------------------------------------------------------------
// 3) UI由来のステップ番号の匿名化
// ---------------------------------------------------------------------------

/**
 * description テキスト中の「ステップ17」「ステップ7から10」
 * 「ステップ16、17、18」等のUI由来番号を匿名化する。
 * 「ステップ一覧」（数字なし）はそのまま残す。
 */
export function anonymizeOnScreenStepNumbers(text: string): string {
  if (!text) return "";

  let result = text;

  // 「ステップN〜M」「ステップNからM」「ステップNからステップMまで」のような範囲パターン
  result = result.replace(
    /ステップ\d+\s*[〜～からーto\-]+\s*(ステップ)?\d+(まで)?/g,
    "ステップ一覧の一部",
  );

  // 「ステップN、N、N(など)」のような列挙パターン
  result = result.replace(
    /ステップ\d+([、,]\s*\d+)+(など)?/g,
    "ステップ一覧の一部",
  );

  // 単独の「ステップN」（数字のみ）
  result = result.replace(
    /ステップ\d+/g,
    "ステップ（画面上）",
  );

  return result;
}

// ---------------------------------------------------------------------------
// 4) 重複タイトルのユニーク化
// ---------------------------------------------------------------------------

/**
 * 同一 title が複数ある場合に displayTitle を付与する。
 * 2回目 → "（続き）"、3回目以降 → "（続きN）" を付ける。
 * 返り値は入力と同じ順序で displayTitle を含む配列。
 */
export function uniquifyTitles<T extends { title: string }>(
  steps: T[],
): (T & { displayTitle: string })[] {
  const countMap = new Map<string, number>();

  return steps.map((step) => {
    const count = (countMap.get(step.title) ?? 0) + 1;
    countMap.set(step.title, count);

    let displayTitle: string;
    if (count === 1) {
      displayTitle = step.title;
    } else if (count === 2) {
      displayTitle = `${step.title}（続き）`;
    } else {
      displayTitle = `${step.title}（続き${count - 1}）`;
    }

    return { ...step, displayTitle };
  });
}

/**
 * buildDisplayTitleMap — uniquifyTitles の Map 版。
 * steps の各 id に対して displayTitle を返す。
 */
export function buildDisplayTitleMap(
  steps: Array<{ id: number; title: string }>,
): Map<number, string> {
  const countMap = new Map<string, number>();
  const result = new Map<number, string>();

  for (const step of steps) {
    const count = (countMap.get(step.title) ?? 0) + 1;
    countMap.set(step.title, count);

    let displayTitle: string;
    if (count === 1) {
      displayTitle = step.title;
    } else if (count === 2) {
      displayTitle = `${step.title}（続き）`;
    } else {
      displayTitle = `${step.title}（続き${count - 1}）`;
    }

    result.set(step.id, displayTitle);
  }

  return result;
}

// ---------------------------------------------------------------------------
// 5) 最終ステップの安全な補正
// ---------------------------------------------------------------------------

const HOVER_KEYWORDS = ["カーソル", "ホバー", "hover", "マウスを合わせ"];
const NON_HOVER_KEYWORDS = [
  "クリック",
  "押す",
  "選択",
  "入力",
  "タップ",
  "ダブルクリック",
  "実行",
];

/** 最終ステップ補正用の定型文 */
export const FINAL_STEP_FALLBACK = {
  operation: "ダウンロードした動画を再生して内容を確認する。",
  description:
    "音声・画面・手順が意図どおりか確認し、必要に応じて編集して再生成します。",
} as const;

/**
 * 最終ステップの operation がカーソル/ホバーだけで終わっている場合に
 * 完了確認の定型文へ置換する。
 *
 * @returns 補正が適用されたか (true) / そのままか (false) と、補正後の値
 */
export function fixFinalStepIfHover(
  operation: string,
  description: string,
): { operation: string; description: string; modified: boolean } {
  const opLower = operation.toLowerCase();

  const hasHover = HOVER_KEYWORDS.some((kw) =>
    opLower.includes(kw.toLowerCase()),
  );
  const hasNonHover = NON_HOVER_KEYWORDS.some((kw) =>
    opLower.includes(kw.toLowerCase()),
  );

  if (hasHover && !hasNonHover) {
    return {
      operation: FINAL_STEP_FALLBACK.operation,
      description: FINAL_STEP_FALLBACK.description,
      modified: true,
    };
  }

  return { operation, description, modified: false };
}

/**
 * applyFinalStepCompletionFix — 最終ステップのみ fixFinalStepIfHover を適用するラッパー。
 * stepIndex === totalSteps - 1 のときだけ補正を試みる。
 */
export function applyFinalStepCompletionFix(
  step: { operation: string; description: string },
  stepIndex: number,
  totalSteps: number,
): { operation: string; description: string; modified: boolean } {
  if (stepIndex !== totalSteps - 1) {
    return {
      operation: step.operation,
      description: step.description,
      modified: false,
    };
  }
  return fixFinalStepIfHover(step.operation, step.description);
}
