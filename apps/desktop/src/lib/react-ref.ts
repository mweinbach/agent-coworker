import type * as React from "react";

export function assignElementRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (!ref) {
    return;
  }
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  (ref as React.MutableRefObject<T | null>).current = value;
}

export function assignComposedRefs<T>(value: T | null, ...refs: Array<React.Ref<T> | undefined>) {
  for (const ref of refs) {
    assignElementRef(ref, value);
  }
}

export function getElementRef<T>(element: React.ReactElement): React.Ref<T> | undefined {
  const withPossibleRef = element as React.ReactElement & {
    ref?: React.Ref<T>;
    props: { ref?: React.Ref<T> };
  };
  return withPossibleRef.props.ref ?? withPossibleRef.ref;
}
