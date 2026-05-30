---
name: documents
description: Create, edit, redline, and comment on `.docx` files inside the container, with a strict render-and-verify workflow. Use `render_docx.py` to generate page PNGs (and optional PDF) for visual QA, then iterate until layout is flawless before delivering the final DOCX.
---

# Documents Skill (Read • Create • Edit • Redline • Comment)

Use this skill when you need to create or modify `.docx` files **in this container environment** and verify them visually.

## Tools + Contract

- Use the Cowork-managed artifact runtime for docx artifact work: its bundled Node/Python runtimes and package directory are authoritative. Do not use system `node`, system `python`, global npm packages, or repo-local installs.
- For document creation and deterministic OOXML edits, it is still acceptable to use the bundled Python/OOXML helper scripts in this skill package when the JS surface is incomplete.
- Run any builder or helper file from a writable workspace or temp directory, not from the managed dependency directory itself.
- Final user-facing responses should describe only the requested document result and link only to the final `.docx` deliverable unless the user explicitly asks for QA intermediates.

## Non-negotiable: render → inspect PNGs → iterate

**You do not “know” a DOCX is satisfactory until you’ve rendered it and visually inspected page images.**
DOCX text extraction (or reading XML) will miss layout defects: clipping, overlap, missing glyphs, broken tables, spacing drift, and header/footer issues.

**Shipping gate:** before delivering any DOCX, you must:
- Run `render_docx.py` to produce `page-<N>.png` images (optionally also a PDF with `--emit_pdf`)
- Open the PNGs (100% zoom) and confirm every page is clean
- If anything looks off, fix the DOCX and **re-render** (repeat until flawless)

If rendering fails because LibreOffice/`soffice` is missing, first attempt to install LibreOffice using the environment's normal approved installation path. If installation is not approved by the user, is unavailable, or still does not produce a working renderer, it is acceptable to return the requested DOCX without rendered PNG QA. In that fallback case, use the relevant Markdown task docs in this skill package as the authoritative guidance for building and checking the document structurally, state clearly in the final response that rendering/visual QA could not be completed, and do not imply that the document passed the render gate.

If rendering fails for any other reason, fix rendering first (LibreOffice profile/HOME, conversion errors, or renderer setup) rather than guessing.

**Deliverable discipline:** Rendered artifacts (PNGs and optional PDFs) are for internal QA only. Unless the user explicitly asks for intermediates, **return only the requested final deliverable** (e.g., when the task asks for a DOCX, deliver the DOCX — not page images or PDFs).




## Default DOCX Construction Contract

Use these defaults for new DOCX creation and major rewrites unless the user explicitly asks for a different layout. For existing-document edit tasks, preserve the original document and apply the minimal local edits described later in this skill.

Important: a clean Codex preview or rendered PNG pass is not enough by itself when the underlying Word geometry is wrong. Tables and lists must use Word-compatible structure, not just visual approximations.

### Page geometry and typography

- Page: US Letter, 8.5 x 11 inches.
- Margins: 1 inch on all sides unless the user requests otherwise.
- Widths: 1440 DXA = 1 inch; under the default margins, usable content width is 9360 DXA.
- Body: Arial, 12pt, 1.08 line spacing, 0pt before and 6pt after paragraphs.
- Title: 22pt bold, black or a restrained document accent, with clear spacing after.
- Subtitle: 12pt regular or muted, directly under the title when needed.
- Heading 1: 16pt bold, 12pt before and 6pt after.
- Heading 2: 14pt bold, 10pt before and 4pt after.
- Heading 3: 12pt bold, 8pt before and 3pt after.
- Use document styles for Normal, Title, Subtitle, Heading 1, Heading 2, and Heading 3. Do not fake headings with one-off bold/size changes on Normal paragraphs.

### Page furniture and headers

- For polished new documents, use a quiet running header by default: a small muted document label at the top of each page with a thin full-width rule beneath it.
- Keep the main title, subtitle, dates, and metadata in the body of the first page. The running header should identify the document, not compete with the title.
- For multi-page professional documents, add a muted right-aligned page-number footer by default.
- Keep page furniture consistent across pages: same header label placement, rule width, footer placement, and spacing.
- Use restrained styling. Avoid heavy branding, decorative header blocks, improvised header tables, or large repeated titles in the running header.

### Word-compatible tables

- Use tables only for tabular information, not as divider lines, spacing hacks, or two-column text layout. Use paragraph borders, tab stops, or proper headers/footers for rules and alignment.
- Use DXA table widths only. Do not use percentage widths for generated tables.
- Standard content tables and metadata tables should default to full content width. Under the default page setup, use 9360 DXA.
- Align tables flush with the body text column and nearby subheaders by default. A full-width table should start at the same left edge as the section text and span the content width; do not center tables or add extra left indentation unless the user asks for it.
- The acceptance check is the rendered outer table border, not just the XML. If Word or LibreOffice renders a nominally left-aligned table a little left or right of the text column, adjust the explicit table indent/alignment until the visible table border is flush with the subheader/body left edge.
- Use narrower tables only when the user asks for a compact object or the table is intentionally not a primary content table.
- Choose column widths by content. Short fields such as status, date, owner, score, yes/no, and IDs should be compact; narrative columns should get the remaining width.
- After all rows are created, normalize the table geometry so `tblW`, `tblGrid`, and every row's `tcW` agree. The table width must equal the sum of grid column widths, and each cell width must match its column.
- In Python, use `scripts/table_geometry.py` for this normalization. Build the table rows first, compute exact DXA column widths with `column_widths_from_weights(...)` or `exact_column_widths(...)`, then call `apply_table_geometry(table, widths, table_width_dxa=sum(widths), indent_dxa=0)`. This is the python-docx equivalent of the docx-js `width` + `columnWidths` + cell `width` pattern: it writes `tblW`, `tblGrid/gridCol`, every `tcW`, fixed table layout, left alignment, and cell margins together.
- Do not rely on autofit to rescue bad geometry. Prefer fixed, explicit widths that Word, Google Docs, LibreOffice, and Codex preview can all interpret conservatively.
- Add cell margins/padding on every table. A good default is 80 DXA top/bottom and 120 DXA left/right, adjusted upward when the table feels cramped.
- Never set fixed row heights that can clip text. Let rows expand, use readable wrapping, and reduce font size only after width and wrapping choices are correct.
- For multi-page tables, repeat the header row and keep the same column order and widths across page breaks.
- Default visual treatment is a simple full-width grid: white body cells, thin light-gray borders, dark body text, and no zebra striping.
- Prefer a plain built-in Word table style such as `Table Grid` as the baseline. Use a lightly shaded header row only when it stays subtle; do not use saturated dark header bars, heavy fills, or blue body text unless the user asks for a branded design.
- Header rows should use modest bold text and either white fill or a very light tint. Borders should remain thin and quiet.
- For document metadata near the title, prefer a full-width metadata table with compact labels, comfortable padding, consistent column widths, and the same simple grid treatment. Avoid multicolor label bands by default.

### Word-compatible lists

- Never create fake lists with Unicode bullets, hyphen-prefixed bullets, manually typed numbers, or newline-separated items inside one paragraph.
- Use real Word numbering/list paragraphs for bullets and numbered lists.
- Default list indent: marker position 360 DXA from the body left edge; item text starts at 720 DXA with a 360 DXA hanging indent. This creates equal left-side air before the marker and between the marker and text, so the bullet circle is indented relative to the subheading instead of sitting on the same left edge.
- The first list item must use the same real list style and indentation as the rest of the list. It must not sit flush with the heading or body left edge.
- Prefer a small, light bullet marker from a real Word list style. Do not type oversized manual bullet characters into the paragraph text.
- Make each list item its own paragraph, including list items inside table cells.
- Use the same list definition when numbering should continue. Use a separate list definition only when numbering should restart.
- Keep list spacing compatible with body text unless the document style calls for tighter or looser spacing.

#### List rhythm and spacing

- Give the list lead-in or subheading clear separation from the first item; lists should not feel pinned to the title above them.
- Default list lead-in rhythm: keep about 32px of rendered vertical space after the lead-in/subheading before the first bullet.
- Default list-item rhythm: tune paragraph spacing so the rendered gap between consecutive bullet items is about 32px. Start with 0pt before / 8pt after at the default render scale, then adjust after visual QA if the rendered PNG does not show roughly 32px.
- Use the same 32px rendered gap for executive-facing or skim-first documents unless the user asks for a looser list.
- Do not let same-style/contextual spacing suppression collapse the gap between consecutive list items. If the renderer shows much more or less than 32px between bullets, adjust paragraph-after spacing until the rendered page matches the 32px target.
- Do not insert blank paragraphs between bullets. Use paragraph spacing on the list style.
- Wrapped bullet lines must align under the item text, not under the bullet marker.

### Structural QA before final render review

Before the final render-and-visual review, inspect or audit the DOCX for common construction mistakes:

- Fake bullets, hyphen bullets, manually typed numbering, or multi-item lists inside one paragraph.
- Missing explicit page size or margins.
- Fake headings made from Normal paragraphs with direct formatting.
- Heading styles missing outline levels when TOC/navigation behavior matters.
- Tables missing explicit width, grid columns, or cell widths.
- Tables with percentage widths, inconsistent `tblW` / `tblGrid` / `tcW`, or total width beyond the page margins.
- Tables that have not passed `python scripts/table_geometry.py <docx>` or an equivalent structural audit after generation.
- Table cells missing margins/padding, text pinned to borders, fixed row heights, or missing repeated header rows on multi-page tables.
- Divider or layout tables that should be paragraph borders, tab stops, section structure, or header/footer content instead.
- Heavy table styling by default: saturated dark headers, zebra striping, colored body text, multicolor metadata labels, or thick borders.
- Cramped lists, bullets stuck too close to the heading above, oversized bullet markers, bullet markers flush with the heading/body left edge, first bullets with different indentation from the rest of the list, rendered table borders offset from the subheader/body left edge, tables that are centered/indented instead of flush with the subheader/body left edge, tables that do not use full width without a clear reason, or inconsistent/missing running headers.

## Design standards for document generation

For generating new documents or major rewrite/repackages, follow the design standards below unless the user explicitly requests otherwise. The user's instructions always take precedence; otherwise, adhere to these standards.

When creating the document design, do not compromise on the content and make factual/technical errors. Do not produce something that looks polished but not actually what the user requested.

It is very important that the document is professional and aesthetically pleasing. As such, you should follow this general workflow to make your final delivered document:

1. Before you make the DOCX, please first think about the high-level design of the DOCX:
   - Before creating the document, decide what kind of document it is (for example, a memo, report, SOP, workflow, form, proposal, or manual) and design accordingly. In general, you shall create documents which are professional, visually polished, and aesthetically pleasing. However, you should also calibrate the level of styling to the document's purpose: for formal, serious, or highly utilitarian documents, visual appeal should come mainly from strong typography, spacing, hierarchy, and overall polish rather than expressive styling. The goal is for the document's visual character to feel appropriate to its real-world use case, with readability and usability always taking priority.
   - You should make documents that feel visually natural. If a human looks at your document, they should find the design natural and smooth. This is very important; please think carefully about how to achieve this.
   - Think about how you would like the first page to be organized. How about subsequent pages? What about the placement of the title? What does the heading ladder look like? Should there be a clear hierarchy? etc
   - Would you like to include visual components, such as tables, callouts, checklists, images, etc? If yes, then plan out the design for each component.
   - Think about the general spacing and layout. What will be the default body spacing? What page budget is allocated between packaging and substance? How will page breaks behave around tables and figures, since we must make sure to avoid large blank gaps, keep captions and their visuals together when possible, and keep content from becoming too wide by maintaining generous side margins so the page feels balanced and natural.
   - Think about font, type scale, consistent accent treatment, etc. Try to avoid forcing large chunks of small text into narrow areas. When space is tight, adjust font size, line breaks, alignment, or layout instead of cramming in more text.
2. Once you have a working DOCX, continue iterating until the entire document is polished and correct. After every change or edit, render the DOCX and review it carefully to evaluate the result. If LibreOffice/`soffice` is missing, attempt to install LibreOffice first; if the user does not approve installation or installation is unavailable, continue using the relevant Markdown task docs in this skill package for structural QA and document-design guidance, and disclose that visual render QA was skipped. The plan from (1) should guide you, but it is only a flexible draft; you should update your decisions as needed throughout the revision process. Important: each time you render and reflect, you should check for both:

   1. Design aesthetics: the document should be aesthetically pleasing and easy to skim. Ask yourself: if a human were to look at my document, would they find it aesthetically nice? It should feel natural, smooth, and visually cohesive.
   2. Formatting issues that need to be fixed: e.g. text overlap, overflow, cramped spacing between adjacent elements, awkward spacing in tables/charts, awkward page breaks, etc. This is super important. Do not stop revising until all formatting issues are fixed.

While making and revising the DOCX, please adhere to and check against these quality reminders, to ensure the deliverable is visually high quality:

- Document density: Try to avoid having verbose dense walls of text, unless it's necessary. Avoid long runs of consecutive plain paragraphs or too many words before visual anchors. For some tasks this may be necessary (i.e. verbose legal documents); in those cases ignore this suggestion.
- Font: Use professional, easy-to-read font choices with appropriate size that is not too small. Usage of bold, underlines, and italics should be professional.
- Color: Use color intentionally for titles, headings, subheadings, and selective emphasis so important information stands out in a visually appealing way. The palette and intensity should fit the document's purpose, with more restrained use where a formal or serious tone is needed.
- Visuals: Consider using tables, diagrams, and other visual components when they improve comprehension, navigation, or usability.
- Tables: Please invest significant effort to make sure your tables are well-made and aesthetically/visually good. Below are some suggestions, as well as some hard constraints that you must relentlessly check to make sure your table satisfies them.
  - Suggestions:
    - Set deliberate table/cell widths and heights instead of defaulting to full page width.
    - Choose column widths intentionally rather than giving every column equal width by default. Very short fields (for example: item number, checkbox, score, result, year, date, or status) should usually be kept compact, while wider columns should be reserved for longer content.
    - Avoid overly wide tables, and leave generous side margins so the layout feels natural.
    - Keep all text vertically centered and make deliberate horizontal alignment choices.
    - Ensure cell height avoids a crowded look. Leave clear vertical spacing between a table and its caption or following text.
  - Hard constraints:
    - To prevent clipping/overflow:
      - Never use fixed row heights that can truncate text; allow rows to expand with wrapped content.
      - Ensure cell padding and line spacing are sufficient so descenders/ascenders don't get clipped.
      - If content is tight, prefer (in order): wrap text -> adjust column widths -> reduce font slightly -> abbreviate headers/use two-line headers.
    - Padding / breathing room: Ensure text doesn't sit against cell borders or look "pinned" to the upper-left. Favor generous internal padding on all sides, and keep it consistent across the table.
    - Vertical alignment: In general, you should center your text vertically. Make sure that the content uses the available cell space naturally rather than clustering at the top.
    - Horizontal alignment: Do not default all body cells to top-left alignment. Choose horizontal alignment intentionally by column type: centered alignment often works best for short values, status fields, dates, numbers, and check indicators; left alignment is usually better for narrative or multi-line text.
    - Line height inside cells: Use line spacing that avoids a cramped feel and prevents ascenders/descenders from looking clipped. If a cell feels tight, adjust wrapping/width/padding before shrinking type.
    - Width + wrapping sanity check: Avoid default equal-width columns when the content in each column clearly has different sizes. Avoid lines that run so close to the right edge that the cell feels overfull. If this happens, prefer wrapping or column-width adjustments before reducing font size.
    - Spacing around tables: Keep clear separation between tables and surrounding text (especially the paragraph immediately above/below) so the layout doesn't feel stuck together. Captions and tables should stay visually paired, with deliberate spacing.
    - Quick visual QA pass: Look for text that appears "boundary-hugging", specifically content pressed against the top or left edge of a cell or sitting too close beneath a table. Also watch for overly narrow descriptive columns and short-value columns whose contents feel awkwardly pinned. Correct these issues through padding, alignment, wrapping, or small column-width adjustments.
- Forms / questionnaires: Design these as a usable form, not a spreadsheet.
  - Prioritize clear response options, obvious and well-sized check targets, readable scale labels, generous row height, clear section hierarchy, light visual structure. Please size fields and columns based on the content they hold rather than by equal-width table cells.
  - Use spacing, alignment, and subtle header/section styling to organize the page. Avoid dense full-grid borders, cramped layouts, and ambiguous numeric-only response areas.
- Coherence vs. fragmentation: In general, try to keep things to be one coherent representation rather than fragmented, if possible.
  - For example, don't split one logical dataset across multiple independent tables unless there's a clear, labeled reason.
  - For example, if a table must span across pages, continue to the next page with a repeated header and consistent column order
- Background shapes/colors: Where helpful, consider section bands, note boxes, control grids, or other visual containers with suitable colors to improve scanability and communication. Use them when they suit the document type. If you do use these, make sure they are formatted well, with no overlaps, awkward spacing, etc.
- Spacing: Please check rigorously for spacing issues. Please always use a natural amount of spacing between adjacent components. Use clear, generous vertical spacing between sections and paragraphs, and leave a bit of extra space between subheadings and the content that follows when it improves readability. Use indentation and alignment intentionally so the document's hierarchy is immediately clear. At the same time, avoid large "layout gaps" caused by a table or chart not fitting at the bottom of a page and getting pushed to the next one. If this happens, please try these suggestions:
  - moving the preceding paragraph(s) with it to the next page to keep the narrative cohesive
  - scaling the visual modestly or simplify labels without hurting readability, formatting, or aesthetics of the visual
  - Splitting the table/figure cleanly across multiple pages, but use repeated headers to make the page continuation clear.
- Text boxes: For text boxes, please follow the same breathing-room rules as the tables: make sure to use generous internal padding, intentional alignment, and sufficient line spacing so text never feels cramped, clipped, or pinned to the edges. Keep spacing around the text box clear so it remains visually distinct from surrounding content, and if the content feels tight, prefer adjusting box size, padding, or text wrapping before reducing font size.
- Layout/archetype: Remember to choose the right document archetype/template (proposal, SOP, workflow, form, handbook, etc.). Use a coherent style system. Once a style system is chosen, apply it consistently across headings, spacing, table treatments, callouts, and accent usage. If appropriate to the document type, include a cover page or front-matter elements such as title, subtitle, metadata, or branding.

### Editing tasks (DOCX edits) — apply instead of major rewrite behavior

When the user asks to edit an existing document, preserve the original and make minimal, local changes:

- Prefer inline edits (small replacements) over rewriting whole paragraphs.
- Use clear inline annotations/comments at the point of change (margin comments or comment markers). Don’t move all feedback to the end.
- Keep the original structure unless there’s a strong reason; if a restructure is needed, do it surgically and explain via comments.
- Don’t “cross out everything and rewrite”; avoid heavy, blanket deletions. The goal is trackable improvements, not a fresh draft unless explicitly requested.

## Quick start (common one-liners)

```bash
# 1) Render any DOCX to PNGs (visual QA)
python render_docx.py input.docx --output_dir out

# 2) Remove reviewer comments (finalization)
python scripts/comments_strip.py input.docx --out no_comments.docx

# 3) Accept tracked changes (finalization)
python scripts/accept_tracked_changes.py input.docx --mode accept --out accepted.docx

# 4) Accessibility audit (+ optional safe fixes)
python scripts/a11y_audit.py input.docx
python scripts/a11y_audit.py input.docx --out_json a11y_report.json
python scripts/a11y_audit.py input.docx --fix_image_alt from_filename --out a11y_fixed.docx

# 5) Redact sensitive text (layout-preserving by default)
python scripts/redact_docx.py input.docx redacted.docx --emails --phones
```

## Package layout

This skill is organized for progressive discovery: start here, then jump into task- or OOXML-specific docs.

DOCS SKILL PACKAGE

Root:
- SKILL.md: short overview + routing
- manifest.txt: machine-readable list of files to download (one relative path per line)
- render_docx.py: canonical DOCX→PNG renderer (container-safe LO profile + writable HOME + verbose logs)

Tasks:
- tasks/read_review.md
- tasks/create_edit.md
- tasks/verify_render.md
- tasks/accessibility_a11y.md
- tasks/comments_manage.md
- tasks/protection_restrict_editing.md
- tasks/privacy_scrub_metadata.md
- tasks/multi_doc_merge.md
- tasks/style_lint_normalize.md
- tasks/forms_content_controls.md
- tasks/captions_crossrefs.md
- tasks/redaction_anonymization.md
- tasks/clean_tracked_changes.md
- tasks/compare_diff.md
- tasks/templates_style_packs.md
- tasks/watermarks_background.md
- tasks/footnotes_endnotes.md
- tasks/fixtures_edge_cases.md
- tasks/navigation_internal_links.md

OOXML:
- ooxml/tracked_changes.md
- ooxml/comments.md
- ooxml/hyperlinks_and_fields.md
- ooxml/rels_and_content_types.md

Troubleshooting:
- troubleshooting/libreoffice_headless.md
- troubleshooting/run_splitting.md

Scripts:

**Core building blocks (importable helpers):**
- `scripts/docx_ooxml_patch.py` — low-level OOXML patch helper (tracked changes, comments, hyperlinks, relationships). Other scripts reuse this.
- `scripts/fields_materialize.py` — materialize `SEQ`/`REF` field *display text* for deterministic headless rendering/QA.
- `scripts/table_geometry.py` — apply/audit exact Word table geometry for python-docx tables (`tblW`, `tblGrid`, and every `tcW` match).

**High-leverage utilities (also importable, but commonly invoked as CLIs):**
- `render_docx.py` — canonical DOCX → PNG renderer (optional PDF via `--emit_pdf`; do not deliver intermediates unless asked).
- `scripts/render_and_diff.py` — render + per-page image diff between two DOCXs.
- `scripts/content_controls.py` — list / wrap / fill Word content controls (SDTs) for forms/templates.
- `scripts/captions_and_crossrefs.py` — insert Caption paragraphs for tables/figures + optional bookmarks around caption numbers.
- `scripts/insert_ref_fields.py` — replace `[[REF:bookmark]]` markers with real `REF` fields (cross-references).
- `scripts/internal_nav.py` — add internal navigation links (static TOC + Top/Bottom + figN/tblN jump links).
- `scripts/style_lint.py` — report common formatting/style inconsistencies.
- `scripts/style_normalize.py` — conservative cleanup (clear run-level overrides; optional paragraph overrides).
- `scripts/redact_docx.py` — layout-preserving redaction/anonymization.
- `scripts/privacy_scrub.py` — remove personal metadata + `rsid*` attributes.
- `scripts/set_protection.py` — restrict editing (read-only / comments / forms).
- `scripts/comments_extract.py` — extract comments to JSON (text, author/date, resolved flag, anchored snippets).
- `scripts/comments_strip.py` — remove all comments (final-delivery mode).

**Audits / conversions / niche helpers:**
- `scripts/fields_report.py`, `scripts/heading_audit.py`, `scripts/section_audit.py`, `scripts/images_audit.py`, `scripts/footnotes_report.py`, `scripts/watermark_audit_remove.py`
- `scripts/xlsx_to_docx_table.py`, `scripts/docx_table_to_csv.py`
- `scripts/insert_toc.py`, `scripts/insert_note.py`, `scripts/apply_template_styles.py`, `scripts/accept_tracked_changes.py`, `scripts/make_fixtures.py`

**v7 additions (stress-test helpers):**
- `scripts/watermark_add.py` — add a detectable VML watermark object into an existing header.
- `scripts/comments_add.py` — add multiple comments (by paragraph substring match) and wire up comments.xml plumbing if needed.
- `scripts/comments_apply_patch.py` — append/replace comment text and mark/clear resolved state (`w:done=1`).
- `scripts/add_tracked_replacements.py` — generate tracked-change replacements (`<w:del>` + `<w:ins>`) in-place.
- `scripts/a11y_audit.py` — audit a11y issues; can also apply simple fixes via `--fix_table_headers` / `--fix_image_alt`.
- `scripts/flatten_ref_fields.py` — replace REF/PAGEREF field blocks with their cached visible text for deterministic rendering.

> `scripts/xlsx_to_docx_table.py` also marks header rows as repeating headers (`w:tblHeader`) to improve a11y and multi-page tables.

Examples:
- examples/end_to_end_smoke_test.md

> Note: `manifest.txt` is **machine-readable** and is used by download tooling. It must contain only relative file paths (one per line).


## Coverage map (scripts ↔ task guides)

This is a quick index so you can jump from a helper script to the right task guide.

### Layout & style
- `style_lint.py`, `style_normalize.py` → `tasks/style_lint_normalize.md`
- `apply_template_styles.py` → `tasks/templates_style_packs.md`
- `section_audit.py` → `tasks/sections_layout.md`
- `heading_audit.py` → `tasks/headings_numbering.md`

### Figures / images
- `images_audit.py`, `a11y_audit.py` → `tasks/images_figures.md`, `tasks/accessibility_a11y.md`
- `captions_and_crossrefs.py` → `tasks/captions_crossrefs.md`

### Tables / spreadsheets
- `table_geometry.py` → root `Default DOCX Construction Contract` table geometry rules
- `xlsx_to_docx_table.py` → `tasks/tables_spreadsheets.md`
- `docx_table_to_csv.py` → `tasks/tables_spreadsheets.md`

### Fields & references
- `fields_report.py`, `fields_materialize.py` → `tasks/fields_update.md`
- `insert_ref_fields.py`, `flatten_ref_fields.py` → `tasks/fields_update.md`, `tasks/captions_crossrefs.md`
- `insert_toc.py` → `tasks/toc_workflow.md`

### Review lifecycle (comments / tracked changes)
- `add_tracked_replacements.py`, `accept_tracked_changes.py` → `tasks/clean_tracked_changes.md`
- `comments_add.py`, `comments_extract.py`, `comments_apply_patch.py`, `comments_strip.py` → `tasks/comments_manage.md`

### Privacy / publishing
- `privacy_scrub.py` → `tasks/privacy_scrub_metadata.md`
- `redact_docx.py` → `tasks/redaction_anonymization.md`
- `watermark_add.py`, `watermark_audit_remove.py` → `tasks/watermarks_background.md`

### Navigation & multi-doc assembly
- `internal_nav.py` → `tasks/navigation_internal_links.md`
- `merge_docx_append.py` → `tasks/multi_doc_merge.md`

### Forms & protection
- `content_controls.py` → `tasks/forms_content_controls.md`
- `set_protection.py` → `tasks/protection_restrict_editing.md`

### QA / regression
- `render_and_diff.py`, `render_docx.py` → `tasks/compare_diff.md`, `tasks/verify_render.md`
- `make_fixtures.py` → `tasks/fixtures_edge_cases.md`
- `docx_ooxml_patch.py` → used across guides for targeted patches

## Skill folder contents
- `tasks/` — task playbooks (what to do step-by-step)
- `ooxml/` — advanced OOXML patches (tracked changes, comments, hyperlinks, fields)
- `scripts/` — reusable helper scripts
- `examples/` — small runnable examples

## Default workflow (80/20)

**Rule of thumb:** every meaningful edit batch must end with a render + PNG review. No exceptions.
"80/20" here means: follow the simplest workflow that covers *most* DOCX tasks reliably.

**Golden path (don’t mix-and-match unless debugging):**
1. **Author/edit with `python-docx`** (paragraphs, runs, styles, tables, headers/footers).
2. **Render → inspect PNGs immediately** (DOCX → PNGs). Treat this as your feedback loop.
3. **Fix and repeat** until the PNGs are visually perfect.
4. **Only if needed**: use OOXML patching for tracked changes, comments, hyperlinks, or fields.
5. **Re-render and inspect again** after *any* OOXML patch or layout-sensitive change.
6. **Deliver only after the latest PNG review passes** (all pages, 100% zoom).

## Visual review (recommended)
Use the packaged renderer (dedicated LibreOffice profile + writable HOME):

```bash
python render_docx.py /mnt/data/input.docx --output_dir /mnt/data/out
# If debugging LibreOffice:
python render_docx.py /mnt/data/input.docx --output_dir /mnt/data/out --verbose
# Optional: also write <input_stem>.pdf to --output_dir (for debugging/archival):
python render_docx.py /mnt/data/input.docx --output_dir /mnt/data/out --emit_pdf
```

Then inspect the generated `page-<N>.png` files.

**Success criteria (render + visual QA):**
- PNGs exist for each page
- Page count matches expectations
- **Inspect every page at 100% zoom** (no “spot check” for final delivery)
- No clipping/overlap, no broken tables, no missing glyphs, no header/footer misplacement

**Note:** LibreOffice sometimes prints scary-looking stderr (e.g., `error : Unknown IO error`) even when output is correct. Treat the render as successful if the PNGs exist and look right (and if you used `--emit_pdf`, the PDF exists and is non-empty).

### What rendering does and doesn’t validate

- **Great for:** layout correctness, fonts, spacing, tables, headers/footers, and whether **tracked changes** visually appear.
- **Not reliable for:** **comments** (often not rendered in headless PDF export). For comments, also do **structural checks** (comments.xml + anchors + rels + content-types).

## Quality reminders
- Don’t ship visible defects (clipped/overlapping text, broken tables, unreadable glyphs).
- Don’t leak tool citation tokens into the DOCX (convert them to normal human citations).
- Prefer ASCII punctuation (avoid exotic Unicode hyphens/dashes that render inconsistently).

## Where to go next
- If the task is **reading/reviewing**: `tasks/read_review.md`
- If the task is **creating/editing**: `tasks/create_edit.md`
- If you need an **accessibility audit** (alt text, headings, tables, links): `tasks/accessibility_a11y.md`
- If you need to **extract or remove comments**: `tasks/comments_manage.md`
- If you need to **restrict editing / make read-only**: `tasks/protection_restrict_editing.md`
- If you need to **scrub personal metadata** (author/rsid/custom props): `tasks/privacy_scrub_metadata.md`
- If you need to **merge/append DOCXs**: `tasks/multi_doc_merge.md`
- If you need **format consistency / style cleanup**: `tasks/style_lint_normalize.md`
- If you need **forms / content controls (SDTs)**: `tasks/forms_content_controls.md`
- If you need **captions + cross-references**: `tasks/captions_crossrefs.md`
- If you need **redaction/anonymization**: `tasks/redaction_anonymization.md`
- If the task is **verification/raster review**: `tasks/verify_render.md`
- If your render looks wrong but content is right (stale fields): `tasks/fields_update.md`
- If you need a **Table of Contents**: `tasks/toc_workflow.md`
- If you need **internal navigation links** (static TOC + Back-to-TOC + Top/Bottom): `tasks/navigation_internal_links.md`
- If headings/numbering/TOC levels are messy: `tasks/headings_numbering.md`
- If you have mixed portrait/landscape or margin weirdness: `tasks/sections_layout.md`
- If images shift or overlap across renderers: `tasks/images_figures.md`
- If you need spreadsheet ↔ table round-tripping: `tasks/tables_spreadsheets.md`
- If you need **tracked changes (redlines)**: `ooxml/tracked_changes.md`
- If you need **comments**: `ooxml/comments.md`
- If you need **hyperlinks/fields/page numbers/headers**: `ooxml/hyperlinks_and_fields.md`
- If LibreOffice headless is failing: `troubleshooting/libreoffice_headless.md`
- If you need a **clean copy** with tracked changes accepted: `tasks/clean_tracked_changes.md`
- If you need to **diff two DOCXs** (render + per-page diff): `tasks/compare_diff.md`
- If you need **templates / style packs (DOTX)**: `tasks/templates_style_packs.md`
- If you need **watermark audit/removal**: `tasks/watermarks_background.md`
- If you need **true footnotes/endnotes**: `tasks/footnotes_endnotes.md`
- If you want reproducible fixtures for edge cases: `tasks/fixtures_edge_cases.md`
