#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const ALLOWED_SOURCE_TYPES = new Set([
  "official_brand_or_source_asset",
  "native_editable_shape",
  "lucide_or_selected_icon_library",
  "editable_label_or_card",
  "approved_clean_official_source_crop",
  "imagegen_crop_last_resort",
]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--manifest") {
      args.manifest = value;
      i += 1;
    } else if (key === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument '${key}'`);
    }
  }
  return args;
}

function usage() {
  return "Usage: check_icon_manifest.mjs --manifest /path/icon-manifest.json";
}

function addError(errors, message) {
  errors.push(message);
}

function requireString(errors, value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    addError(errors, `${path} must be a non-empty string`);
  }
}

function requireSlides(errors, value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    addError(errors, `${path} must be a non-empty array`);
  }
}

function validateItem(errors, item, path) {
  requireString(errors, item.id, `${path}.id`);
  requireSlides(errors, item.slides, `${path}.slides`);
  requireString(errors, item.role, `${path}.role`);
  requireString(errors, item.source_type, `${path}.source_type`);

  if (item.source_type && !ALLOWED_SOURCE_TYPES.has(item.source_type)) {
    addError(errors, `${path}.source_type '${item.source_type}' is not allowed`);
  }

  if (item.source_type === "lucide_or_selected_icon_library") {
    requireString(errors, item.library, `${path}.library`);
    requireString(errors, item.icon_name, `${path}.icon_name`);
  }

  if (
    item.source_type === "official_brand_or_source_asset" ||
    item.source_type === "approved_clean_official_source_crop" ||
    item.source_type === "imagegen_crop_last_resort"
  ) {
    requireString(errors, item.asset_path, `${path}.asset_path`);
  }

  if (item.source_type === "imagegen_crop_last_resort") {
    if (item.approval_status !== "approved_last_resort") {
      addError(errors, `${path}.approval_status must be 'approved_last_resort'`);
    }
    if (item.not_logo_brand_mark_generic_icon_chart_label_or_ui_symbol !== true) {
      addError(
        errors,
        `${path} must confirm it is not a logo, brand mark, generic icon, chart label, or UI symbol`
      );
    }
    requireString(errors, item.reason_no_better_source_exists, `${path}.reason_no_better_source_exists`);
  }
}

function validateLastResort(errors, item, path) {
  requireString(errors, item.id, `${path}.id`);
  requireSlides(errors, item.slides, `${path}.slides`);
  requireString(errors, item.asset_path, `${path}.asset_path`);
  requireString(errors, item.reason_no_better_source_exists, `${path}.reason_no_better_source_exists`);
  if (item.approved_by_main_agent !== true) {
    addError(errors, `${path}.approved_by_main_agent must be true`);
  }
  if (item.not_logo_brand_mark_generic_icon_chart_label_or_ui_symbol !== true) {
    addError(
      errors,
      `${path} must confirm it is not a logo, brand mark, generic icon, chart label, or UI symbol`
    );
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}
if (!args.manifest) {
  throw new Error(usage());
}

const manifest = JSON.parse(await readFile(args.manifest, "utf8"));
const errors = [];

if (!Array.isArray(manifest.items)) {
  addError(errors, "items must be an array");
} else {
  manifest.items.forEach((item, index) => validateItem(errors, item, `items[${index}]`));
}

if (manifest.last_resort_imagegen_crops !== undefined) {
  if (!Array.isArray(manifest.last_resort_imagegen_crops)) {
    addError(errors, "last_resort_imagegen_crops must be an array");
  } else {
    manifest.last_resort_imagegen_crops.forEach((item, index) =>
      validateLastResort(errors, item, `last_resort_imagegen_crops[${index}]`)
    );
  }
}

if (errors.length) {
  console.error("Icon manifest check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Icon manifest check passed: ${args.manifest}`);
