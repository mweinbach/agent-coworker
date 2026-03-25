import { useEffect } from "react";
import { ActivityIndicator, Pressable, Switch, Text, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import { useSkillsStore } from "@/features/cowork/skillsStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { useAppTheme } from "@/theme/use-app-theme";

export default function SkillsScreen() {
  const theme = useAppTheme();
  const skills = useSkillsStore((s) => s.skills);
  const loading = useSkillsStore((s) => s.loading);
  const error = useSkillsStore((s) => s.error);
  const fetchSkills = useSkillsStore((s) => s.fetchSkills);
  const enableSkill = useSkillsStore((s) => s.enableSkill);
  const disableSkill = useSkillsStore((s) => s.disableSkill);
  const deleteSkill = useSkillsStore((s) => s.deleteSkill);
  const mutationPending = useSkillsStore((s) => s.mutationPending);
  const isConnected = usePairingStore((s) => s.connectionState.status === "connected");

  useEffect(() => {
    if (isConnected) {
      void fetchSkills();
    }
  }, [isConnected, fetchSkills]);

  if (!isConnected) {
    return (
      <Screen scroll>
        <SectionCard title="Skills" description="Connect to a desktop to manage skills.">
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            Skills catalog will load here once connected to a workspace.
          </Text>
        </SectionCard>
      </Screen>
    );
  }

  return (
    <Screen scroll contentStyle={{ gap: 18 }}>
      {loading && skills.length === 0 ? (
        <View style={{ padding: 40, alignItems: "center" }}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : null}

      {error ? (
        <SectionCard title="Error" description={error}>
          <Pressable
            onPress={() => void fetchSkills()}
            style={({ pressed }) => ({
              alignSelf: "flex-start",
              borderRadius: 999,
              backgroundColor: pressed ? theme.accent : theme.primary,
              paddingHorizontal: 16,
              paddingVertical: 11,
            })}
          >
            <Text style={{ color: theme.primaryText, fontWeight: "700" }}>Retry</Text>
          </Pressable>
        </SectionCard>
      ) : null}

      {skills.length > 0 ? (
        <SectionCard title="Installed skills" description={`${skills.length} skills configured`}>
          <View style={{ gap: 10 }}>
            {skills.map((skill) => (
              <View
                key={skill.name}
                style={{
                  gap: 8,
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
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>{skill.name}</Text>
                    {skill.description ? (
                      <Text numberOfLines={2} style={{ color: theme.textSecondary, fontSize: 13 }}>
                        {skill.description}
                      </Text>
                    ) : null}
                  </View>
                  <Switch
                    value={skill.enabled}
                    onValueChange={(value) => {
                      void (value ? enableSkill(skill.name) : disableSkill(skill.name));
                    }}
                    disabled={!!mutationPending[skill.name]}
                    trackColor={{ true: theme.primary }}
                  />
                </View>
                <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                  {skill.scope ? <StatusPill label={skill.scope} tone="neutral" /> : null}
                  <Pressable
                    onPress={() => void deleteSkill(skill.name)}
                    disabled={!!mutationPending[skill.name]}
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
              </View>
            ))}
          </View>
        </SectionCard>
      ) : !loading ? (
        <SectionCard title="No skills" description="No skills installed in this workspace yet." />
      ) : null}
    </Screen>
  );
}
