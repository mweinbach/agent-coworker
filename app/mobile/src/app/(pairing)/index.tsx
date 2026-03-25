import { View, Text } from "react-native";

export default function PairingIndexRoute() {
  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#0b1020" }}>
      <Text style={{ color: "#f8fafc", fontSize: 24, fontWeight: "700" }}>Pairing</Text>
      <Text style={{ color: "#94a3b8", marginTop: 8, paddingHorizontal: 24, textAlign: "center" }}>
        Remote pairing UI will live here once the secure transport and Cowork client layers are wired in.
      </Text>
    </View>
  );
}
