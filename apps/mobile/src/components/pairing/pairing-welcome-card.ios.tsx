import { Image, Text, VStack } from "@expo/ui/swift-ui";
import {
  font,
  foregroundStyle,
  frame,
  multilineTextAlignment,
  padding,
} from "@expo/ui/swift-ui/modifiers";
import { useRouter } from "expo-router";
import type { SFSymbol } from "sf-symbols-typescript";

import { useAppTheme } from "@/theme/use-app-theme";

import { PairingActionButton } from "./pairing-ios-ui";

type PairingWelcomeCardProps = {
  title: string;
  body: string;
};

export function PairingWelcomeCard({ title, body }: PairingWelcomeCardProps) {
  const router = useRouter();
  const theme = useAppTheme();

  return (
    <VStack alignment="center" spacing={16} modifiers={[padding({ horizontal: 20, vertical: 28 })]}>
      <Image systemName={"macbook.and.iphone" as SFSymbol} size={52} color={theme.textSecondary} />
      <VStack
        alignment="center"
        spacing={8}
        modifiers={[frame({ maxWidth: Number.POSITIVE_INFINITY })]}
      >
        <Text
          modifiers={[
            font({ size: 22, weight: "bold" }),
            foregroundStyle(theme.text),
            multilineTextAlignment("center"),
          ]}
        >
          {title}
        </Text>
        <Text
          modifiers={[
            font({ size: 15 }),
            foregroundStyle(theme.textSecondary),
            multilineTextAlignment("center"),
          ]}
        >
          {body}
        </Text>
      </VStack>
      <PairingActionButton
        title="Scan QR Code"
        systemImage={"qrcode.viewfinder" as SFSymbol}
        primaryColor={theme.primary}
        onPress={() => router.push("/(pairing)/scan")}
      />
    </VStack>
  );
}
