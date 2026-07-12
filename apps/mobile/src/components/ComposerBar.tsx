import { Button, Host } from "@expo/ui/swift-ui";
import {
  buttonStyle,
  controlSize,
  disabled as disabledModifier,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { Pressable, Text, TextInput, View } from "react-native";

import { SFSymbol } from "@/components/ui/sf-symbol";
import {
  MAX_DYNAMIC_TYPE_MULTIPLIER,
  minimumTouchTarget,
} from "@/features/accessibility/mobile-accessibility";
import { alpha, palette } from "@/theme/tokens";
import { useAppTheme } from "@/theme/use-app-theme";

type ComposerBarProps = {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  canEdit: boolean;
  canSubmit: boolean;
  isSubmitting: boolean;
  isBusy: boolean;
  isStopping: boolean;
  submitLabel?: string;
  helperText?: string | null;
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
  canSubmit,
  canEdit,
  hasText,
  isSubmitting,
  submitLabel,
}: {
  canSubmit: boolean;
  canEdit: boolean;
  hasText: boolean;
  isSubmitting: boolean;
  submitLabel: string;
}): string {
  if (isSubmitting) {
    return "Sending message";
  }
  if (!canEdit) {
    return "Send unavailable while offline";
  }
  if (!hasText && !canSubmit) {
    return `${submitLabel}, enter a message first`;
  }
  if (!canSubmit) {
    return submitLabel;
  }
  return submitLabel;
}

function ComposerActionButton({
  canSubmit,
  isBusy,
  isStopping,
  accessibilityLabel,
  onSubmit,
  onStop,
}: {
  canSubmit: boolean;
  isBusy: boolean;
  isStopping: boolean;
  accessibilityLabel: string;
  onSubmit: () => void;
  onStop: () => void;
}) {
  const theme = useAppTheme();
  const useLiquidGlass = process.env.EXPO_OS === "ios" && isLiquidGlassAvailable();
  const enabled = isBusy ? !isStopping : canSubmit;
  const action = isBusy ? onStop : onSubmit;
  const icon = isBusy ? "stop.fill" : "arrow.up";
  const actionLabel = isBusy ? (isStopping ? "Stopping turn" : "Stop turn") : accessibilityLabel;
  const fillColor = isBusy ? theme.danger : theme.primary;
  const targetSize = minimumTouchTarget();

  if (useLiquidGlass) {
    return (
      <Host matchContents style={{ width: targetSize, height: targetSize }}>
        <Button
          onPress={action}
          systemImage={icon}
          modifiers={[
            buttonStyle(enabled ? "glassProminent" : "glass"),
            controlSize("regular"),
            tint(fillColor),
            disabledModifier(!enabled),
          ]}
        />
      </Host>
    );
  }

  return (
    <Pressable
      onPress={action}
      disabled={!enabled}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      accessibilityRole="button"
      accessibilityLabel={actionLabel}
      accessibilityState={{ disabled: !enabled, busy: isStopping }}
      style={{
        width: targetSize,
        height: targetSize,
        borderRadius: targetSize / 2,
        borderCurve: "continuous",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: enabled ? fillColor : theme.surfaceMuted,
        marginBottom: 2,
      }}
    >
      <SFSymbol name={icon} size={16} color={enabled ? theme.primaryText : theme.textTertiary} />
    </Pressable>
  );
}

export function ComposerBar({
  value,
  onChangeText,
  onSubmit,
  onStop,
  canEdit,
  canSubmit,
  isSubmitting,
  isBusy,
  isStopping,
  submitLabel = "Send",
  helperText = null,
}: ComposerBarProps) {
  const theme = useAppTheme();
  const hasText = value.trim().length > 0;
  const accessibilityLabel = sendAccessibilityLabel({
    canSubmit,
    canEdit,
    hasText,
    isSubmitting,
    submitLabel,
  });
  const shouldUseGlass = process.env.EXPO_OS === "ios" && isLiquidGlassAvailable();
  const glassColors = glassFallbackColors(theme.isDark);

  return (
    <View style={{ gap: 8 }}>
      {helperText ? (
        <Text
          accessibilityLiveRegion="polite"
          allowFontScaling
          maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
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
          editable={canEdit}
          placeholder="Message…"
          placeholderTextColor={theme.textTertiary}
          accessibilityLabel="Message"
          accessibilityHint={canEdit ? "Enter a message" : "Message editing is unavailable"}
          accessibilityState={{ disabled: !canEdit }}
          allowFontScaling
          maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
          multiline
          style={{
            flex: 1,
            color: theme.text,
            fontSize: 16,
            lineHeight: 22,
            minHeight: minimumTouchTarget(),
            maxHeight: 120,
            paddingTop: 6,
            paddingBottom: 6,
            textAlignVertical: "top",
          }}
        />
        <ComposerActionButton
          canSubmit={canSubmit}
          isBusy={isBusy}
          isStopping={isStopping}
          accessibilityLabel={accessibilityLabel}
          onSubmit={onSubmit}
          onStop={onStop}
        />
      </View>
    </View>
  );
}
