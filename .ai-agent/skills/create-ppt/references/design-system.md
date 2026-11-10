# Advantest presentation design system

The bundled corporate template is the brand authority. The generator mirrors
its 16:9 canvas, Arial typography, and theme colors while producing editable
native PowerPoint objects.

## Palette

- Deep teal: `005777` — primary brand and data series.
- Orange: `FF7E00` — sharp emphasis.
- Purple: `651366` — secondary series or category.
- Green: `25993F` — positive state or supporting series.
- Cyan: `05A8B3` — supporting information.
- Magenta: `8C003D` — cover, section, and decisive emphasis.
- Charcoal: `3F3F3F` — primary text.
- Off-white: `F8F8F8` — light surface.
- White: `FFFFFF` — background and reversed text.

Use one dominant color, one or two supporting colors, and one accent. Do not
give all accents equal visual weight.

## Typography

- Latin: Arial.
- Chinese fallback: Microsoft YaHei, then Arial.
- Japanese fallback: Meiryo, then Arial.
- Cover title: 30–36 pt.
- Slide title: 24–28 pt.
- Body: 16–20 pt.
- Card/process detail: 12–15 pt.
- Source/footer: 8–10 pt.

Use the professional runtime `fitText` API for variable text. It measures the
selected font and Unicode line-break opportunities. Still leave approximately
4–8% safety because PowerPoint and Gotenberg can shape fonts differently.

## Grid

- Canvas: 13.333 × 7.5 inches.
- Outer margin: at least 0.55 inches.
- Title region: approximately 0.55–1.25 inches high.
- Content starts near 1.45 inches.
- Footer/source region begins near 6.85 inches.
- Gap between independent content blocks: at least 0.25 inches.

## Visual language

- Use light backgrounds for most evidence slides.
- Use dark or magenta-led treatment for cover, section, and closing moments.
- Prefer asymmetric 40/60 or 35/65 compositions when one element dominates.
- Use subtle tinted surfaces and whitespace rather than decorative edge bars.
- Use native charts for common quantitative comparisons.
- Use one repeated motif per deck, such as numbered circles or rounded panels.
- Keep decorative shapes subordinate to the message.

## Layout selection

- `content`: one argument plus a visual callout, not a full-slide bullet wall.
- `two_column`: exactly two comparable groups.
- `cards`: 2–4 parallel ideas with equal conceptual weight.
- `process`: 3–5 ordered steps.
- `metrics`: 2–4 verified values.
- `chart`: quantitative pattern, comparison, or trend.
- `table`: exact lookup or multi-attribute comparison.
- `image`: a real visual that carries evidence.
- `quote`: a real attributed statement.
- `summary`: decision and immediate actions.

Avoid more than two consecutive slides with the same composition.

Professional mode is not limited to these named standard layouts. Compose the
same grid, palette, and hierarchy freely when the story needs an architecture
diagram, annotated screenshot, roadmap, matrix, or other purpose-built page.
Do not create empty cards merely to preserve symmetry.

## Images and diagrams

- Use `contain` when the full image is evidence; use `crop` only when losing the
  outer area does not change meaning.
- Prefer SVG for icons and simple diagrams. Use native shapes when users are
  likely to edit labels or connectors.
- Never stretch an image by setting width and height without an aspect-ratio
  strategy.
- Photographs should be large enough to act as a focal point, not decorative
  thumbnails beside dense prose.
