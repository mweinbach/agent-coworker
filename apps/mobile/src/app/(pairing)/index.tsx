import { Link, useRouter } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { useAppTheme } from "@/theme/use-app-theme";

export default function PairingIndexRoute() {
  const router = useRouter();
  const theme = useAppTheme();
  const trustedDesktops = usePairingStore((state) => state.trustedMacs);
  const connectionState = usePairingStore((state) => state.connectionState);
  const reconnectTrusted = usePairingStore((state) => state.reconnectTrusted);
  const tone = connectionState.status === "connected"
    ? "success"
    : connectionState.status === "error"
      ? "danger"
      : connectionState.status === "connecting" || connectionState.status === "reconnecting" || connectionState.status === "pairing"
        ? "warning"
        : "neutral";

  return (
    <Screen scroll>
      <SectionCard
        title="Secure desktop access"
        description="Pair Cowork Desktop over the relay, then browse live threads and answer server prompts from your phone."
        action={<StatusPill label={connectionState.status} tone={tone} />}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <Link href="/(pairing)/scan" asChild>
            <Pressable
              style={({ pressed }) => ({
                borderRadius: 999,
                borderCurve: "continuous",
                backgroundColor: pressed ? theme.accent : theme.primary,
                paddingHorizontal: 16,
                paddingVertical: 11,
              })}
            >
              <Text style={{ color: theme.primaryText, fontWeight: "700" }}>Scan desktop QR</Text>
            </Pressable>
          </Link>
          {connectionState.status === "connected" ? (
            <Pressable
              onPress={() => {
                router.replace("/(app)/(tabs)/(threads)");
              }}
              style={({ pressed }) => ({
                borderRadius: 999,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                paddingHorizontal: 16,
                paddingVertical: 11,
              })}
            >
              <Text style={{ color: theme.text, fontWeight: "700" }}>Open threads</Text>
            </Pressable>
          ) : null}
        </View>
      </SectionCard>

      <SectionCard
        title="Live session"
        description="Remote JSON-RPC is available once the secure transport is connected."
      >
        <View style={{ gap: 10 }}>
          <View style={{ gap: 4 }}>
            <Text selectable style={{ color: theme.textSecondary, fontSize: 13 }}>Connected desktop</Text>
            <Text selectable style={{ color: theme.text, fontSize: 16, fontWeight: "600" }}>
              {connectionState.connectedMacDeviceId ?? "No active desktop"}
            </Text>
          </View>
          <View style={{ gap: 4 }}>
            <Text selectable style={{ color: theme.textSecondary, fontSize: 13 }}>Relay</Text>
            <Text selectable style={{ color: theme.text, fontSize: 14 }}>
              {connectionState.relayUrl ?? "Waiting for pairing payload"}
            </Text>
          </View>
          <View style={{ gap: 4 }}>
            <Text selectable style={{ color: theme.textSecondary, fontSize: 13 }}>Session</Text>
            <Text
              selectable
              style={{
                color: theme.text,
                fontSize: 14,
                fontVariant: ["tabular-nums"],
              }}
            >
              {connectionState.sessionId ?? "Not connected"}
            </Text>
          </View>
          {connectionState.lastError ? (
            <Text selectable style={{ color: theme.danger, fontSize: 14, lineHeight: 21 }}>
              {connectionState.lastError}
            </Text>
          ) : null}
        </View>
      </SectionCard>

      <SectionCard
        title="Trusted desktops"
        description={`${trustedDesktops.length} saved ${trustedDesktops.length === 1 ? "desktop" : "desktops"}`}
      >
        {trustedDesktops.length === 0 ? (
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            No trusted desktop yet. Scan the QR shown in Cowork Desktop to add one.
          </Text>
        ) : (
          trustedDesktops.map((trustedMac) => (
            <View
              key={trustedMac.macDeviceId}
              style={{
                gap: 10,
                borderRadius: 20,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: theme.borderMuted,
                backgroundColor: theme.surfaceElevated,
                padding: 14,
              }}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text selectable style={{ color: theme.text, fontSize: 16, fontWeight: "700" }}>
                    {trustedMac.displayName}
                  </Text>
                  <Text
                    selectable
                    style={{
                      color: theme.textSecondary,
                      fontSize: 13,
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {trustedMac.fingerprint}
                  </Text>
                </View>
                <StatusPill label={trustedMac.lastConnectedAt ? "trusted" : "saved"} tone="primary" />
              </View>
              <Text selectable style={{ color: theme.textTertiary, fontSize: 12 }}>
                Last connected: {trustedMac.lastConnectedAt ?? "Never"}
              </Text>
              <Pressable
                onPress={() => {
                  void reconnectTrusted(trustedMac.macDeviceId);
                }}
                style={({ pressed }) => ({
                  alignSelf: "flex-start",
                  borderRadius: 999,
                  borderCurve: "continuous",
                  borderWidth: 1,
                  borderColor: theme.border,
                  backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                  paddingHorizontal: 14,
                  paddingVertical: 9,
                })}
              >
                <Text style={{ color: theme.text, fontWeight: "700" }}>Reconnect</Text>
              </Pressable>
            </View>
          ))
        )}
      </SectionCard>
    </Screen>
  );
}
