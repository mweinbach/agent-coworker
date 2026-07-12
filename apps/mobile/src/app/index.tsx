import { Redirect } from "expo-router";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { isWorkspaceConnectionReady } from "@/features/relay/connectionState";

export default function IndexScreen() {
  const isConnected = usePairingStore((state) => isWorkspaceConnectionReady(state.connectionState));
  const hasTrustedDesktop = usePairingStore((state) => state.trustedMacs.length > 0);
  const shouldEnterApp = isConnected || hasTrustedDesktop;
  return <Redirect href={shouldEnterApp ? "/threads" : "/(pairing)"} />;
}
