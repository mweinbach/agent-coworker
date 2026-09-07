import {
  ContentUnavailableView,
  Host,
  List,
  ProgressView,
  RNHostView,
  Section,
  Text,
} from "@expo/ui/swift-ui";
import { listStyle, padding, tint } from "@expo/ui/swift-ui/modifiers";
import { type BarcodeScanningResult, CameraView, useCameraPermissions } from "expo-camera";
import { Stack, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, AppState, Linking, Pressable, Text as RNText, TextInput, View } from "react-native";

import {
  MAX_DYNAMIC_TYPE_MULTIPLIER,
  minimumTouchTarget,
  useAccessibilityAnnouncement,
} from "@/features/accessibility/mobile-accessibility";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { validatePairingPayload } from "@/features/pairing/qrValidation";
import { createPairingScanHandler } from "@/features/pairing/scanHandler";
import { alpha } from "@/theme/tokens";
import { useAppTheme } from "@/theme/use-app-theme";

import { PairingActionButton, SectionFooter } from "./pairing-ios-ui";

function CameraScanner({
  pairingInFlight,
  onBarcodeScanned,
}: {
  pairingInFlight: boolean;
  onBarcodeScanned: (result: BarcodeScanningResult) => void;
}) {
  const theme = useAppTheme();

  return (
    <RNHostView matchContents={false}>
      <View
        style={{
          height: 320,
          overflow: "hidden",
          borderRadius: 12,
          borderCurve: "continuous",
          backgroundColor: theme.backgroundMuted,
        }}
      >
        <CameraView
          accessibilityLabel="QR code scanner camera"
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={pairingInFlight ? undefined : onBarcodeScanned}
        />
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            inset: 0,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View
            style={{
              width: 220,
              height: 220,
              borderRadius: 24,
              borderCurve: "continuous",
              borderWidth: 2,
              borderColor: alpha(theme.text, theme.isDark ? 0.72 : 0.42),
              backgroundColor: alpha(theme.text, theme.isDark ? 0.12 : 0.08),
            }}
          />
        </View>
      </View>
    </RNHostView>
  );
}

export function PairingScanIos() {
  const router = useRouter();
  const theme = useAppTheme();
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [scannedPayload, setScannedPayload] = useState<string | null>(null);
  const [manualPayload, setManualPayload] = useState("");
  const connectionState = usePairingStore((state) => state.connectionState);
  const connectWithQr = usePairingStore((state) => state.connectWithQr);
  const [scanHandler] = useState(() =>
    createPairingScanHandler({
      validatePairingPayload,
      connectWithQr,
      setScannedPayload,
      onSuccess: () => {
        router.replace("/threads");
      },
      onInvalidPayload: (message) => {
        Alert.alert("Invalid QR", message);
      },
      onPairingError: (message) => {
        Alert.alert("Pairing failed", message);
      },
    }),
  );

  const granted = permission?.granted ?? false;
  const needsSettings = permission?.canAskAgain === false;
  const pairingInFlight =
    scannedPayload !== null &&
    (connectionState.status === "pairing" || connectionState.status === "connecting");
  useAccessibilityAnnouncement(
    connectionState.lastError ?? (pairingInFlight ? "Connecting to your Mac" : null),
  );

  useEffect(() => {
    let mounted = true;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void getPermission().catch((error) => {
        if (!mounted) return;
        Alert.alert(
          "Camera access unavailable",
          error instanceof Error ? error.message : "Could not check camera permission. Try again.",
        );
      });
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [getPermission]);

  async function onBarcodeScanned(result: BarcodeScanningResult) {
    await scanHandler.handleScan(result);
  }

  async function enableCamera() {
    try {
      if (needsSettings) {
        await Linking.openSettings();
      } else {
        await requestPermission();
      }
    } catch (error) {
      Alert.alert(
        needsSettings ? "Unable to open Settings" : "Camera access unavailable",
        error instanceof Error
          ? error.message
          : needsSettings
            ? "Open your device Settings to enable camera access for Cowork."
            : "Could not request camera permission. Try again.",
      );
    }
  }

  async function pairManualPayload() {
    const payload = manualPayload.trim();
    if (!payload || pairingInFlight) {
      return;
    }
    await scanHandler.handleScan({ data: payload });
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerLeft: () => (
            <Pressable
              onPress={() => router.back()}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              style={{ minHeight: minimumTouchTarget(), justifyContent: "center" }}
            >
              <RNText
                maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
                style={{ color: theme.primary, fontSize: 17, fontWeight: "400" }}
              >
                Cancel
              </RNText>
            </Pressable>
          ),
        }}
      />
      <Host
        useViewportSizeMeasurement
        colorScheme={theme.isDark ? "dark" : "light"}
        style={{ flex: 1 }}
      >
        <List modifiers={[listStyle("insetGrouped"), tint(theme.primary)]}>
          {!granted ? (
            <Section
              footer={
                <SectionFooter>
                  Cowork uses the camera only to read pairing codes from Cowork Desktop.
                </SectionFooter>
              }
            >
              <ContentUnavailableView
                title="Camera Access Needed"
                systemImage="camera.viewfinder"
                description={
                  needsSettings
                    ? "Enable camera access for Cowork in Settings, then return to scan the QR code."
                    : "Allow camera access to scan the QR code shown on your Mac."
                }
                modifiers={[padding({ vertical: 8 })]}
              />
              <PairingActionButton
                title={needsSettings ? "Open Settings" : "Allow Camera Access"}
                systemImage="camera.fill"
                primaryColor={theme.primary}
                onPress={() => {
                  void enableCamera();
                }}
              />
            </Section>
          ) : (
            <Section
              footer={
                <SectionFooter>
                  Point your camera at the QR code shown in Cowork Desktop under Remote Access.
                </SectionFooter>
              }
            >
              <CameraScanner
                pairingInFlight={pairingInFlight}
                onBarcodeScanned={onBarcodeScanned}
              />
            </Section>
          )}

          {pairingInFlight ? (
            <Section
              footer={
                <SectionFooter>Keep Cowork Desktop open while pairing finishes.</SectionFooter>
              }
            >
              <ProgressView />
              <Text>Connecting to your Mac…</Text>
            </Section>
          ) : null}

          <Section
            title="Pairing key"
            footer={
              <SectionFooter>
                Copy the pairing key from Cowork Desktop under Remote Access, then paste it here if
                you cannot scan the QR code.
              </SectionFooter>
            }
          >
            <RNHostView matchContents>
              <View style={{ minHeight: 88, justifyContent: "center", paddingHorizontal: 16 }}>
                <TextInput
                  accessibilityLabel="Pairing key"
                  accessibilityHint="Paste the pairing key from Cowork Desktop"
                  maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
                  value={manualPayload}
                  onChangeText={setManualPayload}
                  placeholder="cowork-pair://…"
                  placeholderTextColor={theme.textTertiary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                  style={{
                    color: theme.text,
                    paddingVertical: 0,
                    fontSize: 13,
                    lineHeight: 18,
                    fontFamily: theme.fontFamilyMono,
                  }}
                />
              </View>
            </RNHostView>
            <PairingActionButton
              title="Connect with pasted key"
              systemImage="doc.on.clipboard"
              primaryColor={theme.primary}
              disabled={!manualPayload.trim() || pairingInFlight}
              onPress={() => {
                void pairManualPayload();
              }}
            />
          </Section>
        </List>
      </Host>
    </>
  );
}
