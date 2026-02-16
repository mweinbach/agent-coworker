import { createSignal, type Accessor } from "solid-js";

/**
 * Creates a signal that automatically updates when the accessor value changes.
 */
export function createDerivedSignal<T>(accessor: () => T): Accessor<T> {
  const [value, setValue] = createSignal<T>(accessor());
  return value;
}

/**
 * Creates a toggle signal with convenient toggle function.
 */
export function createToggle(initial = false): [Accessor<boolean>, () => void, (v: boolean) => void] {
  const [value, setValue] = createSignal(initial);
  const toggle = () => setValue((v) => !v);
  return [value, toggle, setValue];
}
