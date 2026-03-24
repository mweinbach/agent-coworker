#!/usr/bin/env python3
"""Cross-platform executable resolution helpers for the slides skill."""

from __future__ import annotations

import os
import ntpath
import posixpath
import shutil
import sys
from typing import Callable, Mapping, Optional, Sequence

WhichFn = Callable[[str], Optional[str]]


class MissingDependencyError(RuntimeError):
    """Raised when a required external executable cannot be located."""


def _platform(platform: str | None = None) -> str:
    return (platform or sys.platform).lower()


def _dedupe(values: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def _program_files_dirs(env: Mapping[str, str]) -> list[str]:
    return _dedupe(
        [
            env.get("ProgramFiles", ""),
            env.get("ProgramFiles(x86)", ""),
            env.get("LOCALAPPDATA", ""),
        ]
    )


def _candidate_path(platform: str, *parts: str) -> str:
    join = ntpath.join if platform == "win32" else posixpath.join
    return join(*parts)


def _libreoffice_extra_paths(platform: str, env: Mapping[str, str]) -> list[str]:
    if platform == "darwin":
        return ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
    if platform != "win32":
        return ["/usr/bin/soffice", "/usr/bin/libreoffice"]

    candidates: list[str] = []
    for base in _program_files_dirs(env):
        candidates.extend(
            [
                _candidate_path(platform, base, "LibreOffice", "program", "soffice.exe"),
                _candidate_path(platform, base, "Programs", "LibreOffice", "program", "soffice.exe"),
            ]
        )
    return _dedupe(candidates)


def _inkscape_extra_paths(platform: str, env: Mapping[str, str]) -> list[str]:
    if platform != "win32":
        return []

    candidates: list[str] = []
    for base in _program_files_dirs(env):
        candidates.extend(
            [
                _candidate_path(platform, base, "Inkscape", "bin", "inkscape.exe"),
                _candidate_path(platform, base, "Inkscape", "inkscape.exe"),
            ]
        )
    return _dedupe(candidates)


def _ghostscript_extra_paths(platform: str, env: Mapping[str, str]) -> list[str]:
    if platform != "win32":
        return []

    candidates: list[str] = []
    for base in _program_files_dirs(env):
        gs_root = _candidate_path(platform, base, "gs")
        if not os.path.isdir(gs_root):
            continue
        try:
            entries = sorted(os.listdir(gs_root), reverse=True)
        except OSError:
            continue
        for entry in entries:
            bin_dir = _candidate_path(platform, gs_root, entry, "bin")
            candidates.extend(
                [
                    _candidate_path(platform, bin_dir, "gswin64c.exe"),
                    _candidate_path(platform, bin_dir, "gswin32c.exe"),
                ]
            )
    return _dedupe(candidates)


def libreoffice_search_candidates(platform: str | None = None, env: Mapping[str, str] | None = None) -> list[str]:
    effective_platform = _platform(platform)
    env_map = env or os.environ
    return _dedupe(["soffice", "libreoffice", *_libreoffice_extra_paths(effective_platform, env_map)])


def inkscape_search_candidates(platform: str | None = None, env: Mapping[str, str] | None = None) -> list[str]:
    effective_platform = _platform(platform)
    env_map = env or os.environ
    return _dedupe(["inkscape", *_inkscape_extra_paths(effective_platform, env_map)])


def ghostscript_search_candidates(platform: str | None = None, env: Mapping[str, str] | None = None) -> list[str]:
    effective_platform = _platform(platform)
    env_map = env or os.environ
    names = ["gswin64c.exe", "gswin32c.exe", "gs"] if effective_platform == "win32" else ["gs"]
    return _dedupe([*names, *_ghostscript_extra_paths(effective_platform, env_map)])


def _resolve_override(
    env_var: str,
    label: str,
    env: Mapping[str, str],
    which: WhichFn,
) -> str | None:
    override = env.get(env_var)
    if not override:
        return None

    expanded = os.path.expanduser(os.path.expandvars(override))
    if os.path.isfile(expanded):
        return expanded

    resolved = which(expanded)
    if resolved:
        return resolved

    raise MissingDependencyError(
        f"{label} executable configured via {env_var} was not found: {override}. "
        f"Update {env_var} to a valid executable path or command name."
    )


def resolve_executable(
    *,
    label: str,
    env_var: str,
    candidates: Sequence[str],
    install_hint: str,
    platform: str | None = None,
    env: Mapping[str, str] | None = None,
    which: WhichFn = shutil.which,
) -> str:
    effective_platform = _platform(platform)
    env_map = env or os.environ

    override = _resolve_override(env_var, label, env_map, which)
    if override:
        return override

    searched: list[str] = []
    for candidate in candidates:
        searched.append(candidate)
        if os.path.isabs(candidate):
            if os.path.isfile(candidate):
                return candidate
            continue

        resolved = which(candidate)
        if resolved:
            return resolved

    searched_display = ", ".join(searched)
    raise MissingDependencyError(
        f"{label} executable not found for platform {effective_platform}. "
        f"Searched: {searched_display}. {install_hint} "
        f"Set {env_var} to override the executable path."
    )


def resolve_libreoffice_executable(
    platform: str | None = None,
    env: Mapping[str, str] | None = None,
    which: WhichFn = shutil.which,
) -> str:
    return resolve_executable(
        label="LibreOffice",
        env_var="COWORK_SLIDES_LIBREOFFICE_BIN",
        candidates=libreoffice_search_candidates(platform, env),
        install_hint=(
            "Install LibreOffice and make `soffice` available on PATH "
            "or point the env var at the `soffice` executable."
        ),
        platform=platform,
        env=env,
        which=which,
    )


def resolve_inkscape_executable(
    platform: str | None = None,
    env: Mapping[str, str] | None = None,
    which: WhichFn = shutil.which,
) -> str:
    return resolve_executable(
        label="Inkscape",
        env_var="COWORK_SLIDES_INKSCAPE_BIN",
        candidates=inkscape_search_candidates(platform, env),
        install_hint="Install Inkscape and make `inkscape` available on PATH.",
        platform=platform,
        env=env,
        which=which,
    )


def resolve_ghostscript_executable(
    platform: str | None = None,
    env: Mapping[str, str] | None = None,
    which: WhichFn = shutil.which,
) -> str:
    return resolve_executable(
        label="Ghostscript",
        env_var="COWORK_SLIDES_GHOSTSCRIPT_BIN",
        candidates=ghostscript_search_candidates(platform, env),
        install_hint=(
            "Install Ghostscript and make `gs` (or `gswin64c.exe` on Windows) "
            "available on PATH."
        ),
        platform=platform,
        env=env,
        which=which,
    )


def resolve_imagemagick_executable(
    platform: str | None = None,
    env: Mapping[str, str] | None = None,
    which: WhichFn = shutil.which,
) -> str:
    return resolve_executable(
        label="ImageMagick",
        env_var="COWORK_SLIDES_IMAGEMAGICK_BIN",
        candidates=["magick", "convert"],
        install_hint="Install ImageMagick and make `magick` available on PATH.",
        platform=platform,
        env=env,
        which=which,
    )


def resolve_heif_convert_executable(
    platform: str | None = None,
    env: Mapping[str, str] | None = None,
    which: WhichFn = shutil.which,
) -> str:
    return resolve_executable(
        label="heif-convert",
        env_var="COWORK_SLIDES_HEIF_CONVERT_BIN",
        candidates=["heif-convert"],
        install_hint="Install libheif tools and make `heif-convert` available on PATH.",
        platform=platform,
        env=env,
        which=which,
    )


def resolve_jxrdec_executable(
    platform: str | None = None,
    env: Mapping[str, str] | None = None,
    which: WhichFn = shutil.which,
) -> str:
    return resolve_executable(
        label="JxrDecApp",
        env_var="COWORK_SLIDES_JXRDEC_BIN",
        candidates=["JxrDecApp"],
        install_hint="Install jxr-tools and make `JxrDecApp` available on PATH.",
        platform=platform,
        env=env,
        which=which,
    )


def resolve_fontconfig_executable(
    platform: str | None = None,
    env: Mapping[str, str] | None = None,
    which: WhichFn = shutil.which,
) -> str:
    return resolve_executable(
        label="fontconfig (fc-list)",
        env_var="COWORK_SLIDES_FONTCONFIG_BIN",
        candidates=["fc-list"],
        install_hint=(
            "Install fontconfig and make `fc-list` available on PATH. "
            "Font detection uses fontconfig aliases to classify missing vs substituted fonts."
        ),
        platform=platform,
        env=env,
        which=which,
    )
