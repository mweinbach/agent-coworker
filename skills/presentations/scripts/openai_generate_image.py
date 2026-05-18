#!/usr/bin/env python3
"""
Write a Codex imagegen prompt text file for a requested image.

This helper intentionally does not call any network API and does not read API
keys. The Presentations skill uses Codex's imagegen tool for image creation;
this script only prepares the prompt and intended output path for the agent.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

DEFAULT_OUTPUT_FORMAT = "png"
DEFAULT_SIZE = "1792x1024"
DEFAULT_QUALITY = "medium"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prepare a Codex imagegen prompt text file from a text prompt."
    )
    parser.add_argument("prompt", help="Prompt to use with the Codex imagegen tool.")
    parser.add_argument(
        "-o",
        "--output",
        help="Intended generated image path. The script will not create this image.",
    )
    parser.add_argument(
        "--prompt-output",
        help="Prompt file path. Defaults beside --output, or ./imagegen-prompt-<timestamp>.txt.",
    )
    parser.add_argument(
        "--reference-image",
        help="Optional reference image path to pass to Codex imagegen.",
    )
    parser.add_argument(
        "--size",
        default=DEFAULT_SIZE,
        help=f"Requested image size to include in the prompt note. Default: {DEFAULT_SIZE}",
    )
    parser.add_argument(
        "--quality",
        default=DEFAULT_QUALITY,
        help=f"Requested quality to include in the prompt note. Default: {DEFAULT_QUALITY}",
    )
    parser.add_argument(
        "--format",
        dest="output_format",
        default=DEFAULT_OUTPUT_FORMAT,
        help=f"Requested output format to include in the prompt note. Default: {DEFAULT_OUTPUT_FORMAT}",
    )
    parser.add_argument(
        "--background",
        default="auto",
        help="Requested background mode to include in the prompt note. Default: auto",
    )
    parser.add_argument(
        "--moderation",
        default="auto",
        help="Accepted for compatibility; recorded in the prompt metadata only.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite the prompt file if it already exists.",
    )
    return parser.parse_args()


def resolve_reference_image(reference_image: str | None) -> Path | None:
    if not reference_image:
        return None
    image_path = Path(reference_image).expanduser().resolve()
    if not image_path.exists():
        raise FileNotFoundError(f"Reference image not found: {image_path}")
    if not image_path.is_file():
        raise ValueError(f"Reference image is not a file: {image_path}")
    return image_path


def default_prompt_path(output: str | None) -> Path:
    if output:
        output_path = Path(output).expanduser().resolve()
        return output_path.with_suffix(".imagegen.txt")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return Path.cwd() / f"imagegen-prompt-{stamp}.txt"


def build_prompt_doc(args: argparse.Namespace, reference_image: Path | None) -> str:
    intended_output = str(Path(args.output).expanduser().resolve()) if args.output else ""
    metadata = {
        "intended_output": intended_output,
        "reference_image": str(reference_image) if reference_image else "",
        "size": args.size,
        "quality": args.quality,
        "format": args.output_format,
        "background": args.background,
        "moderation": args.moderation,
    }
    return "\n".join(
        [
            "# Codex Imagegen Prompt",
            "",
            "Use the Codex imagegen tool with this prompt. Do not call external image APIs from scripts.",
            "",
            "```json",
            json.dumps(metadata, indent=2),
            "```",
            "",
            "## Prompt",
            "",
            args.prompt.strip(),
            "",
        ]
    )


def main() -> int:
    args = parse_args()
    reference_image = resolve_reference_image(args.reference_image)
    prompt_path = (
        Path(args.prompt_output).expanduser().resolve()
        if args.prompt_output
        else default_prompt_path(args.output)
    )
    if prompt_path.exists() and not args.force:
        raise FileExistsError(f"Prompt file already exists: {prompt_path}")
    prompt_path.parent.mkdir(parents=True, exist_ok=True)
    prompt_path.write_text(build_prompt_doc(args, reference_image), encoding="utf-8")

    result = {
        "prompt_output": str(prompt_path),
        "intended_output": str(Path(args.output).expanduser().resolve()) if args.output else "",
        "reference_image": str(reference_image) if reference_image else "",
        "imagegen_required": True,
    }
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
