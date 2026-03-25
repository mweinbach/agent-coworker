import { Redirect } from "expo-router";

import { usePairingStore } from "@/features/pairing/pairingStore";

export default function IndexScreen() {
  const isConnected = usePairingStore((state) => state.connectionState.status === "connected");
  return <Redirect href={isConnected ? "/(app)/(tabs)/(threads)" : "/(pairing)"} />;
}
