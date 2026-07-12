import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import { GroupedSection } from "@/components/pairing/grouped-list";
import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import {
  MAX_DYNAMIC_TYPE_MULTIPLIER,
  minimumTouchTarget,
  useAccessibilityAnnouncement,
  useReducedMotionEnabled,
} from "@/features/accessibility/mobile-accessibility";
import { type McpUpsertServer, useMcpStore } from "@/features/cowork/mcpStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { isWorkspaceConnectionReady } from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

type McpServerDraft = {
  name: string;
  transportType: "stdio" | "http" | "sse";
  command: string;
  args: string;
  cwd: string;
  url: string;
  required: boolean;
  authType: "none" | "api_key" | "oauth";
  headerName: string;
  prefix: string;
  oauthMode: "auto" | "code";
  scope: string;
  resource: string;
};

function emptyDraft(): McpServerDraft {
  return {
    name: "",
    transportType: "stdio",
    command: "",
    args: "",
    cwd: "",
    url: "",
    required: false,
    authType: "none",
    headerName: "",
    prefix: "",
    oauthMode: "auto",
    scope: "",
    resource: "",
  };
}

function draftFromServer(server: McpUpsertServer): McpServerDraft {
  return {
    name: server.name,
    transportType: server.transport.type,
    command: server.transport.type === "stdio" ? server.transport.command : "",
    args: server.transport.type === "stdio" ? (server.transport.args ?? []).join(" ") : "",
    cwd: server.transport.type === "stdio" ? (server.transport.cwd ?? "") : "",
    url: server.transport.type === "stdio" ? "" : server.transport.url,
    required: Boolean(server.required),
    authType: server.auth?.type ?? "none",
    headerName: server.auth?.type === "api_key" ? (server.auth.headerName ?? "") : "",
    prefix: server.auth?.type === "api_key" ? (server.auth.prefix ?? "") : "",
    oauthMode: server.auth?.type === "oauth" ? (server.auth.oauthMode ?? "auto") : "auto",
    scope: server.auth?.type === "oauth" ? (server.auth.scope ?? "") : "",
    resource: server.auth?.type === "oauth" ? (server.auth.resource ?? "") : "",
  };
}

function toServerConfig(draft: McpServerDraft): McpUpsertServer {
  return {
    name: draft.name.trim(),
    required: draft.required,
    transport:
      draft.transportType === "stdio"
        ? {
            type: "stdio",
            command: draft.command.trim(),
            ...(draft.args.trim()
              ? {
                  args: draft.args.split(/\s+/).filter(Boolean),
                }
              : {}),
            ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
          }
        : {
            type: draft.transportType,
            url: draft.url.trim(),
          },
    auth:
      draft.authType === "api_key"
        ? {
            type: "api_key",
            ...(draft.headerName.trim() ? { headerName: draft.headerName.trim() } : {}),
            ...(draft.prefix.trim() ? { prefix: draft.prefix.trim() } : {}),
          }
        : draft.authType === "oauth"
          ? {
              type: "oauth",
              oauthMode: draft.oauthMode,
              ...(draft.scope.trim() ? { scope: draft.scope.trim() } : {}),
              ...(draft.resource.trim() ? { resource: draft.resource.trim() } : {}),
            }
          : { type: "none" },
  };
}

function transportSummary(server: McpUpsertServer) {
  if (server.transport.type === "stdio") {
    return `${server.transport.command}${server.transport.args?.length ? ` ${server.transport.args.join(" ")}` : ""}`;
  }
  return server.transport.url;
}

export default function McpServersScreen() {
  const theme = useAppTheme();
  const servers = useMcpStore((s) => s.servers);
  const files = useMcpStore((s) => s.files);
  const warnings = useMcpStore((s) => s.warnings);
  const validationByName = useMcpStore((s) => s.validationByName);
  const loading = useMcpStore((s) => s.loading);
  const error = useMcpStore((s) => s.error);
  const fetchServers = useMcpStore((s) => s.fetchServers);
  const upsertServer = useMcpStore((s) => s.upsertServer);
  const validateServer = useMcpStore((s) => s.validateServer);
  const deleteServer = useMcpStore((s) => s.deleteServer);
  const authorizeServer = useMcpStore((s) => s.authorizeServer);
  const callbackServer = useMcpStore((s) => s.callbackServer);
  const setServerApiKey = useMcpStore((s) => s.setServerApiKey);
  const lastAuthChallenge = useMcpStore((s) => s.lastAuthChallenge);
  const lastAuthResult = useMcpStore((s) => s.lastAuthResult);
  const isConnected = usePairingStore((s) => isWorkspaceConnectionReady(s.connectionState));
  const [editorVisible, setEditorVisible] = useState(false);
  const [draft, setDraft] = useState<McpServerDraft>(emptyDraft());
  const [previousName, setPreviousName] = useState<string | undefined>(undefined);
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Record<string, string>>({});
  const [oauthCodeDrafts, setOauthCodeDrafts] = useState<Record<string, string>>({});
  const reducedMotionEnabled = useReducedMotionEnabled();
  useAccessibilityAnnouncement(error ?? (loading ? "Loading integrations" : null));

  useEffect(() => {
    if (isConnected) {
      void fetchServers();
    }
  }, [isConnected, fetchServers]);

  const handleDelete = (name: string) => {
    Alert.alert("Delete MCP server?", `Remove "${name}" from this workspace?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void deleteServer(name) },
    ]);
  };

  const openCreate = () => {
    setDraft(emptyDraft());
    setPreviousName(undefined);
    setEditorVisible(true);
  };

  const openEdit = (server: McpUpsertServer) => {
    setDraft(draftFromServer(server));
    setPreviousName(server.name);
    setEditorVisible(true);
  };

  const saveDraft = async () => {
    await upsertServer(toServerConfig(draft), previousName);
    setEditorVisible(false);
    setDraft(emptyDraft());
    setPreviousName(undefined);
  };

  if (!isConnected) {
    return (
      <Screen scroll>
        <SectionCard title="MCP Servers" description="Connect to a desktop to manage MCP servers.">
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            MCP server management will load here once connected to a workspace.
          </Text>
        </SectionCard>
      </Screen>
    );
  }

  return (
    <Screen scroll avoidKeyboard contentStyle={{ gap: 18 }}>
      <Modal
        visible={editorVisible}
        animationType={reducedMotionEnabled ? "none" : "slide"}
        presentationStyle="pageSheet"
        onRequestClose={() => setEditorVisible(false)}
        accessibilityViewIsModal
      >
        <KeyboardAvoidingView
          style={{ flex: 1, backgroundColor: theme.background }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            style={{ flex: 1, backgroundColor: theme.background }}
            contentContainerStyle={{ gap: 16, padding: 20 }}
            keyboardShouldPersistTaps="handled"
          >
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Text
                accessibilityRole="header"
                maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
                style={{ color: theme.text, fontSize: 22, fontWeight: "800" }}
              >
                {previousName ? "Edit integration" : "New integration"}
              </Text>
              <Pressable
                accessibilityLabel="Close integration editor"
                accessibilityRole="button"
                onPress={() => setEditorVisible(false)}
                style={{ minHeight: minimumTouchTarget(), justifyContent: "center" }}
              >
                <Text style={{ color: theme.primary, fontSize: 16, fontWeight: "700" }}>Close</Text>
              </Pressable>
            </View>

            <SectionCard title="Connection" description="Basic server transport and auth settings.">
              <View style={{ gap: 12 }}>
                <TextInput
                  accessibilityLabel="Integration name"
                  value={draft.name}
                  onChangeText={(value) => setDraft((state) => ({ ...state, name: value }))}
                  placeholder="Server name"
                  placeholderTextColor={theme.textTertiary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{
                    minHeight: minimumTouchTarget(),
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
                  {(["stdio", "http", "sse"] as const).map((transportType) => (
                    <Pressable
                      key={transportType}
                      accessibilityLabel={`${transportType} transport`}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: draft.transportType === transportType }}
                      onPress={() => setDraft((state) => ({ ...state, transportType }))}
                      style={{
                        minHeight: minimumTouchTarget(),
                        justifyContent: "center",
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor:
                          draft.transportType === transportType ? theme.primary : theme.border,
                        backgroundColor:
                          draft.transportType === transportType ? theme.primary : "transparent",
                        paddingHorizontal: 12,
                        paddingVertical: 7,
                      }}
                    >
                      <Text
                        style={{
                          color:
                            draft.transportType === transportType ? theme.primaryText : theme.text,
                          fontWeight: "700",
                        }}
                      >
                        {transportType}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {draft.transportType === "stdio" ? (
                  <>
                    <TextInput
                      accessibilityLabel="Integration command"
                      value={draft.command}
                      onChangeText={(value) => setDraft((state) => ({ ...state, command: value }))}
                      placeholder="Command"
                      placeholderTextColor={theme.textTertiary}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={{
                        minHeight: minimumTouchTarget(),
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
                    <TextInput
                      accessibilityLabel="Integration command arguments"
                      value={draft.args}
                      onChangeText={(value) => setDraft((state) => ({ ...state, args: value }))}
                      placeholder="Args (space separated)"
                      placeholderTextColor={theme.textTertiary}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={{
                        minHeight: minimumTouchTarget(),
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
                    <TextInput
                      accessibilityLabel="Integration working directory"
                      value={draft.cwd}
                      onChangeText={(value) => setDraft((state) => ({ ...state, cwd: value }))}
                      placeholder="Working directory (optional)"
                      placeholderTextColor={theme.textTertiary}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={{
                        minHeight: minimumTouchTarget(),
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
                  </>
                ) : (
                  <TextInput
                    accessibilityLabel="Integration URL"
                    value={draft.url}
                    onChangeText={(value) => setDraft((state) => ({ ...state, url: value }))}
                    placeholder="https://example.com/mcp"
                    placeholderTextColor={theme.textTertiary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{
                      minHeight: minimumTouchTarget(),
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
                )}

                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>
                    Required
                  </Text>
                  <Switch
                    accessibilityLabel="Integration required"
                    accessibilityRole="switch"
                    accessibilityState={{ checked: draft.required }}
                    value={draft.required}
                    onValueChange={(value) => setDraft((state) => ({ ...state, required: value }))}
                    trackColor={{ true: theme.primary, false: theme.surfaceMuted }}
                    ios_backgroundColor={theme.surfaceMuted}
                  />
                </View>
              </View>
            </SectionCard>

            <SectionCard
              title="Authentication"
              description="Optional API key or OAuth auth for this integration."
            >
              <View style={{ gap: 12 }}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {(["none", "api_key", "oauth"] as const).map((authType) => (
                    <Pressable
                      key={authType}
                      accessibilityLabel={`${authType} authentication`}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: draft.authType === authType }}
                      onPress={() => setDraft((state) => ({ ...state, authType }))}
                      style={{
                        minHeight: minimumTouchTarget(),
                        justifyContent: "center",
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: draft.authType === authType ? theme.primary : theme.border,
                        backgroundColor:
                          draft.authType === authType ? theme.primary : "transparent",
                        paddingHorizontal: 12,
                        paddingVertical: 7,
                      }}
                    >
                      <Text
                        style={{
                          color: draft.authType === authType ? theme.primaryText : theme.text,
                          fontWeight: "700",
                        }}
                      >
                        {authType}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {draft.authType === "api_key" ? (
                  <>
                    <TextInput
                      accessibilityLabel="API key header name"
                      value={draft.headerName}
                      onChangeText={(value) =>
                        setDraft((state) => ({ ...state, headerName: value }))
                      }
                      placeholder="Header name"
                      placeholderTextColor={theme.textTertiary}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={{
                        minHeight: minimumTouchTarget(),
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
                    <TextInput
                      accessibilityLabel="API key prefix"
                      value={draft.prefix}
                      onChangeText={(value) => setDraft((state) => ({ ...state, prefix: value }))}
                      placeholder="Prefix (optional)"
                      placeholderTextColor={theme.textTertiary}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={{
                        minHeight: minimumTouchTarget(),
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
                  </>
                ) : null}

                {draft.authType === "oauth" ? (
                  <>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      {(["auto", "code"] as const).map((oauthMode) => (
                        <Pressable
                          key={oauthMode}
                          accessibilityLabel={`${oauthMode} OAuth mode`}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: draft.oauthMode === oauthMode }}
                          onPress={() => setDraft((state) => ({ ...state, oauthMode }))}
                          style={{
                            minHeight: minimumTouchTarget(),
                            justifyContent: "center",
                            borderRadius: 999,
                            borderWidth: 1,
                            borderColor:
                              draft.oauthMode === oauthMode ? theme.primary : theme.border,
                            backgroundColor:
                              draft.oauthMode === oauthMode ? theme.primary : "transparent",
                            paddingHorizontal: 12,
                            paddingVertical: 7,
                          }}
                        >
                          <Text
                            style={{
                              color: draft.oauthMode === oauthMode ? theme.primaryText : theme.text,
                              fontWeight: "700",
                            }}
                          >
                            {oauthMode}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                    <TextInput
                      accessibilityLabel="OAuth scope"
                      value={draft.scope}
                      onChangeText={(value) => setDraft((state) => ({ ...state, scope: value }))}
                      placeholder="OAuth scope"
                      placeholderTextColor={theme.textTertiary}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={{
                        minHeight: minimumTouchTarget(),
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
                    <TextInput
                      accessibilityLabel="OAuth resource"
                      value={draft.resource}
                      onChangeText={(value) => setDraft((state) => ({ ...state, resource: value }))}
                      placeholder="OAuth resource"
                      placeholderTextColor={theme.textTertiary}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={{
                        minHeight: minimumTouchTarget(),
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
                  </>
                ) : null}
              </View>
            </SectionCard>

            <Pressable
              accessibilityLabel="Save integration"
              accessibilityRole="button"
              accessibilityState={{ disabled: !draft.name.trim() }}
              disabled={!draft.name.trim()}
              onPress={() => {
                void saveDraft();
              }}
              style={({ pressed }) => ({
                minHeight: minimumTouchTarget(),
                justifyContent: "center",
                borderRadius: 999,
                backgroundColor: pressed ? theme.accent : theme.primary,
                paddingHorizontal: 18,
                paddingVertical: 12,
              })}
            >
              <Text
                style={{
                  color: theme.primaryText,
                  fontSize: 15,
                  fontWeight: "700",
                  textAlign: "center",
                }}
              >
                Save integration
              </Text>
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      {loading && servers.length === 0 ? (
        <View style={{ padding: 40, alignItems: "center" }}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : null}

      {error ? <SectionCard title="Error" description={error} /> : null}

      <SectionCard
        title="Workspace integrations"
        description="Add, edit, validate, and migrate MCP servers."
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <Pressable
            accessibilityLabel="Add integration"
            accessibilityRole="button"
            onPress={openCreate}
            style={({ pressed }) => ({
              minHeight: minimumTouchTarget(),
              justifyContent: "center",
              borderRadius: 999,
              backgroundColor: pressed ? theme.accent : theme.primary,
              paddingHorizontal: 16,
              paddingVertical: 11,
            })}
          >
            <Text style={{ color: theme.primaryText, fontWeight: "700" }}>Add integration</Text>
          </Pressable>
        </View>
      </SectionCard>

      {warnings.length > 0 ? (
        <SectionCard
          title="Warnings"
          description="Some integration files or inherited servers need attention."
        >
          <View style={{ gap: 8 }}>
            {warnings.map((warning) => (
              <Text key={warning} style={{ color: theme.warning, fontSize: 13, lineHeight: 18 }}>
                {warning}
              </Text>
            ))}
          </View>
        </SectionCard>
      ) : null}

      {servers.length > 0 ? (
        <GroupedSection title="Configured servers" footer={`${servers.length} MCP servers`}>
          {servers.map((server, index) => {
            const validation = validationByName[server.name];
            const isLast = index === servers.length - 1;
            return (
              <View
                key={server.name}
                style={{
                  gap: 8,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
                  borderBottomColor: theme.borderMuted,
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700", flex: 1 }}>
                    {server.name}
                  </Text>
                  <StatusPill
                    label={server.authMode}
                    tone={
                      server.authMode === "error"
                        ? "danger"
                        : server.authMode === "oauth_pending"
                          ? "warning"
                          : "neutral"
                    }
                  />
                </View>
                <Text
                  selectable
                  maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
                  style={{ fontSize: 12, color: theme.textSecondary }}
                >
                  {transportSummary(server)}
                </Text>
                <Text style={{ color: theme.textTertiary, fontSize: 11 }}>
                  {server.source} {server.inherited ? "· inherited" : "· editable"}{" "}
                  {server.authMessage ? `· ${server.authMessage}` : ""}
                </Text>
                {validation ? (
                  <Text
                    style={{
                      color: validation.ok ? theme.success : theme.danger,
                      fontSize: 12,
                      fontWeight: "600",
                    }}
                  >
                    {validation.ok
                      ? `Validated${validation.toolCount ? ` · ${validation.toolCount} tools` : ""}`
                      : validation.message}
                  </Text>
                ) : null}
                {server.auth?.type === "api_key" ? (
                  <View style={{ gap: 8 }}>
                    <TextInput
                      accessibilityLabel={`API key for ${server.name}`}
                      value={apiKeyDrafts[server.name] ?? ""}
                      onChangeText={(value) => {
                        setApiKeyDrafts((state) => ({ ...state, [server.name]: value }));
                      }}
                      placeholder="Set API key"
                      placeholderTextColor={theme.textTertiary}
                      secureTextEntry
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={{
                        minHeight: minimumTouchTarget(),
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
                    <Pressable
                      accessibilityLabel={`Save API key for ${server.name}`}
                      accessibilityRole="button"
                      accessibilityState={{
                        disabled: !apiKeyDrafts[server.name]?.trim(),
                      }}
                      disabled={!apiKeyDrafts[server.name]?.trim()}
                      onPress={() => {
                        const nextValue = apiKeyDrafts[server.name]?.trim();
                        if (!nextValue) return;
                        void setServerApiKey(server.name, nextValue);
                        setApiKeyDrafts((state) => ({ ...state, [server.name]: "" }));
                      }}
                      style={({ pressed }) => ({
                        minHeight: minimumTouchTarget(),
                        justifyContent: "center",
                        alignSelf: "flex-start",
                        borderRadius: 999,
                        backgroundColor: pressed ? theme.accent : theme.primary,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                      })}
                    >
                      <Text style={{ color: theme.primaryText, fontWeight: "700", fontSize: 13 }}>
                        Save key
                      </Text>
                    </Pressable>
                  </View>
                ) : null}

                {server.auth?.type === "oauth" ? (
                  <View style={{ gap: 8 }}>
                    <Pressable
                      accessibilityLabel={`Authenticate ${server.name}`}
                      accessibilityRole="button"
                      onPress={() => {
                        void authorizeServer(server.name);
                      }}
                      style={({ pressed }) => ({
                        minHeight: minimumTouchTarget(),
                        justifyContent: "center",
                        alignSelf: "flex-start",
                        borderRadius: 999,
                        backgroundColor: pressed ? theme.accent : theme.primary,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                      })}
                    >
                      <Text style={{ color: theme.primaryText, fontWeight: "700", fontSize: 13 }}>
                        Authenticate
                      </Text>
                    </Pressable>
                    {lastAuthChallenge?.name === server.name ? (
                      <View style={{ gap: 8 }}>
                        <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}>
                          {lastAuthChallenge.instructions}
                        </Text>
                        {lastAuthChallenge.url ? (
                          <Text selectable style={{ color: theme.text, fontSize: 13 }}>
                            {lastAuthChallenge.url}
                          </Text>
                        ) : null}
                        <TextInput
                          accessibilityLabel={`OAuth code for ${server.name}`}
                          value={oauthCodeDrafts[server.name] ?? ""}
                          onChangeText={(value) => {
                            setOauthCodeDrafts((state) => ({ ...state, [server.name]: value }));
                          }}
                          placeholder="Paste code if prompted"
                          placeholderTextColor={theme.textTertiary}
                          autoCapitalize="none"
                          autoCorrect={false}
                          style={{
                            minHeight: minimumTouchTarget(),
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
                        <Pressable
                          accessibilityLabel={`Submit OAuth code for ${server.name}`}
                          accessibilityRole="button"
                          accessibilityState={{
                            disabled: !oauthCodeDrafts[server.name]?.trim(),
                          }}
                          disabled={!oauthCodeDrafts[server.name]?.trim()}
                          onPress={() => {
                            void callbackServer(server.name, oauthCodeDrafts[server.name]);
                            setOauthCodeDrafts((state) => ({ ...state, [server.name]: "" }));
                          }}
                          style={({ pressed }) => ({
                            minHeight: minimumTouchTarget(),
                            justifyContent: "center",
                            alignSelf: "flex-start",
                            borderRadius: 999,
                            borderWidth: 1,
                            borderColor: theme.border,
                            backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                          })}
                        >
                          <Text style={{ color: theme.text, fontWeight: "700", fontSize: 13 }}>
                            Complete auth
                          </Text>
                        </Pressable>
                      </View>
                    ) : null}
                    {lastAuthResult?.name === server.name ? (
                      <Text
                        style={{
                          color: lastAuthResult.ok ? theme.success : theme.danger,
                          fontSize: 13,
                          fontWeight: "600",
                        }}
                      >
                        {lastAuthResult.message}
                      </Text>
                    ) : null}
                  </View>
                ) : null}

                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Pressable
                    accessibilityLabel={`Edit ${server.name}`}
                    accessibilityRole="button"
                    onPress={() => openEdit(server)}
                    hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                    style={({ pressed }) => ({
                      minHeight: minimumTouchTarget(),
                      justifyContent: "center",
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
                    accessibilityLabel={`Validate ${server.name}`}
                    accessibilityRole="button"
                    onPress={() => void validateServer(server.name)}
                    hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                    style={({ pressed }) => ({
                      minHeight: minimumTouchTarget(),
                      justifyContent: "center",
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: theme.border,
                      backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                    })}
                  >
                    <Text style={{ color: theme.text, fontSize: 12, fontWeight: "600" }}>
                      Validate
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel={`Delete ${server.name}`}
                    accessibilityRole="button"
                    onPress={() => handleDelete(server.name)}
                    hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                    style={({ pressed }) => ({
                      minHeight: minimumTouchTarget(),
                      justifyContent: "center",
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: theme.danger,
                      backgroundColor: pressed ? theme.dangerMuted : "transparent",
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                    })}
                  >
                    <Text style={{ color: theme.danger, fontSize: 12, fontWeight: "600" }}>
                      Delete
                    </Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </GroupedSection>
      ) : !loading ? (
        <SectionCard
          title="No servers"
          description="No MCP servers configured for this workspace."
        />
      ) : null}

      {files.length > 0 ? (
        <SectionCard
          title="Config files"
          description="Workspace and inherited integration files that contributed to this view."
        >
          <View style={{ gap: 8 }}>
            {files.map((file) => (
              <Text
                key={`${file.source}:${file.path}`}
                selectable
                style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}
              >
                {file.source}: {file.path} {file.parseError ? `· ${file.parseError}` : ""}
              </Text>
            ))}
          </View>
        </SectionCard>
      ) : null}
    </Screen>
  );
}
