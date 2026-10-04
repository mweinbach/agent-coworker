import { useEffect, useState } from "react";

function readPreference(key: string): unknown {
  try {
    const raw = localStorage.getItem(`cowork.sidebar.${key}`);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readBooleanPreference(key: string, fallback: boolean): boolean {
  const value = readPreference(key);
  return typeof value === "boolean" ? value : fallback;
}

function readExpansionPreference(key: string): Record<string, boolean> {
  const value = readPreference(key);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
    ),
  );
}

function usePersistedState<T>(key: string, readInitial: (key: string) => T) {
  const [state, setState] = useState<T>(() => readInitial(key));

  useEffect(() => {
    try {
      localStorage.setItem(`cowork.sidebar.${key}`, JSON.stringify(state));
    } catch (error) {
      console.warn(`Failed to save ${key} to localStorage:`, error);
    }
  }, [key, state]);

  return [state, setState] as const;
}

export function useSidebarPersistence() {
  const [expandedWorkspaceSections, setExpandedWorkspaceSections] = usePersistedState(
    "expandedWorkspaceSections",
    readExpansionPreference,
  );
  const [expandedThreadLists, setExpandedThreadLists] = usePersistedState(
    "expandedThreadLists",
    readExpansionPreference,
  );
  const [expandedTaskLists, setExpandedTaskLists] = usePersistedState(
    "expandedTaskLists",
    readExpansionPreference,
  );
  const [projectsOpen, setProjectsOpen] = usePersistedState("projectsOpen", (key) =>
    readBooleanPreference(key, true),
  );
  const [chatsOpen, setChatsOpen] = usePersistedState("chatsOpen", (key) =>
    readBooleanPreference(key, true),
  );
  const [showAllChats, setShowAllChats] = usePersistedState("showAllChats", (key) =>
    readBooleanPreference(key, false),
  );

  return {
    expandedWorkspaceSections,
    setExpandedWorkspaceSections,
    expandedThreadLists,
    setExpandedThreadLists,
    expandedTaskLists,
    setExpandedTaskLists,
    projectsOpen,
    setProjectsOpen,
    chatsOpen,
    setChatsOpen,
    showAllChats,
    setShowAllChats,
  };
}
