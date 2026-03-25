import { Link } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import { usePairingStore } from "@/features/pairing/pairingStore";
import {
  describeTransportMode,
  describeTransportStatus,
  toneForTransportState,
} from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

function formatFingerprint(value: string) {
  const trimmed = value.replace(/\s+/g, "");
  return trimmed.length > 16
    ? `${trimmed.slice(0, 16)}…${trimmed.slice(-8)}`
    : trimmed;
}

export default function ConnectionScreen() {
  const theme = useAppTheme();
  const trustedDesktops = usePairingStore((state) => state.trustedMacs);
  const connectionState = usePairingStore((state) => state.connectionState);
  const disconnect = usePairingStore((state) => state.disconnect);
  const forgetTrustedMac = usePairingStore((state) => state.forgetTrustedMac);
  const tone = toneForTransportState(connectionState);

  return (
    <Screen scroll>
      <SectionCard
        title="Remote Access"
        description="Relay status, session identity, and trusted desktops for the Remodex-backed mobile link."
        action={<StatusPill label={describeTransportStatus(connectionState)} tone={tone} />}
      >
        <View style={{ gap: 10 }}>
          <View style={{ gap: 4 }}>
            <Text selectable style={{ color: theme.textSecondary, fontSize: 13 }}>Transport mode</Text>
            <Text selectable style={{ color: theme.text, fontSize: 16, fontWeight: "600" }}>
              {describeTransportMode(connectionState.transportMode)}
            </Text>
          </View>
          {connectionState.sessionId ? (
            <View style={{ gap: 4 }}>
              <Text selectable style={{ color: theme.textSecondary, fontSize: 13 }}>Session</Text>
              <Text selectable style={{ color: theme.text, fontSize: 14, fontVariant: ["tabular-nums"] }}>
                {connectionState.sessionId}
              </Text>
            </View>
          ) : null}
          <View style={{ gap: 4 }}>
            <Text selectable style={{ color: theme.textSecondary, fontSize: 13 }}>Connected desktop</Text>
            <Text selectable style={{ color: theme.text, fontSize: 16, fontWeight: "600" }}>
              {connectionState.connectedMacDeviceId ?? "Not connected"}
            </Text>
          </View>
          <View style={{ gap: 4 }}>
            <Text selectable style={{ color: theme.textSecondary, fontSize: 13 }}>Relay URL</Text>
            <Text selectable style={{ color: theme.text, fontSize: 14 }}>
              {connectionState.relayUrl ?? "No active relay session"}
            </Text>
          </View>
          {connectionState.lastError ? (
            <Text selectable style={{ color: theme.danger, fontSize: 14, lineHeight: 21 }}>
              {connectionState.lastError}
            </Text>
          ) : null}
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
                <Text style={{ color: theme.primaryText, fontWeight: "700" }}>Pair another desktop</Text>
              </Pressable>
            </Link>
            <Pressable
              onPress={() => {
                void disconnect();
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
              <Text style={{ color: theme.text, fontWeight: "700" }}>Disconnect</Text>
            </Pressable>
          </View>
        </View>
      </SectionCard>

      <SectionCard
        title="Trusted desktops"
        description={trustedDesktops.length === 0 ? "Nothing saved yet" : `${trustedDesktops.length} remembered desktops`}
      >
        {trustedDesktops.length === 0 ? (
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            Pair your first desktop from the scanner to start syncing conversations and approvals onto mobile.
          </Text>
        ) : (
          trustedDesktops.map((trustedMac) => (
            <View
              key={trustedMac.macDeviceId}
              style={{
                gap: 10,
                borderRadius: 22,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: theme.borderMuted,
                backgroundColor: theme.surfaceElevated,
                paddingHorizontal: 16,
                paddingVertical: 14,
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
                    {formatFingerprint(trustedMac.fingerprint)}
                  </Text>
                </View>
                <StatusPill label={trustedMac.lastConnectedAt ? "recent" : "saved"} tone="primary" />
              </View>
              <Text selectable style={{ color: theme.textTertiary, fontSize: 12 }}>
                Last connected: {trustedMac.lastConnectedAt ?? "Never"}
              </Text>
              <Pressable
                onPress={() => {
                  void forgetTrustedMac(trustedMac.macDeviceId);
                }}
                style={({ pressed }) => ({
                  alignSelf: "flex-start",
                  borderRadius: 999,
                  borderCurve: "continuous",
                  borderWidth: 1,
                  borderColor: theme.danger,
                  backgroundColor: pressed ? theme.dangerMuted : "transparent",
                  paddingHorizontal: 14,
                  paddingVertical: 9,
                })}
              >
                <Text style={{ color: theme.danger, fontWeight: "700" }}>Forget desktop</Text>
              </Pressable>
            </View>
          ))
        )}
      </SectionCard>
    </Screen>
  );
}
