import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import { useSkillsStore } from "@/features/cowork/skillsStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { isWorkspaceConnectionReady } from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

export default function SkillsScreen() {
  const theme = useAppTheme();
  const skills = useSkillsStore((s) => s.skills);
  const installations = useSkillsStore((s) => s.installations);
  const effectiveInstallations = useSkillsStore((s) => s.effectiveInstallations);
  const installPreview = useSkillsStore((s) => s.installPreview);
  const installationContentById = useSkillsStore((s) => s.installationContentById);
  const updateChecksByInstallationId = useSkillsStore((s) => s.updateChecksByInstallationId);
  const loading = useSkillsStore((s) => s.loading);
  const error = useSkillsStore((s) => s.error);
  const fetchSkills = useSkillsStore((s) => s.fetchSkills);
  const previewInstall = useSkillsStore((s) => s.previewInstall);
  const installSkill = useSkillsStore((s) => s.installSkill);
  const readInstallation = useSkillsStore((s) => s.readInstallation);
  const enableInstallation = useSkillsStore((s) => s.enableInstallation);
  const disableInstallation = useSkillsStore((s) => s.disableInstallation);
  const deleteInstallation = useSkillsStore((s) => s.deleteInstallation);
  const updateInstallation = useSkillsStore((s) => s.updateInstallation);
  const copyInstallation = useSkillsStore((s) => s.copyInstallation);
  const checkInstallationUpdate = useSkillsStore((s) => s.checkInstallationUpdate);
  const mutationPending = useSkillsStore((s) => s.mutationPending);
  const isConnected = usePairingStore((s) => isWorkspaceConnectionReady(s.connectionState));
  const [sourceInput, setSourceInput] = useState("");
  const [targetScope, setTargetScope] = useState<"project" | "global">("project");

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
      <SectionCard
        title="Workspace skills"
        description="Install from skills.sh, GitHub, or local paths, then inspect what is actually effective in the active workspace."
      >
        <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
          This is the same managed skill surface the desktop control session exposes, now reachable directly from a top-level mobile page.
        </Text>
      </SectionCard>

      {loading && skills.length === 0 ? (
        <View style={{ padding: 40, alignItems: "center" }}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : null}

      <SectionCard title="Install skill" description="Preview or install from skills.sh, GitHub, or a local path.">
        <View style={{ gap: 10 }}>
          <TextInput
            value={sourceInput}
            onChangeText={setSourceInput}
            placeholder="skills.sh slug, GitHub URL, or local path"
            placeholderTextColor={theme.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              borderRadius: 14,
              borderWidth: 1,
              borderColor: theme.border,
              backgroundColor: theme.surfaceMuted,
              color: theme.text,
              paddingHorizontal: 12,
              paddingVertical: 10,
              fontSize: 14,
            }}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {(["project", "global"] as const).map((scope) => (
              <Pressable
                key={scope}
                onPress={() => setTargetScope(scope)}
                style={{
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: targetScope === scope ? theme.primary : theme.border,
                  backgroundColor: targetScope === scope ? theme.primary : "transparent",
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                }}
              >
                <Text style={{ color: targetScope === scope ? theme.primaryText : theme.text, fontWeight: "700" }}>
                  {scope === "project" ? "Workspace" : "User"}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Pressable
              onPress={() => {
                if (!sourceInput.trim()) return;
                void previewInstall(sourceInput.trim(), targetScope);
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
              <Text style={{ color: theme.text, fontWeight: "700", fontSize: 13 }}>Preview</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (!sourceInput.trim()) return;
                void installSkill(sourceInput.trim(), targetScope);
                setSourceInput("");
              }}
              disabled={Boolean(mutationPending.install)}
              style={({ pressed }) => ({
                borderRadius: 999,
                backgroundColor: pressed ? theme.accent : theme.primary,
                paddingHorizontal: 14,
                paddingVertical: 9,
              })}
            >
              <Text style={{ color: theme.primaryText, fontWeight: "700", fontSize: 13 }}>
                {mutationPending.install ? "Installing..." : "Install"}
              </Text>
            </Pressable>
          </View>
        </View>
      </SectionCard>

      {installPreview ? (
        <SectionCard title="Install preview" description={`${installPreview.candidates.length} candidate skills`}>
          <View style={{ gap: 8 }}>
            {installPreview.warnings.map((warning) => (
              <Text key={warning} style={{ color: theme.warning, fontSize: 13, lineHeight: 18 }}>
                {warning}
              </Text>
            ))}
            {installPreview.candidates.map((candidate) => (
              <View
                key={candidate.relativeRootPath}
                style={{
                  gap: 4,
                  borderRadius: 16,
                  borderCurve: "continuous",
                  borderWidth: 1,
                  borderColor: theme.borderMuted,
                  backgroundColor: theme.surfaceElevated,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                }}
              >
                <Text style={{ color: theme.text, fontSize: 14, fontWeight: "700" }}>{candidate.name}</Text>
                <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}>{candidate.description}</Text>
                <Text style={{ color: theme.textTertiary, fontSize: 12 }}>
                  {candidate.wouldBeEffective ? "Becomes active" : "Installed but shadowed"}
                </Text>
              </View>
            ))}
          </View>
        </SectionCard>
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

      {installations.length > 0 ? (
        <SectionCard title="Installations" description={`${installations.length} managed skill installs`}>
          <View style={{ gap: 10 }}>
            {installations.map((installation) => {
              const updateCheck = updateChecksByInstallationId[installation.installationId];
              const content = installationContentById[installation.installationId];
              const copyScope = installation.scope === "global" ? "project" : "global";
              return (
                <View
                  key={installation.installationId}
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
                      <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>{installation.name}</Text>
                      {installation.description ? (
                        <Text numberOfLines={2} style={{ color: theme.textSecondary, fontSize: 13 }}>
                          {installation.description}
                        </Text>
                      ) : null}
                    </View>
                    <StatusPill label={installation.state} tone={installation.effective ? "success" : "neutral"} />
                  </View>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                    <StatusPill label={installation.scope} tone="neutral" />
                    {installation.effective ? <StatusPill label="effective" tone="primary" /> : null}
                    <Pressable
                      onPress={() => {
                        void (installation.enabled
                          ? disableInstallation(installation.installationId)
                          : enableInstallation(installation.installationId));
                      }}
                      style={({ pressed }) => ({
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: theme.border,
                        backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                      })}
                    >
                      <Text style={{ color: theme.text, fontSize: 12, fontWeight: "600" }}>
                        {installation.enabled ? "Disable" : "Enable"}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        void readInstallation(installation.installationId);
                      }}
                      style={({ pressed }) => ({
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: theme.border,
                        backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                      })}
                    >
                      <Text style={{ color: theme.text, fontSize: 12, fontWeight: "600" }}>Inspect</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        void checkInstallationUpdate(installation.installationId);
                      }}
                      style={({ pressed }) => ({
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: theme.border,
                        backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                      })}
                    >
                      <Text style={{ color: theme.text, fontSize: 12, fontWeight: "600" }}>Check update</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        void copyInstallation(installation.installationId, copyScope);
                      }}
                      style={({ pressed }) => ({
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: theme.border,
                        backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                      })}
                    >
                      <Text style={{ color: theme.text, fontSize: 12, fontWeight: "600" }}>
                        Copy to {copyScope === "project" ? "workspace" : "user"}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        void deleteInstallation(installation.installationId);
                      }}
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
                  {updateCheck ? (
                    <View style={{ gap: 4 }}>
                      <Text style={{ color: updateCheck.canUpdate ? theme.success : theme.textSecondary, fontSize: 12, fontWeight: "600" }}>
                        {updateCheck.canUpdate ? "Update available" : updateCheck.reason ?? "Up to date"}
                      </Text>
                      {updateCheck.canUpdate ? (
                        <Pressable
                          onPress={() => {
                            void updateInstallation(installation.installationId);
                          }}
                          style={({ pressed }) => ({
                            alignSelf: "flex-start",
                            borderRadius: 999,
                            backgroundColor: pressed ? theme.accent : theme.primary,
                            paddingHorizontal: 10,
                            paddingVertical: 5,
                          })}
                        >
                          <Text style={{ color: theme.primaryText, fontSize: 12, fontWeight: "700" }}>Update now</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ) : null}
                  {content ? (
                    <Text selectable numberOfLines={10} style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 18 }}>
                      {content}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        </SectionCard>
      ) : !loading ? (
        <SectionCard title="No installations" description="No managed skills are installed in this workspace yet." />
      ) : null}

      {effectiveInstallations.length > 0 ? (
        <SectionCard title="Effective skills" description={`${effectiveInstallations.length} active skills currently shape the workspace prompt.`}>
          <View style={{ gap: 8 }}>
            {effectiveInstallations.map((installation) => (
              <View
                key={`effective:${installation.installationId}`}
                style={{
                  gap: 4,
                  borderRadius: 16,
                  borderCurve: "continuous",
                  borderWidth: 1,
                  borderColor: theme.borderMuted,
                  backgroundColor: theme.surfaceElevated,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                }}
              >
                <Text style={{ color: theme.text, fontSize: 14, fontWeight: "700" }}>{installation.name}</Text>
                <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}>{installation.description}</Text>
              </View>
            ))}
          </View>
        </SectionCard>
      ) : skills.length > 0 ? (
        <SectionCard title="Effective skills" description={`${skills.length} skills resolved in the current workspace.`}>
          <View style={{ gap: 8 }}>
            {skills.map((skill) => (
              <View
                key={skill.name}
                style={{
                  gap: 4,
                  borderRadius: 16,
                  borderCurve: "continuous",
                  borderWidth: 1,
                  borderColor: theme.borderMuted,
                  backgroundColor: theme.surfaceElevated,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                }}
              >
                <Text style={{ color: theme.text, fontSize: 14, fontWeight: "700" }}>{skill.name}</Text>
                <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}>{skill.description}</Text>
              </View>
            ))}
          </View>
        </SectionCard>
      ) : null}
    </Screen>
  );
}
