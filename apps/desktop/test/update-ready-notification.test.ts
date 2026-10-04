import { describe, expect, test } from "bun:test";

import { createUpdateReadyNotificationHold } from "../electron/services/updateReadyNotification";

describe("update-ready notification hold", () => {
  test("keeps timed-out toasts, releases handled/closed ones, and ignores stale replacements", () => {
    const hold = createUpdateReadyNotificationHold<{ id: string }>();
    const older = { id: "older" };
    const newer = { id: "newer" };

    hold.hold(older);
    hold.release(older, "timedOut");
    expect(hold.held()).toBe(older);

    hold.release(older, undefined);
    expect(hold.held()).toBeNull();

    hold.hold(older);
    hold.release(older, "user");
    expect(hold.held()).toBeNull();

    hold.hold(older);
    hold.hold(newer);
    hold.release(older);
    hold.release(older, "user");
    expect(hold.held()).toBe(newer);

    hold.release(newer, "action");
    expect(hold.held()).toBeNull();
  });
});
