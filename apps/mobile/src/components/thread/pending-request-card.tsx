import { Pressable, Text, TextInput, View } from "react-native";

import {
  minimumTouchTarget,
  useAccessibilityFocus,
} from "@/features/accessibility/mobile-accessibility";
import type { PendingServerRequest } from "@/features/cowork/threadStore";
import { alpha, radius } from "@/theme/tokens";
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
  const isApproval = request.kind === "approval";
  const isDangerous = isApproval && request.dangerous;
  const focusRef = useAccessibilityFocus<View>(
    `${request.threadId}:${request.itemId}:${request.requestFingerprint}`,
  );
  // Desktop SandboxApprovalCard: quiet tinted wash (border-destructive/40 + bg-destructive/5),
  // no heavy shadow — not a loud solid border.
  const toneAccent = isDangerous ? theme.danger : theme.warning;

  return (
    <View
      ref={focusRef}
      accessibilityLabel={
        request.kind === "approval"
          ? `${isDangerous ? "Dangerous command" : "Approval needed"}. ${request.command}. ${request.reason}`
          : `Question from Cowork. ${request.question}`
      }
      accessibilityLiveRegion="assertive"
      collapsable={false}
      style={{
        gap: 12,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: isApproval ? alpha(toneAccent, 0.4) : theme.border,
        backgroundColor: isApproval
          ? isDangerous
            ? theme.dangerMuted
            : theme.warningMuted
          : theme.surface,
        paddingHorizontal: 16,
        paddingVertical: 16,
      }}
    >
      <Text
        selectable
        style={{
          color: isApproval ? toneAccent : theme.textSecondary,
          fontSize: 12,
          fontWeight: "700",
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
              fontFamily: theme.fontFamilyMono,
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
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
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
            accessibilityLabel="Response"
            accessibilityHint="Type an answer for Cowork"
            style={{
              minHeight: 48,
              borderRadius: radius.md,
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
                accessibilityRole="button"
                accessibilityLabel={`Answer with ${option}`}
                style={({ pressed }) => ({
                  minHeight: minimumTouchTarget(),
                  justifyContent: "center",
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
              disabled={!askDraft.trim()}
              onPress={onAnswerText}
              accessibilityRole="button"
              accessibilityLabel="Send answer"
              accessibilityState={{ disabled: !askDraft.trim() }}
              style={({ pressed }) => ({
                minHeight: minimumTouchTarget(),
                justifyContent: "center",
                borderRadius: radius.md,
                borderCurve: "continuous",
                backgroundColor: pressed ? theme.primaryMuted : theme.primary,
                paddingHorizontal: 16,
                paddingVertical: 10,
              })}
            >
              <Text style={{ color: theme.primaryText, fontWeight: "600" }}>Send answer</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <Pressable
            onPress={onApprove}
            accessibilityRole="button"
            accessibilityLabel="Approve command"
            style={({ pressed }) => ({
              minHeight: minimumTouchTarget(),
              justifyContent: "center",
              borderRadius: radius.md,
              borderCurve: "continuous",
              backgroundColor: pressed ? theme.primaryMuted : theme.primary,
              paddingHorizontal: 16,
              paddingVertical: 10,
            })}
          >
            <Text style={{ color: theme.primaryText, fontWeight: "600" }}>Approve</Text>
          </Pressable>
          <Pressable
            onPress={onReject}
            accessibilityRole="button"
            accessibilityLabel="Decline command"
            style={({ pressed }) => ({
              minHeight: minimumTouchTarget(),
              justifyContent: "center",
              borderRadius: radius.md,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: theme.border,
              backgroundColor: pressed ? theme.surfaceMuted : "transparent",
              paddingHorizontal: 16,
              paddingVertical: 10,
            })}
          >
            <Text style={{ color: theme.danger, fontWeight: "600" }}>Decline</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
