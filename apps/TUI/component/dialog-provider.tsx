import { createEffect, createMemo, createSignal } from "solid-js";
import { Dialog } from "../ui/dialog";
import { DialogPrompt } from "../ui/dialog-prompt";
import { DialogSelect, type SelectItem } from "../ui/dialog-select";
import { useDialog } from "../context/dialog";
import { useLocal } from "../context/local";
import { useSyncActions, useSyncState } from "../context/sync";
import { useTheme } from "../context/theme";

type AuthMethod = {
  id: string;
  type: "api" | "oauth";
  label: string;
  oauthMode?: "auto" | "code";
};

export function openProviderDialog(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <ProviderDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

export function openProviderDialogForProvider(dialog: ReturnType<typeof useDialog>, provider: string) {
  dialog.push(
    () => <ProviderDialog onDismiss={() => dialog.pop()} initialProvider={provider} />,
    () => {}
  );
}

function ProviderDialog(props: { onDismiss: () => void; initialProvider?: string }) {
  const theme = useTheme();
  const dialog = useDialog();
  const local = useLocal();
  const syncState = useSyncState();
  const syncActions = useSyncActions();
  const [provider, setProvider] = createSignal(props.initialProvider ?? "");
  const [method, setMethod] = createSignal<AuthMethod | null>(null);
  const [stage, setStage] = createSignal<"provider" | "method" | "api_key" | "oauth_auto" | "oauth_code" | "waiting">(props.initialProvider ? "method" : "provider");
  const [awaitingResult, setAwaitingResult] = createSignal(false);

  const providerItems = createMemo((): SelectItem[] => {
    if (syncState.providerCatalog.length > 0) {
      return syncState.providerCatalog.map((entry) => ({
        label: entry.name,
        value: entry.id,
        description: syncState.providerConnected.includes(entry.id) ? "Connected" : "Connect provider",
      }));
    }

    return local.providerNames().map((name) => ({
      label: name,
      value: name,
      description: "Connect provider",
    }));
  });

  const methodsForProvider = createMemo((): AuthMethod[] => {
    const selected = provider();
    if (!selected) return [];
    const fromSync = syncState.providerAuthMethods[selected];
    if (fromSync && fromSync.length > 0) return fromSync;

    const base: AuthMethod[] = [{ id: "api_key", type: "api", label: "API key" }];
    if (selected === "codex-cli" || selected === "claude-code") {
      base.unshift({ id: "oauth_cli", type: "oauth", label: "OAuth (CLI)", oauthMode: "auto" });
    }
    return base;
  });

  const matchingChallenge = createMemo(() => {
    const challenge = syncState.providerAuthChallenge;
    if (!challenge) return null;
    if (challenge.provider !== provider()) return null;
    if (challenge.methodId !== method()?.id) return null;
    return challenge.challenge;
  });

  const matchingResult = createMemo(() => {
    const result = syncState.providerAuthResult;
    if (!result) return null;
    if (result.provider !== provider()) return null;
    if (result.methodId !== method()?.id) return null;
    return result;
  });

  createEffect(() => {
    const result = matchingResult();
    if (!result || !awaitingResult()) return;
    setAwaitingResult(false);
    if (!result.ok) return;
    import("./dialog-model").then(({ openModelPicker }) => {
      props.onDismiss();
      openModelPicker(dialog, result.provider);
    });
  });

  const methodItems = createMemo((): SelectItem[] => {
    return methodsForProvider().map((item) => ({
      label: item.label,
      value: item.id,
      description: item.type === "oauth" ? "OAuth sign-in" : "Store API key",
    }));
  });

  const handleProviderSelect = (item: SelectItem) => {
    setProvider(item.value);
    setMethod(null);
    setStage("method");
    setAwaitingResult(false);
  };

  const handleMethodSelect = (item: SelectItem) => {
    const selected = methodsForProvider().find((m) => m.id === item.value);
    if (!selected) return;
    setMethod(selected);
    setAwaitingResult(false);
    if (selected.type === "api") {
      setStage("api_key");
      return;
    }
    syncActions.authorizeProviderAuth(provider(), selected.id);
    setStage(selected.oauthMode === "code" ? "oauth_code" : "oauth_auto");
  };

  if (stage() === "provider") {
    return (
      <DialogSelect
        items={providerItems()}
        onSelect={handleProviderSelect}
        onDismiss={props.onDismiss}
        title="Connect Provider"
        placeholder="Select a provider..."
      />
    );
  }

  if (stage() === "method") {
    return (
      <DialogSelect
        items={methodItems()}
        onSelect={handleMethodSelect}
        onDismiss={props.onDismiss}
        title={`Auth Method: ${provider()}`}
        placeholder="Select auth method..."
      />
    );
  }

  if (stage() === "api_key") {
    return (
      <DialogPrompt
        title={`API Key: ${provider()}`}
        placeholder="Paste API key and press Enter"
        onDismiss={props.onDismiss}
        onSubmit={(value) => {
          const selectedMethod = method();
          if (!selectedMethod) return;
          setAwaitingResult(true);
          setStage("waiting");
          syncActions.setProviderApiKey(provider(), selectedMethod.id, value);
        }}
      />
    );
  }

  if (stage() === "oauth_code") {
    return (
      <DialogPrompt
        title={`OAuth Code: ${provider()}`}
        placeholder="Paste authorization code"
        onDismiss={props.onDismiss}
        onSubmit={(value) => {
          const selectedMethod = method();
          if (!selectedMethod) return;
          setAwaitingResult(true);
          setStage("waiting");
          syncActions.callbackProviderAuth(provider(), selectedMethod.id, value);
        }}
      />
    );
  }

  if (stage() === "oauth_auto") {
    const challenge = matchingChallenge();
    const command = challenge?.command;
    const instructions = challenge?.instructions ?? "Complete OAuth in the provider CLI, then continue.";
    return (
      <DialogSelect
        items={[
          { label: "Continue", value: "continue", description: "Run callback after completing OAuth" },
          { label: "Cancel", value: "cancel", description: "Back out of this flow" },
        ]}
        onSelect={(item) => {
          if (item.value === "cancel") {
            props.onDismiss();
            return;
          }
          const selectedMethod = method();
          if (!selectedMethod) return;
          setAwaitingResult(true);
          setStage("waiting");
          syncActions.callbackProviderAuth(provider(), selectedMethod.id);
        }}
        onDismiss={props.onDismiss}
        title={command ? `OAuth: ${command}` : "OAuth: Continue"}
        placeholder={instructions}
      />
    );
  }

  const result = matchingResult();
  return (
    <Dialog onDismiss={props.onDismiss} width="55%">
      <box flexDirection="column" gap={1}>
        <text fg={theme.text}>
          <strong>Connecting {provider()}...</strong>
        </text>
        <text fg={theme.textMuted}>
          Waiting for provider authentication result.
        </text>
        {result && !result.ok ? (
          <text fg={theme.error}>{result.message}</text>
        ) : null}
        <text fg={theme.textMuted}>Press Escape to close</text>
      </box>
    </Dialog>
  );
}
