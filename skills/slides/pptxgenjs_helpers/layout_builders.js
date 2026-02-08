// Copyright (c) OpenAI. All rights reserved.
"use strict";

const { calcTextBoxHeight } = require("./util");
const { imageSizingCrop, imageSizingContain } = require("./image");
const { getSlideDimensions } = require("./layout");

module.exports = {
  addImageTextCard,
  addCardRow,
  addIconTitleTextGroup,
  addIconTitleTextGroupsRow,
  addThreeLevelTree,
};

function addImageTextCard(slide, opts = {}) {
  const x = toNumberOr(opts.x, 0);
  const y = toNumberOr(opts.y, 0);
  const w = toNumberOr(opts.width, 3.0);
  const gap = toNumberOr(opts.gap, 0.15);
  const image = opts.image || {};
  const text = opts.text || "";
  const textBox = opts.textBox || {};

  const boxH = toNumberOr(image.boxHeight, 2.2);
  const sizing = (image.sizing || "crop").toLowerCase();
  let imgPlacement;
  if (image.path || image.data) {
    const base = image.path ? { path: image.path } : { data: image.data };
    if (sizing === "contain") {
      imgPlacement = imageSizingContain(
        image.path || image.data,
        x,
        y,
        w,
        boxH
      );
      slide.addImage({ ...base, ...imgPlacement });
    } else {
      const c = image.crop || {};
      imgPlacement = imageSizingCrop(
        image.path || image.data,
        x,
        y,
        w,
        boxH,
        c.cx,
        c.cy,
        c.cw,
        c.ch
      );
      slide.addImage({ ...base, ...imgPlacement });
    }
  }

  const textY = y + boxH + gap;
  const fontSize = toNumberOr(textBox.fontSize, 14);
  const lines = toNumberOr(textBox.lines, 5);
  const hText = toNumberOr(textBox.h, calcTextBoxHeight(fontSize, lines));
  slide.addText(text, {
    x,
    y: textY,
    w,
    h: hText,
    fontFace: textBox.fontFace,
    fontSize,
    color: textBox.color,
    align: textBox.align,
    valign: textBox.valign || "top",
    paraSpaceAfter: textBox.paraSpaceAfter,
    margin: textBox.margin,
    fill: opts.background,
  });

  return {
    x,
    y,
    w,
    image: {
      x: imgPlacement?.x ?? x,
      y,
      w: imgPlacement?.w ?? w,
      h: imgPlacement?.h ?? boxH,
    },
    text: { x, y: textY, w, h: hText },
  };
}

function addCardRow(slide, region, cards = [], options = {}) {
  const rx = toNumberOr(region.x, 0.4);
  const ry = toNumberOr(region.y, 1.6);
  const slideWidth = getSlideDimensions(slide).width;
  const rw = toNumberOr(region.w, slideWidth - rx * 2);
  const gap = toNumberOr(options.gap, 0.25);
  const count = cards.length;
  if (count === 0) return [];

  let cardW;
  if (options.widthStrategy === "fixed") {
    cardW = toNumberOr(
      options.cardWidth,
      rw / count - (gap * (count - 1)) / count
    );
  } else {
    cardW = (rw - gap * (count - 1)) / count;
  }

  const totalWidth = cardW * count + gap * (count - 1);
  const align = options.align || "left";
  const ox =
    align === "center"
      ? (rw - totalWidth) / 2
      : align === "right"
      ? rw - totalWidth
      : 0;

  const placements = [];
  for (let i = 0; i < count; i++) {
    const x = rx + ox + i * (cardW + gap);
    placements.push(
      addImageTextCard(slide, { ...cards[i], x, y: ry, width: cardW })
    );
  }
  return placements;
}

function addIconTitleTextGroup(slide, opts = {}) {
  const x = toNumberOr(opts.x, 0);
  const y = toNumberOr(opts.y, 0);
  const labelW = toNumberOr(opts.widths?.labelW, 0.8);
  const bodyW = toNumberOr(opts.widths?.bodyW, 2.6);
  const gapIconTitle = toNumberOr(opts.gaps?.iconTitle, 0.15);
  const gapLabelBody = toNumberOr(opts.gaps?.labelBody, 0.25);
  const iconW = toNumberOr(opts.icon?.w, 0.4);
  const iconH = toNumberOr(opts.icon?.h, 0.4);
  const fontFace = opts.fonts?.fontFace;
  const titleSize = toNumberOr(opts.fonts?.titleSize, 14);
  const bodySize = toNumberOr(opts.fonts?.bodySize, 12);

  const iconX = x + (labelW - iconW) / 2;
  slide.addImage({
    ...(opts.icon?.data ? { data: opts.icon.data } : { path: opts.icon?.path }),
    x: iconX,
    y,
    w: iconW,
    h: iconH,
  });
  const titleH = calcTextBoxHeight(titleSize);
  slide.addText(opts.title || "", {
    x,
    y: y + iconH + gapIconTitle,
    w: labelW,
    h: titleH,
    fontFace,
    fontSize: titleSize,
    align: "center",
    valign: "top",
  });

  const groupTop = y;
  const bodyY = groupTop;
  const hBody = toNumberOr(
    opts.bodyBox?.h,
    calcTextBoxHeight(bodySize, 16, 1.4)
  );
  slide.addText(opts.body || "", {
    x: x + labelW + gapLabelBody,
    y: bodyY,
    w: bodyW,
    h: hBody,
    fontFace,
    fontSize: bodySize,
    paraSpaceAfter: bodySize * 0.3,
    valign: "top",
  });

  return {
    x,
    y,
    label: {
      x,
      y,
      w: labelW,
      h: Math.max(iconH + gapIconTitle + titleH, hBody),
    },
    body: { x: x + labelW + gapLabelBody, y: bodyY, w: bodyW, h: hBody },
  };
}

function addIconTitleTextGroupsRow(slide, region, groups = [], options = {}) {
  const rx = toNumberOr(region.x, 0.4);
  const ry = toNumberOr(region.y, 1.6);
  const slideWidth = getSlideDimensions(slide).width;
  const rw = toNumberOr(region.w, slideWidth - rx * 2);
  const gap = toNumberOr(options.gap, 0.9);
  const count = groups.length;
  if (count === 0) return [];
  const groupW = toNumberOr(
    options.groupWidth,
    (rw - gap * (count - 1)) / count
  );
  const placements = [];
  for (let i = 0; i < count; i++) {
    const x = rx + i * (groupW + gap);
    placements.push(addIconTitleTextGroup(slide, { ...groups[i], x, y: ry }));
  }
  return placements;
}

function addThreeLevelTree(slide, opts = {}) {
  const slideWidth = getSlideDimensions(slide).width;
  const cx = toNumberOr(opts.centerX, slideWidth / 2);
  const topY = toNumberOr(opts.topY, 1.6);

  const rootW = toNumberOr(opts.root?.w, 3.3333333);
  const rootH = toNumberOr(opts.root?.h, 0.93333333);
  const rootX = cx - rootW / 2;

  slide.addText(opts.root?.text || "", {
    x: rootX,
    y: topY,
    w: rootW,
    h: rootH,
    align: "center",
    valign: "mid",
    fontFace: opts.root?.fontFace,
    fontSize: toNumberOr(opts.root?.fontSize, 16),
    color: opts.root?.color || "FFFFFF",
    fill: { color: opts.root?.fill || "0B0F1A" },
    line: { color: opts.root?.line || opts.root?.fill || "0B0F1A" },
  });

  const midLabels = Array.isArray(opts.mid?.labels) ? opts.mid.labels : [];
  let midW = toNumberOr(opts.mid?.w, NaN);
  const midH = toNumberOr(opts.mid?.h, rootH);
  const midY = toNumberOr(opts.mid?.y, topY + rootH + 1.2);
  const requestedSpacing = toNumberOr(opts.mid?.spacing, NaN); // center-to-center distance if provided
  const leftRightMargin = toNumberOr(opts.mid?.marginX, 0.6);
  const availableRowWidth = slideWidth - leftRightMargin * 2;
  const countMid = midLabels.length;
  const minGap = 0.4;
  if (!Number.isFinite(midW) && Number.isFinite(requestedSpacing)) {
    // Derive midW from spacing and available width
    const totalSpan = requestedSpacing * (countMid - 1) + 0; // span between first and last centers
    const maxW = Math.min(rootW, (availableRowWidth - totalSpan) / countMid);
    midW = Math.max(0.8, maxW);
  }
  if (!Number.isFinite(midW)) {
    // Fit equally within available width with minimum gaps
    midW = Math.max(
      0.8,
      (availableRowWidth - minGap * (countMid - 1)) / countMid
    );
  }
  // Compute gap to center-group horizontally without overlap
  let gap = Math.max(
    minGap,
    (availableRowWidth - midW * countMid) / Math.max(1, countMid - 1)
  );
  const totalWidth = midW * countMid + gap * (countMid - 1);
  const startLeft = cx - totalWidth / 2;
  for (let i = 0; i < midLabels.length; i++) {
    const x = startLeft + i * (midW + gap);
    slide.addText(midLabels[i], {
      x,
      y: midY,
      w: midW,
      h: midH,
      align: "center",
      valign: "mid",
      fontFace: opts.mid?.fontFace,
      fontSize: toNumberOr(opts.mid?.fontSize, 16),
      color: opts.mid?.color || "000000",
      fill: { color: opts.mid?.fill || "A0BEC2" },
      line: { color: opts.mid?.line || opts.mid?.fill || "A0BEC2" },
    });
    addConnector(slide, cx, topY + rootH, x + midW / 2, midY, opts.line);
  }

  const leavesPerMid = Array.isArray(opts.leaf?.labelsPerMid)
    ? opts.leaf.labelsPerMid
    : [];
  const leafW = toNumberOr(opts.leaf?.w, 1.05);
  const leafH = toNumberOr(opts.leaf?.h, 1.0666667);
  const leafY = toNumberOr(opts.leaf?.y, midY + midH + 1.0);
  const minLeafGap = 0.2;
  for (let i = 0; i < midLabels.length; i++) {
    const xBase = startLeft + i * (midW + gap);
    const childLabels = Array.isArray(leavesPerMid[i]) ? leavesPerMid[i] : [];
    const childCount = childLabels.length || 3;
    // Compute per-mid gap to fit children within midW without overlap
    const leafGap = Math.max(
      minLeafGap,
      (midW - childCount * leafW) / Math.max(1, childCount - 1)
    );
    const totalWidth = childCount * leafW + (childCount - 1) * leafGap;
    const leftX = xBase + (midW - totalWidth) / 2;
    for (let j = 0; j < childCount; j++) {
      const x = leftX + j * (leafW + leafGap);
      slide.addText(childLabels[j] || "", {
        x,
        y: leafY,
        w: leafW,
        h: leafH,
        align: "center",
        valign: "mid",
        fontFace: opts.leaf?.fontFace,
        fontSize: toNumberOr(opts.leaf?.fontSize, 16),
        color: opts.leaf?.color || "000000",
        fill: { color: opts.leaf?.fill || "A6C1EE" },
        line: { color: opts.leaf?.line || opts.leaf?.fill || "A6C1EE" },
      });
      addConnector(
        slide,
        xBase + midW / 2,
        midY + midH,
        x + leafW / 2,
        leafY,
        opts.line
      );
    }
  }
}

function addConnector(slide, x1, y1, x2, y2, line = {}) {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  slide.addShape("line", {
    x,
    y,
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
    line: { color: line.color || "000000", pt: line.pt || 1 },
    flipH: x2 < x1 ? true : undefined,
  });
}

function toNumberOr(v, fallback) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : fallback;
}
