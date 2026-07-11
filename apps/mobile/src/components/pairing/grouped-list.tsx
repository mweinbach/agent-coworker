import type { PropsWithChildren, ReactElement, ReactNode } from "react";
import {
  Pressable,
  type RefreshControlProps,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Switch,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import Swipeable from "react-native-gesture-handler/Swipeable";

import {
  MAX_DYNAMIC_TYPE_MULTIPLIER,
  minimumTouchTarget,
} from "@/features/accessibility/mobile-accessibility";
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
      automaticallyAdjustKeyboardInsets
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
              accessibilityRole="header"
              allowFontScaling
              maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
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
          allowFontScaling
          maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
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
        minHeight: minimumTouchTarget(),
        justifyContent: "center",
        paddingHorizontal: 16,
        paddingVertical: detail ? 10 : 12,
        borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: theme.borderMuted,
        backgroundColor: theme.surface,
      }}
    >
      <Text
        allowFontScaling
        maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
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
          allowFontScaling
          maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
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
      accessibilityLabel={[label, detail].filter(Boolean).join(", ")}
      accessibilityRole="button"
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
        flexWrap: "wrap",
        minHeight: minimumTouchTarget(),
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: theme.borderMuted,
      }}
    >
      <Text
        allowFontScaling
        maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
        selectable
        style={{ flexShrink: 1, color: theme.text, fontSize: 17 }}
      >
        {label}
      </Text>
      <Text
        allowFontScaling
        maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
        selectable
        style={{
          flex: 1,
          minWidth: 120,
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

type GroupedSwitchRowProps = {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  isLast?: boolean;
};

export function GroupedSwitchRow({
  label,
  description,
  value,
  onValueChange,
  isLast = false,
}: GroupedSwitchRowProps) {
  const theme = useAppTheme();

  return (
    <Pressable
      accessibilityHint={description}
      accessibilityLabel={label}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={() => onValueChange(!value)}
      style={({ pressed }) => ({
        minHeight: minimumTouchTarget(),
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: theme.borderMuted,
        backgroundColor: pressed ? theme.surfaceMuted : "transparent",
      })}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text
          allowFontScaling
          maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
          style={{ color: theme.text, fontSize: 17 }}
        >
          {label}
        </Text>
        {description ? (
          <Text
            allowFontScaling
            maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
            style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}
          >
            {description}
          </Text>
        ) : null}
      </View>
      <Switch
        accessibilityElementsHidden
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        value={value}
        trackColor={{ true: theme.primary, false: theme.surfaceMuted }}
        ios_backgroundColor={theme.surfaceMuted}
      />
    </Pressable>
  );
}
