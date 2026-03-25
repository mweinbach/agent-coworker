import { Link } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";

import { useThreadStore } from "../../../features/cowork/threadStore";

export default function ThreadsTab() {
  const snapshots = useThreadStore((state) => state.snapshots);
  const threads = Object.values(snapshots).map((snapshot) => ({
    id: snapshot.sessionId,
    title: snapshot.title,
    preview:
      snapshot.feed.findLast((entry) => entry.kind === "message")?.text.slice(0, 80) ??
      "No messages yet.",
    updatedAtLabel: `Seq ${snapshot.lastEventSeq}`,
    feed: snapshot.feed,
    pendingPrompt: snapshot.hasPendingAsk || snapshot.hasPendingApproval,
  }));

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: "#0b1020" }}
      contentContainerStyle={{ gap: 16, padding: 20 }}
    >
      <View style={{ gap: 6 }}>
        <Text style={{ color: "#f8fafc", fontSize: 28, fontWeight: "700" }}>Threads</Text>
        <Text style={{ color: "#94a3b8", fontSize: 14 }}>
          Browse the shared Cowork transcript feed rendered from coworkSnapshot.feed.
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => {
          // Local draft creation happens once the JS protocol layer lands.
        }}
        style={{
          alignItems: "center",
          backgroundColor: "#2563eb",
          borderRadius: 14,
          paddingHorizontal: 16,
          paddingVertical: 14,
        }}
      >
        <Text style={{ color: "#eff6ff", fontSize: 15, fontWeight: "700" }}>Start local draft thread</Text>
      </Pressable>

      <View style={{ gap: 12 }}>
        {threads.map((thread) => {
          return (
            <Link key={thread.id} href={`/(app)/thread/${thread.id}`} asChild>
              <Pressable
                style={{
                  backgroundColor: "#111827",
                  borderColor: "#1f2937",
                  borderRadius: 18,
                  borderWidth: 1,
                  gap: 8,
                  padding: 16,
                }}
              >
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ color: "#f8fafc", flex: 1, fontSize: 16, fontWeight: "700" }}>
                    {thread.title}
                  </Text>
                  {thread.pendingPrompt ? (
                    <View
                      style={{
                        alignItems: "center",
                        backgroundColor: "#1e3a8a",
                        borderRadius: 999,
                        paddingHorizontal: 10,
                        paddingVertical: 4,
                      }}
                    >
                      <Text style={{ color: "#dbeafe", fontSize: 11, fontWeight: "700" }}>Awaiting input</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={{ color: "#94a3b8", fontSize: 13 }}>{thread.preview}</Text>
                <Text style={{ color: "#64748b", fontSize: 12 }}>
                  {thread.updatedAtLabel} • {thread.feed.length} feed items
                </Text>
              </Pressable>
            </Link>
          );
        })}
      </View>
    </ScrollView>
  );
}
