import { Image } from "expo-image";
import { useState } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import { normalizeInlineLinkHref } from "@/features/cowork/inlineMarkdown";
import {
  displaySourceSubtitle,
  displaySourceTitle,
  faviconUrl,
  type SourceLinkItem,
} from "@/features/cowork/sourceDisplay";
import { useAppTheme } from "@/theme/use-app-theme";

const CARD_WIDTH = 176;

function SourceFavicon({ url }: { url: string }) {
  const theme = useAppTheme();
  const [failed, setFailed] = useState(false);
  const src = faviconUrl(url);
  const fallbackLetter = displaySourceSubtitle({ label: "", href: url }).charAt(0).toUpperCase();

  if (!src || failed) {
    return (
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 6,
          borderCurve: "continuous",
          backgroundColor: theme.surfaceMuted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          style={{
            color: theme.textSecondary,
            fontSize: 10,
            fontWeight: "700",
            textTransform: "uppercase",
          }}
        >
          {fallbackLetter || "?"}
        </Text>
      </View>
    );
  }

  return (
    <Image
      source={{ uri: src }}
      style={{ width: 20, height: 20, borderRadius: 4 }}
      contentFit="contain"
      onError={() => setFailed(true)}
    />
  );
}

function SourceCard({ item }: { item: SourceLinkItem }) {
  const theme = useAppTheme();
  const title = displaySourceTitle(item);
  const domain = displaySourceSubtitle(item);

  async function openLink() {
    const normalized = normalizeInlineLinkHref(item.href);
    if (!normalized) return;
    try {
      const supported = await Linking.canOpenURL(normalized);
      if (supported) {
        await Linking.openURL(normalized);
      }
    } catch {
      // Best-effort only.
    }
  }

  return (
    <Pressable
      onPress={() => void openLink()}
      style={({ pressed }) => ({
        width: CARD_WIDTH,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        borderRadius: 12,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: pressed ? theme.border : theme.borderMuted,
        backgroundColor: pressed ? theme.surfaceMuted : theme.surface,
        paddingHorizontal: 12,
        paddingVertical: 10,
      })}
    >
      <SourceFavicon url={item.href} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          numberOfLines={2}
          style={{
            color: theme.text,
            fontSize: 12,
            lineHeight: 16,
            fontWeight: "600",
          }}
        >
          {title}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            color: theme.textTertiary,
            fontSize: 10,
            lineHeight: 14,
          }}
        >
          {domain}
        </Text>
      </View>
    </Pressable>
  );
}

export function SourcesCarousel({ items }: { items: SourceLinkItem[] }) {
  const theme = useAppTheme();

  if (items.length === 0) {
    return null;
  }

  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text
          style={{
            color: theme.textTertiary,
            fontSize: 10,
            fontWeight: "700",
            letterSpacing: 1.2,
            textTransform: "uppercase",
          }}
        >
          Sources
        </Text>
        <Text
          style={{
            color: theme.textTertiary,
            fontSize: 10,
            opacity: 0.65,
          }}
        >
          {items.length}
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingRight: 4 }}
      >
        {items.map((item) => (
          <SourceCard key={`${item.href}:${displaySourceTitle(item)}`} item={item} />
        ))}
      </ScrollView>
    </View>
  );
}
