import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";

export type SettingsChromeState = {
  /** Optional row on the right side of the sticky settings header (actions, secondary controls). */
  headerActions?: ReactNode;
};

type SettingsChromeApi = {
  setChrome: (patch: Partial<SettingsChromeState> | null) => void;
};

const SettingsChromeContext = createContext<SettingsChromeApi | null>(null);

export function SettingsChromeProvider({
  children,
  onChromeChange,
}: {
  children: ReactNode;
  onChromeChange: (chrome: SettingsChromeState) => void;
}) {
  const setChrome = useCallback(
    (patch: Partial<SettingsChromeState> | null) => {
      onChromeChange(patch ?? {});
    },
    [onChromeChange],
  );

  const value = useMemo(() => ({ setChrome }), [setChrome]);

  return <SettingsChromeContext.Provider value={value}>{children}</SettingsChromeContext.Provider>;
}

/** Safe when the provider is absent (e.g. isolated tests rendering a page alone). */
export function useOptionalSettingsChrome(): SettingsChromeApi | null {
  return useContext(SettingsChromeContext);
}
