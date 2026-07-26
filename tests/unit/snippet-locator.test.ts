import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveSnippetLine } from "../../src/benchmark/matching/snippet-locator.ts";

const DIFF = `diff --git a/src/api/users.ts b/src/api/users.ts
--- a/src/api/users.ts
+++ b/src/api/users.ts
@@ -8,6 +8,9 @@ export async function getUser(req, res) {
   const log = req.log;
-  const id = req.params.id;
+  const id = req.query.id;
+  const rows = await db.query('SELECT * FROM users WHERE id = ' + id);
+  return res.json(rows[0]);
 }
`;

test("resolves an added line to its new-file line number", () => {
  // Hunk starts new-file at line 8: context(8) `const log`, added(9) `const id`,
  // added(10) `const rows`, added(11) `return`.
  const line = resolveSnippetLine(
    DIFF,
    "src/api/users.ts",
    "const rows = await db.query('SELECT * FROM users WHERE id = ' + id);",
  );
  assert.equal(line, 10);
});

test("resolves a context line", () => {
  assert.equal(resolveSnippetLine(DIFF, "src/api/users.ts", "const log = req.log;"), 8);
});

test("tolerates whitespace/indent differences and quoted fragments", () => {
  assert.equal(
    resolveSnippetLine(DIFF, "src/api/users.ts", "   const   id = req.query.id;   "),
    9,
  );
  // A fragment of the line still anchors (substring match).
  assert.equal(resolveSnippetLine(DIFF, "src/api/users.ts", "return res.json(rows[0])"), 11);
});

test("normalizes a/ b/ ./ path prefixes on the file argument", () => {
  assert.equal(resolveSnippetLine(DIFF, "./src/api/users.ts", "const id = req.query.id;"), 9);
});

test("returns undefined when the snippet is not in the target file", () => {
  assert.equal(resolveSnippetLine(DIFF, "src/api/users.ts", "totally absent line"), undefined);
  assert.equal(resolveSnippetLine(DIFF, "src/other.ts", "const id = req.query.id;"), undefined);
  assert.equal(resolveSnippetLine(DIFF, "src/api/users.ts", "   "), undefined);
});
