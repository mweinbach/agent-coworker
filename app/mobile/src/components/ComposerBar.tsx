import { Pressable, Text, TextInput, View } from "react-native";

type ComposerBarProps = {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
};

export function ComposerBar({ value, onChangeText, onSubmit }: ComposerBarProps) {
  return (
    <View
      style={{
        borderRadius: 20,
        borderWidth: 1,
        borderColor: "#1e293b",
        backgroundColor: "#0f172a",
        padding: 12,
        gap: 12,
      }}
    >
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder="Send a steer, a follow-up, or a new prompt…"
        placeholderTextColor="#64748b"
        multiline
        style={{
          color: "#f8fafc",
          fontSize: 15,
          lineHeight: 22,
          minHeight: 72,
          textAlignVertical: "top",
        }}
      />
      <Pressable
        onPress={onSubmit}
        style={{
          alignSelf: "flex-end",
          borderRadius: 999,
          backgroundColor: "#2563eb",
          paddingHorizontal: 16,
          paddingVertical: 10,
        }}
      >
        <Text style={{ color: "#eff6ff", fontWeight: "700" }}>Send</Text>
      </Pressable>
    </View>
  );
}
