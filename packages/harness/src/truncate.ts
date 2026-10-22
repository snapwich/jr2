// Ported from @earendil-works/pi-agent-core 0.82.1 (MIT, see PI-LICENSE): dist/harness/utils/truncate.js
//
// The output bounds of the Working tools (ADR-0027): `read` keeps the head of a file, `bash` keeps
// the tail of its output. Two limits, and the first one that is hit wins: 2000 lines or 50 KB. The
// numbers and the words that report them are what the model reads, so they stay pi 0.82.1's.

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

/** What a truncation did. The tools write their notices from these numbers. */
export type TruncationResult = {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  /** `truncateTail` only: the one line kept is the end of a line longer than the byte limit. */
  lastLinePartial: boolean;
  /** `truncateHead` only: the first line alone is longer than the byte limit, so nothing is kept. */
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
};

type TruncationOptions = { maxLines?: number; maxBytes?: number };

function utf8ByteLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function replaceUnpairedSurrogates(content: string): string {
  let output = "";
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < content.length) {
        const next = content.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          output += content[i]! + content[i + 1]!;
          i++;
          continue;
        }
      }
      output += "�";
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output += "�";
    } else {
      output += content[i];
    }
  }
  return output;
}

/** A byte count as the notices print it: `512B`, `50.0KB`, `1.2MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Keep the first lines that fit. Never a partial line: when the first line alone is over the
 * byte limit, the content is empty and `firstLineExceedsLimit` is set. */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = utf8ByteLength(content);
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }
  const firstLineBytes = utf8ByteLength(lines[0]!);
  if (firstLineBytes > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }
  const kept: string[] = [];
  let keptBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i]!;
    const lineBytes = utf8ByteLength(line) + (i > 0 ? 1 : 0);
    if (keptBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    kept.push(line);
    keptBytes += lineBytes;
  }
  if (kept.length >= maxLines && keptBytes <= maxBytes) truncatedBy = "lines";
  const output = kept.join("\n");
  return {
    content: output,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: kept.length,
    outputBytes: utf8ByteLength(output),
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

/** Keep the last lines that fit. When the last line alone is over the byte limit, its end is kept
 * and `lastLinePartial` is set. */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = utf8ByteLength(content);
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }
  const kept: string[] = [];
  let keptBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  let lastLinePartial = false;
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const line = lines[i]!;
    const lineBytes = utf8ByteLength(line) + (kept.length > 0 ? 1 : 0);
    if (keptBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (kept.length === 0) {
        const end = truncateStringToBytesFromEnd(line, maxBytes);
        kept.unshift(end);
        keptBytes = utf8ByteLength(end);
        lastLinePartial = true;
      }
      break;
    }
    kept.unshift(line);
    keptBytes += lineBytes;
  }
  if (kept.length >= maxLines && keptBytes <= maxBytes) truncatedBy = "lines";
  const output = kept.join("\n");
  return {
    content: output,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: kept.length,
    outputBytes: utf8ByteLength(output),
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

/** The end of `str` that fits in `maxBytes` of UTF-8, cut on a character boundary. */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let outputBytes = 0;
  let start = str.length;
  let needsReplacement = false;
  for (let i = str.length; i > 0; ) {
    let characterStart = i - 1;
    const code = str.charCodeAt(characterStart);
    let characterBytes: number;
    let unpairedSurrogate = false;
    if (code >= 0xdc00 && code <= 0xdfff && characterStart > 0) {
      const previous = str.charCodeAt(characterStart - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) {
        characterStart--;
        characterBytes = 4;
      } else {
        characterBytes = 3;
        unpairedSurrogate = true;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      characterBytes = 3;
      unpairedSurrogate = true;
    } else {
      characterBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    }
    if (outputBytes + characterBytes > maxBytes) break;
    outputBytes += characterBytes;
    start = characterStart;
    needsReplacement ||= unpairedSurrogate;
    i = characterStart;
  }
  const output = str.slice(start);
  return needsReplacement ? replaceUnpairedSurrogates(output) : output;
}
