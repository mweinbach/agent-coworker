import { dispatchHttpRpcMessage, type HttpJsonRpcConnection } from "../httpJsonRpcConnection";
import { jsonResponse } from "../httpResponse";
import type { H3TrustedDeviceRecord } from "./pairing";
import { applyTrustedDevicePermissionsToConnection, getRequiredH3Permission } from "./permissions";

export async function dispatchHttpRpcPayload(
  raw: unknown,
  connection: HttpJsonRpcConnection,
  trustedDevice: H3TrustedDeviceRecord,
): Promise<Response> {
  return await dispatchHttpRpcMessage(raw, connection, (message) => {
    applyTrustedDevicePermissionsToConnection(connection, trustedDevice);
    const requiredPermission = getRequiredH3Permission(message);
    const requiredPermissions =
      requiredPermission === null
        ? []
        : Array.isArray(requiredPermission)
          ? requiredPermission
          : [requiredPermission];
    const missingPermission = requiredPermissions.find(
      (permission) => trustedDevice.permissions[permission] !== true,
    );
    if (missingPermission) {
      return jsonResponse(
        {
          error: `Mobile device permission required: ${missingPermission}.`,
          permission: missingPermission,
        },
        { status: 403 },
      );
    }
    return null;
  });
}
