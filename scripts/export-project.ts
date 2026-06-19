import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { generateSlides } from "../server/slideGenerator";
import { generateVideo } from "../server/videoGenerator";
import { isLocalStorageUrl, resolveLocalStoragePathFromUrl } from "../server/storage";
import type { AudioMode } from "../server/videoClips";

type Options = {
  projectId?: number;
  outdir: string;
  audioMode: AudioMode;
};

const repoRoot = path.resolve(import.meta.dirname, "..");

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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await fs.mkdir(options.outdir, { recursive: true });

  const projectId = options.projectId as number;
  const slideUrl = await generateSlides(projectId);
  const videoResult = await generateVideo(projectId, { audioMode: options.audioMode });

  const summary = {
    project_id: projectId,
    generated_at: new Date().toISOString(),
    requested_audio_mode: options.audioMode,
    slide: {
      ...(await localArtifact(slideUrl)),
      content_check: "file_exists_only; visually inspect PPTX for placeholder images before release",
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
