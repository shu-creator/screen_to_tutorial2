import { describe, expect, it } from "vitest";
import type { EvidenceSegment } from "./evidence/types";
import { selectClipSegments } from "./stepGenerator";

function makeSegment(
  id: string,
  tStart: number,
  tEnd: number,
  overrides: Partial<EvidenceSegment> = {},
): EvidenceSegment {
  return {
    segment_id: id,
    t_start: tStart,
    t_end: tEnd,
    transition_start: tStart + 100,
    before_frame: null,
    after_frame: {
      t: tEnd,
      image_key: `frames/${id}.jpg`,
      image_url: `/api/storage/frames/${id}.jpg`,
      frame_id: 100,
    },
    changed_region_bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
    ocr_lines: ["保存", "キャンセル"],
    ocr_focus: ["保存"],
    transcript_snippet: "",
    coalesced_from: 1,
    warnings: [],
    ...overrides,
  };
}

describe("selectClipSegments", () => {
  it("action と waiting が混在する場合、action のみを返す", () => {
    const segments = [
      makeSegment("seg-1", 0, 1000, { activity: "action" }),
      makeSegment("seg-2", 1000, 150000, { activity: "waiting" }),
      makeSegment("seg-3", 150000, 151000, { activity: "action" }),
    ];
    const result = selectClipSegments(segments);
    expect(result).toHaveLength(2);
    expect(result[0].segment_id).toBe("seg-1");
    expect(result[1].segment_id).toBe("seg-3");
  });

  it("全セグメントが action の場合、全て返す", () => {
    const segments = [
      makeSegment("seg-1", 0, 1000, { activity: "action" }),
      makeSegment("seg-2", 1000, 2000, { activity: "action" }),
    ];
    const result = selectClipSegments(segments);
    expect(result).toHaveLength(2);
    expect(result).toEqual(segments);
  });

  it("activity が undefined のセグメントは action として扱われる", () => {
    const segments = [
      makeSegment("seg-1", 0, 1000),
      makeSegment("seg-2", 1000, 150000, { activity: "waiting" }),
    ];
    const result = selectClipSegments(segments);
    expect(result).toHaveLength(1);
    expect(result[0].segment_id).toBe("seg-1");
  });

  it("全セグメントが waiting の場合、フォールバックとして入力をそのまま返す", () => {
    const segments = [
      makeSegment("seg-1", 0, 150000, { activity: "waiting" }),
      makeSegment("seg-2", 150000, 300000, { activity: "waiting" }),
    ];
    const result = selectClipSegments(segments);
    expect(result).toHaveLength(2);
    expect(result).toEqual(segments);
  });
});
