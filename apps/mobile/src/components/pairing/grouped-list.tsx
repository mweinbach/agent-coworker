import type { PropsWithChildren, ReactElement, ReactNode } from "react";
import {
  Pressable,
  type RefreshControlProps,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import Swipeable from "react-native-gesture-handler/Swipeable";

import { useAppTheme } from "@/theme/use-app-theme";

type GroupedScreenProps = PropsWithChildren<{
  contentStyle?: StyleProp<ViewStyle>;
  refreshControl?: ReactElement<RefreshControlProps>;
}>;

export function GroupedScreen({ children, contentStyle, refreshControl }: GroupedScreenProps) {
  const theme = useAppTheme();

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.backgroundMuted }}
      contentContainerStyle={[{ paddingHorizontal: 20, paddingBottom: 32, gap: 22 }, contentStyle]}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      refreshControl={refreshControl}
    >
      {children}
    </ScrollView>
  );
}

type GroupedSectionProps = PropsWithChildren<{
  title?: string;
  footer?: string;
  action?: ReactNode;
}>;

export function GroupedSection({ title, footer, action, children }: GroupedSectionProps) {
  const theme = useAppTheme();

  return (
    <View style={{ gap: 8 }}>
      {title || action ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 4,
          }}
        >
          {title ? (
            <Text
              style={{
                color: theme.textSecondary,
                fontSize: 13,
                fontWeight: "400",
                textTransform: "uppercase",
                letterSpacing: 0.2,
              }}
            >
              {title}
            </Text>
          ) : (
            <View />
          )}
          {action}
        </View>
      ) : null}
      <View
        style={{
          overflow: "hidden",
          borderRadius: 10,
          borderCurve: "continuous",
          backgroundColor: theme.surface,
        }}
      >
        {children}
      </View>
      {footer ? (
        <Text
          selectable
          style={{
            color: theme.textSecondary,
            fontSize: 13,
            lineHeight: 18,
            paddingHorizontal: 4,
          }}
        >
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

type GroupedRowProps = {
  label: string;
  detail?: string;
  onPress?: () => void;
  onDelete?: () => void;
  destructive?: boolean;
  isLast?: boolean;
};

export function GroupedRow({
  label,
  detail,
  onPress,
  onDelete,
  destructive = false,
  isLast = false,
}: GroupedRowProps) {
  const theme = useAppTheme();
  const content = (
    <View
      style={{
        minHeight: 44,
        justifyContent: "center",
        paddingHorizontal: 16,
        paddingVertical: detail ? 10 : 12,
        borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: theme.borderMuted,
        backgroundColor: theme.surface,
      }}
    >
      <Text
        selectable
        style={{
          color: destructive ? theme.danger : theme.primary,
          fontSize: 17,
          fontWeight: "400",
        }}
      >
        {label}
      </Text>
      {detail ? (
        <Text
          selectable
          style={{
            color: theme.textSecondary,
            fontSize: 13,
            marginTop: 2,
            fontVariant: ["tabular-nums"],
          }}
        >
          {detail}
        </Text>
      ) : null}
    </View>
  );

  const rowBody = onPress ? (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? theme.surfaceMuted : theme.surface,
      })}
    >
      {content}
    </Pressable>
  ) : (
    content
  );

  if (!onDelete) {
    return rowBody;
  }

  return (
    <Swipeable
      overshootRight={false}
      renderRightActions={() => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete ${label}`}
          onPress={onDelete}
          style={{
            width: 88,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.danger,
          }}
        >
          <Text style={{ color: theme.primaryText, fontSize: 15, fontWeight: "600" }}>Delete</Text>
        </Pressable>
      )}
    >
      {rowBody}
    </Swipeable>
  );
}

type GroupedValueRowProps = {
  label: string;
  value: string;
  isLast?: boolean;
};

export function GroupedValueRow({ label, value, isLast = false }: GroupedValueRowProps) {
  const theme = useAppTheme();

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        minHeight: 44,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: theme.borderMuted,
      }}
    >
      <Text selectable style={{ color: theme.text, fontSize: 17 }}>
        {label}
      </Text>
      <Text
        selectable
        numberOfLines={2}
        style={{
          flexShrink: 1,
          color: theme.textSecondary,
          fontSize: 17,
          textAlign: "right",
          fontVariant: ["tabular-nums"],
        }}
      >
        {value}
      </Text>
    </View>
  );
}
