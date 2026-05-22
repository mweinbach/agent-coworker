import { useEffect, useState } from "react";

export function useSidebarPersistence() {
  const [expandedWorkspaceSections, setExpandedWorkspaceSections] = useState<
    Record<string, boolean>
  >(() => {
    try {
      const raw = localStorage.getItem("cowork.sidebar.expandedWorkspaceSections");
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [expandedThreadLists, setExpandedThreadLists] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem("cowork.sidebar.expandedThreadLists");
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [projectsOpen, setProjectsOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem("cowork.sidebar.projectsOpen");
      return raw !== null ? JSON.parse(raw) : true;
    } catch {
      return true;
    }
  });
  const [chatsOpen, setChatsOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem("cowork.sidebar.chatsOpen");
      return raw !== null ? JSON.parse(raw) : true;
    } catch {
      return true;
    }
  });
  const [showAllChats, setShowAllChats] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem("cowork.sidebar.showAllChats");
      return raw !== null ? JSON.parse(raw) : false;
    } catch {
      return false;
    }
  });

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
    projectsOpen,
    setProjectsOpen,
    chatsOpen,
    setChatsOpen,
    showAllChats,
    setShowAllChats,
  };
}
