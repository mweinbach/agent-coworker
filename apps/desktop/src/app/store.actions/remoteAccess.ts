import {
  forgetMobileRelayTrustedPhone,
  updateMobileRelayTrustedPhonePermissions,
} from "../../lib/desktopCommands";
import type { AppStoreActions, StoreGet, StoreSet } from "../store.helpers";
import { operationKey, runAcknowledgedOperation } from "../store.helpers/operations";

type RemoteAccessActionKeys =
  | "forgetRemoteAccessTrustedPhones"
  | "updateRemoteAccessTrustedPhonePermissions";

export function createRemoteAccessActions(
  set: StoreSet,
  get: StoreGet,
): Pick<AppStoreActions, RemoteAccessActionKeys> {
  return {
    forgetRemoteAccessTrustedPhones: async (input) =>
      await runAcknowledgedOperation(get, set, {
        key: operationKey("remote-access", "forget", input.workspaceId, input.scope),
        label: input.scope === "device" ? "Forget trusted device" : "Forget all trusted devices",
        errorTitle:
          input.scope === "device"
            ? "Trusted device not forgotten"
            : "Trusted devices not forgotten",
        errorMessage: "Unable to revoke trusted remote access.",
        repairAction: "Review the trusted device list and retry.",
        execute: async () => await forgetMobileRelayTrustedPhone(input),
      }),
    updateRemoteAccessTrustedPhonePermissions: async (input) =>
      await runAcknowledgedOperation(get, set, {
        key: operationKey("remote-access", "permissions", input.workspaceId),
        label: "Update trusted device permissions",
        errorTitle: "Device permissions not updated",
        errorMessage: "Unable to update the trusted device permissions.",
        repairAction: "Review the trusted device and retry.",
        execute: async () => await updateMobileRelayTrustedPhonePermissions(input),
      }),
  };
}
