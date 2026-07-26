/**
 * Pure HTML rendering for the Research Dashboard (RFC-11 UI).
 *
 * These functions turn Workbench view models into HTML strings. They are
 * presentation-only: no metric calculation, no I/O, no state. Everything shown
 * is copied verbatim from the view models the backend already produced.
 */
import type {
  ExperimentSummaryView,
  ExperimentDetailView,
  ArchitectureComparisonView,
  MetricsView,
  ReplayView,
  ExportHistoryView,
} from "../../src/workbench/index.ts";

/** Escape a value for safe interpolation into HTML text/attributes. */
export function escapeHtml(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render a `<table>` from headers and rows; every cell is escaped. */
export function table(headers: string[], rows: unknown[][]): string {
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  if (rows.length === 0) {
    return `<table><thead><tr>${head}</tr></thead><tbody><tr><td colspan="${headers.length}"><em>No rows.</em></td></tr></tbody></table>`;
  }
  const body = rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Two-column key/value table for a single object. */
function kvTable(pairs: Array<[string, unknown]>): string {
  return table(
    ["Field", "Value"],
    pairs.map(([k, v]) => [k, v]),
  );
}

function link(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function expLink(experimentId: string, label = "view"): string {
  return link(`/experiment?id=${encodeURIComponent(experimentId)}`, label);
}

/** Minimal, unstyled-but-legible page shell with a nav bar. */
export function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Research Workbench</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 1.5rem; color: #111; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 1.5rem; }
  nav a { margin-right: 1rem; }
  table { border-collapse: collapse; margin: 0.5rem 0 1rem; font-size: 0.9rem; }
  th, td { border: 1px solid #ccc; padding: 0.3rem 0.6rem; text-align: left; vertical-align: top; }
  th { background: #f2f2f2; }
  .btn { display: inline-block; border: 1px solid #444; padding: 0.3rem 0.7rem; margin-right: 0.5rem; text-decoration: none; color: #111; }
  code { background: #f5f5f5; padding: 0 0.2rem; }
</style>
</head>
<body>
<nav>
  ${link("/experiments", "Experiments")}
  ${link("/comparison", "Comparison")}
  ${link("/exports", "Export History")}
</nav>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</body>
</html>`;
}

// ---- Pages ----

export function renderExperimentList(views: ExperimentSummaryView[]): string {
  const rows = views.map((v) => [
    expLink(v.experimentId, v.experimentId),
    v.snapshotId,
    v.architecture,
    v.status,
    v.promptVersion,
    v.modelVersion,
    v.createdAt,
  ]);
  // The experiment-id cell is pre-rendered anchor HTML, so build rows manually.
  const head = [
    "Experiment ID",
    "Snapshot ID",
    "Architecture",
    "Status",
    "Prompt",
    "Model",
    "Created",
  ]
    .map((h) => `<th>${escapeHtml(h)}</th>`)
    .join("");
  const body = rows
    .map((row) => {
      const [idCell, ...rest] = row;
      return `<tr><td>${idCell}</td>${rest
        .map((c) => `<td>${escapeHtml(c)}</td>`)
        .join("")}</tr>`;
    })
    .join("");
  const tableHtml = views.length
    ? `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    : "<p><em>No experiments.</em></p>";
  return `<p>${views.length} experiment(s).</p>${tableHtml}`;
}

export function renderExperimentDetail(view: ExperimentDetailView): string {
  const s = view.summary;
  const meta = kvTable([
    ["Experiment ID", s.experimentId],
    ["Snapshot ID", s.snapshotId],
    ["Architecture", s.architecture],
    ["Status", s.status],
    ["Prompt Version", s.promptVersion],
    ["Model", s.modelVersion],
    ["Created", s.createdAt],
  ]);

  const pr = view.pr
    ? kvTable([
        ["Title", view.pr.title],
        ["Source", view.pr.source],
        ["Category", view.pr.category],
        ["Complexity", view.pr.complexity],
        ["Changed files", view.pr.changedFileCount],
        ["Changed lines", view.pr.totalChangedLines],
      ])
    : "<p><em>No PR snapshot.</em></p>";

  const findings = table(
    ["Severity", "Category", "File", "Line", "Confidence", "Title"],
    view.findings.map((f) => [
      f.severity,
      f.category,
      f.file,
      f.line,
      f.confidence,
      f.title,
    ]),
  );

  const actions = `<p>
    ${expLink(s.experimentId, "detail")} ·
    ${link(`/metrics?id=${encodeURIComponent(s.experimentId)}`, "metrics")} ·
    ${link(`/replay?id=${encodeURIComponent(s.experimentId)}`, "replay")} ·
    ${link(`/comparison?snapshot=${encodeURIComponent(s.snapshotId)}`, "comparison")}
  </p>`;

  return `${actions}
    <h2>Metadata</h2>${meta}
    <h2>Pull Request</h2>${pr}
    <h2>Review Summary</h2><p>${escapeHtml(view.reviewSummary ?? "(none)")}</p>
    <h2>Findings (${view.findings.length})</h2>${findings}
    <h2>Raw Output</h2><pre><code>${escapeHtml(view.rawOutput ?? "(none)")}</code></pre>`;
}

export function renderComparison(view: ArchitectureComparisonView): string {
  const main = table(
    [
      "Architecture",
      "Findings",
      "Low",
      "Medium",
      "High",
      "Critical",
      "Avg Confidence",
      "Evidence (heuristic)",
      "Agreement",
      "Latency (ms)",
      "Input Tok",
      "Output Tok",
      "Cost (USD)",
      "LLM Calls",
      "Messages",
    ],
    view.architectures.map((a) => [
      a.architecture,
      a.findingCount,
      a.severityDistribution.low,
      a.severityDistribution.medium,
      a.severityDistribution.high,
      a.severityDistribution.critical,
      a.averageConfidence,
      a.evidenceScore,
      a.architectureAgreement === undefined ? "—" : a.architectureAgreement,
      a.latencyMs,
      a.inputTokens,
      a.outputTokens,
      a.estimatedCostUsd,
      a.llmCalls,
      a.messageCount,
    ]),
  );

  // Charts are presentation series (label/value) — rendered as compact tables
  // since no chart library is installed.
  const charts = view.charts
    .map(
      (c) =>
        `<h3>${escapeHtml(c.title)}</h3>${table(
          ["Label", "Value"],
          c.labels.map((label, i) => [label, c.values[i]]),
        )}`,
    )
    .join("");

  return `<p>Snapshot <code>${escapeHtml(view.snapshotId)}</code> — ${view.architectures.length} architecture(s).</p>
    <h2>Architecture Comparison</h2>${main}
    <h2>Chart Series</h2>${charts}`;
}

export function renderMetrics(view: MetricsView): string {
  const cost = kvTable([
    ["Latency (ms)", view.cost.latencyMs],
    ["Input tokens", view.cost.inputTokens],
    ["Output tokens", view.cost.outputTokens],
    ["Total tokens", view.cost.totalTokens],
    ["Estimated cost (USD)", view.cost.estimatedCostUsd],
    ["LLM calls", view.cost.llmCalls],
    ["Message count", view.cost.messageCount],
  ]);
  const quality = kvTable([
    ["Finding count", view.quality.findingCount],
    ["Low", view.quality.severityDistribution.low],
    ["Medium", view.quality.severityDistribution.medium],
    ["High", view.quality.severityDistribution.high],
    ["Critical", view.quality.severityDistribution.critical],
    ["Average confidence", view.quality.averageConfidence],
    ["Duplicate findings", view.quality.duplicateFindingCount],
    ["Evidence score (supporting heuristic)", view.quality.evidenceScore],
  ]);
  return `<p>Experiment <code>${escapeHtml(view.experimentId)}</code> · ${escapeHtml(view.architecture)}</p>
    <h2>Cost Analysis</h2>${cost}
    <h2>Quality Analysis</h2>${quality}`;
}

export function renderReplay(view: ReplayView): string {
  const rows = view.steps.map((step) => [
    step.index,
    step.timestamp,
    step.actor,
    step.to,
    step.messageType,
    step.content,
  ]);
  const timeline = table(
    ["#", "Timestamp", "Actor", "To", "Message Type", "Content"],
    rows,
  );
  return `<p>Experiment <code>${escapeHtml(view.experimentId)}</code>${
    view.architecture ? ` · ${escapeHtml(view.architecture)}` : ""
  } — ${view.stepCount} step(s).</p>
    <h2>Replay Timeline</h2>${
      view.stepCount === 0
        ? "<p><em>No conversation recorded (e.g. Agentless produces no multi-agent messages).</em></p>"
        : timeline
    }`;
}

export function renderExportHistory(view: ExportHistoryView): string {
  const buttons = `<p>
    ${link("/export?format=csv", "Download CSV")}
    ${link("/export?format=json", "Download JSON")}
  </p>`;
  const wrapped = buttons
    .replace('href="/export?format=csv"', 'class="btn" href="/export?format=csv"')
    .replace(
      'href="/export?format=json"',
      'class="btn" href="/export?format=json"',
    );
  const rows = view.items.map((i) => [
    i.format,
    i.fileName,
    i.rowCount,
    i.generatedAt,
  ]);
  return `<p>${view.totalExports} export(s) — ${view.csvCount} CSV, ${view.jsonCount} JSON.</p>
    <h2>Generate Export</h2>${wrapped}
    <h2>Export History</h2>${table(["Format", "File Name", "Rows", "Generated At"], rows)}`;
}
