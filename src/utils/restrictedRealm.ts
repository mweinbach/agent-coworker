/** Globals a restricted script is permitted to see. Everything else is stripped. */
const ALLOWED_GLOBALS = [
  "globalThis",
  "undefined",
  "NaN",
  "Infinity",
  "isNaN",
  "isFinite",
  "parseInt",
  "parseFloat",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "Object",
  "Function",
  "Array",
  "String",
  "Boolean",
  "Number",
  "Math",
  "Date",
  "RegExp",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
  "SuppressedError",
  "JSON",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Symbol",
  "BigInt",
  "Proxy",
  "Reflect",
  "Iterator",
  "console",
  "ArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "DisposableStack",
  "AsyncDisposableStack",
];

/** Ambient-capability restriction only: node:vm is not an OS security boundary. */
export const RESTRICTED_REALM_SEAL_SOURCE = `
(() => {
  const ALLOWED = new Set(${JSON.stringify(ALLOWED_GLOBALS)});
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (ALLOWED.has(name)) continue;
    try { delete globalThis[name]; } catch {}
    if (name in globalThis) {
      try {
        Object.defineProperty(globalThis, name, { value: undefined, configurable: false });
      } catch {}
    }
  }

})();
`;
