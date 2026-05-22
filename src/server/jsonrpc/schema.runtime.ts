import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
} from "../../shared/jsonrpcControlSchemas";

export const jsonRpcRuntimeRequestSchemas = {
  "cowork/runtime/libreoffice/check":
    jsonRpcControlRequestSchemas["cowork/runtime/libreoffice/check"],
} as const;

export const jsonRpcRuntimeResultSchemas = {
  "cowork/runtime/libreoffice/check":
    jsonRpcControlResultSchemas["cowork/runtime/libreoffice/check"],
} as const;
