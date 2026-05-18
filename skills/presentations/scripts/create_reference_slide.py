#!/usr/bin/env python3

from __future__ import annotations

import argparse
import sys
from pathlib import Path

RULES = """
Prepare a Codex imagegen prompt for a professional PPTX reference slide.

The generated image is a rebuild blueprint for an editable PowerPoint deck, not final bitmap art.
Optimize for layouts and visuals that can be reconstructed cleanly with native PPTX primitives.

Rules:
- Follow the user's deck brief, audience, source constraints, style requests, and must-have content. User-specific guidance overrides these defaults when it is readable and factually supported.
- If the user did not specify a style, default to polished, structured, readable presentation design.
- Prefer one primary idea per slide with a limited number of supporting elements. Avoid appendix-like density unless the prompt explicitly asks for it.
- Use strict alignment, generous whitespace, readable hierarchy, restrained visual effects, and realistic chart/table density.
- Use a clear slide structure that can be rebuilt with editable text boxes, rectangles, lines, simple icons, image crops, tables, timelines, cards, matrices, and basic charts.
- Prefer PPTX-friendly structures unless the prompt clearly needs something else:
    - Card grids
    - Narrative plus visual compositions
    - Chart or table-led layouts
    - Matrices
    - Timelines
    - Process flows
    - KPI layouts
    - Comparison layouts
- Make layout zones obvious: title zone, body zone, visual/chart zone, footer or page marker. Keep visible gutters between zones.
- Keep text in normal horizontal text blocks. Avoid curved text, rotated labels, text embedded inside images, tiny labels, and decorative microcopy.
- Use at most one complex visual per slide. If a visual would be hard to rebuild, make it a single clean image-crop region instead of many intricate parts.
- Use simple chart and diagram types only. Avoid impossible 3D charts, fake axis labels, dense dashboards, and decorative data art.
- Use simple masks only: rectangle, rounded rectangle, circle, or full-bleed image crop.
- Keep visual effects restrained: no glassmorphism stacks, heavy shadows, blended collages, particle fields, intricate gradients, or many overlapping translucent layers unless explicitly requested.
- Use a limited type system with clear title, body, and label hierarchy.
- Stay professional and visually coherent. Do not include too many different styles in the same slide.
- Avoid competing hero images or complex hero diagrams on the same slide.
- If any icons appear, they should be simple and consistent with the requested or locked icon system.
- Do not copy the outline text verbatim into the slide image, lay it out for maximum clarity.
- Do not blend the hero image into the background.
- Vary slide layouts when useful; do not repeat the same composition mechanically across the deck.
- Generally prefer lighter backgrounds unless specified by the prompt.
- Avoid decorative callout boxes that do not add meaning.
- When a slide has a dominant visual or asset, keep surrounding content simple enough for the visual to stand out.
- Avoid fake UI, unreadable tiny text, decorative clutter, random gradients, generic stock-slide compositions, and any design that would require tracing complex bitmap details into editable slide shapes.
""".strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("prompt")
    parser.add_argument("output_path", nargs="?")
    parser.add_argument("--prompt-output")
    parser.add_argument("--reference-image")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    prompt = f"{RULES}\n"
    if args.reference_image:
        prompt += (
            "\nUse the provided reference image only as a visual style and theme guide "
            "(palette, typography feel, composition, and rendering language). "
            "Do not reuse its slide-1 content; adapt the new prompt into a different slide "
            "that still looks like the same deck.\n"
        )
    prompt += f"\nPrompt:\n{args.prompt}"

    output_args = ["--output", args.output_path] if args.output_path else []
    prompt_output_args = ["--prompt-output", args.prompt_output] if args.prompt_output else []
    reference_args = ["--reference-image", args.reference_image] if args.reference_image else []

    script_dir = Path(__file__).resolve().parent
    if str(script_dir) not in sys.path:
        sys.path.insert(0, str(script_dir))

    from openai_generate_image import main as write_imagegen_prompt

    sys.argv = [
        str(Path(__file__).with_name("openai_generate_image.py")),
        prompt,
        "--quality",
        "medium",
        "--force",
        *output_args,
        *prompt_output_args,
        *reference_args,
    ]
    return write_imagegen_prompt()


if __name__ == "__main__":
    raise SystemExit(main())
