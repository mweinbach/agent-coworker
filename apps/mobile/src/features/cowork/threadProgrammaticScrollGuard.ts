import { THREAD_NEAR_TAIL_THRESHOLD_PX } from "./threadScrollState";

export type ThreadProgrammaticScrollGuard = {
  mode: "idle" | "instant" | "animated";
  momentumStarted: boolean;
};

export function initialThreadProgrammaticScrollGuard(): ThreadProgrammaticScrollGuard {
  return {
    mode: "idle",
    momentumStarted: false,
  };
}

export function beginThreadProgrammaticScroll(animated: boolean): ThreadProgrammaticScrollGuard {
  return {
    mode: animated ? "animated" : "instant",
    momentumStarted: false,
  };
}

export function beginThreadProgrammaticMomentum(
  guard: ThreadProgrammaticScrollGuard,
): ThreadProgrammaticScrollGuard {
  return guard.mode === "animated" ? { ...guard, momentumStarted: true } : guard;
}

export function finishThreadProgrammaticScroll(): ThreadProgrammaticScrollGuard {
  return initialThreadProgrammaticScrollGuard();
}

export function isThreadProgrammaticScrollActive(guard: ThreadProgrammaticScrollGuard): boolean {
  return guard.mode !== "idle";
}

export function shouldFinishInstantThreadScroll(
  guard: ThreadProgrammaticScrollGuard,
  distanceFromBottom: number,
): boolean {
  return guard.mode === "instant" && distanceFromBottom <= THREAD_NEAR_TAIL_THRESHOLD_PX;
}

export function shouldApplyThreadUserScroll(
  guard: ThreadProgrammaticScrollGuard,
  userGestureActive: boolean,
): boolean {
  return userGestureActive && !isThreadProgrammaticScrollActive(guard);
}
