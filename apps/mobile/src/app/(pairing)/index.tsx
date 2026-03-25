import { Link, useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import type { RelayConnectionStatus } from "@/features/relay/relayTypes";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { useAppTheme } from "@/theme/use-app-theme";

type DetailRowProps = {
  label: string;
  value: string;
  emphasize?: boolean;
  mono?: boolean;
};

type StepRowProps = {
  step: string;
  title: string;
  description: string;
};

const STATUS_TONE_BY_STATE: Record<
  RelayConnectionStatus,
  "neutral" | "success" | "warning" | "danger"
> = {
  idle: "neutral",
  pairing: "warning",
  connecting: "warning",
  reconnecting: "warning",
  connected: "success",
  error: "danger",
};

function describeStatus(status: RelayConnectionStatus): string {
  switch (status) {
    case "pairing":
      return "Pairing";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "connected":
      return "Connected";
    case "error":
      return "Needs attention";
    case "idle":
    default:
      return "Ready";
  }
}

function describeHero(
  status: RelayConnectionStatus,
  connectedDesktop: string | null,
  hasTrustedDesktop: boolean,
): { title: string; body: string } {
  switch (status) {
    case "connected":
      return {
        title: "Your computer is connected",
        body: `${connectedDesktop ?? "Cowork Desktop"} is live. Open threads, answer prompts, and keep the session moving from your phone.`,
      };
    case "pairing":
      return {
        title: "Finishing secure pairing",
        body: "Keep Cowork Desktop open while the phone and computer establish their secure relay session.",
      };
    case "connecting":
      return {
        title: "Connecting to your computer",
        body: "Cowork Mobile has the pairing payload and is setting up the secure transport now.",
      };
    case "reconnecting":
      return {
        title: "Reconnecting saved desktop",
        body: "Cowork Mobile is trying to restore a trusted session so you can jump back into threads.",
      };
    case "error":
      return {
        title: "Connection needs attention",
        body: hasTrustedDesktop
          ? "Try reconnecting a saved desktop or rescan the QR from Cowork Desktop to refresh the secure session."
          : "Rescan the QR from Cowork Desktop to start a fresh secure session.",
      };
    case "idle":
    default:
      return {
        title: "Connect your computer to start",
        body: hasTrustedDesktop
          ? "Reconnect a saved desktop or scan a new QR from Cowork Desktop to unlock live threads on this phone."
          : "Cowork Mobile is a companion to Cowork Desktop. Start on your computer, show the pairing QR, then scan it here.",
      };
  }
}

function describeRelay(connectionState: {
  status: RelayConnectionStatus;
  relayUrl: string | null;
}): string {
  if (connectionState.relayUrl) {
    return connectionState.relayUrl;
  }

  switch (connectionState.status) {
    case "pairing":
      return "Waiting for the QR payload to finish pairing.";
    case "connecting":
    case "reconnecting":
      return "Contacting the secure relay.";
    case "connected":
      return "Relay connected.";
    case "error":
      return "Relay setup failed.";
    case "idle":
    default:
      return "No relay selected yet.";
  }
}

function StepRow({ step, title, description }: StepRowProps) {
  const theme = useAppTheme();

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 12,
      }}
    >
      <View
        style={{
          height: 28,
          width: 28,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 999,
          borderCurve: "continuous",
          backgroundColor: theme.primaryMuted,
        }}
      >
        <Text
          selectable
          style={{
            color: theme.primary,
            fontSize: 13,
            fontWeight: "800",
            fontVariant: ["tabular-nums"],
          }}
        >
          {step}
        </Text>
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <Text selectable style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>
          {title}
        </Text>
        <Text
          selectable
          style={{
            color: theme.textSecondary,
            fontSize: 14,
            lineHeight: 20,
          }}
        >
          {description}
        </Text>
      </View>
    </View>
  );
}

function DetailRow({ label, value, emphasize = false, mono = false }: DetailRowProps) {
  const theme = useAppTheme();

  return (
    <View
      style={{
        gap: 4,
        borderRadius: 18,
        borderCurve: "continuous",
        backgroundColor: theme.surfaceElevated,
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
    >
      <Text selectable style={{ color: theme.textSecondary, fontSize: 13 }}>
        {label}
      </Text>
      <Text
        selectable
        style={{
          color: theme.text,
          fontSize: emphasize ? 16 : 14,
          fontWeight: emphasize ? "700" : "500",
          fontVariant: mono ? ["tabular-nums"] : undefined,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

export default function PairingIndexRoute() {
  const router = useRouter();
  const theme = useAppTheme();
  const trustedDesktops = usePairingStore((state) => state.trustedMacs);
  const connectionState = usePairingStore((state) => state.connectionState);
  const reconnectTrusted = usePairingStore((state) => state.reconnectTrusted);
  const primaryTrustedDesktop = trustedDesktops[0] ?? null;
  const isConnected = connectionState.status === "connected";
  const statusTone = STATUS_TONE_BY_STATE[connectionState.status];
  const statusLabel = describeStatus(connectionState.status);
  const hero = describeHero(
    connectionState.status,
    connectionState.connectedMacDeviceId,
    trustedDesktops.length > 0,
  );

  return (
    <Screen scroll>
      <View
        style={{
          gap: 18,
          borderRadius: 32,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: theme.border,
          backgroundColor: theme.surface,
          padding: 22,
          boxShadow: theme.shadow,
        }}
      >
        <View style={{ gap: 12 }}>
          <StatusPill label={statusLabel} tone={statusTone} />
          <View style={{ gap: 10 }}>
            <Text
              selectable
              style={{
                color: theme.text,
                fontSize: 32,
                lineHeight: 36,
                fontWeight: "800",
                letterSpacing: -0.6,
              }}
            >
              {hero.title}
            </Text>
            <Text
              selectable
              style={{
                color: theme.textSecondary,
                fontSize: 15,
                lineHeight: 22,
              }}
            >
              {hero.body}
            </Text>
          </View>
        </View>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <Link href="/(pairing)/scan" asChild>
            <Pressable
              style={({ pressed }) => ({
                borderRadius: 999,
                borderCurve: "continuous",
                backgroundColor: pressed ? theme.accent : theme.primary,
                paddingHorizontal: 18,
                paddingVertical: 12,
              })}
            >
              <Text selectable style={{ color: theme.primaryText, fontSize: 15, fontWeight: "700" }}>
                Scan desktop QR
              </Text>
            </Pressable>
          </Link>

          {isConnected ? (
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
                paddingHorizontal: 18,
                paddingVertical: 12,
              })}
            >
              <Text selectable style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>
                Open threads
              </Text>
            </Pressable>
          ) : primaryTrustedDesktop ? (
            <Pressable
              onPress={() => {
                void reconnectTrusted(primaryTrustedDesktop.macDeviceId);
              }}
              style={({ pressed }) => ({
                borderRadius: 999,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                paddingHorizontal: 18,
                paddingVertical: 12,
              })}
            >
              <Text selectable style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>
                Reconnect saved desktop
              </Text>
            </Pressable>
          ) : null}
        </View>

        <View
          style={{
            gap: 10,
            borderRadius: 24,
            borderCurve: "continuous",
            backgroundColor: theme.surfaceElevated,
            padding: 16,
          }}
        >
          <Text selectable style={{ color: theme.text, fontSize: 14, fontWeight: "700" }}>
            What unlocks after pairing
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {[
              "Live thread updates",
              "Server prompt replies",
              "Trusted one-tap reconnects",
            ].map((item) => (
              <View
                key={item}
                style={{
                  borderRadius: 999,
                  borderCurve: "continuous",
                  backgroundColor: theme.backgroundMuted,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                }}
              >
                <Text selectable style={{ color: theme.textSecondary, fontSize: 13, fontWeight: "600" }}>
                  {item}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </View>

      <SectionCard
        title="Start on your computer"
        description="Cowork Mobile only becomes useful after Cowork Desktop shares its pairing code."
      >
        <StepRow
          step="1"
          title="Open Cowork Desktop"
          description="Use the desktop app where your threads are already running."
        />
        <StepRow
          step="2"
          title="Show the pairing QR"
          description="In Cowork Desktop, open Settings and the remote access screen to reveal the QR code."
        />
        <StepRow
          step="3"
          title="Scan it with this phone"
          description="Cowork Mobile creates a secure relay session and saves the computer for quick reconnect later."
        />
      </SectionCard>

      <SectionCard
        title="Connection status"
        description={isConnected
          ? "This phone is ready to browse threads and answer prompts."
          : "The technical details show up here after a desktop has been paired."}
      >
        <DetailRow label="State" value={statusLabel} emphasize />
        <DetailRow
          label="Computer"
          value={connectionState.connectedMacDeviceId ?? "No computer connected"}
          emphasize={Boolean(connectionState.connectedMacDeviceId)}
        />
        <DetailRow label="Relay" value={describeRelay(connectionState)} />
        {connectionState.sessionId ? (
          <DetailRow label="Session" value={connectionState.sessionId} mono />
        ) : null}
        {connectionState.lastError ? (
          <Text
            selectable
            style={{
              color: theme.danger,
              fontSize: 14,
              lineHeight: 21,
            }}
          >
            {connectionState.lastError}
          </Text>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Trusted desktops"
        description={trustedDesktops.length === 0
          ? "Saved desktops appear here after your first successful connection."
          : `${trustedDesktops.length} saved ${trustedDesktops.length === 1 ? "desktop" : "desktops"}`}
      >
        {trustedDesktops.length === 0 ? (
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            Nothing trusted yet. Scan the QR shown in Cowork Desktop to add your first computer.
          </Text>
        ) : (
          trustedDesktops.map((trustedDesktop) => (
            <View
              key={trustedDesktop.macDeviceId}
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
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <View style={{ flex: 1, gap: 4 }}>
                  <Text selectable style={{ color: theme.text, fontSize: 16, fontWeight: "700" }}>
                    {trustedDesktop.displayName}
                  </Text>
                  <Text
                    selectable
                    style={{
                      color: theme.textSecondary,
                      fontSize: 13,
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {trustedDesktop.fingerprint}
                  </Text>
                </View>
                <StatusPill
                  label={trustedDesktop.lastConnectedAt ? "trusted" : "saved"}
                  tone="primary"
                />
              </View>
              <Text selectable style={{ color: theme.textTertiary, fontSize: 12 }}>
                Last connected: {trustedDesktop.lastConnectedAt ?? "Never"}
              </Text>
              <Pressable
                onPress={() => {
                  void reconnectTrusted(trustedDesktop.macDeviceId);
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
                <Text selectable style={{ color: theme.text, fontWeight: "700" }}>
                  Reconnect
                </Text>
              </Pressable>
            </View>
          ))
        )}
      </SectionCard>
    </Screen>
  );
}
