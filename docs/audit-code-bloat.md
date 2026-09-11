# Code bloat audit

The February 2026 audit described an earlier terminal-first architecture. Its
file paths, line counts, dependency assumptions, and savings estimates are no
longer current. Its suggestions to discard persistence migrations, backup
validation, or supported authentication flows must not be used as cleanup
instructions for the current product.

Run `bun run complexity` for current measurements and `bun run knip` for unused
export findings. The historical report remains available in Git history.
