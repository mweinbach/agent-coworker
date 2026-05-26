import { type BarcodeScanningResult, CameraView, useCameraPermissions } from "expo-camera";
import {
  ContentUnavailableView,
  Host,
  List,
  ProgressView,
  RNHostView,
  Section,
  Text,
} from "@expo/ui/swift-ui";
import {
  listStyle,
  padding,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { Stack, useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Pressable, Text as RNText, TextInput, View } from "react-native";

import { usePairingStore } from "@/features/pairing/pairingStore";
import { validatePairingPayload } from "@/features/pairing/qrValidation";
import { createPairingScanHandler } from "@/features/pairing/scanHandler";
import { alpha } from "@/theme/tokens";
import { useAppTheme } from "@/theme/use-app-theme";

import { SectionFooter, PairingActionButton } from "./pairing-ios-ui";

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
  const [permission, requestPermission] = useCameraPermissions();
  const [scannedPayload, setScannedPayload] = useState<string | null>(null);
  const [manualPayload, setManualPayload] = useState("");
  const connectionState = usePairingStore((state) => state.connectionState);
  const connectWithQr = usePairingStore((state) => state.connectWithQr);
  const scanHandlerRef = useRef<ReturnType<typeof createPairingScanHandler> | null>(null);

  const granted = permission?.granted ?? false;
  const pairingInFlight =
    scannedPayload !== null &&
    (connectionState.status === "pairing" || connectionState.status === "connecting");

  if (!scanHandlerRef.current) {
    scanHandlerRef.current = createPairingScanHandler({
      validatePairingPayload,
      connectWithQr,
      setScannedPayload,
      onSuccess: () => {
        router.replace("/(app)/(tabs)/threads");
      },
      onInvalidPayload: (message) => {
        Alert.alert("Invalid QR", message);
      },
      onPairingError: (message) => {
        Alert.alert("Pairing failed", message);
      },
    });
  }

  async function onBarcodeScanned(result: BarcodeScanningResult) {
    await scanHandlerRef.current?.handleScan(result);
  }

  async function pairManualPayload() {
    const payload = manualPayload.trim();
    if (!payload || pairingInFlight) {
      return;
    }
    await scanHandlerRef.current?.handleScan({ data: payload });
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
            >
              <RNText style={{ color: theme.primary, fontSize: 17, fontWeight: "400" }}>
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
                description="Allow camera access to scan the QR code shown on your Mac."
                modifiers={[padding({ vertical: 8 })]}
              />
              <PairingActionButton
                title="Allow Camera Access"
                systemImage="camera.fill"
                primaryColor={theme.primary}
                onPress={() => {
                  void requestPermission();
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
