# Professional authoring

Professional mode uses a task-local ES module. Export `metadata` and an async
default build function:

```js
export const metadata = {
  title: 'Decision-oriented deck title',
  subtitle: 'Optional subtitle',
  author: 'Team',
  language: 'zh-CN',
  audience: 'Engineering leadership',
  objective: 'Approve a controlled pilot',
}

export default async function build(api) {
  api.cover({ notes: 'Opening note' })
  api.text(
    'cover-title',
    metadata.title,
    { x: 0.78, y: 2.1, w: 5.7, h: 1.5 },
    { fontSize: 30, bold: true, color: api.colors.magenta },
  )

  api.newSlide({
    title: 'A conclusion-style title makes the point immediately',
    takeaway: 'Each slide has one message.',
    source: 'Source: user material §2',
  })
  const fit = api.fitText('Variable body copy', {
    width: 5,
    height: 2,
    fontFace: api.fontFace,
    maxFontSize: 20,
    minFontSize: 14,
  })
  api.text(
    'body',
    'Variable body copy',
    { x: 0.9, y: 1.8, w: 5, h: 2 },
    { fontSize: fit.size, color: api.colors.charcoal, valign: 'top' },
  )
}
```

Run:

```bash
node "${SKILL_DIR}/scripts/run-professional-deck.mjs" \
  "<deck.mjs>" "<output.pptx>"
```

## API

- `cover(options)`, `section(options)`, `newSlide(options)` start a slide.
  Start the next slide to finalize actual-object QA on the current one.
- `text(name, text, box, options)` and `shape(name, type, box, options)` add
  tracked native objects.
- `image(name, source, box, { fit })` accepts a path, Buffer, or data URI.
  `fit` is `contain` or `crop`.
- `chart(name, type, data, box, options)` and
  `table(name, rows, box, options)` add editable native PowerPoint objects.
- `notes(takeaway, notes)` adds presenter notes.
- `fitText`, `measureTextBlock`, and `measureTextWidth` use real font metrics
  and Unicode line-break opportunities.
- `svgToDataUri`, `getImageDimensions`, `imageSizingContain`, and
  `imageSizingCrop` support visual assets.
- `safeOuterShadow` returns a valid PptxGenJS shadow object.
- Brand/runtime values: `colors`, `accents`, `grid`, `page`, `fontFace`,
  `brand`, `shapeType`, and `chartType`.

## PptxGenJS safety

- Clone option objects before modifying them. PptxGenJS may normalize objects
  in place.
- Use color values such as `005777`, never `#005777`.
- Use `api.shapeType` and `api.chartType`; do not guess enum strings.
- Use `slide.addText` bullet options or a runtime component rather than a
  literal bullet glyph.
- For pie charts, use category/percentage labels. For bar, column, and line
  charts, configure axes and data labels that the chart type supports.
- Keep native charts and tables inside the safe content area. Rasterize only
  visuals that cannot be represented faithfully as editable objects.

## File contract

Place these files under `artifacts/create-ppt/<deck-name>/`:

- `outline.md` for decks of five or more slides;
- `deck.mjs`;
- final `.pptx`;
- `.pptx.qa.json` and `.pptx.validation.json`;
- `rendered/deck.pdf`, slide PNGs, and `montage.png`.
