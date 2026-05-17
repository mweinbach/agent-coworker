# Google Slides Addendum

When to read: any task where the requested final artifact is a native Google
Slides deck, a Google Slides URL, a deck that must live in Google Drive, or a
deck that will primarily be edited and collaborated on in Google Slides after
handoff.

This file supplements and overrides the main `Presentations` skill. The main
skill still owns the narrative bar, visual taste, claim spine, proof-object
quality, contact-sheet discipline, and rendered QA. This addendum changes the
delivery target from a finished `.pptx` file to a high-quality **native Google
Slides document** that remains easy to edit, share, comment on, and update after
handoff.

## Core Product Difference

PowerPoint is usually judged as a finished artifact. Google Slides is usually
judged as a living document.

That means a strong Slides deck is not merely a PowerPoint deck that survived
conversion. It should still look premium, but it must also remain:

- natively editable in Slides
- stable under browser rendering and lightweight team edits
- readable in thumbnails, presenter mode, and shared review links
- easy to duplicate, extend, and comment on without breaking the design system
- honest about what is live-linked versus static

When those goals conflict, favor the version that stays clean and native inside
Google Slides over the version that only looks better in the local PPTX render.

## Delivery Contract

For Google Slides requests:

- The user-facing deliverable is the native Google Slides deck, not the local
  `.pptx` working file used to author it.
- For a net-new Google Slides deck, author locally with the main Presentations
  workflow, then import into Google Drive as a native Google Slides presentation
  with `mcp__codex_apps__google_drive_import_presentation` and
  `upload_mode: "native_google_slides"`. Treat the local PPTX as a build
  artifact, not the final deliverable.
- Do not use Computer Use, Browser Use, blank-Google-Slides creation plus Google
  Slides write APIs, or another direct-to-Slides construction path for net-new
  Google Slides unless the user explicitly asks for that alternate workflow. If
  they do, mention first that output quality is expected to be best when a local
  `.pptx` is imported through the Google Drive plugin.
- If the Google Drive plugin is unavailable, use the plugin-install/user-elicitation
  flow to ask the user to install `google-drive@openai-curated`. If the plugin
  is available but `_import_presentation` is missing, ask the user to reinstall
  or refresh the Google Drive plugin before continuing with the native Google
  Slides deliverable.
- After import, verify the native deck through Google Slides / Drive readback,
  not by inspecting the local PPTX again.
- If the task is an edit to an existing Google Slides deck, use that deck as the
  source of truth. Do not rebuild the slide locally unless the user explicitly
  asks for a full redesign or rebuild.
- Do not claim completion from successful PPTX export alone. The task is done
  only after the native Slides artifact itself has been checked.
- Do not hand off a Slides deck made of full-slide raster images unless the user
  explicitly requested image-only slides. The deck must contain editable Slides
  objects for real content.

## Low-Latency Import Validation

Native Slides validation is required, but it should match the risk and workflow.
Do not blindly repeat the full per-slide native edit QA loop for a net-new deck
that has already passed the local Presentations render/QA loop and was only
imported from PPTX.

For a net-new Google Slides deck created by importing a locally verified PPTX,
use this fast path by default:

1. Import with native Google Slides conversion. With the Google Drive import
   connector, call `mcp__codex_apps__google_drive_import_presentation` and set
   `upload_mode` to `"native_google_slides"`.
2. Read back the imported deck once and record deck id, title, URL when
   available, slide count, slide order, and major slide titles.
3. Confirm the Drive MIME type is `application/vnd.google-apps.presentation`
   when metadata is available.
4. Compare imported slide count to the local PPTX slide count.
5. Confirm the deck is not made of slide-sized screenshots by checking that key
   titles, body text, labels, and major diagram/table objects exist as editable
   Slides content.
6. Inspect native thumbnails or a native contact-sheet view after import.
7. Fetch large per-slide thumbnails only for high-risk slides or slides that
   show visible drift in the thumbnail/contact-sheet pass.
8. Record that the fast path was used and list any high-risk slides checked in
   `$WORKSPACE/qa/comeback-scorecard.txt`.

High-risk slides include dense tables, small labels, complex charts, custom font
pairings, aggressive crops, heavy diagrams, layered transparency, and any slide
where the local PPTX render was already near a layout limit.

Use the stricter per-slide thumbnail loop when:

- editing an existing Google Slides deck
- making native Google Slides batch updates
- importing into an existing template deck
- the fast-path checks detect layout drift, missing content, or font fallback
- the user asks for final visual polish in Google Slides
- the deck is client-final, board-final, or otherwise high-stakes enough that
  conversion defects would be costly

The fast path reduces latency; it does not weaken the completion bar. API
success, PPTX export, or Drive upload alone is never sufficient.

## Google Slides Build Bias

Use the main skill's premium bar, but shift the build bias from "maximum
finished fidelity" to "maximum native usefulness at a high visual bar."

### Preserve These From The Main Skill

- claim-led titles and one clear proof object per non-appendix slide
- varied macro-layout rhythm across the contact sheet
- authored visual system, not template-pack sameness
- chart clarity, exact sourcing, brand authenticity, and strong whitespace
- aggressive QA against overlap, bad padding, weak hierarchy, and fake detail

### Modify These For Google Slides

- Prefer fewer, more robust objects over delicate stacks of narrowly aligned
  fragments.
- Prefer explicit structure over hidden complexity. A competent teammate should
  be able to duplicate a slide, replace one number, or add a new callout without
  breaking the layout.
- Use layout families that survive edits: title / section / proof / comparison /
  quote / appendix / roadmap / table / image-led, rather than one-off slide
  sculptures that only work once.
- Keep the same editorial taste, but flatten fragile depth: fewer hairline
  overlays, fewer tiny masks, fewer borderline kerning tricks, fewer nested
  transparent panels whose value disappears after import.
- Design for the browser thumbnail and for live meeting review. Strong hierarchy,
  high contrast, generous spacing, and clear slide jobs matter more than subtle
  print-like flourishes.

## Typography And Fonts

Typography is a larger constraint in Slides than in PPTX.

- Choose fonts that are available or broadly safe in Google Slides by default.
  Prefer Google / web-safe families unless the user provided a trusted template
  or exact brand requirement that is known to survive in Slides.
- For generated Google Slides decks without a trusted template, constrain font
  choices to this stability shortlist. This is not Google's full font
  capability; it is the safe set for decks that need to survive import,
  browser rendering, sharing, and team edits:
  - sans/body: `Arial`, `Roboto`, `Open Sans`, `Lato`
  - display/headline sans: `Montserrat`
  - serif/headline: `Georgia`, `Merriweather`, `Libre Baskerville`
  - mono/code: `Roboto Mono`, `Courier New`
- Use these default pairings unless the user provides a stronger direction:
  - safest: `Arial` only
  - product/business: `Roboto` only, or `Montserrat` headings with `Roboto` body
  - warm/readable: `Lato` only
  - editorial: `Merriweather` headings with `Open Sans` body
  - maximum web-safe serif: `Georgia` headings with `Arial` body
- Avoid `Aptos`, `Avenir Next`, `Helvetica Neue`, `SF Pro`, ultra-thin display
  fonts, condensed fonts, and any local/custom font unless a template or brand
  requirement proves it works in the native Slides deck.
- A single strong family with disciplined weights is often better in Slides than
  an elegant but brittle display/body pairing that may fall back after import.
- If a serif/sans pairing is essential to the art direction, verify that both
  render correctly in the imported Slides deck before delivery.
- Avoid ultra-fine weights, very tight tracking, and typography that depends on
  exact local font metrics. These are more likely to drift after conversion.
- Keep titles short enough to remain one line after import. If a title only fits
  because of a narrow font or precise kerning, shorten the copy.
- As a baseline for decks without a template, target:
  - cover/title: `42pt+`
  - slide titles: `30-36pt`
  - body: `18pt+`
  - dense appendix/table text: only go smaller when the slide is intentionally
    appendix-grade and still passes thumbnail/full-size review

## Layout And Composition

Slides decks should feel designed, but also maintainable.

- Keep composition flatter and clearer than the PPTX equivalent unless the
  user explicitly wants a cinematic, image-led showpiece.
- Prefer obvious frame logic: a viewer should quickly understand where titles,
  proof objects, captions, callouts, and sources live across the deck.
- Use fewer decorative boxes. In Slides, excessive panelization reads like a UI
  kit and also makes later edits harder.
- Use real whitespace instead of many tiny separators. A clean canvas usually
  survives Slides conversion better than a finely layered one.
- Avoid layouts where meaning depends on 1-2px alignments, microscopic rules, or
  text wrapping that only barely fits.
- If a layout requires extreme cropping, aggressive transparency, or many
  overlays to work, simplify it before import.
- Slides should still have rhythm. Do not overcorrect into bland sameness.
  Preserve 4-6 macro layout families in a 10-slide deck, but make those families
  reusable enough that a teammate could create slide 11 without starting over.

## Native Editability

Google Slides is a collaboration surface. Preserve editability where it matters.

- Titles, subtitles, body copy, labels, sources, footnotes, tables, KPI values,
  chart labels, and simple diagrams must remain editable objects.
- Use native Slides-compatible shapes, text boxes, lines, images, and tables for
  ordinary slide structure.
- For data visuals, prefer editable chart/table constructions or linked chart
  workflows when the deck is expected to stay operational. Static raster charts
  are acceptable only when the visual is decorative, sourced, or explicitly
  frozen for executive handoff.
- Keep object grouping logical. Repeated visual grammars such as KPI rails,
  timeline stages, metric comparisons, and footer systems should be easy to
  inspect and modify.
- Avoid fragile micro-fragmentation: one sentence split across many text boxes,
  decorative line segments masquerading as a continuous chart line, or objects
  whose reading order becomes incomprehensible in the Slides editor.
- If using imported PowerPoint as the build path, inspect the converted deck for
  editable slide content after import. A visually accurate but structurally
  broken Slides deck is not complete.

## Charts, Tables, And Live Data

Google Slides users often expect decks to keep changing after the meeting.

- Decide explicitly whether each chart is:
  - static presentation evidence
  - linked to a live sheet / source
  - a polished explanatory visual that should stay frozen
- If the chart should update after handoff, prefer a linked chart / Sheets-backed
  workflow and say so in the working notes. Do not silently freeze a chart that
  the deck owner will expect to refresh next week.
- If a linked chart is used, make sure the surrounding title, takeaway, and
  annotation still make sense when the numbers refresh.
- For executive storytelling slides, static authored charts are still allowed
  when they produce a much better message or labeling system than the linked
  alternative. In that case, the surrounding slide should make the static nature
  clear in the notes or QA ledger.
- Dense appendix tables are allowed, but they must remain native, legible, and
  easy to update. If the data wants a spreadsheet, do not force it into a
  precious poster-slide treatment.

## Templates And Existing Decks

When a target Google Slides deck or template already exists:

- Treat the target deck as truth for layout system, typography, spacing,
  footers, page markers, and asset behavior.
- Duplicate and fill the closest native template slide before inventing a new
  frame from scratch.
- Match the deck's collaboration grammar, not just its visual grammar. Preserve
  how title slides, section breaks, agenda pages, and appendices are expected to
  be extended by future editors.
- Do not restyle the deck slide by slide if a clean existing archetype can be
  reused.
- If the source is a PowerPoint deck and the destination is a Slides template,
  migrate by narrative job first, not by visual mimicry first.

## Speaker Experience

Slides is often presented live from the browser and reviewed asynchronously.

- Slides should read cleanly without relying on complex animations or motion.
- Use animation only when the reveal itself matters. Do not depend on PowerPoint-
  specific choreography such as Morph or Zoom to make the story work.
- Build enough context into the static slide that a reviewer opening the deck
  later can understand the point without hearing the presenter.
- Keep speaker notes useful but concise when the deck is meant for live delivery.
  Notes should explain the talk track, not compensate for a slide that lacks a
  claim or proof.

## Verification After Import Or Native Editing

The main skill's render/QA loop is necessary but not sufficient for Slides.
After import or native edits, do a second verification pass on the actual Google
Slides artifact.

Minimum verification:

1. Confirm the final deck exists as a native Google Slides presentation and not
   merely as an uploaded `.pptx`.
2. Confirm the slide count, order, and intended title/page sequence match the
   final local build.
3. Use the low-latency import validation path for net-new locally verified PPTX
   imports. Use the stricter per-slide thumbnail loop for existing deck edits,
   native batch updates, template imports, high-risk decks, or any detected
   conversion drift.
4. Confirm no obvious text overflow, clipping, overlap, broken crop, stale
   placeholder text, or font fallback drift was introduced.
5. Confirm key content remains editable: titles, body text, charts/tables where
   intended, and major diagram labels.
6. Confirm the target deck is still coherent at contact-sheet scale after import.
7. If using a template or editing an existing deck, confirm the new slide(s)
   look native to that deck rather than pasted in from another system.
8. Record the validation tier used, connector readback performed, thumbnails
   inspected, and any accepted Slides-specific limitations in the QA ledger.

If the imported Slides deck is visibly weaker than the local PPTX render, repair
the Slides deck or simplify the design. Do not hand off a fragile conversion just
because the source PPTX looked good.

## Final Handoff Rules

For Google Slides work:

- Mention the Google Slides deck as the deliverable, not the local PPTX.
- If a local PPTX was used as an intermediate build artifact, do not cite it in
  the final user-facing answer unless the user explicitly asks for both outputs.
- Briefly mention that the native Slides deck was checked after import / edit.
- If any specific limitation remains because of Slides conversion or font
  fallback, state it plainly and name the affected slide(s).

## Blocking Anti-Patterns

Fix these before delivery:

- the result is just a PowerPoint render uploaded to Drive with poor native editability
- full-slide image backgrounds carrying all meaningful content
- titles or proof objects that only work because of brittle font metrics
- microscopic text or ultra-thin rules that collapse in browser thumbnails
- overbuilt panel grids that feel like a product dashboard instead of a deck
- imported slides with broken line wraps, clipped labels, or stale placeholders
- static charts where the user will reasonably expect linked/live data
- slides that require PowerPoint-only transitions to make sense
- a deck that looks premium in export but feels hostile to duplicate, edit, or comment on in Slides
