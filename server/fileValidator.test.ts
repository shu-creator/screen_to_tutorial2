import { describe, it, expect } from "vitest";
import {
  validateVideoFile,
  getExtensionFromMimeType,
  sanitizeFilename,
} from "./fileValidator";

describe("fileValidator", () => {
  describe("validateVideoFile", () => {
    it("有効なMP4ファイルを検証できる", () => {
      // MP4 ftyp box signature
      const mp4Buffer = Buffer.alloc(32);
      mp4Buffer.write("ftyp", 4);

      const result = validateVideoFile(mp4Buffer);
      expect(result.valid).toBe(true);
      expect(result.detectedType).toBe("video/mp4");
    });

    it("有効なAVIファイルを検証できる", () => {
      // AVI: RIFF....AVI
      const aviBuffer = Buffer.alloc(32);
      aviBuffer.write("RIFF", 0);
      aviBuffer.write("AVI ", 8);

      const result = validateVideoFile(aviBuffer);
      expect(result.valid).toBe(true);
      expect(result.detectedType).toBe("video/x-msvideo");
    });

    it("RIFFだがAVIマーカーがないファイルを拒否する", () => {
      // RIFF but not AVI (e.g., WAV file)
      const wavBuffer = Buffer.alloc(32);
      wavBuffer.write("RIFF", 0);
      wavBuffer.write("WAVE", 8);

      const result = validateVideoFile(wavBuffer);
      expect(result.valid).toBe(false);
    });

    it("有効なWebMファイルを検証できる", () => {
      // WebM EBML header
      const webmBuffer = Buffer.alloc(32);
      webmBuffer[0] = 0x1a;
      webmBuffer[1] = 0x45;
      webmBuffer[2] = 0xdf;
      webmBuffer[3] = 0xa3;

      const result = validateVideoFile(webmBuffer);
      expect(result.valid).toBe(true);
      expect(result.detectedType).toBe("video/webm");
    });

    it("有効なMKVファイルを検証できる", () => {
      // MKV also uses EBML header (same as WebM)
      const mkvBuffer = Buffer.alloc(32);
      mkvBuffer[0] = 0x1a;
      mkvBuffer[1] = 0x45;
      mkvBuffer[2] = 0xdf;
      mkvBuffer[3] = 0xa3;

      const result = validateVideoFile(mkvBuffer);
      // WebM and MKV share the same signature
      expect(result.valid).toBe(true);
    });

    it("小さすぎるファイルを拒否する", () => {
      const tooSmall = Buffer.alloc(8);
      const result = validateVideoFile(tooSmall);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("小さすぎます");
    });

    it("不明なフォーマットを拒否する", () => {
      const unknownFormat = Buffer.alloc(32);
      unknownFormat.fill(0x00);

      const result = validateVideoFile(unknownFormat);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("有効な動画ファイルではありません");
    });

    it("PNGファイルを動画として拒否する", () => {
      // PNG signature
      const pngBuffer = Buffer.alloc(32);
      pngBuffer[0] = 0x89;
      pngBuffer[1] = 0x50; // P
      pngBuffer[2] = 0x4e; // N
      pngBuffer[3] = 0x47; // G

      const result = validateVideoFile(pngBuffer);
      expect(result.valid).toBe(false);
    });
  });

  describe("getExtensionFromMimeType", () => {
    it("video/mp4から拡張子mp4を取得する", () => {
      expect(getExtensionFromMimeType("video/mp4")).toBe("mp4");
    });

    it("video/quicktimeから拡張子movを取得する", () => {
      expect(getExtensionFromMimeType("video/quicktime")).toBe("mov");
    });

    it("video/x-msvideoから拡張子aviを取得する", () => {
      expect(getExtensionFromMimeType("video/x-msvideo")).toBe("avi");
    });

    it("video/webmから拡張子webmを取得する", () => {
      expect(getExtensionFromMimeType("video/webm")).toBe("webm");
    });

    it("video/x-matroskaから拡張子mkvを取得する", () => {
      expect(getExtensionFromMimeType("video/x-matroska")).toBe("mkv");
    });

    it("未知のMIMEタイプはmp4を返す", () => {
      expect(getExtensionFromMimeType("video/unknown")).toBe("mp4");
    });
  });

  describe("sanitizeFilename", () => {
    it("通常のファイル名はそのまま返す", () => {
      expect(sanitizeFilename("video.mp4")).toBe("video.mp4");
    });

    it("パス区切り文字を置換する", () => {
      expect(sanitizeFilename("path/to/video.mp4")).toBe("path_to_video.mp4");
      expect(sanitizeFilename("path\\to\\video.mp4")).toBe("path_to_video.mp4");
    });

    it("ディレクトリトラバーサルを防ぐ", () => {
      expect(sanitizeFilename("../../../etc/passwd")).toBe("______etc_passwd");
      expect(sanitizeFilename("..\\..\\..\\windows\\system32")).toBe(
        "______windows_system32"
      );
    });

    it("nullバイトを除去する", () => {
      expect(sanitizeFilename("video\0.mp4")).toBe("video.mp4");
    });

    it("長すぎるファイル名を切り詰める", () => {
      const longName = "a".repeat(300) + ".mp4";
      const result = sanitizeFilename(longName);
      expect(result.length).toBeLessThanOrEqual(255);
      expect(result.endsWith(".mp4")).toBe(true);
    });

    it("空のファイル名をデフォルト値に置換する", () => {
      expect(sanitizeFilename("")).toBe("video.mp4");
    });

    it("ドットのみのファイル名をデフォルト値に置換する", () => {
      expect(sanitizeFilename(".")).toBe("video.mp4");
    });
  });
});
