import { describe, expect, it } from "vitest";
import { clampFrameTimestampMs } from "./timeline";

describe("clampFrameTimestampMs", () => {
  it("動画終端近傍のフレーム抽出時刻を安全側に丸める", () => {
    expect(clampFrameTimestampMs(72_250, 72_798)).toBe(71_798);
  });

  it("終端から十分離れた時刻は変更しない", () => {
    expect(clampFrameTimestampMs(55_000, 72_798)).toBe(55_000);
  });

  it("短い動画でも負の時刻にしない", () => {
    expect(clampFrameTimestampMs(800, 1_000)).toBe(500);
    expect(clampFrameTimestampMs(800, 1)).toBe(0);
  });

  it("duration が不明なら非負整数への丸めだけ行う", () => {
    expect(clampFrameTimestampMs(1234.6)).toBe(1235);
    expect(clampFrameTimestampMs(-10)).toBe(0);
  });
});
