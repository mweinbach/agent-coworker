import type { ServerEvent } from "../server/protocol";

export type ParsedCommand =
  | { type: "help" | "exit" | "new" | "restart" | "tools" | "sessions" }
  | { type: "model" | "provider" | "connect" | "cwd" | "resume"; arg: string }
  | { type: "unknown"; name: string; arg: string }
  | { type: "message"; arg: string };

export type ProviderAuthMethod = Extract<ServerEvent, { type: "provider_auth_methods" }>["methods"][string][number];

const DEFAULT_API_AUTH_METHOD: ProviderAuthMethod = { id: "api_key", type: "api", label: "API key" };

export function parseReplInput(input: string): ParsedCommand {
  const line = input.trim();
  if (!line) return { type: "message", arg: "" };
  if (!line.startsWith("/")) return { type: "message", arg: line };

  const [cmd = "", ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "help":
    case "exit":
    case "new":
    case "restart":
    case "tools":
    case "sessions":
      return { type: cmd };
    case "model":
    case "provider":
    case "connect":
    case "cwd":
    case "resume":
      return { type: cmd, arg };
    default:
      return { type: "unknown", name: cmd, arg };
  }
}

export function normalizeProviderAuthMethods(methods: ProviderAuthMethod[] | undefined): ProviderAuthMethod[] {
  if (methods && methods.length > 0) return methods;
  return [DEFAULT_API_AUTH_METHOD];
}

export function resolveProviderAuthMethodSelection(
  methods: ProviderAuthMethod[],
  rawSelection: string
): ProviderAuthMethod | null {
  if (methods.length === 0) return null;

  const trimmed = rawSelection.trim();
  if (!trimmed) return methods[0] ?? null;

  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= methods.length) {
    return methods[asNumber - 1] ?? null;
  }

  const byId = methods.find((method) => method.id.toLowerCase() === trimmed.toLowerCase());
  return byId ?? null;
}
