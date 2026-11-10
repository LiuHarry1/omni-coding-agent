---
description: Create polished, editable Advantest PowerPoint presentations from a prompt, notes, data, or source files. Use for slides, decks, presentations, PPT, or PPTX. Supports a flexible professional deck.mjs authoring mode and a fast JSON mode, with measured text layout, native charts, speaker notes, structural validation, Gotenberg rendering, and visual QA.
context: inline
---

# Create PowerPoint

Create an editable `.pptx` using `assets/corporate-template.pptx` as the brand
authority. Deliver the authoring source with the deck so another agent can
reproduce and revise it.

## Choose the mode

Use **professional mode by default** for executive decks, customer-facing
presentations, architecture stories, or any request where visual quality
matters. Create a task-local `deck.mjs` and use the flexible authoring API in
`references/professional-authoring.md`.

Use **standard mode** for repeatable reports whose content fits the supported
JSON layouts. Read `references/presentation-spec.md` and create `spec.json`.
Do not force unusual content into a standard layout merely because it is
available.

## Required workflow

1. Establish audience, desired decision, language, length, brand constraints,
   available evidence, and whether current facts require verification. Ask only
   for missing information that materially changes the deck.
2. Inspect source material. Never invent numbers, dates, quotations, citations,
   customer claims, or product capabilities.
3. Read `references/storytelling.md` and write
   `artifacts/create-ppt/<deck-name>/outline.md` for decks of five or more
   slides. Every page needs a conclusion-style title, source mapping,
   transition, page type, and visual intent.
4. Read `references/design-system.md`, select professional or standard mode,
   and author in the same artifact directory.
5. Generate:

   Professional mode:

   ```bash
   node "${SKILL_DIR}/scripts/run-professional-deck.mjs" \
     "<deck.mjs>" "<output.pptx>"
   ```

   Standard mode:

   ```bash
   node "${SKILL_DIR}/scripts/create-presentation.mjs" \
     "<spec.json>" "<output.pptx>"
   ```

6. Validate:

   ```bash
   node "${SKILL_DIR}/scripts/validate-presentation.mjs" \
     "<output.pptx>" --manifest "<output.pptx.qa.json>"
   ```

7. Render every slide through Gotenberg:

   ```bash
   node "${SKILL_DIR}/scripts/render-via-gotenberg.mjs" \
     "<output.pptx>" "<render-directory>"
   ```

8. Read the montage and suspicious full-resolution slides. Apply
   `references/qa-checklist.md`; fix the authoring source and regenerate. Stop
   after three focused visual iterations and report any unresolved defect.
9. Deliver `.pptx`, `deck.mjs` or `spec.json`, `outline.md` when created, and a
   short QA status. Do not present intermediate debug files as final output.

## Authoring rules

- One slide, one takeaway. Titles state the conclusion rather than naming the
  topic.
- Use at least four page types in decks of six or more slides. Avoid identical
  adjacent layouts and repeated text-only pages.
- Use native PowerPoint text, shapes, tables, and charts whenever editability
  matters. Prefer SVG for simple diagrams and PNG/JPEG/WebP for photography.
- Use the runtime `fitText` API before adding variable text. Split content
  rather than dropping body text below 14 pt.
- Use native bullets; do not paste the `•` character. Do not reuse mutable
  PptxGenJS option objects.
- Hex colors never include `#`. Charts must use valid label/axis combinations.
- Add speaker notes when they carry context that does not belong on the slide.
- Cite time-sensitive or quantitative facts in the footer/source field.
- Decorative shapes may overlap intentionally; text, charts, tables, and
  images may not collide or leave the canvas.

## Completion gate

Do not declare success if generation or validation failed, placeholders remain,
facts are unsupported, text is clipped, an important object is rasterized
unnecessarily, or visual QA was skipped while Gotenberg was reachable.

If Gotenberg is unavailable, deliver only if structural QA passes and explicitly
state that visual QA is incomplete.

## Runtime

Baix Cloud Workspace provides Node.js 22, PptxGenJS, Sharp, Skia Canvas,
LineBreak, Fontkit, and `pdftoppm`. Do not install packages during a Skill run.
The default Gotenberg endpoint is `http://10.150.10.210:8030`; override it with
`GOTENBERG_URL` when necessary.
