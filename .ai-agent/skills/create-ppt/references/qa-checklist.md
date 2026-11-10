# Presentation quality checklist

Review the rendered montage first, then inspect every suspicious full-resolution
PNG. A clean authoring preview does not prove the exported PPTX is clean.

## A. Blocking checks

- The PPTX opens without a repair warning.
- The expected number and order of slides are present.
- No text is clipped, cut off, or below the minimum readable size.
- No element leaves the slide boundary.
- No text, chart, image, source, or footer overlaps unintentionally.
- No placeholder, lorem ipsum, TODO, sample value, or empty content block remains.
- Every metric, chart, quote, and factual claim has a known basis.
- Images preserve aspect ratio and are not visibly pixelated.
- Text, tables, charts, and simple diagrams remain editable.
- The rendered slide contains real content rather than a blank, loading, or
  failed-script state.

## B. Information density

- Every non-cover content slide has a visual element: chart, diagram, image,
  table, comparison, process, or meaningful data card.
- A content slide normally has 3–7 core items; split longer inventories.
- No paragraph exceeds roughly 80 characters without a strong reason.
- No empty image slot, empty card, or visual placeholder remains.
- Data pages use charts for patterns rather than numbers plus explanatory prose.
- Connector lines terminate at their intended objects.
- Important quantified claims show a compact source.

## C. Visual checks

- Every slide has one obvious focal point.
- The title and body communicate the same takeaway.
- Margins, columns, and repeated elements align consistently.
- Similar blocks have even spacing.
- Contrast is sufficient in both light and dark treatments.
- Titles normally occupy no more than two lines.
- Charts use direct labels or a compact legend and avoid unnecessary gridlines.
- Sources remain readable without competing with the content.
- Layouts vary with the content; the deck does not look like repeated cards.
- Cover, content, and closing slides feel like one coherent system.
- Emphasis is restrained: no more than two or three competing highlights on a
  page.
- Important text keeps a safe bottom margin and does not sit against a card
  edge.

## D. Content and presenter checks

- The deck has a clear audience and objective.
- The narrative reaches the requested decision or outcome.
- Each slide advances the argument.
- The order is logical and transitions are understandable.
- Wording is concise, grammatical, and consistent in the selected language.
- Estimates, targets, and unavailable data remain explicitly labeled.
- Speaker notes preserve useful presenter context without repeating the slide
  verbatim.
- Page transitions support one coherent story instead of a collection of
  independent templates.

## Iteration

Fix in this order: overflow/overlap/blank output, missing visuals or data
representation, alignment/type/spacing, then story-transition polish. Make a
focused source edit, regenerate, and re-render. Stop after three visual
iterations; report the remaining issue and recommended next action rather than
claiming a pass.

## Delivery

- Structural validation reports zero errors.
- The Gotenberg render contains the same number of pages as the PPTX.
- The montage and every suspicious full-size slide have been inspected.
- Any QA warning is either fixed or explicitly documented as intentional.
