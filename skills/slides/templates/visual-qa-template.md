# Visual QA

## Mechanical Verification
- PPTX exists and is non-empty:
- Expected slide count:
- Rendered preview count:
- Layout checker:
- Icon manifest checker:
- Empty media check:

## Contact Sheet Review
- Does the deck look like one coherent presentation?
- Do any slides look like a different template?
- Which slides or repeated elements, if any, are materially weaker than the rest of the deck?
- Which slides need remediation before delivery?
- Do important text blocks have enough space and hierarchy?

## Reference Comp QA
- Reference contact sheet reviewed before rebuild:
- Weak reference comps regenerated:
- Useful comps approved for rebuild:
- Do-not-rebuild elements:
- Final rebuild compared against approved references:
- Final slides weaker than references:

## Template Fidelity QA
- Template inspection script run:
- `template-inspect.ndjson` reviewed:
- All source slides inventoried:
- Output slide to source slide map complete:
- Starter deck generated from duplicated source slides:
- Starter manifest reviewed:
- Source skeleton slide(s):
- Source renders reviewed:
- Source layout JSON reviewed:
- `template-frame-map.json` complete:
- No output slide rebuilt from theme only:
- Template chrome/master furniture preserved:
- Page markers/footer/source rails preserved:
- Title/body/image/table/chart frames preserved:
- Image wells filled or intentionally removed:
- Extracted template assets reused where appropriate:
- Dominant fonts available or substitution disclosed:
- New palette/type/surface language avoided unless redesign requested:
- Deviations recorded in `deviation-log.txt`:
- Adapted slides compared against source renders slide by slide:

## System Consistency
- Header/title tabs:
- Footer/source lines:
- Page markers:
- Logo/brand marks:
- Icon family:
- Icon manifest complete:
- Generic icons from approved library:
- Imagegen icon/logo crops present:
- Bottom ribbons:
- Chart language:
- KPI/card language:
- Title casing:

## Structured Visual QA
- Connected series continuous and passing through intended markers:
- Bars / dots / labels aligned to the same axis or baseline logic:
- Connectors attached to intended source / target objects:
- Arrow directionality meaningful and consistent:
- No floating slashes, detached strokes, or pseudo-arrows:
- Box systems reflect real grouping, with equal-role boxes aligned and padded consistently:
- Labels visibly attached to the mark, connector, or container they describe:
- Tables / matrices preserve row and column grammar at thumbnail size:

## Slide-by-Slide Findings
- Add one entry per slide reviewed:

## Taste Blockers
- Placeholder-looking icons:
- Broken arrows/glyphs:
- Rough bitmap crops:
- Missing icon manifest/provenance:
- Imagegen-cropped final icons/logos:
- Acronym tiles as icons:
- Weak or unofficial-looking brand marks:
- Mixed title-tab geometry:
- Footer/ribbon drift:
- Generic or crude diagrams:
- Floating connectors or detached chart segments:
- Decorative arrows with no semantic purpose:
- Misaligned equal-role boxes:
- Labels detached from the objects they describe:
- Dense or cramped text:
- KPI cards with cramped labels or notes:
- Claim/support mismatch:
- Unsupported quantitative claims:

## Issue Ledger
| Issue | Slide(s) | Severity | Fix path | Status |
|---|---:|---|---|---|
|  |  |  |  |  |

Severity values:
- `blocker`: must fix before delivery.
- `fix-before-delivery`: should fix before delivery.
- `accepted-tradeoff`: may remain only with a short reason.

## Required Fixes Before Delivery
- Add each unresolved blocker or fix-before-delivery issue:

## Resolved Fixes
- Add each issue resolved after remediation:

## Final Decision
- Pass/fail:
- All blocker/fix-before-delivery issues resolved:
- Remaining compromises to disclose:
