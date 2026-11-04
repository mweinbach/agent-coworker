import { act } from "react";

// Route components are lazy chunks; their first import on a slow CI runner can
// outlast a fixed number of macrotask turns, so bound the wait by time instead.
const ROUTE_SETTLE_TIMEOUT_MS = 3_000;

export async function waitForAppRoute(): Promise<void> {
  const { getAppRouter } = await import("../../src/app/router");
  const router = getAppRouter();
  let load = Promise.resolve();
  await act(async () => {
    load = router.load();
  });
  const deadline = Date.now() + ROUTE_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (
      router.state.status === "idle" &&
      router.state.resolvedLocation?.href === router.history.location.href
    ) {
      await load;
      return;
    }
  }
  throw new Error(
    `Route did not settle: ${router.history.location.href}, status=${router.state.status}, resolved=${router.state.resolvedLocation?.href}, matches=${router.state.matches.map((match) => match.pathname).join(",")}`,
  );
}
