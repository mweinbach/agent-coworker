import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
  providerAuthChallengeEventSchema,
  providerAuthMethodsEventSchema,
  providerAuthResultEventSchema,
  providerCatalogEventSchema,
  providerStatusEventSchema,
} from "../../shared/jsonrpcControlSchemas";

export const jsonRpcProviderRequestSchemas = {
  "cowork/provider/catalog/read": jsonRpcControlRequestSchemas["cowork/provider/catalog/read"],
  "cowork/provider/authMethods/read": jsonRpcControlRequestSchemas["cowork/provider/authMethods/read"],
  "cowork/provider/status/refresh": jsonRpcControlRequestSchemas["cowork/provider/status/refresh"],
  "cowork/provider/auth/authorize": jsonRpcControlRequestSchemas["cowork/provider/auth/authorize"],
  "cowork/provider/auth/logout": jsonRpcControlRequestSchemas["cowork/provider/auth/logout"],
  "cowork/provider/auth/callback": jsonRpcControlRequestSchemas["cowork/provider/auth/callback"],
  "cowork/provider/auth/setApiKey": jsonRpcControlRequestSchemas["cowork/provider/auth/setApiKey"],
  "cowork/provider/auth/copyApiKey": jsonRpcControlRequestSchemas["cowork/provider/auth/copyApiKey"],
} as const;

export const jsonRpcProviderResultSchemas = {
  "cowork/provider/catalog/read": jsonRpcControlResultSchemas["cowork/provider/catalog/read"],
  "cowork/provider/authMethods/read": jsonRpcControlResultSchemas["cowork/provider/authMethods/read"],
  "cowork/provider/status/refresh": jsonRpcControlResultSchemas["cowork/provider/status/refresh"],
  "cowork/provider/auth/authorize": jsonRpcControlResultSchemas["cowork/provider/auth/authorize"],
  "cowork/provider/auth/logout": jsonRpcControlResultSchemas["cowork/provider/auth/logout"],
  "cowork/provider/auth/callback": jsonRpcControlResultSchemas["cowork/provider/auth/callback"],
  "cowork/provider/auth/setApiKey": jsonRpcControlResultSchemas["cowork/provider/auth/setApiKey"],
  "cowork/provider/auth/copyApiKey": jsonRpcControlResultSchemas["cowork/provider/auth/copyApiKey"],
} as const;
