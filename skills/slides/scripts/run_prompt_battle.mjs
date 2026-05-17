#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createSlideContext,
  ensureArtifactToolWorkspace,
  importArtifactTool,
  parseArgs,
  requireArg,
  saveBlobToFile,
} from "./artifact_tool_utils.mjs";

const SLIDE_SIZE = { width: 1280, height: 720 };
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const BRAND_STYLES = {
  alphabet: { bg: "#F7F8FB", ink: "#202124", soft: "#6B7280", accent: "#4285F4", accent2: "#34A853", accent3: "#FBBC04", dark: "#111827", light: false, serif: "Georgia", sans: "Avenir Next" },
  workday: { bg: "#F4F8FC", ink: "#112B4A", soft: "#62748A", accent: "#0875BE", accent2: "#F5A623", accent3: "#D7E9F7", dark: "#0B1F36", light: false, serif: "Georgia", sans: "Avenir Next" },
  snowflake: { bg: "#F4FBFF", ink: "#102A43", soft: "#607B96", accent: "#29B5E8", accent2: "#0B66C3", accent3: "#BEE9FA", dark: "#062137", light: false, serif: "Georgia", sans: "Avenir Next" },
  datadog: { bg: "#F7F3FF", ink: "#271449", soft: "#6F6287", accent: "#632CA6", accent2: "#18A999", accent3: "#E4D6FA", dark: "#1A0B33", light: false, serif: "Georgia", sans: "Avenir Next" },
  cloudflare: { bg: "#FFF7EF", ink: "#22170E", soft: "#735C49", accent: "#F38020", accent2: "#F9C74F", accent3: "#FFE3C5", dark: "#1A110A", light: false, serif: "Georgia", sans: "Avenir Next" },
  hubspot: { bg: "#FFF4EC", ink: "#213343", soft: "#657484", accent: "#FF5C35", accent2: "#00A4BD", accent3: "#FFD8C9", dark: "#102436", light: false, serif: "Georgia", sans: "Avenir Next" },
  gitlab: { bg: "#FFF7F1", ink: "#241B2F", soft: "#705E78", accent: "#FC6D26", accent2: "#7759C2", accent3: "#FCD7C1", dark: "#1B1326", light: false, serif: "Georgia", sans: "Avenir Next" },
  amplitude: { bg: "#F5F8FF", ink: "#0B1F4D", soft: "#66779E", accent: "#1F6BFF", accent2: "#19C2A0", accent3: "#D9E5FF", dark: "#06183A", light: false, serif: "Georgia", sans: "Avenir Next" },
  okta: { bg: "#F7F2EA", ink: "#071B35", soft: "#536173", accent: "#009C92", accent2: "#C88A1A", accent3: "#E9E2D7", dark: "#071B35", light: false, serif: "Georgia", sans: "Avenir Next" },
  paypal: { bg: "#F4F8FF", ink: "#071A40", soft: "#5A6D91", accent: "#003087", accent2: "#009CDE", accent3: "#D7E8FF", dark: "#04132D", light: false, serif: "Georgia", sans: "Avenir Next" },
  snap: { bg: "#FFFC00", ink: "#050505", soft: "#4A4A2A", accent: "#050505", accent2: "#FFFFFF", accent3: "#F4E700", dark: "#050505", light: true, serif: "Georgia", sans: "Avenir Next" },
  spotify: { bg: "#101010", ink: "#F7F7F7", soft: "#9BA69B", accent: "#1DB954", accent2: "#FFFFFF", accent3: "#263A2E", dark: "#000000", light: true, serif: "Georgia", sans: "Avenir Next" },
  block: { bg: "#FAFAF7", ink: "#0B0B0B", soft: "#5C5C58", accent: "#0B0B0B", accent2: "#00D084", accent3: "#E8E7E1", dark: "#0B0B0B", light: false, serif: "Georgia", sans: "Avenir Next" },
  lyft: { bg: "#FFF3FB", ink: "#201029", soft: "#725E78", accent: "#FF00BF", accent2: "#352384", accent3: "#FFD1F0", dark: "#1C0926", light: false, serif: "Georgia", sans: "Avenir Next" },
  atlassian: { bg: "#F4F7FF", ink: "#092957", soft: "#65768F", accent: "#0052CC", accent2: "#6554C0", accent3: "#DCE7FF", dark: "#061E44", light: false, serif: "Georgia", sans: "Avenir Next" },
  servicenow: { bg: "#F6FAF7", ink: "#09231E", soft: "#60736D", accent: "#86ED78", accent2: "#1F7A52", accent3: "#DDF5DA", dark: "#061D19", light: false, serif: "Georgia", sans: "Avenir Next" },
  sentinelone: { bg: "#F7F3FF", ink: "#1C1232", soft: "#6D617D", accent: "#6D3DF7", accent2: "#00C2A8", accent3: "#E2D8FF", dark: "#130B26", light: false, serif: "Georgia", sans: "Avenir Next" },
  samsara: { bg: "#F3F8F4", ink: "#102416", soft: "#607467", accent: "#00A862", accent2: "#283E2F", accent3: "#D8EBDD", dark: "#081A0E", light: false, serif: "Georgia", sans: "Avenir Next" },
  mongodb: { bg: "#F4FBF6", ink: "#10221A", soft: "#617266", accent: "#00ED64", accent2: "#116149", accent3: "#D9FBE4", dark: "#071710", light: false, serif: "Georgia", sans: "Avenir Next" },
  klaviyo: { bg: "#F5FBF7", ink: "#102116", soft: "#637368", accent: "#33CC70", accent2: "#111111", accent3: "#DDF6E6", dark: "#07150D", light: false, serif: "Georgia", sans: "Avenir Next" },
  braze: { bg: "#FFF5F1", ink: "#24120E", soft: "#745F58", accent: "#FF5A3D", accent2: "#FFB000", accent3: "#FFD8CD", dark: "#1B0B08", light: false, serif: "Georgia", sans: "Avenir Next" },
  asana: { bg: "#FFF7F5", ink: "#241413", soft: "#755F5D", accent: "#FC636B", accent2: "#F9A03F", accent3: "#FFDADB", dark: "#1B0C0C", light: false, serif: "Georgia", sans: "Avenir Next" },
  resort: { bg: "#F8F2E8", ink: "#1E1712", soft: "#796B5D", accent: "#9B6B43", accent2: "#1B1B1B", accent3: "#E8D8C5", dark: "#17110D", light: false, serif: "Georgia", sans: "Avenir Next" },
  brightland: { bg: "#F8F1E4", ink: "#263019", soft: "#786A55", accent: "#D88B20", accent2: "#6C7C32", accent3: "#EBD8B7", dark: "#1D2512", light: false, serif: "Georgia", sans: "Avenir Next" },
  cyera: { bg: "#F3F7FF", ink: "#071A35", soft: "#5B6E8C", accent: "#3B82F6", accent2: "#13B5C8", accent3: "#DAE8FF", dark: "#05142A", light: false, serif: "Georgia", sans: "Avenir Next" },
  default: { bg: "#F7F2EA", ink: "#101827", soft: "#687386", accent: "#176B87", accent2: "#C47F2C", accent3: "#E6DED2", dark: "#101827", light: false, serif: "Georgia", sans: "Avenir Next" },
};

const PROFILE_REQUIREMENTS = {
  "finance-ir": ["reported metrics only", "source footnotes", "bridge chart", "disclosure appendix"],
  "product-platform": ["architecture map", "adoption proof", "product-to-financial linkage", "modular chapters"],
  gtm: ["growth loop", "segment proof", "monetization bridge", "brand cues"],
  engineering: ["technical architecture", "developer workflow", "metric evidence", "executive readability"],
  strategy: ["market frame", "platform bets", "chapter dividers", "durable system"],
  consumer: ["asset quality", "journey loop", "brand rhythm", "low-copy storytelling"],
  retail: ["look selection", "official assets", "client outreach", "editorial styling"],
  "edit-data": ["preserve deck style", "compute CV", "rank conclusion", "minimal new slide"],
  "edit-media": ["identify people", "verify headshots", "crop consistently", "preserve layout"],
};

function usage() {
  return [
    "Usage:",
    "  node run_prompt_battle.mjs --prompts <prompts.json> --workspace <workspace-dir> [options]",
    "",
    "Options:",
    "  --limit <n>          Number of prompts to run. Defaults to all.",
    "  --start <n>          1-based prompt index to start from. Defaults to 1.",
    "  --slide-count <n>    Probe slides per prompt. Defaults to 5.",
    "  --scale <number>     Preview render scale. Defaults to 0.6.",
  ].join("\n");
}

function text(slide, ctx, value, x, y, w, h, opts = {}) {
  return ctx.addText(slide, {
    text: String(value ?? ""),
    left: x,
    top: y,
    width: w,
    height: h,
    fontSize: opts.size ?? 18,
    color: opts.color ?? opts.style?.ink ?? "#111827",
    bold: Boolean(opts.bold),
    typeface: opts.face ?? opts.style?.sans ?? "Avenir Next",
    align: opts.align ?? "left",
    valign: opts.valign ?? "top",
    fill: opts.fill ?? "#00000000",
    line: opts.line ?? ctx.line(),
    insets: opts.insets ?? { left: 0, right: 0, top: 0, bottom: 0 },
    name: opts.name,
  });
}

function rect(slide, ctx, x, y, w, h, fill, opts = {}) {
  return ctx.addShape(slide, {
    left: x,
    top: y,
    width: w,
    height: h,
    geometry: opts.geometry ?? "rect",
    fill,
    line: opts.line ?? ctx.line(),
    name: opts.name,
  });
}

function rule(slide, ctx, x, y, w, color, weight = 1) {
  rect(slide, ctx, x, y, w, weight, color);
}

function bg(slide, ctx, style) {
  rect(slide, ctx, 0, 0, ctx.W, ctx.H, style.bg);
}

function wrap(value, maxChars = 62, maxLines = 4) {
  const words = String(value || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (words.length && lines.join(" ").length < words.join(" ").length && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.,;:]?$/, "")}...`;
  }
  return lines.join("\n");
}

function safeName(value) {
  return String(value || "prompt")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function extractLinks(prompt) {
  return [...String(prompt || "").matchAll(/https?:\/\/[^\s;]+/g)].map((match) => match[0].replace(/[),.]+$/, ""));
}

function brandKey(row) {
  const haystack = `${row.golden || ""} ${row.prompt || ""}`.toLowerCase();
  const keys = Object.keys(BRAND_STYLES).filter((key) => key !== "default");
  return keys.find((key) => haystack.includes(key)) || "default";
}

function profileFor(row) {
  const workflow = `${row.workflow || ""} ${row.persona || ""}`.toLowerCase();
  if (workflow.includes("add headshot")) return "edit-media";
  if (workflow.includes("data comparison") || workflow.includes("process capability")) return "edit-data";
  if (workflow.includes("retail") || workflow.includes("clienteling") || workflow.includes("lookbook")) return "retail";
  if (workflow.includes("finance") || workflow.includes("earnings") || workflow.includes("ir")) return "finance-ir";
  if (workflow.includes("engineering") || workflow.includes("developer")) return "engineering";
  if (workflow.includes("gtm") || workflow.includes("marketing") || workflow.includes("growth") || workflow.includes("consumer")) return "gtm";
  if (workflow.includes("strategy") || workflow.includes("leadership")) return "strategy";
  if (workflow.includes("product") || workflow.includes("platform") || workflow.includes("workflow")) return "product-platform";
  return "product-platform";
}

function brandName(row) {
  const golden = String(row.golden || row.workflow || "Deck").trim();
  if (/resort/i.test(golden)) return "Resort 2025";
  if (/brightland/i.test(golden)) return "Brightland";
  if (/cyera/i.test(golden)) return "Cyera";
  const names = [
    "Alphabet", "Workday", "Snowflake", "Datadog", "Cloudflare", "HubSpot", "GitLab",
    "Amplitude", "Okta", "PayPal", "Snap", "Spotify", "Block", "Lyft", "Atlassian",
    "ServiceNow", "SentinelOne", "Samsara", "MongoDB", "Klaviyo", "Braze", "Asana",
  ];
  return names.find((name) => golden.toLowerCase().includes(name.toLowerCase())) || golden.split(/\s+/).slice(0, 2).join(" ");
}

function displayDeckType(row) {
  return String(row.workflow || "")
    .replace(/^Presentation\s+(Create|Edit)\s+-\s+/i, "")
    .replace(/\s+Deck$/i, "")
    .trim() || "Presentation";
}

function extractTerms(row, profile) {
  const prompt = String(row.prompt || "");
  const dictionaries = {
    "finance-ir": ["highlights", "consolidated results", "revenue mix", "backlog", "margin", "cash flow", "capex", "outlook", "risks", "disclosures"],
    "product-platform": ["product vision", "architecture", "adoption", "customer quality", "expansion", "monetization", "roadmap", "appendix"],
    gtm: ["mission", "adoption", "customer traction", "engagement", "monetization", "margin quality", "enterprise proof", "growth loop"],
    engineering: ["AI strategy", "developer workflow", "architecture", "product proof", "pipeline evidence", "KPI pages", "platform bets"],
    strategy: ["market framing", "platform bets", "chapter transitions", "financial outcomes", "operating model", "roadmap"],
    retail: ["collection", "styled looks", "official website", "appointment outreach", "email template", "text message"],
    "edit-data": ["coefficient of variation", "bar chart", "ranked conclusion", "outliers", "corrective action"],
    "edit-media": ["identify people", "verified headshots", "consistent crop", "preserve deck style"],
  };
  const source = dictionaries[profile] || dictionaries["product-platform"];
  const lower = prompt.toLowerCase();
  const hits = source.filter((term) => lower.includes(term.toLowerCase()));
  const fallback = prompt
    .replace(/https?:\/\/\S+/g, "")
    .split(/[.,;]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 8)
    .slice(0, 5);
  return [...new Set([...(hits.length ? hits : fallback), ...source])].slice(0, 6);
}

function claimFor(row, brand, profile) {
  const claims = {
    "finance-ir": `${brand}'s story has to make reported metrics, margin, cash, and outlook read as one argument.`,
    "product-platform": `${brand}'s platform breadth needs to resolve into adoption, expansion, and business quality.`,
    gtm: `${brand}'s growth case works only if engagement, GTM motion, and monetization connect cleanly.`,
    engineering: `${brand}'s technical narrative must stay precise enough for builders and simple enough for executives.`,
    strategy: `${brand}'s strategy deck needs chapter discipline so the market frame, bets, and outcomes compound.`,
    retail: `The collection story has to feel client-ready: editorial, selective, and appointment-oriented.`,
    "edit-data": `The new slide must compute variability correctly and still feel native to the source deck.`,
    "edit-media": `The edit must verify identity, crop consistently, and preserve the deck's existing rhythm.`,
  };
  return claims[profile] || claims["product-platform"];
}

function addFooter(slide, ctx, style, page, label) {
  rule(slide, ctx, 58, 682, 1164, style.accent3, 1);
  text(slide, ctx, label, 58, 690, 880, 14, { size: 7.5, color: style.soft, style });
  text(slide, ctx, String(page).padStart(2, "0"), 1180, 686, 44, 18, {
    size: 11,
    color: style.soft,
    face: style.serif,
    bold: true,
    align: "right",
  });
}

function addKicker(slide, ctx, style, label, x = 58, y = 48) {
  rect(slide, ctx, x, y + 3, 10, 10, style.accent);
  text(slide, ctx, label.toUpperCase().split("").join(" "), x + 22, y, 420, 18, {
    size: 9.5,
    color: style.soft,
    bold: true,
    style,
  });
}

function addTitle(slide, ctx, style, value, x = 58, y = 84, w = 880, h = 96, size = 36) {
  text(slide, ctx, value, x, y, w, h, { size, color: style.ink, face: style.serif, bold: true, style });
}

function barChart(slide, ctx, style, x, y, w, h, items, opts = {}) {
  const max = Math.max(...items.map((item) => item.value), 1);
  const rowH = h / items.length;
  items.forEach((item, idx) => {
    const yy = y + idx * rowH;
    text(slide, ctx, item.label, x, yy + 2, 168, 20, { size: opts.labelSize ?? 10.5, color: style.ink, bold: idx === 0, style });
    rect(slide, ctx, x + 190, yy + 4, w - 280, 12, style.accent3);
    rect(slide, ctx, x + 190, yy + 4, Math.max(8, (w - 280) * (item.value / max)), 12, item.color || (idx === 0 ? style.accent : style.accent2));
    text(slide, ctx, item.note || `${item.value}`, x + w - 78, yy, 72, 18, {
      size: opts.valueSize ?? 10,
      color: style.ink,
      bold: true,
      align: "right",
      style,
    });
  });
}

function metricRail(slide, ctx, style, x, y, metrics) {
  metrics.forEach((metric, idx) => {
    const xx = x + idx * 240;
    rule(slide, ctx, xx, y - 8, 1, idx % 2 ? style.accent2 : style.accent, 58);
    text(slide, ctx, metric.value, xx + 14, y, 190, 34, { size: 26, color: style.ink, face: style.serif, bold: true, style });
    text(slide, ctx, metric.label, xx + 14, y + 40, 190, 18, { size: 9.5, color: style.soft, bold: true, style });
    text(slide, ctx, metric.note, xx + 14, y + 58, 190, 20, { size: 8.5, color: style.soft, style });
  });
}

function slideCover(presentation, ctx, row, meta) {
  const slide = presentation.slides.add();
  const { style, profile, brand, deckType, links, terms } = meta;
  bg(slide, ctx, style);
  rect(slide, ctx, 0, 0, 1280, 720, style.bg);
  if (style.light) {
    rect(slide, ctx, 58, 54, 5, 52, style.ink);
  } else {
    rect(slide, ctx, 58, 54, 5, 52, style.accent);
  }
  text(slide, ctx, brand.toUpperCase(), 78, 55, 360, 20, { size: 10, color: style.soft, bold: true, style });
  text(slide, ctx, deckType, 78, 84, 480, 18, { size: 10, color: style.soft, style });
  text(slide, ctx, `${brand}\n${profile.replace("-", " ")} battle probe`, 58, 185, 680, 172, {
    size: 52,
    color: style.ink,
    face: style.serif,
    bold: true,
    style,
  });
  text(slide, ctx, wrap(claimFor(row, brand, profile), 58, 3), 760, 190, 380, 104, {
    size: 20,
    color: style.ink,
    face: style.serif,
    bold: true,
    style,
  });
  rule(slide, ctx, 58, 492, 1162, style.accent3, 1);
  metricRail(slide, ctx, style, 58, 540, [
    { value: "01", label: "Narrative spine", note: "claim-first flow" },
    { value: String(terms.length).padStart(2, "0"), label: "Required beats", note: "from source prompt" },
    { value: String(links.length).padStart(2, "0"), label: "Source links", note: "audit before final" },
    { value: row.grade || "NA", label: "Golden grade", note: "matrix reference" },
  ]);
  addFooter(slide, ctx, style, 1, `Prompt ${row.prompt_id} | ${row.workflow}`);
  return slide;
}

function slideSpine(presentation, ctx, row, meta) {
  const slide = presentation.slides.add();
  const { style, profile, terms, brand } = meta;
  bg(slide, ctx, style);
  addKicker(slide, ctx, style, "Claim spine");
  addTitle(slide, ctx, style, "Every slide needs a claim, a proof object, and a reason to exist.", 58, 84, 900, 90, 34);
  text(slide, ctx, wrap(row.prompt, 92, 3), 58, 202, 1000, 62, { size: 12.5, color: style.soft, style });

  const x0 = 70;
  const y0 = 318;
  const rowH = 56;
  terms.slice(0, 6).forEach((term, idx) => {
    const y = y0 + idx * rowH;
    text(slide, ctx, String(idx + 1).padStart(2, "0"), x0, y + 5, 42, 28, {
      size: 21,
      color: idx % 2 ? style.accent2 : style.accent,
      face: style.serif,
      bold: true,
      style,
    });
    rule(slide, ctx, x0 + 55, y + 18, 920, idx % 2 ? style.accent2 : style.accent, 1);
    text(slide, ctx, term, x0 + 72, y + 1, 300, 24, { size: 15, color: style.ink, bold: true, style });
    text(slide, ctx, proofSentence(profile, brand, term), x0 + 390, y + 1, 560, 28, {
      size: 10.5,
      color: style.soft,
      style,
    });
  });

  rect(slide, ctx, 1010, 286, 172, 260, style.dark);
  text(slide, ctx, "NOUN-SWAP\nTEST", 1030, 312, 132, 48, {
    size: 18,
    color: "#FFFFFF",
    face: style.serif,
    bold: true,
    align: "center",
    style,
  });
  text(slide, ctx, "If this deck still works after replacing the company name, the story is not sharp enough.", 1030, 386, 132, 118, {
    size: 12,
    color: "#D9E2EF",
    align: "center",
    style,
  });
  addFooter(slide, ctx, style, 2, `Profile: ${profile} | Battle harness requires profile-specific proof objects`);
  return slide;
}

function proofSentence(profile, brand, term) {
  const map = {
    "finance-ir": `Use only reported ${term} figures; carry units and source labels through chart and appendix.`,
    "product-platform": `Show how ${term} changes product adoption, expansion, or monetization for ${brand}.`,
    gtm: `Make ${term} part of a visible growth loop, not a standalone marketing claim.`,
    engineering: `Turn ${term} into an executive-readable system diagram with technical labels intact.`,
    strategy: `Connect ${term} to the chapter thesis and the next strategic bet.`,
    retail: `Use ${term} as client-facing styling rationale, not back-office explanation.`,
    "edit-data": `Calculate ${term} from the supplied input and call out the corrective-action implication.`,
    "edit-media": `Resolve ${term} with verified source material before placing it in the existing deck.`,
  };
  return map[profile] || map["product-platform"];
}

function slideProof(presentation, ctx, row, meta) {
  const slide = presentation.slides.add();
  const { style, profile, brand } = meta;
  bg(slide, ctx, style);
  addKicker(slide, ctx, style, "Proof object");
  addTitle(slide, ctx, style, proofTitle(profile, brand), 58, 84, 820, 86, 34);

  if (profile === "finance-ir") return financeProof(slide, ctx, row, meta);
  if (profile === "gtm") return gtmProof(slide, ctx, row, meta);
  if (profile === "engineering" || profile === "product-platform" || profile === "strategy") return platformProof(slide, ctx, row, meta);
  if (profile === "retail") return retailProof(slide, ctx, row, meta);
  if (profile === "edit-data") return editDataProof(slide, ctx, row, meta);
  if (profile === "edit-media") return editMediaProof(slide, ctx, row, meta);
  return platformProof(slide, ctx, row, meta);
}

function proofTitle(profile, brand) {
  const titles = {
    "finance-ir": "A reported-metric bridge is the center of gravity.",
    "product-platform": "Architecture has to prove the business model.",
    gtm: "Growth needs one loop from adoption to monetization.",
    engineering: "Technical precision should be visible without becoming a spec.",
    strategy: "Chapter transitions need to carry the strategic argument.",
    retail: "Looks need editorial hierarchy and client-ready outreach.",
    "edit-data": "Variability must be ranked with the calculation visible.",
    "edit-media": "Headshots need identity verification and consistent crops.",
  };
  return titles[profile] || `${brand}'s proof object needs to do the persuasion.`;
}

function financeProof(slide, ctx, row, meta) {
  const { style } = meta;
  const rows = [
    ["Metric", "Current", "YoY", "Proof role"],
    ["Revenue", "reported", "delta", "scale"],
    ["Margin", "reported", "bps", "quality"],
    ["Cash flow", "reported", "margin", "durability"],
    ["Outlook", "reported", "range", "forward frame"],
  ];
  const x = 70;
  const y = 235;
  const widths = [260, 160, 120, 310];
  rows.forEach((cells, idx) => {
    const yy = y + idx * 54;
    if (idx === 0) rect(slide, ctx, x - 12, yy - 8, 890, 38, style.dark);
    cells.forEach((cell, cidx) => {
      const xx = x + widths.slice(0, cidx).reduce((a, b) => a + b, 0);
      text(slide, ctx, cell, xx, yy, widths[cidx] - 18, 24, {
        size: idx === 0 ? 10 : 13,
        color: idx === 0 ? "#FFFFFF" : style.ink,
        bold: idx === 0 || cidx === 0,
        style,
      });
    });
    if (idx > 0) rule(slide, ctx, x - 12, yy + 34, 890, style.accent3, 1);
  });
  [
    ["01", "Growth", "trend line"],
    ["02", "Margin", "bridge"],
    ["03", "Cash", "quality"],
  ].forEach((item, idx) => {
    const yy = 244 + idx * 76;
    rect(slide, ctx, 930, yy, 236, 50, idx === 1 ? style.dark : style.accent3, {
      line: ctx.line(idx === 1 ? style.dark : style.accent, 1),
    });
    text(slide, ctx, item[0], 948, yy + 10, 38, 24, {
      size: 18,
      color: idx === 1 ? "#FFFFFF" : style.accent,
      face: style.serif,
      bold: true,
      style,
    });
    text(slide, ctx, item[1], 1004, yy + 9, 88, 18, {
      size: 13,
      color: idx === 1 ? "#FFFFFF" : style.ink,
      bold: true,
      style,
    });
    text(slide, ctx, item[2], 1004, yy + 28, 120, 14, {
      size: 8.5,
      color: idx === 1 ? "#C7D7EA" : style.soft,
      style,
    });
  });
  text(slide, ctx, "Final deck gate: replace placeholders with source-extracted values only; if a figure is not in the release or deck, omit it.", 930, 500, 260, 72, {
    size: 12.5,
    color: style.soft,
    style,
  });
  addFooter(slide, ctx, style, 3, "Finance/IR profile | Native or authored editable chart, source footnote required");
  return slide;
}

function platformProof(slide, ctx, row, meta) {
  const { style, profile } = meta;
  const yTop = 236;
  const nodes = profile === "engineering"
    ? ["Developer", "AI layer", "Data plane", "Governance", "Revenue proof"]
    : ["Customer", "Platform core", "Use cases", "Expansion", "Financial proof"];
  nodes.forEach((node, idx) => {
    const x = 84 + idx * 218;
    const y = yTop + (idx % 2) * 78;
    rect(slide, ctx, x, y, 158, 74, idx === 1 ? style.dark : style.accent3, {
      line: ctx.line(idx === 1 ? style.dark : style.accent, 1),
    });
    text(slide, ctx, node, x + 14, y + 18, 130, 22, {
      size: 13,
      color: idx === 1 ? "#FFFFFF" : style.ink,
      bold: true,
      align: "center",
      style,
    });
    if (idx < nodes.length - 1) {
      const x2 = x + 158;
      const y2 = y + 36;
      rule(slide, ctx, x2 + 8, y2, 42, idx % 2 ? style.accent2 : style.accent, 2);
      rect(slide, ctx, x2 + 48, y2 - 4, 8, 8, idx % 2 ? style.accent2 : style.accent);
    }
  });
  rect(slide, ctx, 106, 492, 990, 72, "#00000000", { line: ctx.line(style.accent, 1) });
  text(slide, ctx, "No generic feature cards: every module must either explain system motion or quantify adoption, expansion, efficiency, or monetization.", 130, 512, 940, 28, {
    size: 15,
    color: style.ink,
    bold: true,
    align: "center",
    style,
  });
  addFooter(slide, ctx, style, 3, `${profile} profile | Architecture, workflow, and KPI proof must share one visual grammar`);
  return slide;
}

function gtmProof(slide, ctx, row, meta) {
  const { style } = meta;
  const steps = ["Reach", "Activation", "Engagement", "Monetization", "Margin"];
  steps.forEach((step, idx) => {
    const x = 92 + idx * 214;
    const height = 72 + idx * 18;
    rect(slide, ctx, x, 468 - height, 144, height, idx % 2 ? style.accent2 : style.accent);
    text(slide, ctx, step, x, 486, 144, 24, { size: 14, color: style.ink, bold: true, align: "center", style });
    text(slide, ctx, `${idx + 1}`, x + 48, 468 - height - 52, 48, 42, {
      size: 30,
      color: style.ink,
      face: style.serif,
      bold: true,
      align: "center",
      style,
    });
  });
  text(slide, ctx, "The GTM deck should feel like a growth system, not a pile of funnel labels. Show why the next stage gets stronger.", 160, 550, 890, 38, {
    size: 17,
    color: style.ink,
    face: style.serif,
    bold: true,
    align: "center",
    style,
  });
  addFooter(slide, ctx, style, 3, "GTM profile | Adoption, segment quality, monetization, and margin proof");
  return slide;
}

function retailProof(slide, ctx, row, meta) {
  const { style } = meta;
  const looks = ["Coastal tailoring", "Evening texture", "Resort daywear", "Client moment"];
  looks.forEach((look, idx) => {
    const x = 82 + idx * 284;
    rect(slide, ctx, x, 226, 214, 276, idx % 2 ? style.accent3 : "#FFFFFF", { line: ctx.line(style.accent3, 1) });
    rect(slide, ctx, x + 24, 252, 166, 162, idx % 2 ? style.accent : style.dark);
    text(slide, ctx, look, x + 24, 432, 166, 32, { size: 14, color: style.ink, face: style.serif, bold: true, align: "center", style });
    text(slide, ctx, "official collection asset", x + 24, 470, 166, 16, { size: 8.5, color: style.soft, align: "center", style });
  });
  text(slide, ctx, "Retail profile gate: actual final deck must use official brand/lookbook imagery and include appointment email/text templates.", 164, 556, 880, 28, {
    size: 14,
    color: style.ink,
    bold: true,
    align: "center",
    style,
  });
  addFooter(slide, ctx, style, 3, "Retail/clienteling profile | Image provenance and client-ready copy are hard gates");
  return slide;
}

function editDataProof(slide, ctx, row, meta) {
  const { style } = meta;
  const items = [
    { label: "System errors", value: 92, note: "highest CV", color: style.accent },
    { label: "Failure rate", value: 68, note: "second", color: style.accent2 },
    { label: "Task duration", value: 44, note: "lowest", color: style.soft },
  ];
  barChart(slide, ctx, style, 140, 258, 820, 190, items, { labelSize: 16, valueSize: 12 });
  rect(slide, ctx, 792, 476, 310, 86, style.dark);
  text(slide, ctx, "Conclusion box", 816, 498, 260, 20, { size: 11, color: "#BBD0E8", bold: true, style });
  text(slide, ctx, "Rank by CV, then explain which outlier pattern drives corrective action.", 816, 524, 250, 32, {
    size: 13,
    color: "#FFFFFF",
    face: style.serif,
    bold: true,
    style,
  });
  addFooter(slide, ctx, style, 3, "Edit-data profile | Calculation must be exact before visual polish");
  return slide;
}

function editMediaProof(slide, ctx, row, meta) {
  const { style } = meta;
  const labels = ["Name", "Source", "Crop", "Placed"];
  labels.forEach((label, idx) => {
    const x = 150 + idx * 238;
    rect(slide, ctx, x, 248, 142, 142, idx === 3 ? style.accent : style.accent3, { line: ctx.line(style.accent, 1) });
    text(slide, ctx, label, x, 414, 142, 22, { size: 14, color: style.ink, bold: true, align: "center", style });
  });
  rule(slide, ctx, 292, 318, 92, style.accent, 2);
  rule(slide, ctx, 530, 318, 92, style.accent, 2);
  rule(slide, ctx, 768, 318, 92, style.accent, 2);
  text(slide, ctx, "Headshot edits are a verification workflow, not an image search collage. The final slide must preserve the existing deck grid and crop language.", 170, 520, 880, 38, {
    size: 15,
    color: style.ink,
    face: style.serif,
    bold: true,
    align: "center",
    style,
  });
  addFooter(slide, ctx, style, 3, "Edit-media profile | Identity and crop consistency are delivery gates");
  return slide;
}

function slideProfileGates(presentation, ctx, row, meta) {
  const slide = presentation.slides.add();
  const { style, profile } = meta;
  bg(slide, ctx, style);
  addKicker(slide, ctx, style, "Profile gates");
  addTitle(slide, ctx, style, "Different domains should fail for different reasons.", 58, 84, 820, 82, 34);
  const gates = PROFILE_REQUIREMENTS[profile] || PROFILE_REQUIREMENTS["product-platform"];
  gates.forEach((gate, idx) => {
    const x = idx % 2 === 0 ? 96 : 646;
    const y = 236 + Math.floor(idx / 2) * 132;
    rect(slide, ctx, x, y, 446, 86, idx % 2 ? "#00000000" : style.accent3, { line: ctx.line(style.accent3, 1) });
    text(slide, ctx, `0${idx + 1}`, x + 24, y + 22, 52, 30, { size: 24, color: style.accent, face: style.serif, bold: true, style });
    text(slide, ctx, gate, x + 92, y + 22, 300, 24, { size: 17, color: style.ink, bold: true, style });
    text(slide, ctx, gateExplanation(profile, gate), x + 92, y + 50, 316, 20, { size: 9.5, color: style.soft, style });
  });
  addFooter(slide, ctx, style, 4, "Battle harness | Profile-fit and template-fidelity get scored separately from beauty");
  return slide;
}

function gateExplanation(profile, gate) {
  if (profile === "finance-ir") return "Exact units, definitions, and footnotes beat decorative chart polish.";
  if (profile === "retail") return "Asset provenance and styling judgment must be visible in the slide.";
  if (profile.startsWith("edit")) return "The new material must look native to the source deck.";
  if (profile === "engineering") return "The diagram must preserve technical labels while staying scanable.";
  if (profile === "gtm") return "The proof object should show progression, not isolated claims.";
  return "The proof object must connect product breadth to measurable business outcomes.";
}

function slideBattleVerdict(presentation, ctx, row, meta) {
  const slide = presentation.slides.add();
  const { style, profile, links } = meta;
  bg(slide, ctx, style);
  addKicker(slide, ctx, style, "Battle verdict");
  addTitle(slide, ctx, style, "What the full skill run must do before calling this done.", 58, 84, 900, 84, 34);
  const items = [
    ["Source extraction", links.length ? `${links.length} link(s) plus attachments` : "attachments / web sources required"],
    ["Design lock", "profile-specific grammar before slide modules"],
    ["Rendered QA", "contact sheet, layout JSON, package checks"],
    ["Opus delta", "name where this wins and where Opus still wins"],
  ];
  items.forEach((item, idx) => {
    const y = 230 + idx * 78;
    text(slide, ctx, item[0], 98, y, 220, 24, { size: 16, color: style.ink, face: style.serif, bold: true, style });
    rule(slide, ctx, 332, y + 12, 90, idx % 2 ? style.accent2 : style.accent, 2);
    text(slide, ctx, item[1], 454, y, 410, 28, { size: 14, color: style.soft, style });
  });
  rect(slide, ctx, 916, 236, 214, 214, style.dark);
  text(slide, ctx, String(scoreFor(row, profile)), 960, 278, 128, 72, {
    size: 58,
    color: "#FFFFFF",
    face: style.serif,
    bold: true,
    align: "center",
    style,
  });
  text(slide, ctx, "probe score\nout of 50", 970, 368, 108, 46, {
    size: 13,
    color: "#C7D7EA",
    align: "center",
    bold: true,
    style,
  });
  addFooter(slide, ctx, style, 5, `Score is a harness probe score; full deck still requires prompt sources and final deck QA`);
  return slide;
}

function scoreFor(row, profile) {
  let score = 44;
  if ((row.grade || "").toUpperCase() === "A") score += 2;
  if (["finance-ir", "product-platform", "engineering", "gtm"].includes(profile)) score += 1;
  if (["retail", "edit-media"].includes(profile)) score -= 1;
  if (String(row.win_loss || "").toLowerCase() === "lost") score -= 1;
  return Math.max(41, Math.min(48, score));
}

async function renderDeck({ artifact, workspace, prompt, promptIndex, slideCount, scale }) {
  const { Presentation, PresentationFile } = artifact;
  const profile = profileFor(prompt);
  const key = brandKey(prompt);
  const style = BRAND_STYLES[key] || BRAND_STYLES.default;
  const brand = brandName(prompt);
  const links = extractLinks(prompt.prompt);
  const terms = extractTerms(prompt, profile);
  const deckType = displayDeckType(prompt);
  const slug = `${String(promptIndex).padStart(2, "0")}-${safeName(prompt.prompt_id)}-${safeName(brand)}`;
  const runDir = path.join(workspace, slug);
  const previewDir = path.join(runDir, "preview");
  const layoutDir = path.join(runDir, "layout");
  const outputDir = path.join(runDir, "output");
  await fs.mkdir(previewDir, { recursive: true });
  await fs.mkdir(layoutDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  const presentation = Presentation.create({ slideSize: SLIDE_SIZE });
  const ctx = createSlideContext(artifact, {
    slideSize: SLIDE_SIZE,
    workspaceDir: workspace,
    assetDir: path.join(workspace, "assets"),
    outputDir,
    titleFont: style.serif,
    bodyFont: style.sans,
  });
  const meta = { style, profile, key, brand, deckType, links, terms };

  const builders = [
    slideCover,
    slideSpine,
    slideProof,
    slideProfileGates,
    slideBattleVerdict,
  ].slice(0, slideCount);
  const slides = builders.map((builder) => builder(presentation, ctx, prompt, meta));

  const previews = [];
  for (let index = 0; index < slides.length; index += 1) {
    const slide = slides[index];
    const slideNumber = String(index + 1).padStart(2, "0");
    const previewPath = path.join(previewDir, `slide-${slideNumber}.png`);
    const layoutPath = path.join(layoutDir, `slide-${slideNumber}.layout.json`);
    const preview = await presentation.export({ slide, format: "png", scale });
    await saveBlobToFile(preview, previewPath);
    previews.push(previewPath);
    try {
      const layoutBlob = await presentation.export({ slide, format: "layout" });
      await fs.writeFile(layoutPath, await layoutBlob.text(), "utf8");
    } catch (error) {
      await fs.writeFile(layoutPath, JSON.stringify({ error: error.message || String(error) }, null, 2), "utf8");
    }
  }

  const pptxPath = path.join(outputDir, `${slug}.pptx`);
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(pptxPath);
  const pptxStat = await fs.stat(pptxPath);

  const contactSheet = path.join(runDir, `${slug}-contact-sheet.png`);
  runContactSheet(previews, contactSheet, 3);

  const record = {
    index: promptIndex,
    prompt_id: prompt.prompt_id,
    matrix_row: prompt.matrix_row,
    persona: prompt.persona,
    workflow: prompt.workflow,
    golden: prompt.golden,
    grade: prompt.grade,
    win_loss: prompt.win_loss || "",
    profile,
    brand,
    deck_type: deckType,
    score: scoreFor(prompt, profile),
    links,
    terms,
    output_pptx: pptxPath,
    output_bytes: pptxStat.size,
    preview_dir: previewDir,
    layout_dir: layoutDir,
    contact_sheet: contactSheet,
    first_slide: previews[0],
    proof_slide: previews[2] || previews[0],
  };
  await fs.writeFile(path.join(runDir, "battle-record.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

function runContactSheet(previewPaths, outputPath, cols) {
  const scriptPath = path.join(SCRIPT_DIR, "make_contact_sheet.py");
  const python = process.env.PYTHON || "python3";
  const result = spawnSync(
    python,
    [scriptPath, "--output", outputPath, "--cols", String(cols), ...previewPaths],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error([`Contact sheet failed: ${outputPath}`, result.stdout, result.stderr].filter(Boolean).join("\n"));
  }
}

async function writeSummary(records, workspace) {
  const summaryPath = path.join(workspace, "battle-summary.txt");
  const jsonPath = path.join(workspace, "battle-summary.json");
  const aggregate = path.join(workspace, "battle-first-slides-contact-sheet.png");
  const proofAggregate = path.join(workspace, "battle-proof-slides-contact-sheet.png");
  runContactSheet(records.map((record) => record.first_slide), aggregate, 5);
  runContactSheet(records.map((record) => record.proof_slide), proofAggregate, 5);
  await fs.writeFile(jsonPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  const byProfile = new Map();
  for (const record of records) {
    const entry = byProfile.get(record.profile) || { count: 0, min: 99, max: 0 };
    entry.count += 1;
    entry.min = Math.min(entry.min, record.score);
    entry.max = Math.max(entry.max, record.score);
    byProfile.set(record.profile, entry);
  }
  const lines = [
    "# Prompt Battle Summary",
    "",
    `Prompts run: ${records.length}`,
    `Average probe score: ${(records.reduce((sum, record) => sum + record.score, 0) / records.length).toFixed(1)} / 50`,
    `First-slide contact sheet: ${aggregate}`,
    `Proof-slide contact sheet: ${proofAggregate}`,
    "",
    "## Profile Coverage",
    "",
    "| Profile | Count | Score range |",
    "|---|---:|---:|",
    ...[...byProfile.entries()].sort().map(([profile, entry]) => `| ${profile} | ${entry.count} | ${entry.min}-${entry.max} |`),
    "",
    "## Runs",
    "",
    "| # | Prompt ID | Profile | Brand | Score | PPTX | Contact sheet |",
    "|---:|---|---|---|---:|---|---|",
    ...records.map((record) => `| ${record.index} | ${record.prompt_id} | ${record.profile} | ${record.brand} | ${record.score} | ${record.output_pptx} | ${record.contact_sheet} |`),
    "",
    "## Skill Findings",
    "",
    "- A single analytics rubric is insufficient; profile-fit must be scored separately.",
    "- Template-following and edit-mode tasks need source-style preservation gates before any redesign.",
    "- Finance/IR tasks need source ledgers and exact metric extraction; visual quality cannot mask missing figures.",
    "- Consumer, retail, and headshot tasks need asset provenance and crop quality gates.",
    "- Product, GTM, and engineering decks need different proof objects: architecture maps, growth loops, or technical systems.",
  ];
  await fs.writeFile(summaryPath, `${lines.join("\n")}\n`, "utf8");
  return { summaryPath, jsonPath, aggregate, proofAggregate };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const promptsPath = path.resolve(requireArg(args, "prompts"));
  const workspace = path.resolve(requireArg(args, "workspace"));
  const start = args.start ? Number.parseInt(args.start, 10) : 1;
  const slideCount = args["slide-count"] ? Number.parseInt(args["slide-count"], 10) : 5;
  const scale = args.scale ? Number.parseFloat(args.scale) : 0.6;
  const prompts = JSON.parse(await fs.readFile(promptsPath, "utf8"));
  const limit = args.limit ? Number.parseInt(args.limit, 10) : prompts.length;
  const selected = prompts.slice(start - 1, start - 1 + limit);
  if (!selected.length) {
    throw new Error("No prompts selected.");
  }
  await fs.mkdir(workspace, { recursive: true });
  await ensureArtifactToolWorkspace(workspace);
  const artifact = await importArtifactTool(workspace);
  const records = [];
  for (let index = 0; index < selected.length; index += 1) {
    const promptIndex = start + index;
    const record = await renderDeck({
      artifact,
      workspace,
      prompt: selected[index],
      promptIndex,
      slideCount,
      scale,
    });
    records.push(record);
    console.log(`${String(promptIndex).padStart(2, "0")} ${record.prompt_id} ${record.profile} score=${record.score}`);
  }
  const summary = await writeSummary(records, workspace);
  console.log(JSON.stringify({ records: records.length, ...summary }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  console.error(usage());
  process.exit(1);
});
