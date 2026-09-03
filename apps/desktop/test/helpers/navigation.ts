import type { StoreApi } from "zustand";
import { appNavigation } from "../../src/app/navigation";
import type { AppStoreState, StoreSet } from "../../src/app/store.helpers";

export function setAppState(
  store: StoreApi<AppStoreState>,
  partial: Parameters<StoreSet>[0],
  replace = false,
): void {
  const { navigation, ...state } =
    typeof partial === "function" ? partial(store.getState()) : partial;
  if (replace) store.setState(state as AppStoreState, true);
  else store.setState(state);
  if (navigation) appNavigation.update(navigation, true);
}
