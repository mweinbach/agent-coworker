import { Button, Image as ExpoImage, Group, Host, HStack, RNHostView } from "@expo/ui/swift-ui";
import {
  accessibilityLabel as accessibilityLabelModifier,
  background,
  buttonStyle,
  disabled as disabledModifier,
  foregroundStyle,
  frame,
  glassEffect,
  padding,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import type { ComponentProps } from "react";
import { useState } from "react";
import { View } from "react-native";

import { useAppTheme } from "@/theme/use-app-theme";
import {
  type ComposerActionIcon,
  type ComposerBarProps,
  ComposerHelperText,
  ComposerTextInput,
  useComposerBehavior,
} from "./composerShared";

const MIN_INPUT_HEIGHT = 44;
const MAX_INPUT_HEIGHT = 116;
const VERTICAL_CHROME = 16;
const BUTTON_SIZE = 44;
type NativeSFSymbol = ComponentProps<typeof ExpoImage>["systemName"];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function asNativeSymbol(icon: ComposerActionIcon): NativeSFSymbol {
  return icon as NativeSFSymbol;
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
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT);
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
  const barHeight = clamp(inputHeight, MIN_INPUT_HEIGHT, MAX_INPUT_HEIGHT) + VERTICAL_CHROME;
  const actionFillColor = composerBehavior.actionEnabled
    ? isBusy
      ? theme.danger
      : theme.primary
    : theme.surfaceMuted;
  const actionIconColor = composerBehavior.actionEnabled ? theme.primaryText : theme.textTertiary;

  return (
    <View style={{ gap: 8, width: "100%", backgroundColor: "transparent" }}>
      <ComposerHelperText helperText={helperText} />
      <Host
        colorScheme={theme.isDark ? "dark" : "light"}
        style={{
          width: "100%",
          height: barHeight,
          backgroundColor: "transparent",
        }}
      >
        <HStack
          spacing={10}
          alignment="bottom"
          modifiers={[
            frame({
              maxWidth: Number.POSITIVE_INFINITY,
              height: barHeight,
            }),
            padding({ leading: 16, trailing: 8, vertical: 8 }),
            glassEffect({
              glass: {
                variant: "regular",
                interactive: true,
                tint: theme.surface,
              },
              shape: "roundedRectangle",
              cornerRadius: 22,
            }),
          ]}
        >
          <Group
            modifiers={[
              frame({
                maxWidth: Number.POSITIVE_INFINITY,
                minHeight: MIN_INPUT_HEIGHT,
                maxHeight: MAX_INPUT_HEIGHT,
              }),
            ]}
          >
            <RNHostView matchContents={false}>
              <View
                style={{
                  width: "100%",
                  minHeight: MIN_INPUT_HEIGHT,
                  justifyContent: "center",
                }}
              >
                <ComposerTextInput
                  value={value}
                  onChangeText={onChangeText}
                  canEdit={canEdit}
                  placeholderTextColor={theme.textTertiary}
                  onContentSizeChange={(event) => {
                    setInputHeight(
                      clamp(
                        event.nativeEvent.contentSize.height,
                        MIN_INPUT_HEIGHT,
                        MAX_INPUT_HEIGHT,
                      ),
                    );
                  }}
                  style={{
                    width: "100%",
                    color: theme.text,
                    fontSize: 16,
                    lineHeight: 22,
                    minHeight: MIN_INPUT_HEIGHT,
                    maxHeight: MAX_INPUT_HEIGHT,
                    paddingTop: 6,
                    paddingBottom: 6,
                    textAlignVertical: "top",
                  }}
                />
              </View>
            </RNHostView>
          </Group>
          <Group modifiers={[frame({ width: BUTTON_SIZE, height: BUTTON_SIZE })]}>
            <Button
              onPress={composerBehavior.actionEnabled ? composerBehavior.performAction : undefined}
              modifiers={[
                accessibilityLabelModifier(composerBehavior.actionAccessibilityLabel),
                disabledModifier(!composerBehavior.actionEnabled),
                buttonStyle("plain"),
                foregroundStyle(actionIconColor),
                frame({ width: BUTTON_SIZE, height: BUTTON_SIZE }),
                background(actionFillColor, shapes.circle()),
                glassEffect({
                  glass: {
                    variant: "regular",
                    interactive: true,
                    tint: actionFillColor,
                  },
                  shape: "circle",
                }),
              ]}
            >
              <ExpoImage
                systemName={asNativeSymbol(composerBehavior.actionIcon)}
                size={16}
                color={actionIconColor}
              />
            </Button>
          </Group>
        </HStack>
      </Host>
    </View>
  );
}
