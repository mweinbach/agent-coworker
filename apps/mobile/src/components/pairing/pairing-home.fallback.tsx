import { useRouter } from "expo-router";
import { Text, View } from "react-native";
import {
  GroupedRow,
  GroupedScreen,
  GroupedSection,
  GroupedValueRow,
} from "@/components/pairing/grouped-list";
import { PairingWelcomeCard } from "@/components/pairing/pairing-welcome-card";
import { AppButton } from "@/components/ui/app-button";
import { describeHero, describeRelay } from "@/features/pairing/pairingCopy";
import { usePairingStore } from "@/features/pairing/pairingStore";
import {
  describeTransportMode,
  describeTransportStatus,
  isWorkspaceConnectionReady,
} from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

export function PairingHomeFallback() {
  const router = useRouter();
  const theme = useAppTheme();
  const trustedDesktops = usePairingStore((state) => state.trustedMacs);
  const connectionState = usePairingStore((state) => state.connectionState);
  const reconnectTrusted = usePairingStore((state) => state.reconnectTrusted);
  const forgetTrustedMac = usePairingStore((state) => state.forgetTrustedMac);
  const primaryTrustedDesktop = trustedDesktops[0] ?? null;
  const isConnected = isWorkspaceConnectionReady(connectionState);
  const statusLabel = describeTransportStatus(connectionState);
  const hero = describeHero(
    connectionState.status,
    connectionState.transportMode,
    connectionState.connectedMacDeviceId,
    trustedDesktops.length > 0,
  );
  const showDetails =
    isConnected || Boolean(connectionState.lastError) || Boolean(connectionState.sessionId);
  const showWelcome = connectionState.status === "idle" && !isConnected;

  return (
    <GroupedScreen>
      {showWelcome ? (
        <GroupedSection footer="Your Mac and iPhone must be on the same network for the first pairing.">
          <PairingWelcomeCard title={hero.title} body={hero.body} />
        </GroupedSection>
      ) : (
        <>
          <GroupedSection footer={hero.body}>
            <View style={{ paddingHorizontal: 16, paddingVertical: 18, gap: 6 }}>
              <Text selectable style={{ color: theme.text, fontSize: 22, fontWeight: "700" }}>
                {hero.title}
              </Text>
              {!isConnected && connectionState.status !== "idle" ? (
                <Text selectable style={{ color: theme.textSecondary, fontSize: 15 }}>
                  Status: {statusLabel}
                </Text>
              ) : null}
            </View>
          </GroupedSection>

          <GroupedSection footer="Your Mac and iPhone must be on the same network for the first pairing.">
            <View style={{ padding: 12, gap: 10 }}>
              <AppButton
                fullWidth
                icon="qrcode.viewfinder"
                onPress={() => router.push("/(pairing)/scan")}
              >
                Scan QR Code
              </AppButton>
              {isConnected ? (
                <AppButton
                  fullWidth
                  variant="secondary"
                  icon="bubble.left.and.bubble.right.fill"
                  onPress={() => router.replace("/(app)/(tabs)/threads")}
                >
                  Open Threads
                </AppButton>
              ) : primaryTrustedDesktop ? (
                <AppButton
                  fullWidth
                  variant="secondary"
                  icon="arrow.clockwise"
                  onPress={() => void reconnectTrusted(primaryTrustedDesktop.macDeviceId)}
                >
                  Reconnect to {primaryTrustedDesktop.displayName}
                </AppButton>
              ) : null}
            </View>
          </GroupedSection>
        </>
      )}

      {trustedDesktops.length > 0 ? (
        <GroupedSection title="Saved Macs">
          {trustedDesktops.map((desktop, index) => (
            <GroupedRow
              key={desktop.macDeviceId}
              label={desktop.displayName}
              detail={desktop.fingerprint}
              onPress={() => void reconnectTrusted(desktop.macDeviceId)}
              onDelete={() => void forgetTrustedMac(desktop.macDeviceId)}
              isLast={index === trustedDesktops.length - 1}
            />
          ))}
        </GroupedSection>
      ) : null}

      {showDetails ? (
        <GroupedSection title="Connection">
          <GroupedValueRow label="Status" value={statusLabel} />
          <GroupedValueRow
            label="Transport"
            value={describeTransportMode(connectionState.transportMode)}
          />
          <GroupedValueRow
            label="Computer"
            value={connectionState.connectedMacDeviceId ?? "Not connected"}
          />
          <GroupedValueRow label="Relay" value={describeRelay(connectionState)} />
          {connectionState.sessionId ? (
            <GroupedValueRow label="Session" value={connectionState.sessionId} isLast />
          ) : null}
          {connectionState.lastError ? (
            <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
              <Text selectable style={{ color: theme.danger, fontSize: 15, lineHeight: 21 }}>
                {connectionState.lastError}
              </Text>
            </View>
          ) : null}
        </GroupedSection>
      ) : null}
    </GroupedScreen>
  );
}
