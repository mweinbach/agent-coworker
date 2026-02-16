import { createContext, useContext, type JSX } from "solid-js";

type CleanupFn = () => void;

type ExitContextValue = {
  register: (fn: CleanupFn) => void;
  exit: () => void;
};

const ExitContext = createContext<ExitContextValue>();

export function ExitProvider(props: { children: JSX.Element; onExit?: () => void }) {
  const cleanups: CleanupFn[] = [];
  let exited = false;

  const value: ExitContextValue = {
    register(fn: CleanupFn) {
      cleanups.push(fn);
    },
    exit() {
      if (exited) return;
      exited = true;
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          // ignore cleanup errors
        }
      }
      if (props.onExit) {
        props.onExit();
        return;
      }
      process.kill(process.pid, "SIGTERM");
    },
  };

  return (
    <ExitContext.Provider value={value}>
      {props.children}
    </ExitContext.Provider>
  );
}

export function useExit(): ExitContextValue {
  const ctx = useContext(ExitContext);
  if (!ctx) throw new Error("useExit must be used within ExitProvider");
  return ctx;
}
