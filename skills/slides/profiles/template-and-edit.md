# template-following and targeted edits

Use when the user provides an existing deck/template, asks to follow a
presentation, or asks for a narrow edit inside an existing visual system.

## Template Contract

When the user provides a template PPTX, treat it as a slide library and editable
starting point, not a theme reference. The default mode is `template-starter
adaptation`: read every source slide, choose which source slide each output
slide starts from, duplicate those slides, then edit the copied elements in
place.

Do not create a fresh layout that merely borrows palette, fonts, or vibes from
the template. Preserve the copied slide's master furniture, chrome, placeholder
frames, spacing rhythm, image wells, chart/table frames, page markers,
typography voice, and component geometry unless the user explicitly asks for
redesign.

Use artifact-tool and headless package tooling only. If those cannot inspect,
duplicate, or render the source deck, report the blocker instead of launching
desktop apps.

## Source Inspection

Before final copy or slide modules, run:

```bash
node "$SKILL_DIR/scripts/inspect_template_deck.mjs" \
  --workspace "$WORKSPACE" \
  --pptx "<source.pptx>"
```

Review all source slide PNGs, layout JSON files, `template-inspect.ndjson`,
extracted media, font evidence, and `template-manifest.json`. Do not sample only
one or two representative slides.

Then create:

- `template-audit.txt`: source system, reusable slide types, weak spots,
  do-not-copy artifacts, brand/assets, and insertion contract.
- `template-frame-map.json`: a full source slide inventory and the selected
  source slide for every output slide.
- `deviation-log.txt`: each intentional departure from a copied source slide,
  with reason and affected slides.

`template-frame-map.json` must include:

```json
{
  "outputSlides": [
    {
      "outputSlide": 1,
      "sourceSlide": 3,
      "narrativeRole": "opening thesis",
      "reuseMode": "duplicate-slide",
      "editTargets": []
    }
  ],
  "omittedSourceSlides": [
    { "sourceSlide": 4, "reason": "appendix pattern not needed" }
  ]
}
```

Every output slide requires a `sourceSlide`. Source slides may be reused multiple
times. If a source slide is omitted from the final narrative, record why in the
audit or frame map.

## Plan Against The Slide Library

Read the full template deck before writing the narrative spine. Build the story
by selecting source slides that already match the intended narrative roles:
opener, section divider, proof/chart, table, visual case study, process,
summary, appendix, or close.

If no source slide is a perfect fit, pick the closest source skeleton and edit
within its existing frames. Do not invent a custom slide just because a clean
blank layout would be easier.

`reference rebuild` is allowed only when the user explicitly says the template
is style-only, asks for redesign, or direct import/duplication is blocked. In
that case, disclose the exception in `deviation-log.txt` and still map each
rebuilt slide to its closest source slide.

## Build The Starter Deck

After `template-frame-map.json` is complete, run:

```bash
node "$SKILL_DIR/scripts/prepare_template_starter_deck.mjs" \
  --workspace "$WORKSPACE" \
  --pptx "<source.pptx>" \
  --map "$WORKSPACE/template-frame-map.json" \
  --out "$WORKSPACE/template-starter.pptx" \
  --preview-dir "$WORKSPACE/template-starter-preview" \
  --layout-dir "$WORKSPACE/template-starter-layout" \
  --contact-sheet "$WORKSPACE/template-starter-contact-sheet.png"
```

Use the starter PPTX as the authoring base. Edit copied placeholders, textboxes,
charts, tables, and images by placeholder or resolved element IDs from
`template-inspect.ndjson` whenever possible. Fill inherited component slots; do
not lay a parallel custom design over the copied template slide.

If a copied slide cannot be edited cleanly, choose a different source slide and
rerun the starter deck script. Do not switch to a fresh theme-matched layout
without the explicit exception above.

## Targeted Edits

For data edits:

- Compute first, design second.
- Show formulas or calculation definitions in notes or appendix when useful.
- Rank and conclude from the computed result, not visual intuition.
- Insert the result into an inherited table/chart/metric frame whenever
  practical.

For media edits:

- Verify identity/source before using headshots or logos.
- Never replace missing logos, app icons, mascots, or product UI with
  hand-drawn lookalikes or pseudo-official marks.
- Normalize crops, background treatment, and image size.
- Do not damage existing slide alignment.

For new real-world subjects, products, screenshots, people, places, events, or
evidence, resolve public or official raster assets and swap them into inherited
frames. Do not generate fake screenshots, fake UI, fake logos, fake product
images, fake evidence, or generated approximations of real entities.

## QA

Export the final deck, render final slide previews with artifact-tool, and
review each adapted output slide against its mapped source slide render.

Blocking defects:

- output slide has no `sourceSlide` mapping
- output slide was rebuilt from template theme instead of duplicated from the
  mapped source slide
- missing chrome or master furniture from the mapped source slide
- unsupported SVG/EMF/vector placeholders
- blank image wells
- shifted component fills or template frame drift
- title/body/footer collisions
- font substitutions that materially break parity
- new palette/type/surface language when redesign was not requested
- missing source-vs-output preview review
- unverified identities, inconsistent headshot crops, or local layout damage

Patch and rerun previews before final response.
