import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { CameraView, type BarcodeScanningResult, useCameraPermissions } from "expo-camera";
import { Stack } from "expo-router";

import { validatePairingPayload } from "../../features/pairing/qrValidation";

export default function PairingScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scannedPayload, setScannedPayload] = useState<string | null>(null);

  const granted = permission?.granted ?? false;

  function onBarcodeScanned(result: BarcodeScanningResult) {
    if (scannedPayload) {
      return;
    }
    const parsed = validatePairingPayload(result.data);
    if (!parsed.success) {
      Alert.alert("Invalid QR", parsed.error);
      return;
    }
    setScannedPayload(JSON.stringify(parsed.data, null, 2));
  }

  return (
    <>
      <Stack.Screen options={{ title: "Scan pairing QR" }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: "#050816" }}
        contentContainerStyle={{ padding: 24, gap: 18 }}
      >
        <View style={{ gap: 8 }}>
          <Text style={{ color: "#F8FAFC", fontSize: 30, fontWeight: "700" }}>Scan desktop QR</Text>
          <Text style={{ color: "#94A3B8", fontSize: 15, lineHeight: 22 }}>
            Point the camera at the QR shown in Cowork Desktop → Settings → Remote Access.
          </Text>
        </View>

        {!granted ? (
          <View
            style={{
              borderRadius: 24,
              borderWidth: 1,
              borderColor: "#1E293B",
              backgroundColor: "#0F172A",
              padding: 20,
              gap: 12,
            }}
          >
            <Text style={{ color: "#E2E8F0", fontSize: 18, fontWeight: "600" }}>Camera permission required</Text>
            <Text style={{ color: "#94A3B8", fontSize: 14, lineHeight: 21 }}>
              Cowork Mobile needs camera access to scan the pairing code. You can also grant it later in Settings.
            </Text>
            <Pressable
              onPress={() => {
                void requestPermission();
              }}
              style={{
                alignSelf: "flex-start",
                borderRadius: 999,
                backgroundColor: "#8B5CF6",
                paddingHorizontal: 18,
                paddingVertical: 12,
              }}
            >
              <Text style={{ color: "#FFFFFF", fontSize: 14, fontWeight: "700" }}>Grant camera access</Text>
            </Pressable>
          </View>
        ) : (
          <View
            style={{
              overflow: "hidden",
              borderRadius: 28,
              borderWidth: 1,
              borderColor: "#1E293B",
              backgroundColor: "#020617",
            }}
          >
            <CameraView
              style={{ height: 420, width: "100%" }}
              facing="back"
              barcodeScannerSettings={{
                barcodeTypes: ["qr"],
              }}
              onBarcodeScanned={onBarcodeScanned}
            />
          </View>
        )}

        <View
          style={{
            borderRadius: 24,
            borderWidth: 1,
            borderColor: "#1E293B",
            backgroundColor: "#0F172A",
            padding: 20,
            gap: 12,
          }}
        >
          <Text style={{ color: "#E2E8F0", fontSize: 18, fontWeight: "600" }}>Last scanned payload</Text>
          <Text style={{ color: scannedPayload ? "#C4B5FD" : "#64748B", fontFamily: "monospace", fontSize: 12, lineHeight: 18 }}>
            {scannedPayload ?? "No QR scanned yet."}
          </Text>
        </View>
      </ScrollView>
    </>
  );
}
