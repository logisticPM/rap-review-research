/**
 * Parse a unified diff into its ADDED lines, each with its new-file line number.
 * Deterministic, LLM-free — the input a static-analysis reviewer runs its rules
 * over. Mirrors the diff-walking in `benchmark/matching/snippet-locator.ts`
 * (git header / `+++` / hunk header, advancing the new-file counter on added and
 * context lines, skipping deletions).
 */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, "").replace(/^[ab]\//, "");
}

export interface AddedLine {
  readonly file: string;
  readonly line: number; // 1-based line number in the NEW file
  readonly content: string; // the added line, without the leading '+'
}

export function parseAddedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let currentFile: string | undefined;
  let newLine = 0;
  let inHunk = false;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const parts = raw.slice("diff --git ".length).trim().split(" ");
      currentFile = normalizePath(parts[parts.length - 1] ?? "");
      inHunk = false;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).trim();
      if (path !== "/dev/null") currentFile = normalizePath(path);
      continue;
    }
    if (raw.startsWith("--- ")) continue;

    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (raw.startsWith("+")) {
      if (currentFile !== undefined) {
        out.push({ file: currentFile, line: newLine, content: raw.slice(1) });
      }
      newLine += 1;
    } else if (raw.startsWith("-") || raw.startsWith("\\")) {
      // deletion / "no newline at end of file" — not present in the new file
    } else {
      newLine += 1; // context line
    }
  }
  return out;
}
