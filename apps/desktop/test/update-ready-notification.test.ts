import { describe, expect, test } from "bun:test";

import { createUpdateReadyNotificationHold } from "../electron/services/updateReadyNotification";

describe("update-ready notification hold", () => {
  test("keeps a timed-out toast until a later click or action releases it", () => {
    const hold = createUpdateReadyNotificationHold<{ id: string }>();
    const notification = { id: "ready" };

    hold.hold(notification);
    hold.releaseUnlessTimedOut(notification, "timedOut");
    expect(hold.held()).toBe(notification);

    hold.release(notification);
    expect(hold.held()).toBeNull();
  });

  test("releases on any other close reason", () => {
    const hold = createUpdateReadyNotificationHold<{ id: string }>();
    const notification = { id: "ready" };

    hold.hold(notification);
    hold.releaseUnlessTimedOut(notification, undefined);
    expect(hold.held()).toBeNull();

    hold.hold(notification);
    hold.releaseUnlessTimedOut(notification, "user");
    expect(hold.held()).toBeNull();
  });

  test("closing an older toast does not drop the toast that replaced it", () => {
    const hold = createUpdateReadyNotificationHold<{ id: string }>();
    const older = { id: "older" };
    const newer = { id: "newer" };

    hold.hold(older);
    hold.hold(newer);
    hold.release(older);
    hold.releaseUnlessTimedOut(older, "user");
    expect(hold.held()).toBe(newer);

    hold.releaseUnlessTimedOut(newer, "action");
    expect(hold.held()).toBeNull();
  });
});
