const nativeDisabledElements = new Set([
  "button",
  "fieldset",
  "input",
  "optgroup",
  "option",
  "select",
  "textarea",
]);

function supportsNativeDisabled(elementType: unknown): boolean {
  return typeof elementType === "string" && nativeDisabledElements.has(elementType);
}

export { supportsNativeDisabled };
