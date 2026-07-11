export type PendingServerRequestIdentity = {
  method: "item/tool/requestUserInput" | "item/commandExecution/requestApproval";
  requestId: string | number;
  requestFingerprint: string;
};

export function copyPendingServerRequestIdentity(
  request: PendingServerRequestIdentity,
): PendingServerRequestIdentity {
  return {
    method: request.method,
    requestId: request.requestId,
    requestFingerprint: request.requestFingerprint,
  };
}

export function hasPendingServerRequestIdentity(
  request: PendingServerRequestIdentity,
  identity: PendingServerRequestIdentity,
): boolean {
  return (
    request.method === identity.method &&
    request.requestId === identity.requestId &&
    request.requestFingerprint === identity.requestFingerprint
  );
}
