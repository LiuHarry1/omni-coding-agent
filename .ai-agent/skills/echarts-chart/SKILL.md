---
name: echarts-chart
description: >-
  Deterministically turn structured data into an offline ECharts HTML page,
  cleaned data, a chart spec, and an optional PNG.
  Trigger phrases: draw a chart, generate a chart, ECharts, bar chart, line chart,
  pie chart, trend chart, chart from data, visualize data,
  画图表, 生成图表, 柱状图, 折线图, 饼图, 趋势图.
argument-hint: "<title + data description or CSV/table>"
user-invocable: true
---

# ECharts Chart — reproducible data charts

Normalize analysis data, then hand it to the script to produce an offline
single-file HTML page, a spec, cleaned data JSON, and a PNG when needed.
Draw conclusions from the data JSON; use the image only for visual QA.

## When to use

- The user wants to visualize data or build an analysis chart
- The data already exists or can be shaped into a table (title + goal + data + fields)
- Provenance matters: source, unit, time range, or YTD markers
- They need interactive HTML, or a static PNG for a report/deck

Do not use when:

- The user only wants a written analysis, with no chart
- They want to change a React component in the codebase instead of generating HTML artifacts

## Trigger Rules

At minimum you need:

- `title`
- `goal` (see [references/input-model.md](references/input-model.md))
- `data` (array of objects)
- `fields.x` and `fields.y`

## Required Calling Discipline

- Write structured JSON only; no arbitrary JavaScript, formatter functions, HTML, or external scripts
- Do not copy or edit `const D` in the template by hand — always call
  [`scripts/generate-chart.mjs`](scripts/generate-chart.mjs)
- Default output directory is the workspace `charts/` folder
- Conclusions must come from the generated `.data.json`; do not guess values via OCR
- Do not pass `--png` by default. Use it only when the user explicitly asks
  for a PNG or a downstream report/deck requires a raster image.

## Preflight Checklist

Before generating, confirm:

- [ ] `data` is a non-empty array
- [ ] `fields.x` exists on every record
- [ ] every `fields.y` field exists on every record
- [ ] `goal` is a valid enum
- [ ] `chartType` (if set) is in the whitelist
- [ ] `source`, `unit`, and `timeRange` are filled when the data provides them
- [ ] missing-value policy is explicit; YTD / current period is marked `incompletePeriod`
- [ ] numerators, denominators, and definitions are confirmed for percentages/ratios

If field names are unclear, shape the data first. Do not guess column names.

## Standard Workflows

### Workflow A — new chart

1. Write the user input to a temporary JSON file (full model:
   [references/input-model.md](references/input-model.md)).
2. Run:
   `node .ai-agent/skills/echarts-chart/scripts/generate-chart.mjs --input <input.json> --output-dir charts`
3. Read the generated `<slug>.spec.json` and `<slug>.data.json`. Confirm record
   count, units, time range, missing values, and sort order.
4. The interactive HTML is the default output and does not require Chrome or
   Playwright. Only when PNG was requested, rerun with `--png` and Read it once.
5. Return all artifacts and a same-origin preview link. Use the exact link form
   supplied in the turn reminder (remote environments include `environmentId`);
   without one, use `/workspace/preview?path={encodedAbsoluteHtmlPath}`. Do not
   prefix an IP address or use `file://`.

### Workflow B — small edits (patch)

When the user changes title, type, theme, size, field mapping, or analysis metadata:

- Edit the original input JSON and rerun the generator
- Do not patch generated HTML, or spec/data/HTML will drift
- If the title change produces a new slug, list the new paths

### Workflow C — bad data

- Incompatible mapping, missing fields, NaN/Infinity, illegal nulls, or too many pie slices:
  let the generator raise a specific validation error
- Use `chartType: "table"` only when the data is genuinely a poor fit for a chart

## goal → defaultType

| goal | defaultType |
|------|-------------|
| trend | line |
| compare | bar |
| composition | donut |
| distribution | histogram |
| ranking | bar |
| correlation | scatter |

## Delivery format (search2chart-mcp)

The final reply must include the actual artifacts; do not embed base64:

```markdown
Chart generated.

- Interactive chart: `{absoluteHtmlPath}`
- Cleaned data: `{absoluteDataPath}`
- Chart spec: `{absoluteSpecPath}`
- Preview (cloud): [Open interactive chart](/workspace/preview?environmentId={encodedEnvironmentId}&path={encodedAbsoluteHtmlPath})
- Preview (local): [Open interactive chart](/workspace/preview?path={encodedAbsoluteHtmlPath})
- PNG (when generated): embed it with Markdown image syntax using the same
  cloud/local preview URL form and the encoded PNG path.
```

Add 2–4 insights from `.data.json`, and state source, unit, and any incomplete period.

## References

- [input-model.md](references/input-model.md) — fields and the `const D` payload
- [chart-template.html](references/chart-template.html) — search2chart-style HTML template
- [examples.md](references/examples.md) — few-shot examples
- `references/echarts.min.js` — pinned offline ECharts runtime

## Quality rules

- Use line/area for trends; bar for category comparison; horizontal bar for ranking
- Composition with more than 6 categories must use Top-N + Other, or switch to bar
- Stacked-bar series must share one unit; no decorative dual axes or 3D
- Prefer labels that keep units and enough precision; do not hide data behind decoration
- Default chart size is 960×480 (override with width/height); the page shrinks to the viewport to avoid scrolling
- Default PNG screenshot window is 1280×860; the Read path compresses it to a separate token budget
