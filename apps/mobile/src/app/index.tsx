import { Redirect } from "expo-router";

import { isWorkspaceConnectionReady } from "@/features/relay/connectionState";
import { usePairingStore } from "@/features/pairing/pairingStore";

export default function IndexScreen() {
  const isConnected = usePairingStore((state) => isWorkspaceConnectionReady(state.connectionState));
  return <Redirect href={isConnected ? "/(app)/(tabs)/threads" : "/(pairing)"} />;
}
