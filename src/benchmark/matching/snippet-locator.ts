/**
 * Resolve a finding's true line by locating its quoted `snippet` in the PR diff
 * (roadmap A3, evaluation side).
 *
 * LLMs count diff lines unreliably, so a finding's reported `line` can be off by
 * a few even when it identifies the right code. When the model also quotes the
 * offending line(s) verbatim, we can re-derive the new-file line number by
 * finding that text in the unified diff — making localization measure
 * understanding rather than arithmetic. Deterministic and LLM-free; returns
 * `undefined` when the snippet cannot be located (caller falls back to the
 * reported line).
 */

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Collapse runs of whitespace and trim, so quoting/indent differences don't matter. */
function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Normalize a path for comparison: trim and drop a leading `./`, `a/`, or `b/`. */
function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/^\.\//, "");
  return trimmed.replace(/^[ab]\//, "");
}

/** The snippet's first non-empty line, normalized — the anchor we search for. */
function anchorLine(snippet: string): string {
  for (const line of snippet.split("\n")) {
    const normalized = normalizeWs(line);
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return "";
}

export function resolveSnippetLine(
  diff: string,
  file: string,
  snippet: string,
): number | undefined {
  const anchor = anchorLine(snippet);
  if (anchor.length === 0) {
    return undefined;
  }
  const targetFile = normalizePath(file);

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
      if (path !== "/dev/null") {
        currentFile = normalizePath(path);
      }
      continue;
    }
    if (raw.startsWith("--- ")) {
      continue; // old path; the new path (or git header) is authoritative
    }
    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || currentFile !== targetFile) {
      continue;
    }
    if (raw.startsWith("-") || raw.startsWith("\\")) {
      continue; // deletion / "no newline" marker — not in the new file
    }
    // Added (`+`) or context (leading space) line: present in the new file.
    const content = raw.startsWith("+") || raw.startsWith(" ") ? raw.slice(1) : raw;
    if (normalizeWs(content).includes(anchor)) {
      return newLine;
    }
    newLine += 1;
  }
  return undefined;
}
