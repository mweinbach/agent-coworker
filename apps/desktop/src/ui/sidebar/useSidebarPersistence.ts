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

export function useSidebarPersistence() {
  const [expandedWorkspaceSections, setExpandedWorkspaceSections] = useState<
    Record<string, boolean>
  >(() => readExpansionPreference("expandedWorkspaceSections"));
  const [expandedThreadLists, setExpandedThreadLists] = useState<Record<string, boolean>>(() =>
    readExpansionPreference("expandedThreadLists"),
  );
  const [expandedTaskLists, setExpandedTaskLists] = useState<Record<string, boolean>>(() =>
    readExpansionPreference("expandedTaskLists"),
  );
  const [projectsOpen, setProjectsOpen] = useState(() =>
    readBooleanPreference("projectsOpen", true),
  );
  const [chatsOpen, setChatsOpen] = useState(() => readBooleanPreference("chatsOpen", true));
  const [showAllChats, setShowAllChats] = useState(() =>
    readBooleanPreference("showAllChats", false),
  );

  useEffect(() => {
    try {
      localStorage.setItem(
        "cowork.sidebar.expandedWorkspaceSections",
        JSON.stringify(expandedWorkspaceSections),
      );
    } catch (error) {
      console.warn("Failed to save expandedWorkspaceSections to localStorage:", error);
    }
  }, [expandedWorkspaceSections]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "cowork.sidebar.expandedThreadLists",
        JSON.stringify(expandedThreadLists),
      );
    } catch (error) {
      console.warn("Failed to save expandedThreadLists to localStorage:", error);
    }
  }, [expandedThreadLists]);

  useEffect(() => {
    try {
      localStorage.setItem("cowork.sidebar.expandedTaskLists", JSON.stringify(expandedTaskLists));
    } catch (error) {
      console.warn("Failed to save expandedTaskLists to localStorage:", error);
    }
  }, [expandedTaskLists]);

  useEffect(() => {
    try {
      localStorage.setItem("cowork.sidebar.projectsOpen", JSON.stringify(projectsOpen));
    } catch (error) {
      console.warn("Failed to save projectsOpen to localStorage:", error);
    }
  }, [projectsOpen]);

  useEffect(() => {
    try {
      localStorage.setItem("cowork.sidebar.chatsOpen", JSON.stringify(chatsOpen));
    } catch (error) {
      console.warn("Failed to save chatsOpen to localStorage:", error);
    }
  }, [chatsOpen]);

  useEffect(() => {
    try {
      localStorage.setItem("cowork.sidebar.showAllChats", JSON.stringify(showAllChats));
    } catch (error) {
      console.warn("Failed to save showAllChats to localStorage:", error);
    }
  }, [showAllChats]);

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
