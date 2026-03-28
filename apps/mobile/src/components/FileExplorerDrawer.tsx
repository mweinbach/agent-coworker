import React from "react";
import { Modal, Pressable, View, Text, ScrollView, PlatformColor } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { SlideInRight, SlideOutRight, FadeIn, FadeOut } from "react-native-reanimated";

import { useAppTheme } from "@/theme/use-app-theme";

import { SFSymbol } from "./ui/sf-symbol";

type Props = {
  visible: boolean;
  onClose: () => void;
  workspaceName?: string;
};

export function FileExplorerDrawer({ visible, onClose, workspaceName = "Cowork" }: Props) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();

  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={{ flex: 1, flexDirection: "row" }}>
        {/* Backdrop */}
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(200)}
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.3)" }}
        >
          <Pressable style={{ flex: 1 }} onPress={onClose} />
        </Animated.View>

        {/* Drawer */}
        <Animated.View
          entering={SlideInRight.springify().damping(20).stiffness(200)}
          exiting={SlideOutRight.duration(200)}
          style={{
            width: "80%",
            maxWidth: 400,
            backgroundColor: theme.background,
            borderLeftWidth: 1,
            borderLeftColor: theme.border,
            boxShadow: "-4px 0 15px rgba(0,0,0,0.1)",
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingTop: Math.max(insets.top, 16),
              paddingHorizontal: 16,
              paddingBottom: 16,
              borderBottomWidth: 1,
              borderBottomColor: theme.borderMuted,
            }}
          >
            <Text style={{ color: theme.textSecondary, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 }}>
              FILES / {workspaceName}
            </Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <SFSymbol name="xmark" size={16} color={theme.textSecondary} />
            </Pressable>
          </View>
          
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 16, paddingBottom: Math.max(insets.bottom, 16), gap: 8 }}
          >
            {/* Placeholder File Tree */}
            <View style={{ gap: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <SFSymbol name="chevron.right" size={12} color={theme.textTertiary} />
                <SFSymbol name="folder" size={18} color={theme.primary} />
                <Text style={{ color: theme.text, fontSize: 16 }}>src</Text>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <SFSymbol name="chevron.down" size={12} color={theme.textTertiary} />
                <SFSymbol name="folder" size={18} color={theme.primary} />
                <Text style={{ color: theme.text, fontSize: 16 }}>components</Text>
              </View>
              <View style={{ paddingLeft: 20, gap: 12 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <SFSymbol name="doc.text" size={16} color={theme.textSecondary} />
                  <View>
                    <Text style={{ color: theme.text, fontSize: 15 }}>Button.tsx</Text>
                    <Text style={{ color: theme.textTertiary, fontSize: 12 }}>2 KB · Today</Text>
                  </View>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <SFSymbol name="doc.text" size={16} color={theme.textSecondary} />
                  <View>
                    <Text style={{ color: theme.text, fontSize: 15 }}>Modal.tsx</Text>
                    <Text style={{ color: theme.textTertiary, fontSize: 12 }}>4 KB · Yesterday</Text>
                  </View>
                </View>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <SFSymbol name="doc.text" size={16} color={theme.textSecondary} />
                <View>
                  <Text style={{ color: theme.text, fontSize: 15 }}>package.json</Text>
                  <Text style={{ color: theme.textTertiary, fontSize: 12 }}>1.2 KB · Mar 20</Text>
                </View>
              </View>
            </View>
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}
