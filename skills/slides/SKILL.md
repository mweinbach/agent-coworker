---
name: "slides"
description: "Create and review slide decks (PPTX). Includes helpers for rendering PPTX→images, rasterizing assets, and building decks with PptxGenJS."
compatibility: "Requires Node.js (pptxgenjs) for deck creation and Python 3 utilities for rendering and asset handling."
metadata:
  version: "1.0"
---

# Slides skill (PPTX create • edit • preview)

Use this skill when you need to **create or modify a PowerPoint deck**, or when you need **reliable visual previews** of a `.pptx`.

## When to use
- Generating a new deck programmatically (e.g., charts, diagrams, screenshots, product slides)
- Updating an existing deck while preserving layout and typography
- Previewing a deck or embedded assets (images/SVG/EMF/PDF) to verify rendering
- Building a montage of slides for quick review / diffing

## Core workflows

### 1) Render a PPTX to slide images (for visual QA)
Use `render_slides.py` to convert a `.pptx` into per-slide PNGs (via a PDF intermediate) so you can visually inspect results.

**Common pattern**
- Render slides → open PNGs → verify layout, fonts, and chart fidelity.

### 2) Make a montage (one image of many slides)
Use `create_montage.py` to generate a montage image from a folder of slide PNGs. Great for quick reviews.

### 3) Rasterize embedded vector assets
Some PPTX assets may be SVG/EMF/WMF/PDF/EPS/etc. Use `ensure_raster_image.py` to convert to a PNG for consistent previews and embedding.

## Files included
- `render_slides.py`: PPTX → PDF → PNG rendering pipeline
- `create_montage.py`: montage builder for slide PNGs
- `ensure_raster_image.py`: rasterizes vector formats to PNG when needed
- `pptxgenjs_helpers/`: helper JS modules used by deck-generation code

## Output expectations
- Slide previews are produced as PNGs in a target folder
- Montages are a single image file suitable for quick iteration and sharing

## Notes / pitfalls
- Always validate final output by **rendering** and checking the PNGs—PPTX can look different depending on fonts and rendering engines.
- Prefer raster images for predictable results when embedding complex vector assets.
