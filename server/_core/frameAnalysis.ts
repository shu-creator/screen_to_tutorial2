import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface ChangedRegionOptions {
  minWidthRatio?: number;
  minHeightRatio?: number;
  skipNearFullFrameRatio?: number;
  cropThreshold?: number;
}

export interface DedupeFrameCandidate {
  filename: string;
  timestamp: number;
  frameNumber: number;
  diffScore: number;
}

export interface DedupeFrameResult extends DedupeFrameCandidate {
  changedRegionBBox: NormalizedRect | null;
  dHash: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export async function getImageDimensions(
  imagePath: string,
): Promise<ImageDimensions> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "quiet",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      imagePath,
    ],
    { timeout: 10_000 },
  );

  const [widthRaw, heightRaw] = stdout.trim().split(",");
  const width = Number(widthRaw);
  const height = Number(heightRaw);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1920, height: 1080 };
  }
  return { width, height };
}

function createTempPath(prefix: string, ext: string): string {
  return `/tmp/${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
}

export async function detectChangedRegion(
  prevImagePath: string,
  currImagePath: string,
  options: ChangedRegionOptions = {},
): Promise<NormalizedRect | null> {
  const diffPath = createTempPath("frame_diff", ".png");
  const minWidthRatio = options.minWidthRatio ?? 0.01;
  const minHeightRatio = options.minHeightRatio ?? 0.01;
  const skipNearFullFrameRatio = options.skipNearFullFrameRatio ?? 0.95;
  const cropThreshold = options.cropThreshold ?? 24;

  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        prevImagePath,
        "-i",
        currImagePath,
        "-filter_complex",
        "[0][1]blend=all_mode=difference,format=gray",
        "-q:v",
        "2",
        diffPath,
      ],
      { timeout: 15_000 },
    );

    const dims = await getImageDimensions(diffPath);
    const { stderr } = await execFileAsync(
      "ffmpeg",
      ["-i", diffPath, "-vf", `cropdetect=${cropThreshold}:2:0`, "-f", "null", "-"],
      { timeout: 15_000 },
    );

    const cropMatches = stderr.match(/crop=(\d+):(\d+):(\d+):(\d+)/g);
    if (!cropMatches || cropMatches.length === 0) return null;

    const match = cropMatches[cropMatches.length - 1].match(
      /crop=(\d+):(\d+):(\d+):(\d+)/,
    );
    if (!match) return null;

    const cropW = Number(match[1]);
    const cropH = Number(match[2]);
    const cropX = Number(match[3]);
    const cropY = Number(match[4]);

    if (cropW >= dims.width * skipNearFullFrameRatio && cropH >= dims.height * skipNearFullFrameRatio) {
      return null;
    }
    if (cropW < dims.width * minWidthRatio || cropH < dims.height * minHeightRatio) {
      return null;
    }

    return {
      x: clamp(cropX / dims.width, 0, 1),
      y: clamp(cropY / dims.height, 0, 1),
      w: clamp(cropW / dims.width, 0, 1),
      h: clamp(cropH / dims.height, 0, 1),
    };
  } catch {
    return null;
  } finally {
    await fs.unlink(diffPath).catch(() => {});
  }
}

export async function computeImageDHash(imagePath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      imagePath,
      "-vf",
      "scale=9:8,format=gray",
      "-f",
      "rawvideo",
      "-",
    ],
    {
      timeout: 10_000,
      encoding: "buffer",
      maxBuffer: 2 * 1024 * 1024,
    },
  );

  const pixels = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  if (pixels.length < 72) {
    throw new Error(`Unexpected raw frame size for dHash: ${pixels.length}`);
  }

  let bits = "";
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = pixels[row * 9 + col];
      const right = pixels[row * 9 + col + 1];
      bits += left > right ? "1" : "0";
    }
  }
  return bits;
}

export function hammingDistance(hashA: string, hashB: string): number {
  if (hashA.length !== hashB.length) {
    return Number.MAX_SAFE_INTEGER;
  }
  let distance = 0;
  for (let i = 0; i < hashA.length; i++) {
    if (hashA[i] !== hashB[i]) {
      distance += 1;
    }
  }
  return distance;
}

export async function dedupeFramesByDHash(
  frames: DedupeFrameCandidate[],
  resolvePath: (filename: string) => string,
  options?: {
    maxHammingDistance?: number;
  },
): Promise<DedupeFrameResult[]> {
  const maxHammingDistance = options?.maxHammingDistance ?? 6;
  const kept: DedupeFrameResult[] = [];

  for (const frame of frames) {
    const imagePath = resolvePath(frame.filename);
    const hash = await computeImageDHash(imagePath);

    if (kept.length === 0) {
      kept.push({
        ...frame,
        dHash: hash,
        changedRegionBBox: null,
      });
      continue;
    }

    const prev = kept[kept.length - 1];
    const dist = hammingDistance(prev.dHash, hash);
    if (dist <= maxHammingDistance) {
      continue;
    }

    const changedRegionBBox = await detectChangedRegion(
      resolvePath(prev.filename),
      imagePath,
    );
    kept.push({
      ...frame,
      dHash: hash,
      changedRegionBBox,
    });
  }

  return kept;
}
