import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
} from "../../shared/jsonrpcControlSchemas";

export const jsonRpcPluginsRequestSchemas = {
  "cowork/plugins/catalog/read": jsonRpcControlRequestSchemas["cowork/plugins/catalog/read"],
  "cowork/plugins/read": jsonRpcControlRequestSchemas["cowork/plugins/read"],
  "cowork/plugins/enable": jsonRpcControlRequestSchemas["cowork/plugins/enable"],
  "cowork/plugins/disable": jsonRpcControlRequestSchemas["cowork/plugins/disable"],
} as const;

export const jsonRpcPluginsResultSchemas = {
  "cowork/plugins/catalog/read": jsonRpcControlResultSchemas["cowork/plugins/catalog/read"],
  "cowork/plugins/read": jsonRpcControlResultSchemas["cowork/plugins/read"],
  "cowork/plugins/enable": jsonRpcControlResultSchemas["cowork/plugins/enable"],
  "cowork/plugins/disable": jsonRpcControlResultSchemas["cowork/plugins/disable"],
} as const;
