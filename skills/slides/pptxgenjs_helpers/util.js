// Copyright (c) OpenAI. All rights reserved.
"use strict";

function calcTextBoxHeight(fontSize, lines = 1, leading = 1.15, padding = 0.3) {
  const lineHeightIn = (fontSize / 72) * leading;
  return lines * lineHeightIn + padding;
}

// Safe outer shadow helper (avoid inner/outer mix and XML pitfalls)
function safeOuterShadow(
  color = "000000",
  opacity = 0.25,
  angle = 45,
  blur = 3,
  offset = 2
) {
  return {
    type: "outer",
    color,
    opacity,
    angle,
    blur,
    offset,
  };
}

module.exports = {
  calcTextBoxHeight,
  safeOuterShadow,
};
