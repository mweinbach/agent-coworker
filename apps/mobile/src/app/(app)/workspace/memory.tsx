import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, TextInput, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import { useMemoryStore } from "@/features/cowork/memoryStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { isWorkspaceConnectionReady } from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

function ScopeFilter() {
  const theme = useAppTheme();
  const filterScope = useMemoryStore((s) => s.filterScope);
  const setFilterScope = useMemoryStore((s) => s.setFilterScope);
  const scopes = ["all", "workspace", "user"] as const;

  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      {scopes.map((scope) => (
        <Pressable
          key={scope}
          onPress={() => setFilterScope(scope)}
          style={{
            borderRadius: 999,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: scope === filterScope ? theme.primary : theme.border,
            backgroundColor: scope === filterScope ? theme.primary : "transparent",
            paddingHorizontal: 14,
            paddingVertical: 7,
          }}
        >
          <Text
            style={{
              color: scope === filterScope ? theme.primaryText : theme.text,
              fontSize: 13,
              fontWeight: "600",
              textTransform: "capitalize",
            }}
          >
            {scope}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export default function MemoryScreen() {
  const theme = useAppTheme();
  const entries = useMemoryStore((s) => s.entries);
  const loading = useMemoryStore((s) => s.loading);
  const error = useMemoryStore((s) => s.error);
  const filterScope = useMemoryStore((s) => s.filterScope);
  const fetchMemories = useMemoryStore((s) => s.fetchMemories);
  const upsertMemory = useMemoryStore((s) => s.upsertMemory);
  const deleteMemory = useMemoryStore((s) => s.deleteMemory);
  const isConnected = usePairingStore((s) => isWorkspaceConnectionReady(s.connectionState));
  const [editorOpen, setEditorOpen] = useState(false);
  const [draftScope, setDraftScope] = useState<"workspace" | "user">("workspace");
  const [draftId, setDraftId] = useState("");
  const [draftContent, setDraftContent] = useState("");

  useEffect(() => {
    if (isConnected) {
      void fetchMemories();
    }
  }, [isConnected, fetchMemories]);

  const filtered = filterScope === "all"
    ? entries
    : entries.filter((e) => e.scope === filterScope);

  const handleSave = async () => {
    if (!draftContent.trim()) return;
    await upsertMemory(draftScope, draftId.trim() || "hot", draftContent.trim());
    setDraftId("");
    setDraftContent("");
    setDraftScope("workspace");
    setEditorOpen(false);
  };

  const handleDelete = (entry: (typeof entries)[number]) => {
    Alert.alert("Delete memory?", `Remove this ${entry.scope} memory entry?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => void deleteMemory(entry.scope, entry.id),
      },
    ]);
  };

  const openEditor = (entry?: (typeof entries)[number]) => {
    if (entry) {
      setDraftScope(entry.scope);
      setDraftId(entry.id);
      setDraftContent(entry.content);
    } else {
      setDraftScope("workspace");
      setDraftId("");
      setDraftContent("");
    }
    setEditorOpen(true);
  };

  if (!isConnected) {
    return (
      <Screen scroll>
        <SectionCard title="Memory" description="Connect to a desktop to manage memory.">
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            Memory entries will load here once connected to a workspace.
          </Text>
        </SectionCard>
      </Screen>
    );
  }

  return (
    <Screen scroll contentStyle={{ gap: 18 }}>
      {loading && entries.length === 0 ? (
        <View style={{ padding: 40, alignItems: "center" }}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : null}

      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 4 }}>
        <ScopeFilter />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pressable
            onPress={() => {
              void fetchMemories();
            }}
            style={({ pressed }) => ({
              borderRadius: 999,
              borderWidth: 1,
              borderColor: theme.border,
              backgroundColor: pressed ? theme.surfaceMuted : "transparent",
              paddingHorizontal: 14,
              paddingVertical: 9,
            })}
          >
            <Text style={{ color: theme.text, fontWeight: "700", fontSize: 13 }}>Refresh</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              if (editorOpen) {
                setEditorOpen(false);
                setDraftId("");
                setDraftContent("");
                return;
              }
              openEditor();
            }}
            style={({ pressed }) => ({
              borderRadius: 999,
              backgroundColor: pressed ? theme.accent : theme.primary,
              paddingHorizontal: 14,
              paddingVertical: 9,
            })}
          >
            <Text style={{ color: theme.primaryText, fontWeight: "700", fontSize: 13 }}>
              {editorOpen ? "Cancel" : "Add"}
            </Text>
          </Pressable>
        </View>
      </View>

      {editorOpen ? (
        <SectionCard title="Memory editor" description="Blank IDs default to hot so the current workspace cache updates immediately.">
          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {(["workspace", "user"] as const).map((scope) => (
                <Pressable
                  key={scope}
                  onPress={() => setDraftScope(scope)}
                  style={{
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: scope === draftScope ? theme.primary : theme.border,
                    backgroundColor: scope === draftScope ? theme.primary : "transparent",
                    paddingHorizontal: 14,
                    paddingVertical: 7,
                  }}
                >
                  <Text
                    style={{
                      color: scope === draftScope ? theme.primaryText : theme.text,
                      fontSize: 13,
                      fontWeight: "600",
                      textTransform: "capitalize",
                    }}
                  >
                    {scope}
                  </Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              value={draftId}
              onChangeText={setDraftId}
              placeholder="Entry ID (defaults to hot)"
              placeholderTextColor={theme.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                borderRadius: 16,
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: theme.surfaceMuted,
                color: theme.text,
                paddingHorizontal: 12,
                paddingVertical: 10,
                fontSize: 14,
              }}
            />
            <TextInput
              value={draftContent}
              onChangeText={setDraftContent}
              placeholder="Memory content..."
              placeholderTextColor={theme.textTertiary}
              multiline
              style={{
                minHeight: 80,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: theme.surfaceMuted,
                color: theme.text,
                padding: 12,
                fontSize: 14,
                textAlignVertical: "top",
              }}
            />
            <Pressable
              onPress={() => void handleSave()}
              style={({ pressed }) => ({
                alignSelf: "flex-start",
                borderRadius: 999,
                backgroundColor: pressed ? theme.accent : theme.primary,
                paddingHorizontal: 16,
                paddingVertical: 11,
              })}
            >
              <Text style={{ color: theme.primaryText, fontWeight: "700" }}>Save</Text>
            </Pressable>
          </View>
        </SectionCard>
      ) : null}

      {error ? (
        <SectionCard title="Error" description={error} />
      ) : null}

      {filtered.length > 0 ? (
        <SectionCard title="Entries" description={`${filtered.length} memory entries`}>
          <View style={{ gap: 10 }}>
            {filtered.map((entry) => (
              <Pressable
                key={entry.id}
                style={{
                  gap: 6,
                  borderRadius: 18,
                  borderCurve: "continuous",
                  borderWidth: 1,
                  borderColor: theme.borderMuted,
                  backgroundColor: theme.surfaceElevated,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                }}
              >
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={{ color: theme.text, fontSize: 14, fontWeight: "600" }}>{entry.id}</Text>
                  <StatusPill label={entry.scope} tone={entry.scope === "workspace" ? "primary" : "neutral"} />
                </View>
                <Text
                  selectable
                  numberOfLines={4}
                  style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 19 }}
                >
                  {entry.content}
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <Pressable
                    onPress={() => openEditor(entry)}
                    style={({ pressed }) => ({
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: theme.border,
                      backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                    })}
                  >
                    <Text style={{ color: theme.text, fontSize: 12, fontWeight: "600" }}>Edit</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => handleDelete(entry)}
                    style={({ pressed }) => ({
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: theme.danger,
                      backgroundColor: pressed ? theme.dangerMuted : "transparent",
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                    })}
                  >
                    <Text style={{ color: theme.danger, fontSize: 12, fontWeight: "600" }}>Delete</Text>
                  </Pressable>
                </View>
              </Pressable>
            ))}
          </View>
        </SectionCard>
      ) : !loading && !editorOpen ? (
        <SectionCard title="No entries" description="No memory entries found for this filter." />
      ) : null}
    </Screen>
  );
}
