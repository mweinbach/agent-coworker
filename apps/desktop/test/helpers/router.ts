import { act } from "react";

export async function waitForAppRoute(): Promise<void> {
  const { getAppRouter } = await import("../../src/app/router");
  const router = getAppRouter();
  let load = Promise.resolve();
  await act(async () => {
    load = router.load();
  });
  for (let attempt = 0; attempt < 100; attempt++) {
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
