import { View, Text, Pressable } from "react-native";

import { usePairingStore } from "../../../features/pairing/pairingStore";

export default function SettingsScreen() {
  const trustedDesktops = usePairingStore((state) => state.trustedMacs);
  const connectionState = usePairingStore((state) => state.connectionState);
  const disconnect = usePairingStore((state) => state.disconnect);
  const forgetTrustedMac = usePairingStore((state) => state.forgetTrustedMac);

  return (
    <View style={{ flex: 1, backgroundColor: "#0b1020", padding: 20, gap: 16 }}>
      <Text style={{ color: "#f8fafc", fontSize: 28, fontWeight: "700" }}>Settings</Text>
      <Text style={{ color: "#94a3b8", lineHeight: 22 }}>
        Trust stays in native secure storage. Use this screen to reconnect to a known Mac or forget
        the pairing.
      </Text>

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
        <Text style={{ color: "#e2e8f0", fontSize: 18, fontWeight: "600" }}>Connection</Text>
        <Text style={{ color: "#94a3b8" }}>
          State: {connectionState.status}{" "}
          {connectionState.connectedMacDeviceId ? `· ${connectionState.connectedMacDeviceId}` : ""}
        </Text>
        {connectionState.lastError ? (
          <Text style={{ color: "#fca5a5" }}>{connectionState.lastError}</Text>
        ) : null}
        <Pressable
          onPress={() => {
            void disconnect();
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
          <Text style={{ color: "#e2e8f0", fontWeight: "600" }}>Disconnect</Text>
        </Pressable>
      </View>

      <View style={{ gap: 12 }}>
        <Text style={{ color: "#e2e8f0", fontSize: 18, fontWeight: "600" }}>Trusted Macs</Text>
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
              No trusted desktop yet. Pair from the QR flow to add one.
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
              <Text style={{ color: "#f8fafc", fontWeight: "700", fontSize: 16 }}>
                {trustedMac.displayName}
              </Text>
              <Text style={{ color: "#94a3b8" }}>
                Fingerprint: {trustedMac.fingerprint}
              </Text>
              <Text style={{ color: "#64748b", fontSize: 12 }}>
                Last connected: {trustedMac.lastConnectedAt ?? "Never"}
              </Text>
              <Pressable
                onPress={() => {
                  void forgetTrustedMac(trustedMac.macDeviceId);
                }}
                style={{
                  alignSelf: "flex-start",
                  borderRadius: 999,
                  backgroundColor: "#7f1d1d",
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                }}
              >
                <Text style={{ color: "#fee2e2", fontWeight: "600" }}>Forget Mac</Text>
              </Pressable>
            </View>
          ))
        )}
      </View>
    </View>
  );
}
