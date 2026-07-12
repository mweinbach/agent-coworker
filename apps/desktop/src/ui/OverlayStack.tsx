import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type OverlayOwner = {
  id: string;
  label: string;
  onDismiss: () => void | Promise<void>;
  restoreFocus: () => HTMLElement | null;
  sequence: number;
};

type OverlayStack = {
  claimSequence: () => number;
  dismissOwner: (id: string) => boolean;
  dismissTop: (event?: KeyboardEvent) => boolean;
  hasOpenOverlay: () => boolean;
  register: (owner: OverlayOwner) => () => void;
};

type OverlayEscapeEvent = {
  defaultPrevented: boolean;
  isComposing?: boolean;
  nativeEvent?: KeyboardEvent;
  preventDefault: () => void;
  stopImmediatePropagation?: () => void;
  stopPropagation?: () => void;
};

type OverlayOwnership = {
  handleEscape: (event: OverlayEscapeEvent) => boolean;
  sequence: number;
  zIndex: number;
};

type OverlayRootState = {
  open: boolean;
  restoreFocusRef: RefObject<HTMLElement | null>;
  setOpen: (open: boolean) => void;
};

const OverlayStackContext = createContext<OverlayStack | null>(null);
const stackReservedEditableEscapes = new WeakSet<object>();
const OVERLAY_Z_INDEX_BASE = 1_000;
const OVERLAY_LAYER_SEQUENCE_ATTRIBUTE = "data-overlay-layer-sequence";
const EDITABLE_ESCAPE_SELECTOR =
  "input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only'], [role='textbox']";

type ClosestEventTarget = EventTarget & {
  closest: (selectors: string) => Element | null;
};

function nativeEscapeEvent(event: OverlayEscapeEvent): object {
  return event.nativeEvent ?? event;
}

function activeElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function topOwner(owners: OverlayOwner[]): OverlayOwner | undefined {
  let top: OverlayOwner | undefined;
  for (const candidate of owners) {
    if (!top || candidate.sequence > top.sequence) {
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
    if (currentTop && currentTop.sequence > owner.sequence) {
      return;
    }
    const target = owner.restoreFocus();
    if (target?.isConnected) target.focus();
  });
}

function supportsClosest(target: EventTarget | null): target is ClosestEventTarget {
  return target !== null && typeof (target as Partial<ClosestEventTarget>).closest === "function";
}

export function isTargetInHigherOverlayLayer(
  target: EventTarget | null,
  ownerSequence: number,
): boolean {
  if (!supportsClosest(target)) return false;
  const layer = target.closest(`[${OVERLAY_LAYER_SEQUENCE_ATTRIBUTE}]`);
  const sequence = Number(layer?.getAttribute(OVERLAY_LAYER_SEQUENCE_ATTRIBUTE));
  return Number.isFinite(sequence) && sequence > ownerSequence;
}

function isEditableElement(target: EventTarget | null): boolean {
  return supportsClosest(target) && target.closest(EDITABLE_ESCAPE_SELECTOR) !== null;
}

export function isEditableEscapeTarget(target: EventTarget | null): boolean {
  if (isEditableElement(target)) return true;
  const focused = typeof document === "undefined" ? null : document.activeElement;
  return focused !== target && isEditableElement(focused);
}

export function isReservedEditableEscape(event: OverlayEscapeEvent): boolean {
  return stackReservedEditableEscapes.has(nativeEscapeEvent(event));
}

export function OverlayStackProvider({ children }: { children: ReactNode }) {
  const ownersRef = useRef<OverlayOwner[]>([]);
  const sequenceRef = useRef(0);

  const claimSequence = useCallback(() => ++sequenceRef.current, []);

  const register = useCallback((owner: OverlayOwner) => {
    ownersRef.current = [
      ...ownersRef.current.filter((candidate) => candidate.id !== owner.id),
      owner,
    ];
    return () => {
      ownersRef.current = ownersRef.current.filter(
        (candidate) => candidate.id !== owner.id || candidate.sequence !== owner.sequence,
      );
    };
  }, []);

  const dismissOwner = useCallback((id: string) => {
    const owner = topOwner(ownersRef.current);
    if (!owner || owner.id !== id) return false;

    ownersRef.current = ownersRef.current.filter((candidate) => candidate.id !== owner.id);
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
      claimSequence,
      dismissOwner,
      dismissTop,
      hasOpenOverlay: () => ownersRef.current.length > 0,
      register,
    }),
    [claimSequence, dismissOwner, dismissTop, register],
  );

  useLayoutEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !topOwner(ownersRef.current)) return;
      if (event.isComposing || isEditableEscapeTarget(event.target)) {
        stackReservedEditableEscapes.add(event);
        event.preventDefault();
        return;
      }
      dismissTop(event);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [dismissTop]);

  return <OverlayStackContext.Provider value={stack}>{children}</OverlayStackContext.Provider>;
}

export function OverlayLayerBoundary({ children }: { children: ReactNode }) {
  return <>{children}</>;
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
}): OverlayOwnership | null {
  const stack = useContext(OverlayStackContext);
  const id = useId();
  const optionsRef = useRef(options);
  const stackRef = useRef(stack);
  const activeRef = useRef(false);
  const sequenceRef = useRef(0);
  optionsRef.current = options;

  if (stackRef.current !== stack) {
    stackRef.current = stack;
    activeRef.current = false;
    sequenceRef.current = 0;
  }
  if (options.active && !activeRef.current && stack) {
    sequenceRef.current = stack.claimSequence();
  } else if (!options.active) {
    sequenceRef.current = 0;
  }
  activeRef.current = options.active;
  const sequence = sequenceRef.current;

  useLayoutEffect(() => {
    if (!stack || !options.active || sequence === 0) return;
    const currentOptions = optionsRef.current;
    const capturedFocus = currentOptions.restoreFocus?.() ?? activeElement();
    return stack.register({
      id,
      label: currentOptions.label,
      onDismiss: () => optionsRef.current.onDismiss(),
      restoreFocus: () => optionsRef.current.restoreFocus?.() ?? capturedFocus,
      sequence,
    });
  }, [id, options.active, sequence, stack]);

  return useMemo(
    () =>
      stack
        ? {
            handleEscape: (event: OverlayEscapeEvent) => {
              const reservedByStack = isReservedEditableEscape(event);
              const isComposing = event.isComposing || event.nativeEvent?.isComposing === true;
              if (
                isComposing ||
                (event.defaultPrevented && !reservedByStack) ||
                !stack.dismissOwner(id)
              ) {
                return false;
              }
              event.preventDefault();
              if (event.stopImmediatePropagation) {
                event.stopImmediatePropagation();
              } else {
                event.stopPropagation?.();
              }
              return true;
            },
            sequence,
            zIndex: OVERLAY_Z_INDEX_BASE + sequence,
          }
        : null,
    [id, sequence, stack],
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

export type { OverlayOwnership, OverlayRootState };
