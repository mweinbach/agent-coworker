import { Button, Host } from "@expo/ui/swift-ui";
import {
  accessibilityLabel as accessibilityLabelModifier,
  buttonStyle,
  controlSize,
  disabled as disabledModifier,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { Pressable, View } from "react-native";

import { SFSymbol } from "@/components/ui/sf-symbol";
import { minimumTouchTarget } from "@/features/accessibility/mobile-accessibility";
import { alpha, palette } from "@/theme/tokens";
import { useAppTheme } from "@/theme/use-app-theme";
import {
  type ComposerActionIcon,
  type ComposerBarProps,
  ComposerHelperText,
  ComposerTextInput,
  useComposerBehavior,
} from "./composerShared";

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

function ComposerActionButton({
  actionAccessibilityLabel,
  actionBusy,
  actionEnabled,
  actionIcon,
  isBusy,
  performAction,
}: {
  actionAccessibilityLabel: string;
  actionBusy: boolean;
  actionEnabled: boolean;
  actionIcon: ComposerActionIcon;
  isBusy: boolean;
  performAction: () => void;
}) {
  const theme = useAppTheme();
  const useLiquidGlass = process.env.EXPO_OS === "ios" && isLiquidGlassAvailable();
  const fillColor = isBusy ? theme.danger : theme.primary;
  const targetSize = minimumTouchTarget();

  if (useLiquidGlass) {
    return (
      <Host matchContents style={{ width: targetSize, height: targetSize }}>
        <Button
          onPress={performAction}
          systemImage={actionIcon}
          modifiers={[
            accessibilityLabelModifier(actionAccessibilityLabel),
            buttonStyle(actionEnabled ? "glassProminent" : "glass"),
            controlSize("regular"),
            tint(fillColor),
            disabledModifier(!actionEnabled),
          ]}
        />
      </Host>
    );
  }

  return (
    <Pressable
      onPress={performAction}
      disabled={!actionEnabled}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      accessibilityRole="button"
      accessibilityLabel={actionAccessibilityLabel}
      accessibilityState={{ disabled: !actionEnabled, busy: actionBusy }}
      style={{
        width: targetSize,
        height: targetSize,
        borderRadius: targetSize / 2,
        borderCurve: "continuous",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: actionEnabled ? fillColor : theme.surfaceMuted,
        marginBottom: 2,
      }}
    >
      <SFSymbol
        name={actionIcon}
        size={16}
        color={actionEnabled ? theme.primaryText : theme.textTertiary}
      />
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
  submitLabel,
  helperText = null,
}: ComposerBarProps) {
  const theme = useAppTheme();
  const composerBehavior = useComposerBehavior({
    value,
    onSubmit,
    onStop,
    canEdit,
    canSubmit,
    isSubmitting,
    isBusy,
    isStopping,
    submitLabel,
  });
  const shouldUseGlass = process.env.EXPO_OS === "ios" && isLiquidGlassAvailable();
  const glassColors = glassFallbackColors(theme.isDark);

  return (
    <View style={{ gap: 8 }}>
      <ComposerHelperText helperText={helperText} />
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
        <ComposerTextInput
          value={value}
          onChangeText={onChangeText}
          canEdit={canEdit}
          placeholderTextColor={theme.textTertiary}
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
          actionAccessibilityLabel={composerBehavior.actionAccessibilityLabel}
          actionBusy={composerBehavior.actionBusy}
          actionEnabled={composerBehavior.actionEnabled}
          actionIcon={composerBehavior.actionIcon}
          isBusy={isBusy}
          performAction={composerBehavior.performAction}
        />
      </View>
    </View>
  );
}
