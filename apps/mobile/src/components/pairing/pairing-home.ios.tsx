import {
  Button,
  Host,
  LabeledContent,
  List,
  ProgressView,
  Section,
  SwipeActions,
  Text,
} from "@expo/ui/swift-ui";
import { buttonStyle, foregroundStyle, frame, listStyle, tint } from "@expo/ui/swift-ui/modifiers";
import { useRouter } from "expo-router";

import { useAccessibilityAnnouncement } from "@/features/accessibility/mobile-accessibility";
import { describeHero, describeRelay } from "@/features/pairing/pairingCopy";
import { usePairingStore } from "@/features/pairing/pairingStore";
import {
  describeTransportMode,
  describeTransportStatus,
  isWorkspaceConnectionReady,
} from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

import { PairingActionButton, SectionFooter } from "./pairing-ios-ui";
import { PairingWelcomeCard } from "./pairing-welcome-card";

export function PairingHomeIos() {
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
  const isBusy =
    connectionState.status === "pairing" ||
    connectionState.status === "connecting" ||
    connectionState.status === "reconnecting";
  const showWelcome = connectionState.status === "idle" && !isConnected;
  useAccessibilityAnnouncement(connectionState.lastError ?? (isBusy ? statusLabel : null));

  const scanButton = (
    <PairingActionButton
      title="Scan QR Code"
      systemImage="qrcode.viewfinder"
      primaryColor={theme.primary}
      onPress={() => router.push("/(pairing)/scan")}
    />
  );

  return (
    <Host
      useViewportSizeMeasurement
      colorScheme={theme.isDark ? "dark" : "light"}
      style={{ flex: 1 }}
    >
      <List modifiers={[listStyle("insetGrouped"), tint(theme.primary)]}>
        {showWelcome ? (
          <Section
            footer={
              <SectionFooter>
                Your Mac and iPhone must be on the same network for the first pairing.
              </SectionFooter>
            }
          >
            <PairingWelcomeCard title={hero.title} body={hero.body} />
          </Section>
        ) : (
          <Section footer={<SectionFooter>{hero.body}</SectionFooter>}>
            {isBusy ? <ProgressView /> : null}
            <LabeledContent label="Status">
              <Text>{statusLabel}</Text>
            </LabeledContent>
            {scanButton}
            {isConnected ? (
              <Button
                label="Open Threads"
                systemImage="bubble.left.and.bubble.right.fill"
                onPress={() => router.replace("/threads")}
                modifiers={[
                  buttonStyle("bordered"),
                  tint(theme.primary),
                  frame({ maxWidth: Number.POSITIVE_INFINITY }),
                ]}
              />
            ) : primaryTrustedDesktop ? (
              <Button
                label={`Reconnect to ${primaryTrustedDesktop.displayName}`}
                systemImage="arrow.clockwise"
                onPress={() => void reconnectTrusted(primaryTrustedDesktop.macDeviceId)}
                modifiers={[
                  buttonStyle("bordered"),
                  tint(theme.primary),
                  frame({ maxWidth: Number.POSITIVE_INFINITY }),
                ]}
              />
            ) : null}
          </Section>
        )}

        {trustedDesktops.length > 0 ? (
          <Section title="Saved Macs">
            {trustedDesktops.map((desktop) => (
              <SwipeActions key={desktop.macDeviceId}>
                <Button
                  label={desktop.displayName}
                  systemImage="desktopcomputer"
                  onPress={() => void reconnectTrusted(desktop.macDeviceId)}
                  modifiers={[buttonStyle("plain"), tint(theme.primary)]}
                />
                <SwipeActions.Actions edge="trailing" allowsFullSwipe={false}>
                  <Button
                    label="Delete"
                    systemImage="trash"
                    onPress={() => void forgetTrustedMac(desktop.macDeviceId)}
                  />
                </SwipeActions.Actions>
              </SwipeActions>
            ))}
          </Section>
        ) : null}

        {showDetails ? (
          <Section title="Connection">
            <LabeledContent label="Status">
              <Text>{statusLabel}</Text>
            </LabeledContent>
            <LabeledContent label="Transport">
              <Text>{describeTransportMode(connectionState.transportMode)}</Text>
            </LabeledContent>
            <LabeledContent label="Computer">
              <Text>{connectionState.connectedMacDeviceId ?? "Not connected"}</Text>
            </LabeledContent>
            <LabeledContent label="Relay">
              <Text>{describeRelay(connectionState)}</Text>
            </LabeledContent>
            {connectionState.sessionId ? (
              <LabeledContent label="Session">
                <Text>{connectionState.sessionId}</Text>
              </LabeledContent>
            ) : null}
            {connectionState.lastError ? (
              <LabeledContent label="Error">
                <Text modifiers={[foregroundStyle(theme.danger)]}>{connectionState.lastError}</Text>
              </LabeledContent>
            ) : null}
          </Section>
        ) : null}
      </List>
    </Host>
  );
}
