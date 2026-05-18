#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function usage() {
  return [
    "Usage:",
    "  node scripts/check_layout_quality.mjs --layout <layout.json|dir> [options]",
    "",
    "Options:",
    "  --zones <zones.json>          Optional zone contract.",
    "  --allowlist <allowlist.json>  Optional list of tolerated issue ids.",
    "  --warn-only                  Print issues but exit 0.",
    "  --min-gap <px>               Minimum gap between major elements. Default 16.",
    "  --max-text-image-overlap <n> Allowed text/image overlap area. Default 25.",
    "  --max-text-text-overlap <n>  Allowed text/text overlap area. Default 10.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`Unexpected positional argument: ${key}`);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key.slice(2)] = true;
    } else {
      args[key.slice(2)] = next;
      i += 1;
    }
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectLayouts(inputPath) {
  const stat = fs.statSync(inputPath);
  if (stat.isDirectory()) {
    return fs
      .readdirSync(inputPath)
      .filter((entry) => entry.endsWith(".layout.json"))
      .sort()
      .map((entry) => path.join(inputPath, entry));
  }
  return [inputPath];
}

function bboxOf(element) {
  const box = element.bbox;
  if (!Array.isArray(box) || box.length !== 4) return undefined;
  const [x, y, w, h] = box.map(Number);
  if (![x, y, w, h].every(Number.isFinite)) return undefined;
  return { x, y, w, h, x2: x + w, y2: y + h };
}

function estimatedTextBlockHeight(text) {
  const lineCount = text.textLayout?.lineCount || String(text.textPreview || text.text || "").split("|").length;
  const fontSize = Number(text.resolvedFontSize || text.resolvedTextStyle?.fontSize || 0);
  if (!(fontSize > 0) || !(lineCount > 0)) return undefined;
  return { lineCount, fontSize, height: fontSize * lineCount * 1.15 };
}

function area(box) {
  return Math.max(0, box.w) * Math.max(0, box.h);
}

function usableTextContainer(shape, box, textBox, slideBox) {
  const shapeArea = area(box);
  const textArea = area(textBox);
  const broadEnoughForCopy = box.w >= Math.max(120, textBox.w * 1.15);
  return (
    shapeArea > textArea * 1.15 &&
    box.h >= 40 &&
    shapeArea < area(slideBox) * 0.8 &&
    broadEnoughForCopy &&
    shape.fillColor &&
    shape.fillColor !== "rgba(0, 0, 0, 0)"
  );
}

function containsBox(container, child) {
  return (
    child.x >= container.x &&
    child.y >= container.y &&
    child.x2 <= container.x2 &&
    child.y2 <= container.y2
  );
}

function startsInsideBox(container, child) {
  return (
    child.x >= container.x &&
    child.x < container.x2 &&
    child.y >= container.y &&
    child.y < container.y2
  );
}

function countTextsStartingInside(box, texts) {
  return texts.filter((text) => {
    const textBox = bboxOf(text);
    return textBox && startsInsideBox(box, textBox);
  }).length;
}

function intersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  return {
    x,
    y,
    w: Math.max(0, x2 - x),
    h: Math.max(0, y2 - y),
  };
}

function gap(a, b) {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x2, b.x2));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y2, b.y2));
  if (dx === 0 && dy === 0) return 0;
  if (dx === 0) return dy;
  if (dy === 0) return dx;
  return Math.hypot(dx, dy);
}

function issue(layoutPath, id, severity, message, elements = []) {
  return {
    id: `${path.basename(layoutPath)}:${id}`,
    severity,
    message,
    elements: elements
      .filter(Boolean)
      .map((element) => ({
        order: element.order,
        name: element.name,
        kind: element.kind,
        text: (element.textPreview || element.text || "").slice(0, 100),
        bbox: element.bbox,
      })),
  };
}

function hasText(element) {
  return Boolean(element.textPreview || element.text);
}

function elementLabel(element) {
  return element.name || element.textPreview || element.text || `${element.kind}#${element.order}`;
}

function loadAllowlist(filePath) {
  if (!filePath) return new Set();
  const data = readJson(filePath);
  if (Array.isArray(data)) return new Set(data);
  if (Array.isArray(data.allowed)) return new Set(data.allowed);
  return new Set();
}

function normalizeZone(zone) {
  const x = Number(zone.x ?? zone.left ?? 0);
  const y = Number(zone.y ?? zone.top ?? 0);
  const w = Number(zone.w ?? zone.width);
  const h = Number(zone.h ?? zone.height);
  return { x, y, w, h, x2: x + w, y2: y + h };
}

function inZone(box, zone, tolerance = 0) {
  return (
    box.x >= zone.x - tolerance &&
    box.y >= zone.y - tolerance &&
    box.x2 <= zone.x2 + tolerance &&
    box.y2 <= zone.y2 + tolerance
  );
}

function zoneChecks(layoutPath, elements, zonesPath) {
  if (!zonesPath) return [];
  const data = readJson(zonesPath);
  const problems = [];
  const zones = data.zones || {};
  const rules = data.rules || [];
  for (const rule of rules) {
    const zone = zones[rule.zone] ? normalizeZone(zones[rule.zone]) : undefined;
    if (!zone) continue;
    const pattern = rule.namePattern ? new RegExp(rule.namePattern) : undefined;
    const kind = rule.kind;
    const candidates = elements.filter((element) => {
      if (kind && element.kind !== kind) return false;
      if (pattern && !pattern.test(element.name || "")) return false;
      return true;
    });
    for (const element of candidates) {
      const box = bboxOf(element);
    if (box && !inZone(box, zone, 1)) {
        problems.push(
          issue(
            layoutPath,
            `zone:${rule.zone}:${element.order}`,
            "error",
            `${elementLabel(element)} is outside required zone "${rule.zone}".`,
            [element],
          ),
        );
      }
    }
  }
  return problems;
}

function checkLayout(layoutPath, options) {
  const data = readJson(layoutPath);
  const slideBox = bboxOf({ bbox: data.slide?.frame ? [
    data.slide.frame.left,
    data.slide.frame.top,
    data.slide.frame.width,
    data.slide.frame.height,
  ] : [0, 0, 1280, 720] });
  const elements = (data.elements || []).filter((element) => bboxOf(element));
  const texts = elements.filter(hasText);
  const images = elements.filter((element) => element.kind === "image");
  const shapes = elements.filter((element) => element.kind === "shape" && !hasText(element));
  const major = elements.filter((element) => {
    const box = bboxOf(element);
    return box && area(box) > 1200 && element.kind !== "shape";
  });

  const problems = [];
  const maxTextImageOverlap = Number(options.maxTextImageOverlap ?? 25);
  const maxTextTextOverlap = Number(options.maxTextTextOverlap ?? 10);
  const minGap = Number(options.minGap ?? 16);

  for (const element of elements) {
    const box = bboxOf(element);
    if (!inZone(box, slideBox, 1)) {
      problems.push(
        issue(
          layoutPath,
          `bounds:${element.order}`,
          "error",
          `${elementLabel(element)} extends outside the slide bounds.`,
          [element],
        ),
      );
    }
  }

  for (const text of texts) {
    const textBox = bboxOf(text);
    for (const image of images) {
      const imageBox = bboxOf(image);
      const overlapArea = area(intersection(textBox, imageBox));
      if (overlapArea > maxTextImageOverlap) {
        problems.push(
          issue(
            layoutPath,
            `text-image:${text.order}:${image.order}`,
            "error",
            `${elementLabel(text)} overlaps image ${elementLabel(image)} by ${Math.round(overlapArea)}px.`,
            [text, image],
          ),
        );
      }
    }
  }

  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i];
      const b = texts[j];
      const overlapArea = area(intersection(bboxOf(a), bboxOf(b)));
      if (overlapArea > maxTextTextOverlap) {
        problems.push(
          issue(
            layoutPath,
            `text-text:${a.order}:${b.order}`,
            "error",
            `${elementLabel(a)} overlaps ${elementLabel(b)} by ${Math.round(overlapArea)}px.`,
            [a, b],
          ),
        );
      }
    }
  }

  for (const text of texts) {
    const box = bboxOf(text);
    const estimate = estimatedTextBlockHeight(text);
    if (estimate) {
      const { lineCount, fontSize, height: requiredHeight } = estimate;
      if (box.h < requiredHeight) {
        problems.push(
          issue(
            layoutPath,
            `tight-text:${text.order}`,
            "warning",
            `${elementLabel(text)} text box is tight: height ${Math.round(box.h)}px for ${lineCount} line(s) at ${fontSize}px.`,
            [text],
          ),
        );
      }
    }
  }

  for (const text of texts) {
    const textBox = bboxOf(text);
    const estimate = estimatedTextBlockHeight(text);
    if (!estimate) continue;
    const candidates = shapes
      .map((shape) => ({ shape, box: bboxOf(shape) }))
      .filter(({ shape, box }) => {
        if (!box) return false;
        return containsBox(box, textBox) && usableTextContainer(shape, box, textBox, slideBox);
      })
      .sort((a, b) => area(a.box) - area(b.box));
    const container = candidates[0];
    if (!container) continue;

    const bottomPad = container.box.y2 - textBox.y2;
    const minBottomPad = estimate.lineCount > 1 ? 16 : 12;
    if (bottomPad < minBottomPad) {
      const isLikelyCopyContainer = countTextsStartingInside(container.box, texts) >= 3;
      problems.push(
        issue(
          layoutPath,
          `box-bottom-pad:${container.shape.order}:${text.order}`,
          isLikelyCopyContainer ? "error" : "warning",
          `${elementLabel(text)} has only ${Math.round(bottomPad)}px bottom padding inside its containing box; expected at least ${minBottomPad}px.`,
          [container.shape, text],
        ),
      );
    }
  }

  for (const text of texts) {
    const textBox = bboxOf(text);
    const candidates = shapes
      .map((shape) => ({ shape, box: bboxOf(shape) }))
      .filter(({ shape, box }) => {
        if (!box) return false;
        return startsInsideBox(box, textBox) && usableTextContainer(shape, box, textBox, slideBox);
      })
      .filter(({ box }) => !containsBox(box, textBox))
      .sort((a, b) => area(a.box) - area(b.box));
    const container = candidates[0];
    if (!container) continue;

    const overflowBottom = Math.max(0, textBox.y2 - container.box.y2);
    const overflowRight = Math.max(0, textBox.x2 - container.box.x2);
    const overflowText = [
      overflowRight > 0 ? `${Math.round(overflowRight)}px right` : undefined,
      overflowBottom > 0 ? `${Math.round(overflowBottom)}px bottom` : undefined,
    ].filter(Boolean).join(" and ");
    problems.push(
      issue(
        layoutPath,
        `box-overflow:${container.shape.order}:${text.order}`,
        "error",
        `${elementLabel(text)} starts inside a containing box but overflows it by ${overflowText}.`,
        [container.shape, text],
      ),
    );
  }

  for (let i = 0; i < major.length; i += 1) {
    for (let j = i + 1; j < major.length; j += 1) {
      const a = major[i];
      const b = major[j];
      const distance = gap(bboxOf(a), bboxOf(b));
      if (distance > 0 && distance < minGap) {
        problems.push(
          issue(
            layoutPath,
            `gutter:${a.order}:${b.order}`,
            "warning",
            `${elementLabel(a)} is only ${Math.round(distance)}px from ${elementLabel(b)}.`,
            [a, b],
          ),
        );
      }
    }
  }

  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i];
      const b = texts[j];
      const ab = bboxOf(a);
      const bb = bboxOf(b);
      const sameBaseline = Math.abs(ab.y - bb.y) <= 3 && Math.abs(ab.h - bb.h) <= 8;
      const closeInline = sameBaseline && gap(ab, bb) <= 12;
      if (closeInline) {
        problems.push(
          issue(
            layoutPath,
            `split-inline:${a.order}:${b.order}`,
            "warning",
            `${elementLabel(a)} and ${elementLabel(b)} look like manually split inline text.`,
            [a, b],
          ),
        );
      }
    }
  }

  const kickerPairs = new Map();
  for (const element of elements) {
    const name = element.name || "";
    const match = name.match(/^(kicker(?:-[A-Za-z0-9]+)?)-(marker|label)$/);
    if (!match) continue;
    const [, key, role] = match;
    if (!kickerPairs.has(key)) kickerPairs.set(key, {});
    kickerPairs.get(key)[role] = element;
  }

  for (const [key, pair] of kickerPairs) {
    if (!pair.marker || !pair.label) {
      problems.push(
        issue(
          layoutPath,
          `kicker-pair:${key}`,
          "warning",
          `${key} is missing a named marker/label pair, so kicker alignment cannot be verified.`,
          [pair.marker, pair.label],
        ),
      );
      continue;
    }

    const markerBox = bboxOf(pair.marker);
    const labelBox = bboxOf(pair.label);
    const markerCenter = markerBox.y + markerBox.h / 2;
    const labelCenter = labelBox.y + labelBox.h / 2;
    const delta = Math.abs(markerCenter - labelCenter);
    if (delta > 1) {
      problems.push(
        issue(
          layoutPath,
          `kicker-centerline:${key}`,
          "error",
          `${key} marker and label centers differ by ${delta.toFixed(1)}px; expected <= 1px.`,
          [pair.marker, pair.label],
        ),
      );
    }
  }

  return problems.concat(zoneChecks(layoutPath, elements, options.zones));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.layout) {
    console.log(usage());
    process.exit(args.help ? 0 : 1);
  }

  const allowlist = loadAllowlist(args.allowlist);
  const layouts = collectLayouts(path.resolve(args.layout));
  const allProblems = layouts.flatMap((layout) => checkLayout(layout, args));
  const activeProblems = allProblems.filter((problem) => !allowlist.has(problem.id));

  for (const problem of activeProblems) {
    const details = problem.elements
      .map((element) => {
        const name = [element.kind, element.name || element.text || `order ${element.order}`].filter(Boolean).join(" ");
        return `    - ${name} bbox=${JSON.stringify(element.bbox)}`;
      })
      .join("\n");
    console.log(`[${problem.severity}] ${problem.id}: ${problem.message}`);
    if (details) console.log(details);
  }

  const errors = activeProblems.filter((problem) => problem.severity === "error");
  const warnings = activeProblems.filter((problem) => problem.severity === "warning");
  console.log(`Checked ${layouts.length} layout file(s): ${errors.length} error(s), ${warnings.length} warning(s).`);

  if (!args["warn-only"] && errors.length > 0) {
    process.exit(2);
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  console.error(usage());
  process.exit(1);
}
