import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type OverlayOwner = {
  depth: number;
  id: string;
  label: string;
  onDismiss: () => void | Promise<void>;
  restoreFocus: () => HTMLElement | null;
  sequence: number;
};

type OverlayStack = {
  dismissOwner: (id: string) => boolean;
  dismissTop: (event?: KeyboardEvent) => boolean;
  hasOpenOverlay: () => boolean;
  register: (owner: Omit<OverlayOwner, "sequence">) => () => void;
};

type OverlayEscapeEvent = {
  defaultPrevented: boolean;
  preventDefault: () => void;
  stopPropagation?: () => void;
};

type OverlayRootState = {
  open: boolean;
  restoreFocusRef: RefObject<HTMLElement | null>;
  setOpen: (open: boolean) => void;
};

const OverlayStackContext = createContext<OverlayStack | null>(null);
const OverlayDepthContext = createContext(0);

function activeElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function topOwner(owners: OverlayOwner[]): OverlayOwner | undefined {
  let top: OverlayOwner | undefined;
  for (const candidate of owners) {
    if (
      !top ||
      candidate.depth > top.depth ||
      (candidate.depth === top.depth && candidate.sequence > top.sequence)
    ) {
      top = candidate;
    }
  }
  return top;
}

function scheduleFocusRestore(owner: OverlayOwner, getOwners: () => OverlayOwner[]): void {
  requestAnimationFrame(() => {
    const owners = getOwners();
    if (owners.some((candidate) => candidate.id === owner.id)) return;
    const currentTop = topOwner(owners);
    if (currentTop && currentTop.depth >= owner.depth && currentTop.sequence > owner.sequence) {
      return;
    }
    const target = owner.restoreFocus();
    if (target?.isConnected) target.focus();
  });
}

export function isEditableEscapeTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest(
      "input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only'], [role='textbox']",
    ) !== null
  );
}

export function OverlayStackProvider({ children }: { children: ReactNode }) {
  const ownersRef = useRef<OverlayOwner[]>([]);
  const sequenceRef = useRef(0);

  const register = useCallback((owner: Omit<OverlayOwner, "sequence">) => {
    const registered = { ...owner, sequence: ++sequenceRef.current };
    ownersRef.current = [
      ...ownersRef.current.filter((candidate) => candidate.id !== owner.id),
      registered,
    ];
    return () => {
      ownersRef.current = ownersRef.current.filter((candidate) => candidate.id !== owner.id);
    };
  }, []);

  const dismissOwner = useCallback((id: string) => {
    const owner = topOwner(ownersRef.current);
    if (!owner || owner.id !== id) return false;

    void Promise.resolve(owner.onDismiss()).finally(() => {
      scheduleFocusRestore(owner, () => ownersRef.current);
    });
    return true;
  }, []);

  const dismissTop = useCallback(
    (event?: KeyboardEvent) => {
      const owner = topOwner(ownersRef.current);
      if (!owner) return false;
      event?.preventDefault();
      event?.stopImmediatePropagation();
      return dismissOwner(owner.id);
    },
    [dismissOwner],
  );

  const stack = useMemo<OverlayStack>(
    () => ({
      dismissOwner,
      dismissTop,
      hasOpenOverlay: () => ownersRef.current.length > 0,
      register,
    }),
    [dismissOwner, dismissTop, register],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      if (isEditableEscapeTarget(event.target)) return;
      dismissTop(event);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [dismissTop]);

  return <OverlayStackContext.Provider value={stack}>{children}</OverlayStackContext.Provider>;
}

export function OverlayLayerBoundary({ children }: { children: ReactNode }) {
  const parentDepth = useContext(OverlayDepthContext);
  return (
    <OverlayDepthContext.Provider value={parentDepth + 1}>{children}</OverlayDepthContext.Provider>
  );
}

export function useOverlayStack(): Pick<OverlayStack, "hasOpenOverlay"> {
  const stack = useContext(OverlayStackContext);
  return useMemo(
    () => ({
      hasOpenOverlay: stack?.hasOpenOverlay ?? (() => false),
    }),
    [stack],
  );
}

export function useOverlayOwner(options: {
  active: boolean;
  label: string;
  onDismiss: () => void | Promise<void>;
  restoreFocus?: () => HTMLElement | null;
}): { handleEscape: (event: OverlayEscapeEvent) => boolean } | null {
  const stack = useContext(OverlayStackContext);
  const depth = useContext(OverlayDepthContext);
  const id = useId();
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useLayoutEffect(() => {
    if (!stack || !options.active) return;
    const currentOptions = optionsRef.current;
    const capturedFocus = currentOptions.restoreFocus?.() ?? activeElement();
    return stack.register({
      depth,
      id,
      label: currentOptions.label,
      onDismiss: () => optionsRef.current.onDismiss(),
      restoreFocus: () => optionsRef.current.restoreFocus?.() ?? capturedFocus,
    });
  }, [depth, id, options.active, stack]);

  return useMemo(
    () =>
      stack
        ? {
            handleEscape: (event: OverlayEscapeEvent) => {
              if (event.defaultPrevented || !stack.dismissOwner(id)) return false;
              event.preventDefault();
              event.stopPropagation?.();
              return true;
            },
          }
        : null,
    [id, stack],
  );
}

export function useOverlayRootState(options: {
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
}): OverlayRootState {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(options.defaultOpen ?? false);
  const open = options.open ?? uncontrolledOpen;
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const previousOpenRef = useRef(open);

  useLayoutEffect(() => {
    if (open && !previousOpenRef.current) {
      restoreFocusRef.current = activeElement();
    }
    previousOpenRef.current = open;
  }, [open]);

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen && !open) restoreFocusRef.current = activeElement();
      if (options.open === undefined) setUncontrolledOpen(nextOpen);
      options.onOpenChange?.(nextOpen);
    },
    [open, options.onOpenChange, options.open],
  );

  return useMemo(
    () => ({
      open,
      restoreFocusRef,
      setOpen,
    }),
    [open, setOpen],
  );
}

export type { OverlayRootState };
