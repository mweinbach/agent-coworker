import { Pressable, Text, TextInput, View } from "react-native";

import { useAppTheme } from "@/theme/use-app-theme";

type ComposerBarProps = {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  submitLabel?: string;
  helperText?: string | null;
  disabled?: boolean;
};

export function ComposerBar({
  value,
  onChangeText,
  onSubmit,
  submitLabel = "Send",
  helperText = null,
  disabled = false,
}: ComposerBarProps) {
  const theme = useAppTheme();

  return (
    <View
      style={{
        borderRadius: 24,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: theme.border,
        backgroundColor: theme.surface,
        padding: 14,
        gap: 12,
        boxShadow: theme.shadow,
      }}
    >
      {helperText ? (
        <Text
          selectable
          style={{
            color: theme.textTertiary,
            fontSize: 12,
            lineHeight: 18,
          }}
        >
          {helperText}
        </Text>
      ) : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder="Send a steer, a follow-up, or a new prompt…"
        placeholderTextColor={theme.textTertiary}
        multiline
        editable={!disabled}
        style={{
          color: theme.text,
          fontSize: 15,
          lineHeight: 22,
          minHeight: 72,
          textAlignVertical: "top",
        }}
      />
      <Pressable
        onPress={onSubmit}
        disabled={disabled}
        accessibilityRole="button"
        style={{
          alignSelf: "flex-end",
          borderRadius: 999,
          borderCurve: "continuous",
          backgroundColor: disabled ? theme.surfaceMuted : theme.primary,
          paddingHorizontal: 18,
          paddingVertical: 10,
        }}
      >
        <Text
          style={{
            color: disabled ? theme.textTertiary : theme.primaryText,
            fontWeight: "700",
          }}
        >
          {submitLabel}
        </Text>
      </Pressable>
    </View>
  );
}
