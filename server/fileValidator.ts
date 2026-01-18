/**
 * File validation utilities
 * Validates files using magic bytes (file signatures) for security
 */

export type FileValidationResult = {
  valid: boolean;
  detectedType?: string;
  error?: string;
};

/**
 * Magic bytes (file signatures) for common video formats
 * Reference: https://en.wikipedia.org/wiki/List_of_file_signatures
 */
const VIDEO_SIGNATURES: Array<{
  type: string;
  mimeType: string;
  signatures: Array<{ bytes: number[]; offset?: number }>;
}> = [
  {
    type: "MP4",
    mimeType: "video/mp4",
    signatures: [
      // ftyp box signatures (ISO Base Media format)
      { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // "ftyp"
    ],
  },
  {
    type: "MOV",
    mimeType: "video/quicktime",
    signatures: [
      // QuickTime ftyp variants
      { bytes: [0x66, 0x74, 0x79, 0x70, 0x71, 0x74], offset: 4 }, // "ftypqt"
      // moov atom at beginning
      { bytes: [0x6d, 0x6f, 0x6f, 0x76], offset: 4 }, // "moov"
      // free atom at beginning
      { bytes: [0x66, 0x72, 0x65, 0x65], offset: 4 }, // "free"
      // mdat atom at beginning
      { bytes: [0x6d, 0x64, 0x61, 0x74], offset: 4 }, // "mdat"
      // wide atom at beginning
      { bytes: [0x77, 0x69, 0x64, 0x65], offset: 4 }, // "wide"
      // skip atom at beginning
      { bytes: [0x73, 0x6b, 0x69, 0x70], offset: 4 }, // "skip"
    ],
  },
  {
    type: "AVI",
    mimeType: "video/x-msvideo",
    signatures: [
      // RIFF....AVI
      { bytes: [0x52, 0x49, 0x46, 0x46] }, // "RIFF" at offset 0
    ],
  },
  {
    type: "WebM",
    mimeType: "video/webm",
    signatures: [
      // EBML header
      { bytes: [0x1a, 0x45, 0xdf, 0xa3] },
    ],
  },
  {
    type: "MKV",
    mimeType: "video/x-matroska",
    signatures: [
      // EBML header (same as WebM)
      { bytes: [0x1a, 0x45, 0xdf, 0xa3] },
    ],
  },
];

/**
 * Check if buffer starts with given bytes at specified offset
 */
function matchesSignature(
  buffer: Buffer,
  signature: { bytes: number[]; offset?: number }
): boolean {
  const offset = signature.offset ?? 0;

  if (buffer.length < offset + signature.bytes.length) {
    return false;
  }

  for (let i = 0; i < signature.bytes.length; i++) {
    if (buffer[offset + i] !== signature.bytes[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Additional validation for AVI files
 * AVI files must have "AVI " at offset 8
 */
function validateAvi(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;

  // Check for "AVI " at offset 8
  const aviMarker = buffer.slice(8, 12).toString("ascii");
  return aviMarker === "AVI ";
}

/**
 * Validate video file using magic bytes
 *
 * @param buffer - File buffer (at least first 32 bytes needed)
 * @param declaredMimeType - MIME type declared by client
 * @returns Validation result
 */
export function validateVideoFile(
  buffer: Buffer,
  declaredMimeType?: string
): FileValidationResult {
  if (buffer.length < 12) {
    return {
      valid: false,
      error: "ファイルが小さすぎます",
    };
  }

  // Check all known video signatures
  for (const format of VIDEO_SIGNATURES) {
    for (const signature of format.signatures) {
      if (matchesSignature(buffer, signature)) {
        // Additional AVI validation
        if (format.type === "AVI" && !validateAvi(buffer)) {
          continue;
        }

        // If declared MIME type doesn't match, but file is valid video
        // We accept it but note the detected type
        return {
          valid: true,
          detectedType: format.mimeType,
        };
      }
    }
  }

  return {
    valid: false,
    error: "有効な動画ファイルではありません。ファイルの形式を確認してください。",
  };
}

/**
 * Get file extension from MIME type
 */
export function getExtensionFromMimeType(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/x-msvideo": "avi",
    "video/webm": "webm",
    "video/x-matroska": "mkv",
  };

  return mimeToExt[mimeType] || "mp4";
}

/**
 * Sanitize filename to prevent path traversal attacks
 */
export function sanitizeFilename(filename: string): string {
  // Remove path separators and null bytes
  let sanitized = filename
    .replace(/[/\\]/g, "_")
    .replace(/\0/g, "")
    .replace(/\.\./g, "_");

  // Limit length
  if (sanitized.length > 255) {
    const ext = sanitized.slice(sanitized.lastIndexOf("."));
    sanitized = sanitized.slice(0, 255 - ext.length) + ext;
  }

  // Ensure not empty
  if (!sanitized || sanitized === ".") {
    sanitized = "video.mp4";
  }

  return sanitized;
}
