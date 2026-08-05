import { useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import {
  announceForAccessibility,
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
  onApprove: () => Promise<boolean>;
  onReject: () => Promise<boolean>;
};

type ApprovalResponseAction = "approve" | "reject";

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
  const isSandboxEscalation = isApproval && request.dangerous;
  const [respondingAction, setRespondingAction] = useState<ApprovalResponseAction | null>(null);
  const respondingActionRef = useRef<ApprovalResponseAction | null>(null);
  const focusRef = useAccessibilityFocus<View>(
    `${request.threadId}:${request.itemId}:${request.requestFingerprint}`,
  );
  // Desktop SandboxApprovalCard: quiet tinted wash (border-destructive/40 + bg-destructive/5),
  // no heavy shadow — not a loud solid border.
  const toneAccent = isSandboxEscalation ? theme.danger : theme.warning;
  const isResponding = respondingAction !== null;
  const approvalDetail = isApproval ? (request.detail ?? request.reason) : null;
  const categoryLabel =
    isApproval && request.category
      ? request.category === "filesystem"
        ? "Filesystem access"
        : "Network access"
      : null;
  const approvalLabels = isSandboxEscalation
    ? {
        approving: "Starting command with full access",
        approved: "Command started with full access",
        approvalFailed: "Full access request failed",
        approve: "Run with full access",
        rejecting: "Keeping command blocked",
        rejected: "Command kept blocked",
        rejectionFailed: "Failed to keep command blocked",
        reject: "Keep blocked",
      }
    : {
        approving: "Approving command",
        approved: "Command approved",
        approvalFailed: "Command approval failed",
        approve: "Approve command",
        rejecting: "Declining command",
        rejected: "Command declined",
        rejectionFailed: "Command decline failed",
        reject: "Decline command",
      };

  async function respondToApproval(
    action: ApprovalResponseAction,
    respond: () => Promise<boolean>,
  ): Promise<void> {
    if (respondingActionRef.current !== null) {
      return;
    }
    respondingActionRef.current = action;
    setRespondingAction(action);
    announceForAccessibility(
      action === "approve" ? approvalLabels.approving : approvalLabels.rejecting,
    );
    try {
      const sent = await respond();
      if (sent) {
        announceForAccessibility(
          action === "approve" ? approvalLabels.approved : approvalLabels.rejected,
        );
      }
    } catch {
      announceForAccessibility(
        action === "approve" ? approvalLabels.approvalFailed : approvalLabels.rejectionFailed,
      );
    } finally {
      respondingActionRef.current = null;
      setRespondingAction(null);
    }
  }

  return (
    <View
      ref={focusRef}
      accessibilityLabel={
        request.kind === "approval"
          ? `${isSandboxEscalation ? "Full access required. This command is blocked by the sandbox" : "Approval needed"}. ${request.command}. ${approvalDetail}`
          : `Question from Cowork. ${request.question}`
      }
      accessibilityLiveRegion="assertive"
      accessibilityState={{ busy: isResponding }}
      collapsable={false}
      style={{
        gap: 12,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: isApproval ? alpha(toneAccent, 0.4) : theme.border,
        backgroundColor: isApproval
          ? isSandboxEscalation
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
          ? isSandboxEscalation
            ? "Full access required"
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
          {categoryLabel ? (
            <Text selectable style={{ color: toneAccent, fontSize: 13, fontWeight: "600" }}>
              {categoryLabel}
            </Text>
          ) : null}
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            {approvalDetail}
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
                backgroundColor: pressed ? theme.primaryPressed : theme.primary,
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
            disabled={isResponding}
            onPress={() => {
              void respondToApproval("approve", onApprove);
            }}
            accessibilityRole="button"
            accessibilityLabel={
              respondingAction === "approve" ? approvalLabels.approving : approvalLabels.approve
            }
            accessibilityState={{
              busy: respondingAction === "approve",
              disabled: isResponding,
            }}
            style={({ pressed }) => ({
              minHeight: minimumTouchTarget(),
              justifyContent: "center",
              borderRadius: radius.md,
              borderCurve: "continuous",
              backgroundColor: pressed ? theme.primaryPressed : theme.primary,
              paddingHorizontal: 16,
              paddingVertical: 10,
            })}
          >
            <Text style={{ color: theme.primaryText, fontWeight: "600" }}>
              {respondingAction === "approve"
                ? isSandboxEscalation
                  ? "Starting…"
                  : "Approving…"
                : isSandboxEscalation
                  ? "Run with full access"
                  : "Approve"}
            </Text>
          </Pressable>
          <Pressable
            disabled={isResponding}
            onPress={() => {
              void respondToApproval("reject", onReject);
            }}
            accessibilityRole="button"
            accessibilityLabel={
              respondingAction === "reject" ? approvalLabels.rejecting : approvalLabels.reject
            }
            accessibilityState={{
              busy: respondingAction === "reject",
              disabled: isResponding,
            }}
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
            <Text style={{ color: theme.danger, fontWeight: "600" }}>
              {respondingAction === "reject"
                ? isSandboxEscalation
                  ? "Keeping blocked…"
                  : "Declining…"
                : isSandboxEscalation
                  ? "Keep blocked"
                  : "Decline"}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
