import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import zlib from "zlib";
import { generateSlides } from "../server/slideGenerator";
import { generateVideo } from "../server/videoGenerator";
import { isLocalStorageUrl, resolveLocalStoragePathFromUrl } from "../server/storage";
import { loadProjectStepRenderState } from "../server/stepSource";
import type { AudioMode } from "../server/videoClips";

type Options = {
  projectId?: number;
  outdir: string;
  audioMode: AudioMode;
};

const repoRoot = path.resolve(import.meta.dirname, "..");

type ZipEntry = {
  name: string;
  content: Buffer;
};

type PptxContentCheck = {
  status: "pass" | "warning";
  total_slide_count: number;
  slide_count_note: string;
  media_image_count: number;
  slides_with_images: number;
  expected_step_image_count: number | null;
  expected_step_image_count_source: "steps_artifact" | "db_steps" | "unavailable";
  notes_review_warning_count: number;
  placeholder_text_hits: string[];
  warnings: string[];
};

const SLIDE_COUNT_NOTE = "includes title, table-of-contents, step, and completion slides";

function parseArgs(argv: string[]): Options {
  const options: Options = {
    outdir: path.join(repoRoot, "outputs", "project-export"),
    audioMode: "auto",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--project-id") {
      if (!next || next.startsWith("--")) throw new Error("--project-id requires a value");
      options.projectId = Number(next);
      i += 1;
    } else if (arg === "--outdir") {
      if (!next || next.startsWith("--")) throw new Error("--outdir requires a value");
      options.outdir = path.resolve(next);
      i += 1;
    } else if (arg === "--audio-mode") {
      if (!next || next.startsWith("--")) throw new Error("--audio-mode requires a value");
      if (!["auto", "tts", "original", "mixed", "silent"].includes(next)) {
        throw new Error(`Unsupported --audio-mode: ${next}`);
      }
      options.audioMode = next as AudioMode;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.projectId) || (options.projectId ?? 0) <= 0) {
    throw new Error("--project-id <positive integer> is required");
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage:
  pnpm project:export -- --project-id <id> [--audio-mode auto|tts|original|mixed|silent] [--outdir ./outputs/project-export]

Options:
  --outdir <path>      Summary output directory. Default: outputs/project-export
  --audio-mode <mode>  Video audio mode. Default: auto
`);
}

async function localArtifact(url: string): Promise<{ url: string; path: string | null; bytes: number | null }> {
  if (!isLocalStorageUrl(url)) {
    return { url, path: null, bytes: null };
  }
  const filePath = resolveLocalStoragePathFromUrl(url);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Generated artifact is missing for URL ${url}: ${message}`);
  }
  return {
    url,
    path: path.relative(repoRoot, filePath),
    bytes: stat.size,
  };
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("PPTX zip end-of-central-directory record was not found");
}

function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error(`Invalid PPTX central directory header at ${centralOffset}`);
    }
    const method = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const filenameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localHeaderOffset = buffer.readUInt32LE(centralOffset + 42);
    const name = buffer.toString("utf8", centralOffset + 46, centralOffset + 46 + filenameLength);

    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid PPTX local file header for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let content: Buffer;
    if (method === 0) {
      content = Buffer.from(compressed);
    } else if (method === 8) {
      content = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported PPTX zip compression method ${method} for ${name}`);
    }
    entries.push({ name, content });
    centralOffset += 46 + filenameLength + extraLength + commentLength;
  }

  return entries;
}

function inspectPptxContent(
  pptxBuffer: Buffer,
  expectedStepImageCount: number | null,
  expectedStepImageCountSource: PptxContentCheck["expected_step_image_count_source"],
): PptxContentCheck {
  const entries = readZipEntries(pptxBuffer);
  const slideXmlEntries = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const notesXmlEntries = entries.filter((entry) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(entry.name));
  const mediaImageCount = entries.filter((entry) => /^ppt\/media\/.+\.(jpe?g|png|webp)$/i.test(entry.name)).length;
  const slideXmlTexts = slideXmlEntries.map((entry) => entry.content.toString("utf8"));
  const slidesWithImages = slideXmlTexts.filter((xml) => xml.includes("<p:pic")).length;
  const placeholderTextHits = slideXmlEntries
    .filter((entry) => entry.content.toString("utf8").includes("画像を読み込めませんでした"))
    .map((entry) => entry.name);
  const notesReviewWarningCount = notesXmlEntries.filter((entry) =>
    entry.content.toString("utf8").includes("【要レビュー】"),
  ).length;

  const warnings: string[] = [];
  if (expectedStepImageCount !== null) {
    if (slidesWithImages < expectedStepImageCount) {
      warnings.push(`slides_with_images ${slidesWithImages}/${expectedStepImageCount}`);
    }
    if (mediaImageCount < expectedStepImageCount) {
      warnings.push(`media_image_count ${mediaImageCount}/${expectedStepImageCount}`);
    }
  }
  if (placeholderTextHits.length > 0) {
    warnings.push(`placeholder text found in ${placeholderTextHits.join(", ")}`);
  }

  return {
    status: warnings.length === 0 ? "pass" : "warning",
    total_slide_count: slideXmlEntries.length,
    slide_count_note: SLIDE_COUNT_NOTE,
    media_image_count: mediaImageCount,
    slides_with_images: slidesWithImages,
    expected_step_image_count: expectedStepImageCount,
    expected_step_image_count_source: expectedStepImageCountSource,
    notes_review_warning_count: notesReviewWarningCount,
    placeholder_text_hits: placeholderTextHits,
    warnings,
  };
}

async function resolveExpectedStepImageCount(projectId: number): Promise<{
  count: number | null;
  source: PptxContentCheck["expected_step_image_count_source"];
  warnings: string[];
}> {
  const warnings: string[] = [];
  try {
    const state = await loadProjectStepRenderState(projectId, undefined, {
      invalidArtifactFallback: true,
    });
    warnings.push(...state.warnings);
    if (state.steps.length === 0) {
      warnings.push("no renderable steps found; image count check skipped");
      return { count: null, source: "unavailable", warnings };
    }
    return {
      count: state.steps.length,
      source: state.source === "steps_artifact" ? "steps_artifact" : "db_steps",
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`loadProjectStepRenderState failed: ${message}`);
    return { count: null, source: "unavailable", warnings };
  }
}

function buildPptxContentInspectionWarning(
  message: string,
  expectedStepImages: Awaited<ReturnType<typeof resolveExpectedStepImageCount>>,
): PptxContentCheck {
  return {
    status: "warning",
    total_slide_count: 0,
    slide_count_note: SLIDE_COUNT_NOTE,
    media_image_count: 0,
    slides_with_images: 0,
    expected_step_image_count: expectedStepImages.count,
    expected_step_image_count_source: expectedStepImages.source,
    notes_review_warning_count: 0,
    placeholder_text_hits: [],
    warnings: [message],
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await fs.mkdir(options.outdir, { recursive: true });

  const projectId = options.projectId as number;
  const expectedStepImages = await resolveExpectedStepImageCount(projectId);
  const slideUrl = await generateSlides(projectId);
  const videoResult = await generateVideo(projectId, { audioMode: options.audioMode });
  const slideArtifact = await localArtifact(slideUrl);
  let slideContentCheck: PptxContentCheck;
  if (slideArtifact.path) {
    try {
      slideContentCheck = inspectPptxContent(
        await fs.readFile(path.join(repoRoot, slideArtifact.path)),
        expectedStepImages.count,
        expectedStepImages.source,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      slideContentCheck = buildPptxContentInspectionWarning(
        `PPTX content inspection failed: ${message}`,
        expectedStepImages,
      );
    }
  } else {
    slideContentCheck = buildPptxContentInspectionWarning(
      "PPTX content inspection is only available for local storage artifacts",
      expectedStepImages,
    );
  }
  slideContentCheck.warnings.unshift(...expectedStepImages.warnings);
  if (expectedStepImages.warnings.length > 0) {
    slideContentCheck.status = "warning";
  }

  const summary = {
    project_id: projectId,
    generated_at: new Date().toISOString(),
    requested_audio_mode: options.audioMode,
    slide: {
      ...slideArtifact,
      content_check: slideContentCheck,
    },
    video: {
      ...(await localArtifact(videoResult.videoUrl)),
      warnings: videoResult.warnings,
      still_image_fallback_count: videoResult.stillImageFallbackCount,
    },
  };

  const summaryPath = path.join(options.outdir, `project_${projectId}_export_summary.json`);
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`export summary: ${path.relative(repoRoot, summaryPath)}`);
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
