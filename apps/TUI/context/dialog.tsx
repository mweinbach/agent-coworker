import { createContext, useContext, createSignal, type JSX, type Accessor } from "solid-js";

type DialogEntry = {
  element: () => JSX.Element;
  onClose?: () => void;
};

type DialogContextValue = {
  stack: Accessor<DialogEntry[]>;
  push: (element: () => JSX.Element, onClose?: () => void) => void;
  replace: (element: () => JSX.Element, onClose?: () => void) => void;
  pop: () => void;
  clear: () => void;
  hasDialog: Accessor<boolean>;
};

const DialogContext = createContext<DialogContextValue>();

export function DialogProvider(props: { children: JSX.Element }) {
  const [stack, setStack] = createSignal<DialogEntry[]>([]);

  const value: DialogContextValue = {
    stack,

    push(element: () => JSX.Element, onClose?: () => void) {
      setStack((prev) => [...prev, { element, onClose }]);
    },

    replace(element: () => JSX.Element, onClose?: () => void) {
      setStack([{ element, onClose }]);
    },

    pop() {
      setStack((prev) => {
        if (prev.length === 0) return prev;
        const top = prev[prev.length - 1];
        top.onClose?.();
        return prev.slice(0, -1);
      });
    },

    clear() {
      setStack((prev) => {
        for (const entry of prev) {
          entry.onClose?.();
        }
        return [];
      });
    },

    get hasDialog() {
      return () => stack().length > 0;
    },
  };

  return (
    <DialogContext.Provider value={value}>
      {props.children}
    </DialogContext.Provider>
  );
}

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used within DialogProvider");
  return ctx;
}
