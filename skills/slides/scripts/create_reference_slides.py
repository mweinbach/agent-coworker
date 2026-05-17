#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import re
import secrets
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("outline")
    parser.add_argument("output_dir", nargs="?")
    parser.add_argument(
        "--slide-count",
        type=int,
        default=None,
        help="Optional slide count. Defaults to the number of slide sections inferred from the outline.",
    )
    parser.add_argument(
        "--style-guidance",
        default="",
        help=(
            "Optional deck brief and presentation style guidance from the user prompt. "
            "Forwarded into every slide-generation prompt."
        ),
    )
    parser.add_argument("--workers", type=int, default=8)
    return parser.parse_args()


def print_ready(path: Path) -> None:
    print(path, flush=True)


def load_outline(source: str) -> str:
    if source == "-":
        return sys.stdin.read()

    source_path = Path(source).expanduser()
    if source_path.exists():
        return source_path.read_text(encoding="utf-8")

    return source


def ordinal(value: int) -> str:
    if 11 <= value % 100 <= 13:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(value % 10, "th")
    return f"{value}{suffix}"


def extract_section_titles(outline: str, total: int) -> list[str]:
    paragraphs = [
        paragraph.strip()
        for paragraph in re.split(r"\n\s*\n", outline.strip())
        if paragraph.strip()
    ]
    titles = []
    for paragraph in paragraphs[1:]:
        first_line = paragraph.splitlines()[0].strip()
        if first_line:
            titles.append(first_line)

    while len(titles) < total:
        titles.append(f"Slide {len(titles) + 1}")

    return titles[:total]


def infer_slide_count(outline: str) -> int:
    paragraphs = [
        paragraph.strip()
        for paragraph in re.split(r"\n\s*\n", outline.strip())
        if paragraph.strip()
    ]
    return max(1, len(paragraphs) - 1)


def build_slide_prompt(
    index: int,
    total: int,
    outline: str,
    style_guidance: str,
    section_titles: list[str],
) -> str:
    title_hint = section_titles[index - 1] if index <= len(section_titles) else f"Slide {index}"
    section_selector = (
        f"The outline begins with one intro paragraph, followed by exactly {total} slide sections. "
        f"Each slide section has one title line and one explanatory paragraph. "
        f"For this request, use only the {ordinal(index)} slide section after the intro paragraph, "
        f'whose title is exactly "{title_hint}". '
        "Do not use a neighboring section's title, dates, or examples."
    )

    style_block = ""
    if style_guidance.strip():
        style_block = (
            "Apply this deck brief and user-provided style guidance to the slide's "
            "visual language, layout, palette, typography feel, density, and tone. "
            "Specific user guidance overrides default styling unless it would make "
            "the slide unreadable, factually unsupported, or impractical to rebuild "
            "as editable PPTX primitives:\n"
            f"{style_guidance.strip()}\n\n"
        )

    if index == 1:
        return (
            f"You are given the full {total}-slide deck outline below. Create only slide {index}, the opening slide.\n"
            f"{section_selector}\n"
            "Ignore the later sections except as light visual context.\n"
            "Make this a strong visual system setter for the rest of the deck: a clear title area, "
            "one concise thesis statement, a small number of compact supporting elements, and one "
            "PPTX-friendly abstract hero visual built from simple geometric layers, lines, cards, "
            "or a single clean image crop.\n\n"
            f"{style_block}"
            f"Full outline:\n{outline}"
        )

    return (
        f"You are given the full {total}-slide deck outline below. Create only slide {index}.\n"
        f"{section_selector}\n"
        "Do not include the other sections' content except as subtle context.\n"
        "After slide 1 is generated, use it as a style reference if available while making this slide's "
        "content, diagram, and layout specific to the current section. Keep copy concise and readable, and "
        "choose a structure that can be rebuilt with editable PPTX primitives.\n\n"
        f"{style_block}"
        f"Full outline:\n{outline}"
    )


def render_slide(
    script_path: Path,
    index: int,
    total: int,
    outline: str,
    style_guidance: str,
    section_titles: list[str],
    output_path: Path,
    prompt_output_path: Path,
    reference_image: Path | None = None,
) -> Path:
    cmd = [
        sys.executable,
        str(script_path),
        build_slide_prompt(index, total, outline, style_guidance, section_titles),
        str(output_path),
        "--prompt-output",
        str(prompt_output_path),
    ]
    if reference_image:
        cmd.extend(["--reference-image", str(reference_image)])

    subprocess.run(cmd, check=True)
    return prompt_output_path


def write_prompt_index(prompt_paths: list[Path], output_path: Path) -> Path:
    lines = [
        "# Reference Slide Imagegen Prompt Index",
        "",
        "Use Codex imagegen to generate the intended PNGs from these prompt files.",
        "These prompts are rebuild blueprints for editable artifact-tool slides, not final slide assets.",
        "",
    ]
    for index, prompt_path in enumerate(prompt_paths, start=1):
        intended_png = prompt_path.with_name(prompt_path.name.replace(".imagegen.txt", ".png"))
        lines.extend(
            [
                f"## Slide {index:02d}",
                "",
                f"- Prompt: `{prompt_path}`",
                f"- Intended image: `{intended_png}`",
                "",
            ]
        )
    output_path.write_text("\n".join(lines), encoding="utf-8")
    return output_path


def safe_path_segment(value: str | None) -> str | None:
    if not value:
        return None
    segment = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip(".-")
    if not segment or segment in {".", ".."}:
        return None
    return segment


def default_thread_id() -> str:
    thread_id = safe_path_segment(os.environ.get("CODEX_THREAD_ID"))
    if thread_id:
        return thread_id
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return f"manual-{timestamp}-{secrets.token_hex(3)}"


def main() -> int:
    args = parse_args()
    outline = load_outline(args.outline)
    slide_count = args.slide_count or infer_slide_count(outline)
    section_titles = extract_section_titles(outline, slide_count)
    output_dir = (
        Path(args.output_dir).expanduser()
        if args.output_dir
        else Path.cwd() / "outputs" / default_thread_id() / "presentations" / "reference-slides"
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    single_script = Path(__file__).with_name("create_reference_slide.py")

    first_output = output_dir / "slide-01.png"
    first_prompt = output_dir / "slide-01.imagegen.txt"
    render_slide(
        single_script,
        1,
        slide_count,
        outline,
        args.style_guidance,
        section_titles,
        first_output,
        first_prompt,
    )
    print_ready(first_prompt)

    prompt_paths = [first_prompt]
    with ThreadPoolExecutor(max_workers=min(args.workers, max(1, slide_count - 1))) as executor:
        futures = {
            executor.submit(
                render_slide,
                single_script,
                index,
                slide_count,
                outline,
                args.style_guidance,
                section_titles,
                output_dir / f"slide-{index:02d}.png",
                output_dir / f"slide-{index:02d}.imagegen.txt",
            ): index
            for index in range(2, slide_count + 1)
        }

        for future in as_completed(futures):
            completed_path = future.result()
            prompt_paths.append(completed_path)
            print_ready(completed_path)

    prompt_paths = sorted(prompt_paths)
    prompt_index = write_prompt_index(prompt_paths, output_dir / "reference-imagegen-prompts.txt")

    print_ready(prompt_index)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
