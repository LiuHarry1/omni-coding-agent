# Storytelling

## Start with the decision

Identify:

1. Who will see the deck?
2. What should they understand, decide, or do?
3. What evidence is available?
4. What uncertainty must remain visible?

If the request is underspecified and the missing answer would materially alter
the deck, ask one focused question. Otherwise choose a reasonable business
default and record it in the outline.

## Build the argument

Use the shortest structure that supports the objective:

- Decision deck: context → evidence → options → recommendation → decision.
- Project review: goal → progress → evidence → risks → next actions.
- Technical proposal: problem → constraints → architecture → trade-offs → plan.
- Incident review: impact → timeline → causes → corrections → prevention.
- Training: outcome → mental model → demonstration → practice → recap.

Remove any slide that does not advance the argument.

## Write the outline before authoring

For five or more slides, create `outline.md` in one pass. Do not begin by
polishing the cover. Use this structure for every page:

```markdown
## P3 | A conclusion-style title
- pageType: two-column comparison
- source: user material §2, items 3–5
- transition: P2 showed the delay; P3 identifies where it occurs
- content:
  - Evidence or argument
  - Evidence or argument
- visual: editable before/after comparison with one highlighted change
```

The deck should normally cover at least four page types: cover/section,
comparison, process/timeline, chart/data, diagram/image, summary/decision.
Adjacent slides should not use the same composition. Match form to meaning:
trends use charts, sequences use flows, trade-offs use comparisons, and exact
values use tables.

Map every factual page to user material or verified research. Mark unresolved
items as `TBD—needs source`; do not silently complete them.

## Write slide titles

Titles state the conclusion, not the topic.

- Weak: “Current state”
- Strong: “Manual reconciliation delays every weekly review”
- Weak: “Architecture”
- Strong: “A three-layer design isolates enterprise data from model access”

The body proves the title. `takeaway` should match the title's claim without
repeating it word for word.

## Control density

- One primary message per slide.
- Prefer 3–5 meaningful items over exhaustive lists.
- Split a slide when two independent conclusions compete.
- Put detail in speaker notes when it helps the presenter but not the audience.
- Preserve exact values in tables; use charts for patterns and comparisons.
- Content slides normally contain one meaningful visual and 3–7 core items.
- A full paragraph rarely belongs on a slide; extract the conclusion and move
  supporting detail into notes.
- Healthy whitespace is intentional, but sparse content must not be disguised
  with empty cards or decorative placeholders.

## Preserve evidence

- Never convert an assumption into a fact.
- Keep estimates labeled as estimates.
- Do not create example KPIs that could be mistaken for real results.
- Keep source labels short on the slide and put extended context in notes.
- When evidence is missing, omit the claim or state the gap explicitly.
