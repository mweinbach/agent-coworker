import { Button, Host } from "@expo/ui/swift-ui";
import {
  buttonStyle,
  controlSize,
  disabled as disabledModifier,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { Platform, Pressable, Text, TextInput, View } from "react-native";

import { SFSymbol } from "@/components/ui/sf-symbol";
import { alpha, palette } from "@/theme/tokens";
import { useAppTheme } from "@/theme/use-app-theme";

type ComposerBarProps = {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  submitLabel?: string;
  helperText?: string | null;
  disabled?: boolean;
};

function glassFallbackColors(isDark: boolean) {
  const colors = isDark ? palette.dark : palette.light;
  return {
    // Frosted fallback when Liquid Glass is unavailable — derived from palette
    // (a light text-tinted wash on dark, a translucent panel on light) rather
    // than bare rgba literals.
    fill: isDark ? alpha(colors.textBase, 0.1) : alpha(colors.panelBg, 0.58),
    border: colors.glassBorder,
    shadow: isDark
      ? "0 12px 26px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.12)"
      : "0 12px 26px rgba(35, 42, 24, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.78)",
  };
}

function sendAccessibilityLabel({
  canSend,
  disabled,
  hasText,
  submitLabel,
}: {
  canSend: boolean;
  disabled: boolean;
  hasText: boolean;
  submitLabel: string;
}): string {
  if (disabled) {
    return "Send unavailable while offline";
  }
  if (!hasText) {
    return `${submitLabel}, enter a message first`;
  }
  if (!canSend) {
    return submitLabel;
  }
  return submitLabel;
}

function ComposerSendButton({
  canSend,
  accessibilityLabel,
  onSubmit,
}: {
  canSend: boolean;
  accessibilityLabel: string;
  onSubmit: () => void;
}) {
  const theme = useAppTheme();
  const useLiquidGlass = Platform.OS === "ios" && isLiquidGlassAvailable();
  const submitIfReady = () => {
    if (!canSend) {
      return;
    }
    onSubmit();
  };

  if (useLiquidGlass) {
    return (
      <Host matchContents style={{ width: 34, height: 34, marginBottom: 2 }}>
        <Button
          onPress={submitIfReady}
          systemImage="arrow.up"
          modifiers={[
            buttonStyle(canSend ? "glassProminent" : "glass"),
            controlSize("regular"),
            tint(theme.primary),
            disabledModifier(!canSend),
          ]}
        />
      </Host>
    );
  }

  return (
    <Pressable
      onPress={submitIfReady}
      disabled={!canSend}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !canSend }}
      style={{
        width: 34,
        height: 34,
        borderRadius: 17,
        borderCurve: "continuous",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: canSend ? theme.primary : theme.surfaceMuted,
        marginBottom: 2,
      }}
    >
      <SFSymbol
        name="arrow.up"
        size={16}
        color={canSend ? theme.primaryText : theme.textTertiary}
      />
    </Pressable>
  );
}

export function ComposerBar({
  value,
  onChangeText,
  onSubmit,
  submitLabel = "Send",
  helperText = null,
  disabled = false,
}: ComposerBarProps) {
  const theme = useAppTheme();
  const hasText = value.trim().length > 0;
  const canSend = !disabled && hasText;
  const accessibilityLabel = sendAccessibilityLabel({
    canSend,
    disabled,
    hasText,
    submitLabel,
  });
  const shouldUseGlass = Platform.OS === "ios" && isLiquidGlassAvailable();
  const glassColors = glassFallbackColors(theme.isDark);

  return (
    <View style={{ gap: 8 }}>
      {helperText ? (
        <Text
          selectable
          style={{
            color: theme.textTertiary,
            fontSize: 12,
            lineHeight: 16,
            textAlign: "center",
          }}
        >
          {helperText}
        </Text>
      ) : null}
      <View
        style={{
          position: "relative",
          overflow: "hidden",
          flexDirection: "row",
          alignItems: "flex-end",
          gap: 10,
          borderRadius: 22,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: glassColors.border,
          backgroundColor: shouldUseGlass ? "transparent" : glassColors.fill,
          paddingLeft: 16,
          paddingRight: 8,
          paddingVertical: 8,
          boxShadow: glassColors.shadow,
        }}
      >
        {shouldUseGlass ? (
          <GlassView
            pointerEvents="none"
            isInteractive
            glassEffectStyle="regular"
            tintColor={theme.surface}
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              borderRadius: 22,
              borderCurve: "continuous",
            }}
          />
        ) : null}
        <TextInput
          value={value}
          onChangeText={onChangeText}
          editable={!disabled}
          placeholder="Message…"
          placeholderTextColor={theme.textTertiary}
          accessibilityLabel="Message"
          multiline
          style={{
            flex: 1,
            color: theme.text,
            fontSize: 16,
            lineHeight: 22,
            minHeight: 36,
            maxHeight: 120,
            paddingTop: 6,
            paddingBottom: 6,
            textAlignVertical: "top",
          }}
        />
        <ComposerSendButton
          canSend={canSend}
          accessibilityLabel={accessibilityLabel}
          onSubmit={onSubmit}
        />
      </View>
    </View>
  );
}
