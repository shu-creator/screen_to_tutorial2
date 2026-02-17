import { describe, it, expect } from "vitest";
import {
  normalizeWhitespace,
  truncateAtSentence,
  ensureTerminalPunctuation,
  anonymizeOnScreenStepNumbers,
  uniquifyTitles,
  buildDisplayTitleMap,
  fixFinalStepIfHover,
  applyFinalStepCompletionFix,
  FINAL_STEP_FALLBACK,
  estimateTextUnits,
  formatProjectionOperation,
  formatProjectionDetail,
} from "./slideText";

// ---------------------------------------------------------------------------
// 0) normalizeWhitespace
// ---------------------------------------------------------------------------
describe("normalizeWhitespace", () => {
  it("空文字列は空文字列を返す", () => {
    expect(normalizeWhitespace("")).toBe("");
  });

  it("連続する半角スペースを1つにまとめる", () => {
    expect(normalizeWhitespace("a   b")).toBe("a b");
  });

  it("全角スペースを半角スペース1つに正規化する", () => {
    expect(normalizeWhitespace("a\u3000b")).toBe("a b");
  });

  it("前後の空白を除去する", () => {
    expect(normalizeWhitespace("  テキスト  ")).toBe("テキスト");
  });

  it("タブ・改行も正規化する", () => {
    expect(normalizeWhitespace("a\t\nb")).toBe("a b");
  });
});

// ---------------------------------------------------------------------------
// 1) truncateAtSentence
// ---------------------------------------------------------------------------
describe("truncateAtSentence", () => {
  it("maxChars 以内のテキストはそのまま返す", () => {
    expect(truncateAtSentence("短いテキスト。", 20)).toBe("短いテキスト。");
  });

  it("空文字列は空文字列を返す", () => {
    expect(truncateAtSentence("", 10)).toBe("");
  });

  it("句点位置で切れる（文が途中で切れない）", () => {
    const text = "最初の文。次の文。さらに長い三番目の文が続きます。";
    // maxChars=12 → "最初の文。次の文。さらに" の中で最後の「。」は index 8
    const result = truncateAtSentence(text, 12);
    expect(result).toBe("最初の文。次の文。…");
    expect(result.endsWith("…")).toBe(true);
  });

  it("半角句点 '.' でも切れる", () => {
    const text = "Hello world. This is a longer sentence that overflows.";
    const result = truncateAtSentence(text, 20);
    expect(result).toBe("Hello world.…");
  });

  it("句点が見つからない場合は文字数切り + '…'", () => {
    const text = "句点のないとても長いテキストが延々と続いていく";
    const result = truncateAtSentence(text, 10);
    expect(result).toBe("句点のないとても長…");
    expect(result.length).toBe(10); // (maxChars-1)文字 + "…"
  });

  it("ちょうど maxChars のテキストは切らない", () => {
    const text = "ぴったり10文字のテキスト";
    expect(truncateAtSentence(text, text.length)).toBe(text);
  });

  it("全角感嘆符・疑問符でも切れる", () => {
    const text = "本当ですか？それは驚きです！そしてさらに続く長い文章。";
    const result = truncateAtSentence(text, 15);
    // "本当ですか？それは驚きです！そし" → 最後の終端は index 13 の "！"
    expect(result).toBe("本当ですか？それは驚きです！…");
  });
});

// ---------------------------------------------------------------------------
// 2) ensureTerminalPunctuation
// ---------------------------------------------------------------------------
describe("ensureTerminalPunctuation", () => {
  it("空文字列は空文字列を返す", () => {
    expect(ensureTerminalPunctuation("")).toBe("");
  });

  it("末尾が句点で終わっていればそのまま", () => {
    expect(ensureTerminalPunctuation("確認する。")).toBe("確認する。");
  });

  it("末尾に句点がなければ '。' を付与する", () => {
    expect(ensureTerminalPunctuation("確認する")).toBe("確認する。");
  });

  it("末尾が '…' で終わっていればそのまま", () => {
    expect(ensureTerminalPunctuation("テキスト…")).toBe("テキスト…");
  });

  it("末尾が '！' で終わっていればそのまま", () => {
    expect(ensureTerminalPunctuation("完了！")).toBe("完了！");
  });

  it("末尾が '？' で終わっていればそのまま", () => {
    expect(ensureTerminalPunctuation("本当？")).toBe("本当？");
  });

  it("末尾の空白を無視して判定する", () => {
    expect(ensureTerminalPunctuation("確認する   ")).toBe("確認する。");
  });

  it("半角ピリオドで終わっていればそのまま", () => {
    expect(ensureTerminalPunctuation("Done.")).toBe("Done.");
  });
});

// ---------------------------------------------------------------------------
// 3) anonymizeOnScreenStepNumbers
// ---------------------------------------------------------------------------
describe("anonymizeOnScreenStepNumbers", () => {
  it("空文字列は空文字列を返す", () => {
    expect(anonymizeOnScreenStepNumbers("")).toBe("");
  });

  it("'ステップ17' が匿名化される", () => {
    const result = anonymizeOnScreenStepNumbers("ステップ17を確認する");
    expect(result).toBe("ステップ（画面上）を確認する");
    expect(result).not.toMatch(/ステップ\d/);
  });

  it("'ステップ17からステップ21' が匿名化される", () => {
    const result = anonymizeOnScreenStepNumbers(
      "ステップ17からステップ21を実行する",
    );
    expect(result).toBe("ステップ一覧の一部を実行する");
    expect(result).not.toMatch(/\d/);
  });

  it("'ステップ7から10' が匿名化される", () => {
    const result = anonymizeOnScreenStepNumbers("ステップ7から10を参照");
    expect(result).toBe("ステップ一覧の一部を参照");
  });

  it("'ステップ7〜10' が匿名化される", () => {
    const result = anonymizeOnScreenStepNumbers("ステップ7〜10を参照");
    expect(result).toBe("ステップ一覧の一部を参照");
  });

  it("'ステップ16、17、18' が匿名化される", () => {
    const result = anonymizeOnScreenStepNumbers(
      "ステップ16、17、18を参照してください",
    );
    expect(result).toBe("ステップ一覧の一部を参照してください");
  });

  it("'ステップ16、17、18など' が匿名化される", () => {
    const result = anonymizeOnScreenStepNumbers(
      "ステップ16、17、18などを参照",
    );
    expect(result).toBe("ステップ一覧の一部を参照");
  });

  it("'ステップ一覧' (数字なし) は変更しない", () => {
    const text = "ステップ一覧を確認してください";
    expect(anonymizeOnScreenStepNumbers(text)).toBe(text);
  });

  it("数字を含まない 'ステップ' は変更しない", () => {
    const text = "次のステップに進む";
    expect(anonymizeOnScreenStepNumbers(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// 4) uniquifyTitles
// ---------------------------------------------------------------------------
describe("uniquifyTitles", () => {
  it("重複がなければ displayTitle は元のタイトルのまま", () => {
    const steps = [
      { title: "ログイン" },
      { title: "設定変更" },
      { title: "保存" },
    ];
    const result = uniquifyTitles(steps);
    expect(result[0].displayTitle).toBe("ログイン");
    expect(result[1].displayTitle).toBe("設定変更");
    expect(result[2].displayTitle).toBe("保存");
  });

  it("同一タイトルが2回目で '（続き）' が付く", () => {
    const steps = [
      { title: "設定変更" },
      { title: "設定変更" },
    ];
    const result = uniquifyTitles(steps);
    expect(result[0].displayTitle).toBe("設定変更");
    expect(result[1].displayTitle).toBe("設定変更（続き）");
  });

  it("同一タイトルが3回以上で '（続きN）' が付く", () => {
    const steps = [
      { title: "入力" },
      { title: "入力" },
      { title: "入力" },
      { title: "入力" },
    ];
    const result = uniquifyTitles(steps);
    expect(result[0].displayTitle).toBe("入力");
    expect(result[1].displayTitle).toBe("入力（続き）");
    expect(result[2].displayTitle).toBe("入力（続き2）");
    expect(result[3].displayTitle).toBe("入力（続き3）");
  });

  it("元のプロパティが保持される", () => {
    const steps = [{ title: "A", sortOrder: 0, extra: 42 }];
    const result = uniquifyTitles(steps);
    expect(result[0].sortOrder).toBe(0);
    expect((result[0] as any).extra).toBe(42);
    expect(result[0].displayTitle).toBe("A");
  });

  it("空配列は空配列を返す", () => {
    expect(uniquifyTitles([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4b) buildDisplayTitleMap
// ---------------------------------------------------------------------------
describe("buildDisplayTitleMap", () => {
  it("重複がなければそのままのタイトルが返る", () => {
    const steps = [
      { id: 1, title: "ログイン" },
      { id: 2, title: "設定変更" },
    ];
    const map = buildDisplayTitleMap(steps);
    expect(map.get(1)).toBe("ログイン");
    expect(map.get(2)).toBe("設定変更");
  });

  it("同一タイトル2回目に '（続き）' が付く", () => {
    const steps = [
      { id: 10, title: "設定変更" },
      { id: 20, title: "設定変更" },
    ];
    const map = buildDisplayTitleMap(steps);
    expect(map.get(10)).toBe("設定変更");
    expect(map.get(20)).toBe("設定変更（続き）");
  });

  it("3回以上で '（続き2）' '（続き3）' が付く", () => {
    const steps = [
      { id: 1, title: "入力" },
      { id: 2, title: "入力" },
      { id: 3, title: "入力" },
      { id: 4, title: "入力" },
    ];
    const map = buildDisplayTitleMap(steps);
    expect(map.get(1)).toBe("入力");
    expect(map.get(2)).toBe("入力（続き）");
    expect(map.get(3)).toBe("入力（続き2）");
    expect(map.get(4)).toBe("入力（続き3）");
  });

  it("空配列は空の Map を返す", () => {
    const map = buildDisplayTitleMap([]);
    expect(map.size).toBe(0);
  });

  it("異なるタイトルが混在する場合も正しくカウントする", () => {
    const steps = [
      { id: 1, title: "A" },
      { id: 2, title: "B" },
      { id: 3, title: "A" },
      { id: 4, title: "B" },
      { id: 5, title: "A" },
    ];
    const map = buildDisplayTitleMap(steps);
    expect(map.get(1)).toBe("A");
    expect(map.get(2)).toBe("B");
    expect(map.get(3)).toBe("A（続き）");
    expect(map.get(4)).toBe("B（続き）");
    expect(map.get(5)).toBe("A（続き2）");
  });
});

// ---------------------------------------------------------------------------
// 5) fixFinalStepIfHover
// ---------------------------------------------------------------------------
describe("fixFinalStepIfHover", () => {
  it("カーソル操作のみの場合は補正される", () => {
    const result = fixFinalStepIfHover(
      "カーソルを合わせる",
      "要素にカーソルを合わせます",
    );
    expect(result.modified).toBe(true);
    expect(result.operation).toContain("確認する");
    expect(result.description).toContain("意図どおりか確認");
  });

  it("ホバー操作のみの場合は補正される", () => {
    const result = fixFinalStepIfHover(
      "ボタンにホバーする",
      "ボタン上にマウスを置く",
    );
    expect(result.modified).toBe(true);
  });

  it("英語の hover を含む場合も補正される", () => {
    const result = fixFinalStepIfHover(
      "hover over the button",
      "hover on element",
    );
    expect(result.modified).toBe(true);
  });

  it("マウスを合わせる操作のみの場合は補正される", () => {
    const result = fixFinalStepIfHover(
      "要素にマウスを合わせる",
      "マウスオーバーする",
    );
    expect(result.modified).toBe(true);
  });

  it("クリックを含む場合は補正されない", () => {
    const result = fixFinalStepIfHover(
      "カーソルを合わせてクリックする",
      "ボタンをクリック",
    );
    expect(result.modified).toBe(false);
    expect(result.operation).toBe("カーソルを合わせてクリックする");
  });

  it("カーソル/ホバーを含まない通常操作は補正されない", () => {
    const result = fixFinalStepIfHover(
      "保存ボタンを押す",
      "変更を保存します",
    );
    expect(result.modified).toBe(false);
    expect(result.operation).toBe("保存ボタンを押す");
  });

  it("選択操作を含む場合は補正されない", () => {
    const result = fixFinalStepIfHover(
      "カーソルで選択する",
      "テキストを選択",
    );
    expect(result.modified).toBe(false);
  });

  it("実行を含む場合は補正されない", () => {
    const result = fixFinalStepIfHover(
      "カーソルを合わせて実行する",
      "コマンドを実行",
    );
    expect(result.modified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5b) applyFinalStepCompletionFix
// ---------------------------------------------------------------------------
describe("applyFinalStepCompletionFix", () => {
  it("最終ステップのhover系のみ置換する", () => {
    const step = { operation: "カーソルを合わせる", description: "要素にホバー" };
    const result = applyFinalStepCompletionFix(step, 4, 5);
    expect(result.modified).toBe(true);
    expect(result.operation).toBe(FINAL_STEP_FALLBACK.operation);
    expect(result.description).toBe(FINAL_STEP_FALLBACK.description);
  });

  it("最終ステップでもクリック系は置換しない", () => {
    const step = { operation: "ボタンをクリックする", description: "保存する" };
    const result = applyFinalStepCompletionFix(step, 4, 5);
    expect(result.modified).toBe(false);
    expect(result.operation).toBe("ボタンをクリックする");
  });

  it("最終ステップでないhover系は置換しない", () => {
    const step = { operation: "カーソルを合わせる", description: "要素にホバー" };
    const result = applyFinalStepCompletionFix(step, 2, 5);
    expect(result.modified).toBe(false);
    expect(result.operation).toBe("カーソルを合わせる");
  });

  it("1ステップのみの場合 (index=0, total=1) でも最終ステップとして判定する", () => {
    const step = { operation: "ホバーする", description: "マウスオーバー" };
    const result = applyFinalStepCompletionFix(step, 0, 1);
    expect(result.modified).toBe(true);
  });

  it("最終ステップで通常操作の場合は置換しない", () => {
    const step = { operation: "保存ボタンを押す", description: "変更を保存" };
    const result = applyFinalStepCompletionFix(step, 9, 10);
    expect(result.modified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6) FINAL_STEP_FALLBACK
// ---------------------------------------------------------------------------
describe("FINAL_STEP_FALLBACK", () => {
  it("operation と description が定義されている", () => {
    expect(FINAL_STEP_FALLBACK.operation).toBeDefined();
    expect(FINAL_STEP_FALLBACK.description).toBeDefined();
    expect(typeof FINAL_STEP_FALLBACK.operation).toBe("string");
    expect(typeof FINAL_STEP_FALLBACK.description).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 統合テスト: パイプライン適用順序
// ---------------------------------------------------------------------------
describe("テキスト整形パイプライン", () => {
  it("ensureTerminalPunctuation → truncateAtSentence の順で操作テキストを整形", () => {
    const raw = "ボタンをクリックする";
    const withPunct = ensureTerminalPunctuation(raw); // "ボタンをクリックする。"
    const result = truncateAtSentence(withPunct, 60);
    expect(result).toBe("ボタンをクリックする。");
  });

  it("anonymize → ensureTerminalPunctuation → truncateAtSentence の順で詳細テキストを整形", () => {
    const raw =
      "ステップ17からステップ21を確認し、設定を変更する";
    const anonymized = anonymizeOnScreenStepNumbers(raw);
    expect(anonymized).not.toMatch(/\d/);
    const withPunct = ensureTerminalPunctuation(anonymized);
    expect(withPunct.endsWith("。")).toBe(true);
    const result = truncateAtSentence(withPunct, 120);
    expect(result.endsWith("。")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7) 投影プリセット向けテキスト整形
// ---------------------------------------------------------------------------
describe("estimateTextUnits", () => {
  it("半角文字は全角文字より小さい単位で計算される", () => {
    const asciiUnits = estimateTextUnits("ABCD");
    const jpUnits = estimateTextUnits("あいうえ");
    expect(asciiUnits).toBeLessThan(jpUnits);
  });
});

describe("formatProjectionOperation", () => {
  it("行数上限を守り、超過時は省略記号を付ける", () => {
    const formatted = formatProjectionOperation(
      "この操作はとても長く、投影資料では2行に収める必要があります。さらに説明が続きます。",
      { maxUnitsPerLine: 14, maxLines: 2 },
    );
    expect(formatted.lineCount).toBeLessThanOrEqual(2);
    expect(formatted.truncated).toBe(true);
    expect(formatted.text.endsWith("…")).toBe(true);
    expect(formatted.overflow.length).toBeGreaterThan(0);
  });
});

describe("formatProjectionDetail", () => {
  it("結果/注意/次 の順で箇条書き化する", () => {
    const formatted = formatProjectionDetail(
      "ログアウト画面を表示する",
      "正常にログアウトされましたと表示されます。共有PCでは必ずログアウトを確認してください。続ける場合は再ログインします。",
      { maxUnitsPerLine: 26, maxLines: 4 },
    );
    expect(formatted.text).toContain("・結果:");
    expect(formatted.text).toContain("・注意:");
    expect(formatted.text).toContain("・次:");
    expect(formatted.lineCount).toBeLessThanOrEqual(4);
  });

  it("行数超過時は overflow に退避する", () => {
    const formatted = formatProjectionDetail(
      "設定を開く",
      "結果を確認します。注意点を確認します。次の操作に進みます。追加の長い説明が続きます。",
      { maxUnitsPerLine: 12, maxLines: 2 },
    );
    expect(formatted.truncated).toBe(true);
    expect(formatted.overflow.length).toBeGreaterThan(0);
    expect(formatted.lineCount).toBeLessThanOrEqual(2);
  });
});
