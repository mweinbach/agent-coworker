import { Pressable, Text, TextInput, View } from "react-native";

import type { PendingServerRequest } from "@/features/cowork/threadStore";
import { useAppTheme } from "@/theme/use-app-theme";

type PendingRequestCardProps = {
  request: PendingServerRequest;
  askDraft: string;
  onChangeAskDraft: (text: string) => void;
  onAnswerOption: (answer: string) => void;
  onAnswerText: () => void;
  onApprove: () => void;
  onReject: () => void;
};

export function PendingRequestCard({
  request,
  askDraft,
  onChangeAskDraft,
  onAnswerOption,
  onAnswerText,
  onApprove,
  onReject,
}: PendingRequestCardProps) {
  const theme = useAppTheme();
  const isDangerous = request.kind === "approval" && request.dangerous;

  return (
    <View
      style={{
        gap: 12,
        borderRadius: 24,
        borderCurve: "continuous",
        borderWidth: isDangerous ? 2 : 1,
        borderColor: isDangerous ? theme.danger : theme.warning,
        backgroundColor: theme.surface,
        paddingHorizontal: 16,
        paddingVertical: 16,
        boxShadow: theme.shadow,
      }}
    >
      <Text
        selectable
        style={{
          color: isDangerous ? theme.danger : theme.warning,
          fontSize: 12,
          fontWeight: "800",
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        {request.kind === "approval"
          ? isDangerous
            ? "Dangerous command"
            : "Approval needed"
          : "Question from desktop"}
      </Text>
      {request.kind === "approval" ? (
        <>
          <Text
            selectable
            style={{
              fontFamily: "Menlo",
              fontSize: 13,
              lineHeight: 18,
              color: theme.text,
              backgroundColor: theme.surfaceMuted,
              borderRadius: 10,
              borderCurve: "continuous",
              padding: 10,
              overflow: "hidden",
            }}
          >
            {request.command}
          </Text>
          <Text
            selectable
            style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}
          >
            {request.reason}
          </Text>
        </>
      ) : (
        <Text
          selectable
          style={{
            color: theme.text,
            fontSize: 15,
            lineHeight: 22,
          }}
        >
          {request.question}
        </Text>
      )}
      {request.kind === "ask" ? (
        <>
          <TextInput
            value={askDraft}
            onChangeText={onChangeAskDraft}
            placeholder="Type a response..."
            placeholderTextColor={theme.textTertiary}
            style={{
              minHeight: 48,
              borderRadius: 16,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: theme.border,
              backgroundColor: theme.surfaceMuted,
              color: theme.text,
              paddingHorizontal: 12,
              paddingVertical: 10,
            }}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            {request.options.map((option) => (
              <Pressable
                key={option}
                onPress={() => onAnswerOption(option)}
                style={({ pressed }) => ({
                  borderRadius: 999,
                  borderCurve: "continuous",
                  borderWidth: 1,
                  borderColor: theme.border,
                  backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                  paddingHorizontal: 14,
                  paddingVertical: 9,
                })}
              >
                <Text style={{ color: theme.text, fontWeight: "600" }}>{option}</Text>
              </Pressable>
            ))}
            <Pressable
              onPress={onAnswerText}
              style={({ pressed }) => ({
                borderRadius: 999,
                borderCurve: "continuous",
                backgroundColor: pressed ? theme.accent : theme.primary,
                paddingHorizontal: 14,
                paddingVertical: 9,
              })}
            >
              <Text style={{ color: theme.primaryText, fontWeight: "700" }}>Send answer</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <Pressable
            onPress={onApprove}
            style={({ pressed }) => ({
              borderRadius: 999,
              borderCurve: "continuous",
              backgroundColor: pressed ? theme.success : theme.primary,
              paddingHorizontal: 14,
              paddingVertical: 9,
            })}
          >
            <Text style={{ color: theme.primaryText, fontWeight: "700" }}>Approve</Text>
          </Pressable>
          <Pressable
            onPress={onReject}
            style={({ pressed }) => ({
              borderRadius: 999,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: theme.danger,
              backgroundColor: pressed ? theme.dangerMuted : "transparent",
              paddingHorizontal: 14,
              paddingVertical: 9,
            })}
          >
            <Text style={{ color: theme.danger, fontWeight: "700" }}>Decline</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
