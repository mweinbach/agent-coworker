import { createEffect, createMemo, createSignal, Switch, Match, Show } from "solid-js";
import { Dialog } from "../ui/dialog";
import { DialogPrompt } from "../ui/dialog-prompt";
import { DialogSelect, type SelectItem } from "../ui/dialog-select";
import { useDialog } from "../context/dialog";
import { useLocal } from "../context/local";
import { useSyncActions, useSyncState } from "../context/sync";
import type { ProviderAuthChallengeState } from "../context/syncTypes";
import { useTheme } from "../context/theme";

type ProviderAuthChallengePayload = NonNullable<ProviderAuthChallengeState>["challenge"];

export type AuthMethod = {
  id: string;
  type: "api" | "oauth";
  label: string;
  oauthMode?: "auto" | "code";
};

export type ProviderDialogStage = "provider" | "method" | "api_key" | "oauth_code" | "waiting";

export function stageAfterAuthMethodSelection(selectedMethod: AuthMethod): ProviderDialogStage {
  if (selectedMethod.type === "api") return "api_key";
  if (selectedMethod.oauthMode === "code") return "oauth_code";
  return "method";
}

export function shouldStartAutoOauthCallback(opts: {
  selectedMethod: AuthMethod | null;
  currentChallenge: ProviderAuthChallengePayload | null;
  initialChallenge: ProviderAuthChallengePayload | null;
  handledChallenge: ProviderAuthChallengePayload | null;
  awaitingResult?: boolean;
}): boolean {
  if (opts.awaitingResult) return false;
  if (!opts.selectedMethod || opts.selectedMethod.type !== "oauth" || opts.selectedMethod.oauthMode === "code") {
    return false;
  }
  if (!opts.currentChallenge) return false;
  if (opts.currentChallenge === opts.handledChallenge) return false;
  return opts.currentChallenge !== opts.initialChallenge;
}

export function openProviderDialog(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <ProviderDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

export function openProviderDialogForProvider(dialog: ReturnType<typeof useDialog>, provider: string) {
  const normalized = provider.trim().toLowerCase();
  dialog.push(
    () => <ProviderDialog onDismiss={() => dialog.pop()} initialProvider={normalized} />,
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
  const [stage, setStage] = createSignal<ProviderDialogStage>(props.initialProvider ? "method" : "provider");
  const [awaitingResult, setAwaitingResult] = createSignal(false);
  const [pendingAutoOauthChallenge, setPendingAutoOauthChallenge] = createSignal<ProviderAuthChallengePayload | null>(null);
  const [handledAutoOauthChallenge, setHandledAutoOauthChallenge] = createSignal<ProviderAuthChallengePayload | null>(null);
  const [didAutoAdvanceInitial, setDidAutoAdvanceInitial] = createSignal(false);

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

  const getMethodsForProvider = (selected: string): AuthMethod[] => {
    if (!selected) return [];
    const fromSync = syncState.providerAuthMethods[selected];
    if (fromSync && fromSync.length > 0) return fromSync;

    const base: AuthMethod[] = [{ id: "api_key", type: "api", label: "API key" }];
    if (selected === "google") {
      base.push({ id: "exa_api_key", type: "api", label: "Exa API key (web search)" });
    }
    if (selected === "codex-cli") {
      base.unshift(
        { id: "oauth_cli", type: "oauth", label: "ChatGPT (browser)", oauthMode: "auto" }
      );
    }
    return base;
  };

  const methodsForProvider = createMemo((): AuthMethod[] => {
    const selected = provider();
    return getMethodsForProvider(selected);
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

  const getSavedApiKeyMask = (selectedProvider: string, methodId: string): string | null => {
    const status = syncState.providerStatuses.find((entry) => entry.provider === selectedProvider);
    const mask = status?.savedApiKeyMasks?.[methodId];
    if (typeof mask !== "string") return null;
    const trimmed = mask.trim();
    return trimmed ? trimmed : null;
  };

  const apiKeyPlaceholder = createMemo(() => {
    const selectedMethod = method();
    const mask = selectedMethod ? getSavedApiKeyMask(provider(), selectedMethod.id) : null;
    const isExa = selectedMethod?.id === "exa_api_key";
    if (!mask) {
      return isExa ? "Paste Exa API key and press Enter" : "Paste API key and press Enter";
    }
    return isExa
      ? `Saved (${mask}). Paste new Exa API key and press Enter`
      : `Saved (${mask}). Paste new API key and press Enter`;
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

  createEffect(() => {
    const selectedMethod = method();
    const challenge = matchingChallenge();
    if (!shouldStartAutoOauthCallback({
      selectedMethod,
      currentChallenge: challenge,
      initialChallenge: pendingAutoOauthChallenge(),
      handledChallenge: handledAutoOauthChallenge(),
      awaitingResult: awaitingResult(),
    })) return;

    setHandledAutoOauthChallenge(challenge);
    setPendingAutoOauthChallenge(null);
    setAwaitingResult(true);
    setStage("waiting");
    syncActions.callbackProviderAuth(provider(), selectedMethod.id);
  });

  const methodItems = createMemo((): SelectItem[] => {
    return methodsForProvider().map((item) => ({
      label: item.label,
      value: item.id,
      description:
        item.type === "oauth"
          ? "OAuth sign-in"
          : (() => {
              const mask = getSavedApiKeyMask(provider(), item.id);
              return mask ? `Saved (${mask})` : "Store API key";
            })(),
    }));
  });

  const beginMethodFlow = (selectedProvider: string, selectedMethod: AuthMethod) => {
    setMethod(selectedMethod);
    setAwaitingResult(false);
    setPendingAutoOauthChallenge(null);
    setHandledAutoOauthChallenge(null);
    const nextStage = stageAfterAuthMethodSelection(selectedMethod);
    setStage(nextStage);
    if (nextStage === "api_key") {
      return;
    }
    syncActions.authorizeProviderAuth(selectedProvider, selectedMethod.id);
    if (nextStage === "oauth_code") {
      return;
    }
    // Only advance auto OAuth once a fresh challenge confirms authorization succeeded.
    setPendingAutoOauthChallenge(matchingChallenge());
  };

  const handleProviderSelect = (item: SelectItem) => {
    const nextProvider = item.value;
    const nextMethods = getMethodsForProvider(nextProvider);
    setProvider(nextProvider);
    setAwaitingResult(false);
    setPendingAutoOauthChallenge(null);
    setHandledAutoOauthChallenge(null);

    if (nextMethods.length === 1) {
      beginMethodFlow(nextProvider, nextMethods[0]!);
      return;
    }

    setMethod(null);
    setStage("method");
  };

  createEffect(() => {
    if (!props.initialProvider || didAutoAdvanceInitial()) return;
    if (stage() !== "method") return;
    const selected = provider();
    if (!selected) return;

    const nextMethods = getMethodsForProvider(selected);
    if (nextMethods.length !== 1) return;

    setDidAutoAdvanceInitial(true);
    beginMethodFlow(selected, nextMethods[0]!);
  });

  const handleMethodSelect = (item: SelectItem) => {
    const selected = methodsForProvider().find((m) => m.id === item.value);
    if (!selected) return;
    beginMethodFlow(provider(), selected);
  };

  return (
    <Switch fallback={
      <Dialog onDismiss={props.onDismiss} width="55%">
        <box flexDirection="column" gap={1}>
          <text fg={theme.text}>
            <strong>Connecting {provider()}...</strong>
          </text>
          <text fg={theme.textMuted}>
            Waiting for provider authentication result.
          </text>
          <Show when={matchingResult() && !matchingResult()!.ok}>
            <text fg={theme.error}>{matchingResult()!.message}</text>
          </Show>
          <text fg={theme.textMuted}>Press Escape to close</text>
        </box>
      </Dialog>
    }>
      <Match when={stage() === "provider"}>
        <DialogSelect
          items={providerItems()}
          onSelect={handleProviderSelect}
          onDismiss={props.onDismiss}
          title="Connect Provider"
          placeholder="Select a provider..."
        />
      </Match>

      <Match when={stage() === "method"}>
        <DialogSelect
          items={methodItems()}
          onSelect={handleMethodSelect}
          onDismiss={props.onDismiss}
          title={`Auth Method: ${provider()}`}
          placeholder="Select auth method..."
        />
      </Match>

      <Match when={stage() === "api_key"}>
        <DialogPrompt
          title={`API Key: ${method()?.label ?? provider()}`}
          placeholder={apiKeyPlaceholder()}
          onDismiss={props.onDismiss}
          onSubmit={(value) => {
            const selectedMethod = method();
            if (!selectedMethod) return;
            setAwaitingResult(true);
            setStage("waiting");
            syncActions.setProviderApiKey(provider(), selectedMethod.id, value);
          }}
        />
      </Match>

      <Match when={stage() === "oauth_code"}>
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
      </Match>

    </Switch>
  );
}
