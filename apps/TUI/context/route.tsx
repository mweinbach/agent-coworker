import { createContext, useContext, createSignal, type JSX, type Accessor } from "solid-js";

export type RouteState =
  | { route: "home"; initialPrompt?: string }
  | { route: "session"; sessionId: string };

type RouteContextValue = {
  current: Accessor<RouteState>;
  navigate: (to: RouteState) => void;
};

const RouteContext = createContext<RouteContextValue>();

export function RouteProvider(props: { initial?: RouteState; children: JSX.Element }) {
  const [current, setCurrent] = createSignal<RouteState>(
    props.initial ?? { route: "home" }
  );

  const value: RouteContextValue = {
    current,
    navigate(to: RouteState) {
      setCurrent(to);
    },
  };

  return (
    <RouteContext.Provider value={value}>
      {props.children}
    </RouteContext.Provider>
  );
}

export function useRoute(): RouteContextValue {
  const ctx = useContext(RouteContext);
  if (!ctx) throw new Error("useRoute must be used within RouteProvider");
  return ctx;
}
