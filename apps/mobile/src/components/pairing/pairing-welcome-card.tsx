import { useRouter } from "expo-router";
import { Text, View } from "react-native";

import { AppButton } from "@/components/ui/app-button";
import { SFSymbol } from "@/components/ui/sf-symbol";
import { useAppTheme } from "@/theme/use-app-theme";

type PairingWelcomeCardProps = {
  title: string;
  body: string;
};

export function PairingWelcomeCard({ title, body }: PairingWelcomeCardProps) {
  const router = useRouter();
  const theme = useAppTheme();

  return (
    <View style={{ alignItems: "center", gap: 16, paddingHorizontal: 20, paddingVertical: 28 }}>
      <SFSymbol name="macbook.and.iphone" size={52} color={theme.textSecondary} />
      <View style={{ alignItems: "center", gap: 8, width: "100%" }}>
        <Text
          selectable
          style={{
            color: theme.text,
            fontSize: 22,
            fontWeight: "700",
            textAlign: "center",
          }}
        >
          {title}
        </Text>
        <Text
          selectable
          style={{
            color: theme.textSecondary,
            fontSize: 15,
            lineHeight: 22,
            textAlign: "center",
          }}
        >
          {body}
        </Text>
      </View>
      <AppButton
        fullWidth
        variant="glass"
        icon="qrcode.viewfinder"
        onPress={() => router.push("/(pairing)/scan")}
      >
        Scan QR Code
      </AppButton>
    </View>
  );
}
