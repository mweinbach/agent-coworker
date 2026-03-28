import { Link, Stack, useRouter } from "expo-router";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  FadeInUp,
  FadeInDown,
} from "react-native-reanimated";

import { HeaderGlassButton } from "@/components/ui/header-glass-button";
import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { SFSymbol } from "@/components/ui/sf-symbol";
import { StatusPill } from "@/components/ui/status-pill";
import { usePairingStore } from "@/features/pairing/pairingStore";
import {
  describeTransportMode,
  describeTransportStatus,
  isWorkspaceConnectionReady,
} from "@/features/relay/connectionState";
import type { RelayConnectionStatus, RelayTransportMode } from "@/features/relay/relayTypes";
import { useAppTheme } from "@/theme/use-app-theme";

type FeatureItemProps = {
  icon: string;
  title: string;
  description: string;
  index: number;
};

function FeatureItem({ icon, title, description, index }: FeatureItemProps) {
  const theme = useAppTheme();

  return (
    <Animated.View
      entering={FadeInUp.delay(index * 80).duration(400)}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 14,
          borderRadius: 22,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: theme.borderMuted,
          backgroundColor: theme.surfaceMuted,
          padding: 14,
        }}
      >
        <View
          style={{
            width: 38,
            height: 38,
            borderRadius: 12,
            borderCurve: "continuous",
            backgroundColor: theme.surfaceElevated,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <SFSymbol name={icon} size={19} color={theme.primary} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text selectable style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>
            {title}
          </Text>
          <Text
            selectable
            style={{
              color: theme.textSecondary,
              fontSize: 13,
              lineHeight: 18,
            }}
          >
            {description}
          </Text>
        </View>
      </View>
    </Animated.View>
  );
}

type DetailRowProps = {
  label: string;
  value: string;
  icon?: string;
  emphasize?: boolean;
  mono?: boolean;
};

function DetailRow({ label, value, icon, emphasize = false, mono = false }: DetailRowProps) {
  const theme = useAppTheme();

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        borderRadius: 16,
        borderCurve: "continuous",
        backgroundColor: theme.surfaceElevated,
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
    >
      {icon && (
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            borderCurve: "continuous",
            backgroundColor: theme.backgroundMuted,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <SFSymbol name={icon} size={16} color={theme.textSecondary} />
        </View>
      )}
      <View style={{ flex: 1, gap: 3 }}>
        <Text selectable style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "500" }}>
          {label}
        </Text>
        <Text
          selectable
          style={{
            color: theme.text,
            fontSize: emphasize ? 15 : 14,
            fontWeight: emphasize ? "700" : "500",
            fontVariant: mono ? ["tabular-nums"] : undefined,
          }}
        >
          {value}
        </Text>
      </View>
    </View>
  );
}

type StepRowProps = {
  step: number;
  title: string;
  description: string;
  icon: string;
  delay?: number;
};

function StepRow({ step, title, description, icon, delay = 0 }: StepRowProps) {
  const theme = useAppTheme();

  return (
    <Animated.View
      entering={FadeInUp.delay(delay).duration(500)}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 14,
      }}
    >
      <View
        style={{
          height: 36,
          width: 36,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 12,
          borderCurve: "continuous",
          backgroundColor: theme.primaryMuted,
        }}
      >
        <SFSymbol name={icon} size={18} color={theme.primary} />
      </View>
      <View style={{ flex: 1, gap: 4, paddingTop: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View
            style={{
              width: 18,
              height: 18,
              borderRadius: 9,
              borderCurve: "continuous",
              backgroundColor: theme.backgroundMuted,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              selectable
              style={{
                color: theme.textSecondary,
                fontSize: 10,
                fontWeight: "800",
                fontVariant: ["tabular-nums"],
              }}
            >
              {step}
            </Text>
          </View>
          <Text selectable style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>
            {title}
          </Text>
        </View>
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
    </Animated.View>
  );
}

function PrimaryButton({
  children,
  onPress,
  icon,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  icon?: string;
}) {
  const theme = useAppTheme();

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        borderRadius: 16,
        borderCurve: "continuous",
        backgroundColor: pressed ? theme.primaryMuted : theme.primary,
        paddingHorizontal: 18,
        paddingVertical: 14,
        boxShadow: "0 10px 24px rgba(4, 17, 16, 0.18)",
      })}
    >
      {icon && <SFSymbol name={icon} size={18} color={theme.primaryText} />}
      <Text selectable style={{ color: theme.primaryText, fontSize: 16, fontWeight: "700" }}>
        {children}
      </Text>
    </Pressable>
  );
}

function SecondaryButton({
  children,
  onPress,
  icon,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  icon?: string;
}) {
  const theme = useAppTheme();

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        borderRadius: 16,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: theme.border,
        backgroundColor: pressed ? theme.surfaceMuted : theme.surfaceElevated,
        paddingHorizontal: 18,
        paddingVertical: 14,
      })}
    >
      {icon && <SFSymbol name={icon} size={18} color={theme.text} />}
      <Text selectable style={{ color: theme.text, fontSize: 16, fontWeight: "700" }}>
        {children}
      </Text>
    </Pressable>
  );
}

function describeHero(
  status: RelayConnectionStatus,
  transportMode: RelayTransportMode,
  connectedDesktop: string | null,
  hasTrustedDesktop: boolean,
): { title: string; body: string } {
  if (transportMode === "fallback" && status === "connected") {
    return {
      title: "Demo mode active",
      body: "This build uses JavaScript fallback transport for testing. It's not a live desktop connection.",
    };
  }
  if (transportMode === "unsupported") {
    return {
      title: "Native transport unavailable",
      body: hasTrustedDesktop
        ? "This mobile build cannot open a real Remodex secure session yet. Re-scan a QR once native transport support lands."
        : "This mobile build cannot open a real Remodex secure session yet. Scan a QR again once native transport support lands.",
    };
  }
  switch (status) {
    case "connected":
      return {
        title: "Remote access is live",
        body: `${connectedDesktop ?? "Cowork Desktop"} is available now. Open threads, answer prompts, and keep the session moving from your phone.`,
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
        title: "Connect a desktop to start",
        body: hasTrustedDesktop
          ? "Reconnect a saved desktop or scan a new QR from Cowork Desktop to unlock live threads on this phone."
          : "Cowork Mobile is a companion to Cowork Desktop. Start on your computer, show the pairing QR, then scan it here.",
      };
  }
}

function describeRelay(connectionState: {
  status: RelayConnectionStatus;
  transportMode: RelayTransportMode;
  relayUrl: string | null;
}): string {
  if (connectionState.transportMode === "fallback" && connectionState.status === "connected") {
    return connectionState.relayUrl
      ? `${connectionState.relayUrl} (fallback demo)`
      : "Fallback demo transport is active.";
  }
  if (connectionState.transportMode === "unsupported") {
    return "Native relay transport is not available in this build.";
  }
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

export default function PairingIndexRoute() {
  const router = useRouter();
  const theme = useAppTheme();
  const trustedDesktops = usePairingStore((state) => state.trustedMacs);
  const connectionState = usePairingStore((state) => state.connectionState);
  const reconnectTrusted = usePairingStore((state) => state.reconnectTrusted);
  const primaryTrustedDesktop = trustedDesktops[0] ?? null;
  const isConnected = isWorkspaceConnectionReady(connectionState);
  const statusLabel = describeTransportStatus(connectionState);
  const hero = describeHero(
    connectionState.status,
    connectionState.transportMode,
    connectionState.connectedMacDeviceId,
    trustedDesktops.length > 0,
  );

  const heroScale = useSharedValue(0.95);
  const heroOpacity = useSharedValue(0);

  useEffect(() => {
    heroOpacity.value = withTiming(1, { duration: 400 });
    heroScale.value = withSpring(1, { damping: 15, stiffness: 120 });
  }, []);

  const heroAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: heroScale.value }],
    opacity: heroOpacity.value,
  }));

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderGlassButton
              icon="ellipsis.circle"
              onPress={() => router.push("/(app)/(tabs)/settings")}
            />
          ),
        }}
      />
      <Screen scroll contentStyle={{ gap: 16 }}>
      <Animated.View
        entering={FadeInDown.duration(500)}
        style={heroAnimatedStyle}
      >
        <View
          style={{
            gap: 18,
            overflow: "hidden",
            borderRadius: 32,
            borderCurve: "continuous",
            backgroundColor: theme.surfaceElevated,
            borderWidth: 1,
            borderColor: theme.borderMuted,
            padding: 22,
            boxShadow: theme.shadow,
          }}
        >
          <View style={{ gap: 14 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  borderRadius: 999,
                  borderCurve: "continuous",
                  backgroundColor: theme.surfaceMuted,
                  borderWidth: 1,
                  borderColor: theme.borderMuted,
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                }}
              >
                <SFSymbol
                  name={isConnected ? "checkmark.shield.fill" : "questionmark"}
                  size={16}
                  color={theme.text}
                />
                <Text
                  selectable
                  style={{
                    color: theme.text,
                    fontSize: 11,
                    fontWeight: "800",
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                  }}
                >
                  {statusLabel}
                </Text>
              </View>
              {trustedDesktops.length > 0 ? (
                <View
                  style={{
                    borderRadius: 999,
                    borderCurve: "continuous",
                    backgroundColor: theme.surfaceMuted,
                    borderWidth: 1,
                    borderColor: theme.borderMuted,
                    paddingHorizontal: 12,
                    paddingVertical: 7,
                  }}
                >
                  <Text
                    selectable
                    style={{
                      color: theme.textSecondary,
                      fontSize: 12,
                      fontWeight: "700",
                    }}
                  >
                    {trustedDesktops.length} trusted {trustedDesktops.length === 1 ? "desktop" : "desktops"}
                  </Text>
                </View>
              ) : null}
            </View>

            <View style={{ gap: 10 }}>
              <Text
                selectable
                style={{
                  color: theme.text,
                  fontSize: 32,
                  lineHeight: 36,
                  fontWeight: "800",
                  letterSpacing: -0.8,
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
              <PrimaryButton icon="qrcode">
                Scan QR Code
              </PrimaryButton>
            </Link>

            {isConnected ? (
              <SecondaryButton
                onPress={() => router.replace("/(app)/(tabs)/threads")}
                icon="bubble.left.and.bubble.right.fill"
              >
                Open Threads
              </SecondaryButton>
            ) : primaryTrustedDesktop ? (
              <SecondaryButton
                onPress={() => void reconnectTrusted(primaryTrustedDesktop.macDeviceId)}
                icon="arrow.clockwise"
              >
                Reconnect
              </SecondaryButton>
            ) : null}
          </View>

          <View style={{ flexDirection: "column", gap: 10 }}>
            <FeatureItem
              index={0}
              icon="bolt.fill"
              title="Live thread updates"
              description="See responses and tool calls in real time."
            />
            <FeatureItem
              index={1}
              icon="bubble.left.and.exclamationmark.bubble.right.fill"
              title="Answer server prompts"
              description="Handle asks and approvals without leaving the phone."
            />
            <FeatureItem
              index={2}
              icon="touchid"
              title="One-tap reconnects"
              description="Trusted desktops come back quickly when you return."
            />
          </View>
        </View>
      </Animated.View>

      {trustedDesktops.length > 0 ? (
        <Animated.View entering={FadeInUp.delay(180).duration(500)}>
          <SectionCard
            title="Trusted desktops"
            description={`${trustedDesktops.length} saved ${trustedDesktops.length === 1 ? "desktop" : "desktops"}`}
          >
            {trustedDesktops.map((trustedDesktop, index) => (
              <Animated.View
                key={trustedDesktop.macDeviceId}
                entering={FadeInUp.delay(240 + index * 100).duration(400)}
                style={{
                  gap: 12,
                  borderRadius: 18,
                  borderCurve: "continuous",
                  borderWidth: 1,
                  borderColor: theme.borderMuted,
                  backgroundColor: theme.surfaceElevated,
                  padding: 16,
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
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flex: 1 }}>
                    <View
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 12,
                        borderCurve: "continuous",
                        backgroundColor: theme.primaryMuted,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <SFSymbol name="desktopcomputer" size={22} color={theme.primary} />
                    </View>
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text selectable style={{ color: theme.text, fontSize: 16, fontWeight: "700" }}>
                        {trustedDesktop.displayName}
                      </Text>
                      <Text
                        selectable
                        style={{
                          color: theme.textSecondary,
                          fontSize: 12,
                          fontVariant: ["tabular-nums"],
                        }}
                      >
                        {trustedDesktop.fingerprint}
                      </Text>
                    </View>
                  </View>
                  <StatusPill
                    label={trustedDesktop.lastConnectedAt ? "Trusted" : "Saved"}
                    tone="primary"
                  />
                </View>

                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <SFSymbol name="clock" size={12} color={theme.textTertiary} />
                  <Text selectable style={{ color: theme.textTertiary, fontSize: 12 }}>
                    {trustedDesktop.lastConnectedAt
                      ? `Last connected: ${trustedDesktop.lastConnectedAt}`
                      : "Never connected"}
                  </Text>
                </View>

                <Pressable
                  onPress={() => void reconnectTrusted(trustedDesktop.macDeviceId)}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignSelf: "flex-start",
                    alignItems: "center",
                    gap: 6,
                    borderRadius: 10,
                    borderCurve: "continuous",
                    borderWidth: 1,
                    borderColor: theme.border,
                    backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                  })}
                >
                  <SFSymbol name="arrow.clockwise" size={14} color={theme.text} />
                  <Text selectable style={{ color: theme.text, fontWeight: "700", fontSize: 14 }}>
                    Reconnect
                  </Text>
                </Pressable>
              </Animated.View>
            ))}
          </SectionCard>
        </Animated.View>
      ) : null}

      {(isConnected || connectionState.lastError || connectionState.sessionId) ? (
        <Animated.View entering={FadeInUp.delay(260).duration(500)}>
          <SectionCard
            title="Connection details"
            description={isConnected
              ? "Your phone is ready to browse threads and answer prompts."
              : "Current relay details for the active connection."}
          >
            <DetailRow
              label="Status"
              value={statusLabel}
              icon="wifi"
              emphasize
            />
            <DetailRow
              label="Transport"
              value={describeTransportMode(connectionState.transportMode)}
              icon="arrow.left.arrow.right"
            />
            <DetailRow
              label="Computer"
              value={connectionState.connectedMacDeviceId ?? "Not connected"}
              icon="desktopcomputer"
              emphasize={Boolean(connectionState.connectedMacDeviceId)}
            />
            <DetailRow
              label="Relay"
              value={describeRelay(connectionState)}
              icon="network"
            />
            {connectionState.sessionId ? (
              <DetailRow
                label="Session"
                value={connectionState.sessionId}
                icon="key.fill"
                mono
              />
            ) : null}
            {connectionState.lastError ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: 12,
                  borderRadius: 12,
                  borderCurve: "continuous",
                  backgroundColor: theme.dangerMuted,
                }}
              >
                <SFSymbol name="exclamationmark.triangle.fill" size={16} color={theme.danger} />
                <Text
                  selectable
                  style={{
                    flex: 1,
                    color: theme.danger,
                    fontSize: 14,
                    lineHeight: 20,
                  }}
                >
                  {connectionState.lastError}
                </Text>
              </View>
            ) : null}
          </SectionCard>
        </Animated.View>
      ) : null}
    </Screen>
    </>
  );
}
