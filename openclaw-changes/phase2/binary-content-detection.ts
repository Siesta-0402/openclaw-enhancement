/**
 * OpenClaw Binary Content Detection System
 * 
 * This module provides comprehensive binary content detection for file operations.
 * It helps prevent issues when reading binary files as text or processing them
 * with tools that expect text input (like sed, grep, etc.).
 * 
 * Features:
 * - Magic byte detection (file signatures)
 * - Binary vs text heuristics
 * - Safe file type detection
 * - Integration with read tool
 */

import { BashVerificationBehavior, PermissionResult, ValidationContext } from './bash-verification';

// ============================================================================
// Binary Detection Types
// ============================================================================

export type BinaryConfidence = 'confirmed' | 'likely' | 'unknown' | 'text';

export interface BinaryDetectionResult {
  isBinary: boolean;
  confidence: BinaryConfidence;
  mimeType?: string;
  detectedType?: string;
  reasons: string[];
  safeToReadAsText: boolean;
  suggestedEncoding?: string;
}

export interface FileSignature {
  magic: number[];       // Magic bytes to match
  mask?: number[];        // Optional mask to apply before matching
  offset: number;        // Offset from start of file
  type: string;           // Human-readable type name
  mimeType: string;       // MIME type
}

// ============================================================================
// File Signatures (Magic Bytes)
// ============================================================================

const FILE_SIGNATURES: FileSignature[] = [
  // Images
  { magic: [0x89, 0x50, 0x4E, 0x47], type: 'PNG', mimeType: 'image/png', offset: 0 },
  { magic: [0xFF, 0xD8, 0xFF], type: 'JPEG', mimeType: 'image/jpeg', offset: 0 },
  { magic: [0x47, 0x49, 0x46, 0x38], type: 'GIF', mimeType: 'image/gif', offset: 0 },
  { magic: [0x42, 0x4D], type: 'BMP', mimeType: 'image/bmp', offset: 0 },
  { magic: [0x00, 0x00, 0x01, 0x00], type: 'ICO', mimeType: 'image/x-icon', offset: 0 },
  { magic: [0x49, 0x49, 0x2A, 0x00], type: 'TIFF (little endian)', mimeType: 'image/tiff', offset: 0 },
  { magic: [0x4D, 0x4D, 0x00, 0x2A], type: 'TIFF (big endian)', mimeType: 'image/tiff', offset: 0 },
  { magic: [0x38, 0x42, 0x50, 0x53], type: 'Photoshop', mimeType: 'image/vnd.adobe.photoshop', offset: 0 },
  { magic: [0x57, 0x45, 0x42, 0x50], type: 'WebP', mimeType: 'image/webp', offset: 0 },
  { magic: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], type: 'OpenEXR', mimeType: 'image/x-exr', offset: 0 },
  
  // Archives
  { magic: [0x50, 0x4B, 0x03, 0x04], type: 'ZIP', mimeType: 'application/zip', offset: 0 },
  { magic: [0x50, 0x4B, 0x05, 0x06], type: 'ZIP (empty)', mimeType: 'application/zip', offset: 0 },
  { magic: [0x50, 0x4B, 0x07, 0x08], type: 'ZIP (spanned)', mimeType: 'application/zip', offset: 0 },
  { magic: [0x1F, 0x8B, 0x08], type: 'GZIP', mimeType: 'application/gzip', offset: 0 },
  { magic: [0x42, 0x5A, 0x68], type: 'BZIP2', mimeType: 'application/x-bzip2', offset: 0 },
  { magic: [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00], type: 'XZ', mimeType: 'application/x-xz', offset: 0 },
  { magic: [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01], type: 'RAR', mimeType: 'application/vnd.rar', offset: 0 },
  { magic: [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C], type: '7Z', mimeType: 'application/x-7z-compressed', offset: 0 },
  { magic: [0x75, 0x73, 0x74, 0x61, 0x72, 0x00, 0x30, 0x30], type: 'TAR (POSIX)', mimeType: 'application/x-tar', offset: 257 },
  { magic: [0x75, 0x73, 0x74, 0x61, 0x72, 0x20, 0x20, 0x00], type: 'TAR (GNU)', mimeType: 'application/x-tar', offset: 257 },
  
  // Executables
  { magic: [0x7F, 0x45, 0x4C, 0x46], type: 'ELF Executable', mimeType: 'application/x-executable', offset: 0 },
  { magic: [0xCA, 0xFE, 0xBA, 0xBE], type: 'Java Class (Mach-O)', mimeType: 'application/x-java-applet', offset: 0 },
  { magic: [0xFE, 0xED, 0xFA, 0xCE], type: 'Mach-O 32-bit', mimeType: 'application/x-mach-binary', offset: 0 },
  { magic: [0xFE, 0xED, 0xFA, 0xCF], type: 'Mach-O 64-bit', mimeType: 'application/x-mach-binary', offset: 0 },
  { magic: [0xCE, 0xFA, 0xED, 0xFE], type: 'Mach-O (reverse endian)', mimeType: 'application/x-mach-binary', offset: 0 },
  { magic: [0xCF, 0xFA, 0xED, 0xFE], type: 'Mach-O 64-bit (reverse)', mimeType: 'application/x-mach-binary', offset: 0 },
  { magic: [0x4D, 0x5A], type: 'Windows Executable (MZ)', mimeType: 'application/x-msdownload', offset: 0 },
  { magic: [0x50, 0x45, 0x00, 0x00], type: 'Windows PE', mimeType: 'application/x-msdownload', offset: 0 },
  
  // Documents
  { magic: [0x25, 0x50, 0x44, 0x46], type: 'PDF', mimeType: 'application/pdf', offset: 0 },
  { magic: [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], type: 'MS Office (legacy)', mimeType: 'application/vnd.ms-office', offset: 0 },
  { magic: [0x50, 0x4B, 0x03, 0x04], type: 'Office Open XML', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', offset: 0 }, // Same as ZIP
  { magic: [0x00, 0x00, 0x1A, 0x00], type: ' Lotus 1-2-3', mimeType: 'application/x-lotus', offset: 0 },
  { magic: [0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00], type: 'Framer', mimeType: 'application/x-framer', offset: 0 },
  
  // Audio/Video
  { magic: [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45], type: 'WAV', mimeType: 'audio/wav', offset: 0 },
  { magic: [0x49, 0x44, 0x33], type: 'MP3 (ID3)', mimeType: 'audio/mpeg', offset: 0 },
  { magic: [0xFF, 0xFB], type: 'MP3', mimeType: 'audio/mpeg', offset: 0 },
  { magic: [0xFF, 0xFA], type: 'MP3', mimeType: 'audio/mpeg', offset: 0 },
  { magic: [0xFF, 0xF3], type: 'MP3', mimeType: 'audio/mpeg', offset: 0 },
  { magic: [0xFF, 0xF2], type: 'MP3', mimeType: 'audio/mpeg', offset: 0 },
  { magic: [0x4F, 0x67, 0x67, 0x53], type: 'OGG', mimeType: 'audio/ogg', offset: 0 },
  { magic: [0x52, 0x49, 0x46, 0x46], type: 'RIFF', mimeType: 'audio/wav', offset: 0 }, // AVI and WAV use RIFF
  { magic: [0x00, 0x00, 0x00, 0x00, 0x4D, 0x54, 0x68, 0x64], type: 'MIDI', mimeType: 'audio/midi', offset: 0 },
  { magic: [0x66, 0x4C, 0x61, 0x43], type: 'FLAC', mimeType: 'audio/flac', offset: 0 },
  
  // Video
  { magic: [0x00, 0x00, 0x00, 0x00, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D], type: 'MP4', mimeType: 'video/mp4', offset: 4 },
  { magic: [0x00, 0x00, 0x00, 0x00, 0x66, 0x74, 0x79, 0x70, 0x4D, 0x34, 0x41], type: 'M4A', mimeType: 'audio/mp4', offset: 4 },
  { magic: [0x1A, 0x45, 0xDF, 0xA3], type: 'WebM/MKV', mimeType: 'video/webm', offset: 0 },
  { magic: [0x00, 0x00, 0x01, 0xBA], type: 'MPEG Video', mimeType: 'video/mpeg', offset: 0 },
  { magic: [0x00, 0x00, 0x01, 0xB3], type: 'MPEG Video (B-frames)', mimeType: 'video/mpeg', offset: 0 },
  
  // Database
  { magic: [0x53, 0x51, 0x4C, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6F, 0x72, 0x6D, 0x61, 0x74, 0x20, 0x33, 0x00], type: 'SQLite', mimeType: 'application/vnd.sqlite3', offset: 0 },
  
  // Fonts
  { magic: [0x00, 0x01, 0x00, 0x00], type: 'TrueType Font', mimeType: 'font/ttf', offset: 0 },
  { magic: [0x4F, 0x54, 0x54, 0x4F], type: 'OpenType Font (CFF)', mimeType: 'font/otf', offset: 0 },
  { magic: [0x77, 0x4F, 0x46, 0x46], type: 'Web Open Font', mimeType: 'font/woff', offset: 0 },
  { magic: [0x77, 0x4F, 0x46, 0x32], type: 'Web Open Font 2', mimeType: 'font/woff2', offset: 0 },
  
  // Other
  { magic: [0x25, 0x21, 0x50, 0x53], type: 'PostScript', mimeType: 'application/postscript', offset: 0 },
  { magic: [0x23, 0x21, 0x41, 0x43, 0x43], type: 'Debian Package', mimeType: 'application/x-deb', offset: 0 },
  { magic: [0x21, 0x3C, 0x61, 0x72, 0x63, 0x68, 0x3E, 0x0A], type: 'Unix Archive', mimeType: 'application/x-unix-archive', offset: 0 },
  { magic: [0x7F, 0x45, 0x4C, 0x46], type: 'Core Dump', mimeType: 'application/x-core-dump', offset: 0 },
];

// ============================================================================
// Binary Detection Functions
// ============================================================================

/**
 * Detect file type from magic bytes.
 */
export function detectByMagic(bytes: Buffer): FileSignature | null {
  for (const sig of FILE_SIGNATURES) {
    if (matchesSignature(bytes, sig)) {
      return sig;
    }
  }
  return null;
}

/**
 * Check if bytes match a file signature.
 */
function matchesSignature(bytes: Buffer, sig: FileSignature): boolean {
  const { magic, mask, offset } = sig;
  
  if (offset + magic.length > bytes.length) {
    return false;
  }
  
  for (let i = 0; i < magic.length; i++) {
    const byte = bytes[offset + i];
    const expected = mask ? (byte & mask[i]) : magic[i];
    if ((byte & (mask ? mask[i] : 0xFF)) !== expected) {
      return false;
    }
  }
  
  return true;
}

/**
 * Heuristic binary detection based on character distribution.
 */
export function detectBinaryByHeuristics(content: string | Buffer): {
  isBinary: boolean;
  confidence: BinaryConfidence;
  reasons: string[];
} {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  const sampleSize = Math.min(bytes.length, 8192);
  
  let nonPrintable = 0;
  let nullBytes = 0;
  let highBytes = 0;
  let lines = 0;
  let veryLongLine = false;
  
  for (let i = 0; i < sampleSize; i++) {
    const byte = bytes[i];
    
    if (byte === 0) {
      nullBytes++;
      nonPrintable++;
    } else if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      // Control characters (except tab, LF, CR)
      nonPrintable++;
    } else if (byte > 127) {
      highBytes++;
    }
    
    if (byte === 10) lines++;
  }
  
  const nonPrintableRatio = nonPrintable / sampleSize;
  const nullRatio = nullBytes / sampleSize;
  const highRatio = highBytes / sampleSize;
  const avgLineLength = sampleSize / Math.max(lines, 1);
  
  const reasons: string[] = [];
  
  // Null bytes are strong indicator of binary
  if (nullRatio > 0.01) {
    reasons.push(`${(nullRatio * 100).toFixed(1)}% null bytes`);
  }
  
  // High ratio of non-printable characters
  if (nonPrintableRatio > 0.3) {
    reasons.push(`${(nonPrintableRatio * 100).toFixed(1)}% non-printable characters`);
  }
  
  // Many high bytes (could be UTF-16 or binary)
  if (highRatio > 0.3) {
    reasons.push(`${(highRatio * 100).toFixed(1)}% high bytes (>127)`);
  }
  
  // Very long lines suggest binary
  if (avgLineLength > 10000) {
    reasons.push(`Very long average line length (${avgLineLength.toFixed(0)})`);
    veryLongLine = true;
  }
  
  // Determine confidence level
  if (nullRatio > 0.1 || nonPrintableRatio > 0.5) {
    return { isBinary: true, confidence: 'confirmed', reasons };
  }
  
  if (nullRatio > 0.01 || nonPrintableRatio > 0.3 || highRatio > 0.5) {
    return { isBinary: true, confidence: 'likely', reasons };
  }
  
  if (veryLongLine) {
    return { isBinary: true, confidence: 'likely', reasons };
  }
  
  if (highRatio > 0.1) {
    // Could be a text file with non-ASCII characters
    return { isBinary: false, confidence: 'text', reasons: [] };
  }
  
  return { isBinary: false, confidence: 'text', reasons: [] };
}

/**
 * Main binary content detection function.
 */
export function detectBinaryContent(content: string | Buffer, filename?: string): BinaryDetectionResult {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  const reasons: string[] = [];
  
  // First try magic byte detection
  const magicResult = detectByMagic(bytes);
  if (magicResult) {
    return {
      isBinary: true,
      confidence: 'confirmed',
      mimeType: magicResult.mimeType,
      detectedType: magicResult.type,
      reasons: [`Magic bytes match ${magicResult.type}`],
      safeToReadAsText: false,
    };
  }
  
  // Then use heuristics
  const heuristicResult = detectBinaryByHeuristics(bytes);
  
  if (heuristicResult.isBinary) {
    const mimeType = detectMimeByExtension(filename);
    return {
      isBinary: true,
      confidence: heuristicResult.confidence,
      detectedType: 'Unknown binary',
      reasons: heuristicResult.reasons,
      safeToReadAsText: heuristicResult.confidence !== 'confirmed',
      suggestedEncoding: 'binary',
    };
  }
  
  // Check for UTF-16 or other encodings
  const encodingResult = detectEncoding(bytes);
  if (encodingResult !== 'utf-8') {
    return {
      isBinary: false,
      confidence: 'text',
      reasons: [],
      safeToReadAsText: true,
      suggestedEncoding: encodingResult,
    };
  }
  
  return {
    isBinary: false,
    confidence: 'text',
    reasons: [],
    safeToReadAsText: true,
    suggestedEncoding: 'utf-8',
  };
}

/**
 * Detect encoding from byte patterns.
 */
function detectEncoding(bytes: Buffer): string {
  // Check for UTF-16 BOM or byte patterns
  if (bytes.length >= 2) {
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return 'utf-16le';
    }
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
      return 'utf-16be';
    }
  }
  
  // Check for UTF-8 validity (simple check)
  let invalidUtf8 = false;
  let i = 0;
  while (i < bytes.length && !invalidUtf8) {
    const byte = bytes[i];
    
    if (byte < 0x80) {
      // ASCII - valid
      i++;
    } else if ((byte & 0xE0) === 0xC0) {
      // 2-byte sequence
      if (i + 1 >= bytes.length || (bytes[i + 1] & 0xC0) !== 0x80) {
        invalidUtf8 = true;
      }
      i += 2;
    } else if ((byte & 0xF0) === 0xE0) {
      // 3-byte sequence
      if (i + 2 >= bytes.length || (bytes[i + 1] & 0xC0) !== 0x80 || (bytes[i + 2] & 0xC0) !== 0x80) {
        invalidUtf8 = true;
      }
      i += 3;
    } else if ((byte & 0xF8) === 0xF0) {
      // 4-byte sequence
      if (i + 3 >= bytes.length || (bytes[i + 1] & 0xC0) !== 0x80 || (bytes[i + 2] & 0xC0) !== 0x80 || (bytes[i + 3] & 0xC0) !== 0x80) {
        invalidUtf8 = true;
      }
      i += 4;
    } else {
      invalidUtf8 = true;
    }
  }
  
  if (invalidUtf8) {
    return 'binary'; // Not valid UTF-8, treat as binary
  }
  
  return 'utf-8';
}

/**
 * Detect MIME type by file extension.
 */
function detectMimeByExtension(filename?: string): string | undefined {
  if (!filename) return undefined;
  
  const ext = filename.split('.').pop()?.toLowerCase();
  if (!ext) return undefined;
  
  const mimeMap: Record<string, string> = {
    // Text
    'txt': 'text/plain',
    'md': 'text/markdown',
    'json': 'application/json',
    'xml': 'application/xml',
    'html': 'text/html',
    'htm': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'ts': 'application/typescript',
    'csv': 'text/csv',
    
    // Images
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'bmp': 'image/bmp',
    'tiff': 'image/tiff',
    'tif': 'image/tiff',
    
    // Audio
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'ogg': 'audio/ogg',
    'flac': 'audio/flac',
    'm4a': 'audio/mp4',
    'mid': 'audio/midi',
    
    // Video
    'mp4': 'video/mp4',
    'avi': 'video/x-msvideo',
    'mkv': 'video/x-matroska',
    'mov': 'video/quicktime',
    'webm': 'video/webm',
    
    // Archives
    'zip': 'application/zip',
    'tar': 'application/x-tar',
    'gz': 'application/gzip',
    'bz2': 'application/x-bzip2',
    '7z': 'application/x-7z-compressed',
    'rar': 'application/vnd.rar',
    
    // Documents
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    
    // Code
    'py': 'text/x-python',
    'java': 'text/x-java',
    'c': 'text/x-c',
    'cpp': 'text/x-c++',
    'h': 'text/x-c-header',
    'go': 'text/x-go',
    'rs': 'text/x-rust',
    'rb': 'text/x-ruby',
    'php': 'text/x-php',
    'sh': 'application/x-sh',
    'bash': 'application/x-sh',
    'zsh': 'application/x-sh',
    
    // Fonts
    'ttf': 'font/ttf',
    'otf': 'font/otf',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    
    // Other
    'iso': 'application/x-iso9660-image',
    'dmg': 'application/x-apple-diskimage',
    'exe': 'application/x-msdownload',
  };
  
  return mimeMap[ext];
}

// ============================================================================
// Safe File Operations
// ============================================================================

export interface SafeReadOptions {
  maxBinarySize?: number;      // Max size to read for binary detection
  allowUnknownBinary?: boolean; // Allow reading files with unknown binary status
  suggestedEncoding?: string;    // Encoding to use if text
}

/**
 * Check if a file is safe to read as text based on its content.
 */
export function isSafeToReadAsText(
  content: string | Buffer,
  filename?: string,
  options: SafeReadOptions = {}
): { safe: boolean; reason?: string; suggestion?: string } {
  const result = detectBinaryContent(content, filename);
  
  if (result.isBinary) {
    if (result.confidence === 'confirmed') {
      return {
        safe: false,
        reason: `File is binary (${result.detectedType || result.mimeType || 'confirmed by magic bytes'})`,
        suggestion: 'Use a binary-safe tool or viewer to read this file',
      };
    }
    
    if (!options.allowUnknownBinary) {
      return {
        safe: false,
        reason: `File may be binary (${result.reasons.join(', ')})`,
        suggestion: 'Verify file type before reading',
      };
    }
  }
  
  if (result.suggestedEncoding && result.suggestedEncoding !== 'utf-8') {
    return {
      safe: true,
      reason: `File uses ${result.suggestedEncoding} encoding`,
      suggestion: `Consider reading with ${result.suggestedEncoding} encoding`,
    };
  }
  
  return { safe: true };
}

/**
 * Quick binary check - returns true if file appears to be binary.
 */
export function isBinaryFile(content: string | Buffer): boolean {
  const result = detectBinaryContent(content);
  return result.isBinary;
}

// ============================================================================
// CLI Integration Helper
// ============================================================================

/**
 * Get a human-readable description of a file's binary status.
 */
export function describeBinaryStatus(result: BinaryDetectionResult): string {
  if (!result.isBinary) {
    return 'Text file';
  }
  
  const parts: string[] = [];
  
  if (result.detectedType) {
    parts.push(result.detectedType);
  } else if (result.mimeType) {
    parts.push(result.mimeType);
  }
  
  parts.push(`(${result.confidence})`);
  
  if (result.reasons.length > 0) {
    parts.push(`- ${result.reasons.join(', ')}`);
  }
  
  return `Binary file ${parts.join(' ')}`;
}
