import { Redirect } from "expo-router";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { isWorkspaceConnectionReady } from "@/features/relay/connectionState";

export default function IndexScreen() {
  const isConnected = usePairingStore((state) => isWorkspaceConnectionReady(state.connectionState));
  return <Redirect href={isConnected ? "/(app)/(tabs)/threads" : "/(pairing)"} />;
}
