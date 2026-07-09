import { Image as ExpoImage, Group, Host, HStack, RNHostView } from "@expo/ui/swift-ui";
import {
  background,
  foregroundStyle,
  frame,
  glassEffect,
  padding,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { SFSymbol as NativeSFSymbol } from "sf-symbols-typescript";

import { useAppTheme } from "@/theme/use-app-theme";

type ComposerBarProps = {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  submitLabel?: string;
  helperText?: string | null;
  disabled?: boolean;
};

const MIN_INPUT_HEIGHT = 36;
const MAX_INPUT_HEIGHT = 116;
const VERTICAL_CHROME = 16;
const BUTTON_SIZE = 34;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function asNativeSymbol(icon: string): NativeSFSymbol {
  return icon as NativeSFSymbol;
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

export function ComposerBar({
  value,
  onChangeText,
  onSubmit,
  submitLabel = "Send",
  helperText = null,
  disabled = false,
}: ComposerBarProps) {
  const theme = useAppTheme();
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT);
  const hasText = value.trim().length > 0;
  const canSend = !disabled && hasText;
  const accessibilityLabel = sendAccessibilityLabel({
    canSend,
    disabled,
    hasText,
    submitLabel,
  });
  const barHeight = clamp(inputHeight, MIN_INPUT_HEIGHT, MAX_INPUT_HEIGHT) + VERTICAL_CHROME;
  const sendFillColor = canSend ? theme.primary : theme.surfaceMuted;
  const sendIconColor = canSend ? theme.primaryText : theme.textTertiary;
  const submitIfReady = () => {
    if (!canSend) {
      return;
    }
    onSubmit();
  };

  return (
    <View style={{ gap: 8, width: "100%", backgroundColor: "transparent" }}>
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
                <TextInput
                  value={value}
                  onChangeText={onChangeText}
                  editable={!disabled}
                  placeholder="Message…"
                  placeholderTextColor={theme.textTertiary}
                  accessibilityLabel="Message"
                  multiline
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
            <ExpoImage
              systemName={asNativeSymbol("arrow.up")}
              size={16}
              color={sendIconColor}
              accessibilityLabel={accessibilityLabel}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSend }}
              onPress={canSend ? submitIfReady : undefined}
              modifiers={[
                foregroundStyle(sendIconColor),
                frame({ width: BUTTON_SIZE, height: BUTTON_SIZE }),
                background(sendFillColor, shapes.circle()),
                glassEffect({
                  glass: {
                    variant: "regular",
                    interactive: true,
                    tint: sendFillColor,
                  },
                  shape: "circle",
                }),
              ]}
            />
          </Group>
        </HStack>
      </Host>
    </View>
  );
}
