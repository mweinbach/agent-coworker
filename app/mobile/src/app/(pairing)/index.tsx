import { Link, useRouter } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";

import { usePairingStore } from "../../features/pairing/pairingStore";

export default function PairingIndexRoute() {
  const router = useRouter();
  const trustedDesktops = usePairingStore((state) => state.trustedMacs);
  const connectionState = usePairingStore((state) => state.connectionState);
  const reconnectTrusted = usePairingStore((state) => state.reconnectTrusted);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: "#0b1020" }}
      contentContainerStyle={{ gap: 18, padding: 20 }}
    >
      <View style={{ gap: 8 }}>
        <Text style={{ color: "#f8fafc", fontSize: 30, fontWeight: "800" }}>Pair a desktop</Text>
        <Text style={{ color: "#94a3b8", fontSize: 15, lineHeight: 22 }}>
          Connect over the Remodex relay, then speak raw Cowork JSON-RPC through the secure transport.
        </Text>
      </View>

      <View
        style={{
          borderRadius: 20,
          borderWidth: 1,
          borderColor: "#1e293b",
          backgroundColor: "#111827",
          padding: 16,
          gap: 10,
        }}
      >
        <Text style={{ color: "#e2e8f0", fontSize: 18, fontWeight: "700" }}>Connection state</Text>
        <Text style={{ color: "#94a3b8" }}>
          {connectionState.status}
          {connectionState.connectedMacDeviceId ? ` · ${connectionState.connectedMacDeviceId}` : ""}
        </Text>
        {connectionState.lastError ? (
          <Text style={{ color: "#fca5a5" }}>{connectionState.lastError}</Text>
        ) : null}
        {connectionState.status === "connected" ? (
          <Pressable
            onPress={() => {
              router.replace("/(app)/(tabs)/threads");
            }}
            style={{
              alignSelf: "flex-start",
              borderRadius: 999,
              backgroundColor: "#2563eb",
              paddingHorizontal: 16,
              paddingVertical: 10,
            }}
          >
            <Text style={{ color: "#eff6ff", fontWeight: "700" }}>Open threads</Text>
          </Pressable>
        ) : null}
      </View>

      <Link href="/(pairing)/scan" asChild>
        <Pressable
          style={{
            borderRadius: 20,
            backgroundColor: "#7c3aed",
            paddingHorizontal: 18,
            paddingVertical: 16,
          }}
        >
          <Text style={{ color: "#f5f3ff", fontSize: 16, fontWeight: "800" }}>Scan desktop QR</Text>
          <Text style={{ color: "#ddd6fe", marginTop: 4 }}>
            Use the QR from Cowork Desktop → Settings → Remote Access.
          </Text>
        </Pressable>
      </Link>

      <View style={{ gap: 12 }}>
        <Text style={{ color: "#e2e8f0", fontSize: 18, fontWeight: "700" }}>Trusted desktops</Text>
        {trustedDesktops.length === 0 ? (
          <View
            style={{
              borderRadius: 18,
              borderWidth: 1,
              borderStyle: "dashed",
              borderColor: "#334155",
              backgroundColor: "#0f172a",
              padding: 16,
            }}
          >
            <Text style={{ color: "#94a3b8" }}>
              No trusted desktop yet. Scan a QR to add the first machine.
            </Text>
          </View>
        ) : (
          trustedDesktops.map((trustedMac) => (
            <View
              key={trustedMac.macDeviceId}
              style={{
                borderRadius: 18,
                borderWidth: 1,
                borderColor: "#1e293b",
                backgroundColor: "#111827",
                padding: 16,
                gap: 10,
              }}
            >
              <Text style={{ color: "#f8fafc", fontSize: 16, fontWeight: "700" }}>
                {trustedMac.displayName}
              </Text>
              <Text style={{ color: "#94a3b8" }}>{trustedMac.fingerprint}</Text>
              <Text style={{ color: "#64748b", fontSize: 12 }}>
                Last connected: {trustedMac.lastConnectedAt ?? "Never"}
              </Text>
              <Pressable
                onPress={() => {
                  void reconnectTrusted(trustedMac.macDeviceId);
                }}
                style={{
                  alignSelf: "flex-start",
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: "#334155",
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                }}
              >
                <Text style={{ color: "#e2e8f0", fontWeight: "700" }}>Reconnect</Text>
              </Pressable>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}
