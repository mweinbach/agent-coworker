import type { MCPServerConfig } from "../../../lib/wsProtocol";

export type DraftState = {
  name: string;
  transportType: "stdio" | "http" | "sse";
  command: string;
  args: string;
  cwd: string;
  url: string;
  required: boolean;
  retries: string;
  authType: "none" | "api_key" | "oauth";
  headerName: string;
  prefix: string;
  keyId: string;
  scope: string;
  resource: string;
  oauthMode: "auto" | "code";
  existingTransport: MCPServerConfig["transport"] | null;
};

const SIMPLE_ARG_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function defaultDraftState(): DraftState {
  return {
    name: "",
    transportType: "stdio",
    command: "",
    args: "",
    cwd: "",
    url: "",
    required: false,
    retries: "",
    authType: "none",
    headerName: "",
    prefix: "",
    keyId: "",
    scope: "",
    resource: "",
    oauthMode: "auto",
    existingTransport: null,
  };
}

export function toBool(checked: boolean | "indeterminate") {
  return checked === true;
}

function quoteArg(value: string): string {
  if (value.length === 0) return "\"\"";
  if (SIMPLE_ARG_RE.test(value)) return value;
  return `"${value.replace(/[\\$`"]/g, "\\$&")}"`;
}

function formatArgs(args: string[] | undefined): string {
  if (!args || args.length === 0) return "";
  return args.map(quoteArg).join(" ");
}

export function parseArgs(value: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quotedBy: "\"" | "'" | null = null;
  let tokenStarted = false;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i] ?? "";

    if (!quotedBy && /\s/.test(ch)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    if (!quotedBy && (ch === "\"" || ch === "'")) {
      quotedBy = ch;
      tokenStarted = true;
      continue;
    }

    if (quotedBy === "'" && ch === "'") {
      quotedBy = null;
      continue;
    }

    if (quotedBy === "\"" && ch === "\"") {
      quotedBy = null;
      continue;
    }

    if (ch === "\\") {
      const next = value[i + 1];
      if (next === undefined) {
        current += "\\";
        tokenStarted = true;
        continue;
      }

      if (!quotedBy || quotedBy === "\"") {
        if (!quotedBy || next === "\"" || next === "\\" || next === "$" || next === "`" || /\s/.test(next)) {
          current += next;
          tokenStarted = true;
          i += 1;
          continue;
        }
      }
    }

    current += ch;
    tokenStarted = true;
  }

  if (tokenStarted) tokens.push(current);
  return tokens.length > 0 ? tokens : undefined;
}

function nonEmptyStringMap(value: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  return Object.keys(value).length > 0 ? { ...value } : undefined;
}

export function formatTransport(server: MCPServerConfig): string {
  if (server.transport.type === "stdio") {
    const args = server.transport.args?.length ? ` ${server.transport.args.join(" ")}` : "";
    return `stdio: ${server.transport.command}${args}`;
  }
  return `${server.transport.type}: ${server.transport.url}`;
}

export function sourceLabel(source: string): string {
  if (source === "workspace") return "workspace";
  if (source === "user") return "user";
  if (source === "system") return "system";
  if (source === "workspace_legacy") return "workspace legacy";
  if (source === "user_legacy") return "user legacy";
  return source;
}

export function draftFromServer(server: MCPServerConfig): DraftState {
  const base: DraftState = {
    name: server.name,
    transportType: server.transport.type,
    command: "",
    args: "",
    cwd: "",
    url: "",
    required: server.required === true,
    retries: typeof server.retries === "number" ? String(server.retries) : "",
    authType: server.auth?.type ?? "none",
    headerName: "",
    prefix: "",
    keyId: "",
    scope: "",
    resource: "",
    oauthMode: "auto",
    existingTransport: server.transport,
  };

  if (server.transport.type === "stdio") {
    base.command = server.transport.command;
    base.args = formatArgs(server.transport.args);
    base.cwd = server.transport.cwd ?? "";
  } else {
    base.url = server.transport.url;
  }

  if (server.auth?.type === "api_key") {
    base.headerName = server.auth.headerName ?? "";
    base.prefix = server.auth.prefix ?? "";
    base.keyId = server.auth.keyId ?? "";
  }

  if (server.auth?.type === "oauth") {
    base.scope = server.auth.scope ?? "";
    base.resource = server.auth.resource ?? "";
    base.oauthMode = server.auth.oauthMode ?? "auto";
  }

  return base;
}

export function buildServerFromDraft(draft: DraftState): MCPServerConfig | null {
  const name = draft.name.trim();
  if (!name) return null;

  const transport = (() => {
    if (draft.transportType === "stdio") {
      const command = draft.command.trim();
      if (!command) return null;
      const args = parseArgs(draft.args);
      const env =
        draft.existingTransport?.type === "stdio" ? nonEmptyStringMap(draft.existingTransport.env) : undefined;
      return {
        type: "stdio" as const,
        command,
        ...(args ? { args } : {}),
        ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
        ...(env ? { env } : {}),
      };
    }

    const url = draft.url.trim();
    if (!url) return null;
    const headers =
      draft.existingTransport && draft.existingTransport.type !== "stdio"
        ? nonEmptyStringMap(draft.existingTransport.headers)
        : undefined;
    return {
      type: draft.transportType,
      url,
      ...(headers ? { headers } : {}),
    };
  })();
  if (!transport) return null;

  const retriesValue = draft.retries.trim();
  const retries = retriesValue.length > 0 ? Number(retriesValue) : undefined;
  const auth: MCPServerConfig["auth"] = (() => {
    if (draft.authType === "none") return { type: "none" };
    if (draft.authType === "api_key") {
      return {
        type: "api_key",
        ...(draft.headerName.trim() ? { headerName: draft.headerName.trim() } : {}),
        ...(draft.prefix.trim() ? { prefix: draft.prefix.trim() } : {}),
        ...(draft.keyId.trim() ? { keyId: draft.keyId.trim() } : {}),
      };
    }
    return {
      type: "oauth",
      ...(draft.scope.trim() ? { scope: draft.scope.trim() } : {}),
      ...(draft.resource.trim() ? { resource: draft.resource.trim() } : {}),
      oauthMode: draft.oauthMode,
    };
  })();

  return {
    name,
    transport,
    ...(draft.required ? { required: true } : {}),
    ...(typeof retries === "number" && Number.isFinite(retries) ? { retries } : {}),
    ...(auth ? { auth } : {}),
  };
}

export const __internal = {
  formatArgs,
  parseArgs,
  quoteArg,
};
