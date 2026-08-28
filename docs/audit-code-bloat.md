# Code bloat audit

The February 2026 audit described an earlier terminal-first architecture. Its
file paths, line counts, dependency assumptions, and savings estimates are no
longer current. Its suggestions to discard persistence migrations, backup
validation, or supported authentication flows must not be used as cleanup
instructions for the current product.

Use [the complexity and cleanup tracker](complexity-tracker.md) for the current
repository inventory, measured hotspots, consumer-verified findings, regression
coverage, and remaining work. Run `bun run complexity` to refresh measurements.
The historical report remains available in Git history.
