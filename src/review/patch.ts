import type { DiffFileContext, ReviewLineType } from "./review-types.js";

interface Hunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

const HUNK_RE = /^@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/;

export function parsePatchWithLineNumbers(rawPatch: string): {
  extendedDiff: string;
  oldLinesWithNumber: Map<number, string>;
  newLinesWithNumber: Map<number, string>;
} {
  const patch = rawPatch.trim();
  if (!patch || !patch.includes("@@")) {
    return {
      extendedDiff: rawPatch,
      oldLinesWithNumber: new Map<number, string>(),
      newLinesWithNumber: new Map<number, string>(),
    };
  }

  const hunks = splitHunks(patch);
  const oldLinesWithNumber = new Map<number, string>();
  const newLinesWithNumber = new Map<number, string>();
  const rendered: string[] = [];

  for (const hunk of hunks) {
    const { renderedLines, oldMap, newMap } = annotateHunk(hunk);
    rendered.push(...renderedLines);

    for (const [lineNumber, line] of oldMap.entries()) {
      oldLinesWithNumber.set(lineNumber, line);
    }

    for (const [lineNumber, line] of newMap.entries()) {
      newLinesWithNumber.set(lineNumber, line);
    }
  }

  return {
    extendedDiff: rendered.join("\n"),
    oldLinesWithNumber,
    newLinesWithNumber,
  };
}

export function getDiffSnippet(
  file: DiffFileContext,
  type: ReviewLineType,
  startLine: number,
  endLine: number,
  contextLines = 3,
): string {
  const source = type === "new" ? file.newLinesWithNumber : file.oldLinesWithNumber;
  if (source.size === 0) {
    return "(no diff snippet available)";
  }

  const snippet: string[] = [];
  const from = Math.max(1, startLine - contextLines);
  const to = endLine + contextLines;

  for (let line = from; line <= to; line += 1) {
    const value = source.get(line);
    if (value !== undefined) {
      snippet.push(value);
    }
  }

  return snippet.length > 0 ? snippet.join("\n") : "(no diff snippet available)";
}

function splitHunks(diff: string): Hunk[] {
  const lines = diff.split("\n");
  const hunks: Hunk[] = [];

  let current: Hunk | undefined;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(HUNK_RE);
      if (current) {
        hunks.push(current);
      }

      current = {
        oldStart: match?.[1] ? Number(match[1]) : 0,
        newStart: match?.[3] ? Number(match[3]) : 0,
        lines: [line],
      };
      continue;
    }

    if (!current) {
      continue;
    }

    current.lines.push(line);
  }

  if (current) {
    hunks.push(current);
  }

  return hunks;
}

function annotateHunk(hunk: Hunk): {
  renderedLines: string[];
  oldMap: Map<number, string>;
  newMap: Map<number, string>;
} {
  const renderedLines: string[] = [];
  const oldMap = new Map<number, string>();
  const newMap = new Map<number, string>();

  const [header, ...contentLines] = hunk.lines;
  renderedLines.push(header ?? "@@");

  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const rows: Array<{ marker: string; raw: string }> = [];
  let markerWidth = 0;

  for (const rawLine of contentLines) {
    let marker: string;

    if (rawLine.startsWith("\\")) {
      marker = "( , )";
    } else if (rawLine.startsWith("-")) {
      marker = `(${oldLine}, )`;
      oldMap.set(oldLine, rawLine);
      oldLine += 1;
    } else if (rawLine.startsWith("+")) {
      marker = `( , ${newLine})`;
      newMap.set(newLine, rawLine);
      newLine += 1;
    } else {
      marker = `(${oldLine}, ${newLine})`;
      oldMap.set(oldLine, rawLine);
      newMap.set(newLine, rawLine);
      oldLine += 1;
      newLine += 1;
    }

    if (marker.length > markerWidth) {
      markerWidth = marker.length;
    }

    rows.push({ marker, raw: rawLine });
  }

  for (const row of rows) {
    renderedLines.push(`${row.marker.padEnd(markerWidth)} ${row.raw}`);
  }

  return { renderedLines, oldMap, newMap };
}
