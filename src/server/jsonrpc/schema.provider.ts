import { pickJsonRpcControlSchemas } from "../../shared/jsonrpcControlSchemas";

const providerControlSchemas = pickJsonRpcControlSchemas([
  "cowork/provider/catalog/read",
  "cowork/provider/authMethods/read",
  "cowork/provider/status/refresh",
  "cowork/provider/codexAppServer/status",
  "cowork/provider/codexAppServer/update",
  "cowork/provider/lmstudio/local/status",
  "cowork/provider/lmstudio/local/start",
  "cowork/provider/auth/authorize",
  "cowork/provider/auth/logout",
  "cowork/provider/auth/callback",
  "cowork/provider/auth/setApiKey",
  "cowork/provider/auth/setConfig",
  "cowork/provider/auth/copyApiKey",
  "cowork/provider/customModel/add",
  "cowork/provider/customModel/delete",
  "cowork/provider/model/setEnabled",
  "cowork/provider/model/resetEnabled",
] as const);

export const jsonRpcProviderRequestSchemas = providerControlSchemas.requests;

export const jsonRpcProviderResultSchemas = providerControlSchemas.results;
