import { useSyncExternalStore } from "react";

type ThemeListener = () => void;

export class DocumentThemeStore {
  private readonly listeners = new Set<ThemeListener>();
  private observer: MutationObserver | null = null;
  private snapshot = this.readSnapshot();

  subscribe = (listener: ThemeListener): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.start();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.observer?.disconnect();
        this.observer = null;
      }
    };
  };

  getSnapshot = (): boolean => {
    return this.snapshot;
  };

  getServerSnapshot = (): boolean => false;

  private readSnapshot(): boolean {
    return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  }

  private start(): void {
    this.snapshot = this.readSnapshot();
    if (
      typeof document === "undefined" ||
      typeof MutationObserver === "undefined" ||
      this.observer
    ) {
      return;
    }
    const root = document.documentElement;
    this.observer = new MutationObserver(() => {
      const next = this.readSnapshot();
      if (next === this.snapshot) {
        return;
      }
      this.snapshot = next;
      for (const listener of this.listeners) {
        listener();
      }
    });
    this.observer.observe(root, { attributes: true, attributeFilter: ["class"] });
  }
}

const documentThemeStore = new DocumentThemeStore();

export function useDocumentIsDark(): boolean {
  return useSyncExternalStore(
    documentThemeStore.subscribe,
    documentThemeStore.getSnapshot,
    documentThemeStore.getServerSnapshot,
  );
}
