import type {
  NativeSyntheticEvent,
  TextInputContentSizeChangeEventData,
  TextInputProps,
} from "react-native";
import { Text, TextInput } from "react-native";

import { MAX_DYNAMIC_TYPE_MULTIPLIER } from "@/features/accessibility/mobile-accessibility";
import { useAppTheme } from "@/theme/use-app-theme";

export type ComposerBarProps = {
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

export type ComposerActionIcon = "stop.fill" | "arrow.up";

type ComposerBehavior = {
  actionAccessibilityLabel: string;
  actionBusy: boolean;
  actionEnabled: boolean;
  actionIcon: ComposerActionIcon;
  performAction: () => void;
};

type ComposerBehaviorProps = Pick<
  ComposerBarProps,
  | "value"
  | "onSubmit"
  | "onStop"
  | "canEdit"
  | "canSubmit"
  | "isSubmitting"
  | "isBusy"
  | "isStopping"
  | "submitLabel"
>;

export const DEFAULT_SUBMIT_LABEL = "Send";
export const COMPOSER_PLACEHOLDER = "Message…";

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

export function useComposerBehavior({
  value,
  onSubmit,
  onStop,
  canEdit,
  canSubmit,
  isSubmitting,
  isBusy,
  isStopping,
  submitLabel = DEFAULT_SUBMIT_LABEL,
}: ComposerBehaviorProps): ComposerBehavior {
  const hasText = value.trim().length > 0;
  const submitAccessibilityLabel = sendAccessibilityLabel({
    canSubmit,
    canEdit,
    hasText,
    isSubmitting,
    submitLabel,
  });
  const actionEnabled = isBusy ? !isStopping : canSubmit;

  return {
    actionAccessibilityLabel: isBusy
      ? isStopping
        ? "Stopping turn"
        : "Stop turn"
      : submitAccessibilityLabel,
    actionBusy: isStopping,
    actionEnabled,
    actionIcon: isBusy ? "stop.fill" : "arrow.up",
    performAction: () => {
      if (!actionEnabled) {
        return;
      }
      if (isBusy) {
        onStop();
        return;
      }
      onSubmit();
    },
  };
}

export function ComposerHelperText({ helperText }: { helperText?: string | null }) {
  const theme = useAppTheme();

  if (!helperText) {
    return null;
  }

  return (
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
  );
}

export function ComposerTextInput({
  value,
  onChangeText,
  canEdit,
  placeholderTextColor,
  style,
  onContentSizeChange,
}: Pick<ComposerBarProps, "value" | "onChangeText" | "canEdit"> & {
  placeholderTextColor: string;
  style: TextInputProps["style"];
  onContentSizeChange?: (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => void;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      editable={canEdit}
      placeholder={COMPOSER_PLACEHOLDER}
      placeholderTextColor={placeholderTextColor}
      accessibilityLabel="Message"
      accessibilityHint={canEdit ? "Enter a message" : "Message editing is unavailable"}
      accessibilityState={{ disabled: !canEdit }}
      allowFontScaling
      maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
      multiline
      onContentSizeChange={onContentSizeChange}
      style={style}
    />
  );
}
