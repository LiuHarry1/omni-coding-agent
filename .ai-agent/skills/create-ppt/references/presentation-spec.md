# Presentation specification

This is the **standard mode** contract for repeatable, structured decks. Use
professional `deck.mjs` mode when the story needs a purpose-built diagram,
annotated screenshot, roadmap, matrix, or composition not represented below.
The standard generator accepts one UTF-8 JSON object. Unknown fields are
rejected.

```json
{
  "title": "Required deck title",
  "subtitle": "Optional subtitle",
  "author": "Optional author",
  "language": "zh-CN",
  "audience": "Engineering leadership",
  "objective": "Approve a three-month pilot",
  "narrative": "Problem → evidence → proposal → decision",
  "slides": []
}
```

`slides` contains 1–24 objects. Every slide requires:

- `type`: one of the types below.
- `title`: a conclusion-style title, at most 100 characters.
- `takeaway`: the single message the audience should retain.
- `source`: optional short citation or caveat.
- `speaker_notes`: optional presenter-only notes.

## Slide types

### `content`

Use for a concise argument with 1–5 points. This is not the default for every
slide.

```json
{
  "type": "content",
  "title": "Manual preparation consumes two days per review",
  "takeaway": "Preparation, not analysis, is the bottleneck.",
  "bullets": [
    "Data is copied from three systems.",
    "Review formatting is rebuilt for every meeting."
  ],
  "visual_intent": "Emphasize the bottleneck with one large callout."
}
```

### `two_column`

Use for exactly two comparable or related groups.

```json
{
  "type": "two_column",
  "title": "Automation shifts effort from collection to decisions",
  "takeaway": "The target workflow preserves review control.",
  "left": {"heading": "Today", "bullets": ["Collect", "Reformat"]},
  "right": {"heading": "Target", "bullets": ["Verify", "Decide"]}
}
```

### `cards`

Use for 2–4 parallel ideas. Each body should stay below 160 characters.

```json
{
  "type": "cards",
  "title": "Three controls keep the pilot safe",
  "takeaway": "The proposal limits operational risk.",
  "cards": [
    {"heading": "Scope", "body": "Start with one reporting workflow."},
    {"heading": "Review", "body": "Require a human approval step."},
    {"heading": "Measure", "body": "Track accuracy and preparation time."}
  ]
}
```

### `process`

Use for 3–5 sequential steps.

```json
{
  "type": "process",
  "title": "A gated rollout produces evidence before scale",
  "takeaway": "Each phase has an explicit exit condition.",
  "steps": [
    {"title": "Prepare", "detail": "Confirm scope and baseline."},
    {"title": "Pilot", "detail": "Run with one team."},
    {"title": "Review", "detail": "Approve, adjust, or stop."}
  ]
}
```

### `metrics`

Use for 2–4 verified values. Values remain strings so units stay explicit.

```json
{
  "type": "metrics",
  "title": "The pilot reduced preparation time by 37%",
  "takeaway": "The observed saving exceeded the pilot threshold.",
  "metrics": [
    {"value": "37%", "label": "Less preparation time", "detail": "4-week pilot"},
    {"value": "96%", "label": "Verified accuracy", "detail": "124 records"}
  ]
}
```

### `chart`

Use only for verified numeric data. Supported kinds: `bar`, `column`, `line`,
and `pie`. Use 2–10 categories and no more than 4 series.

```json
{
  "type": "chart",
  "title": "Adoption increased in every pilot week",
  "takeaway": "Usage grew without additional training.",
  "chart_kind": "line",
  "categories": ["W1", "W2", "W3", "W4"],
  "series": [{"name": "Active users", "values": [12, 21, 34, 48]}],
  "unit": "Users"
}
```

### `table`

Use for exact comparison: 2–6 columns and 1–8 rows.

```json
{
  "type": "table",
  "title": "The pilot option offers the best risk-adjusted path",
  "takeaway": "A limited pilot preserves reversibility.",
  "columns": ["Option", "Effort", "Risk"],
  "rows": [["Manual", "High", "Low"], ["Pilot", "Medium", "Low"]]
}
```

### `quote`

Use only for a real quotation or a user-provided guiding statement.

```json
{
  "type": "quote",
  "title": "Reviewers value traceability over speed alone",
  "takeaway": "Evidence must remain easy to verify.",
  "quote": "I need to see where every number came from.",
  "attribution": "Pilot reviewer"
}
```

### `image`

Use a workspace PNG or JPEG path. `fit` is `contain` or `crop`.

```json
{
  "type": "image",
  "title": "The current handoff has three manual transitions",
  "takeaway": "Every transition creates a reconciliation step.",
  "source_path": "inputs/current-workflow.png",
  "caption": "Source: project workshop",
  "fit": "contain"
}
```

### `section`

Use only when the user explicitly requests chapters or dividers.

```json
{
  "type": "section",
  "title": "From evidence to action",
  "takeaway": "The proposal addresses the measured bottleneck.",
  "subtitle": "Recommended pilot"
}
```

### `summary`

Use for the final decision, recommendation, or next steps.

```json
{
  "type": "summary",
  "title": "Approve one team for a four-week controlled pilot",
  "takeaway": "The next decision is small and reversible.",
  "bullets": ["Confirm owner", "Capture baseline", "Review after four weeks"],
  "closing": "Decision requested"
}
```

## Capacity limits

- Deck title: 100 characters.
- Subtitle: 160 characters.
- Slide title: 100 characters and normally no more than two rendered lines.
- Bullet: 180 characters; at most five per content region.
- Card/process detail: 160 characters.
- Quote: 320 characters.
- Source/footer: 180 characters.
- Minimum body font: 14 pt; minimum source font: 8 pt.
- Split content when it cannot meet these limits. Do not silently truncate.
