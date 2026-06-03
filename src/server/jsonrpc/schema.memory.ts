import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
} from "../../shared/jsonrpcControlSchemas";

export const jsonRpcMemoryRequestSchemas = {
  "cowork/memory/list": jsonRpcControlRequestSchemas["cowork/memory/list"],
  "cowork/memory/upsert": jsonRpcControlRequestSchemas["cowork/memory/upsert"],
  "cowork/memory/delete": jsonRpcControlRequestSchemas["cowork/memory/delete"],
  "cowork/memory/advanced/list": jsonRpcControlRequestSchemas["cowork/memory/advanced/list"],
  "cowork/memory/advanced/upsert": jsonRpcControlRequestSchemas["cowork/memory/advanced/upsert"],
  "cowork/memory/advanced/delete": jsonRpcControlRequestSchemas["cowork/memory/advanced/delete"],
  "cowork/memory/advanced/generate":
    jsonRpcControlRequestSchemas["cowork/memory/advanced/generate"],
} as const;

export const jsonRpcMemoryResultSchemas = {
  "cowork/memory/list": jsonRpcControlResultSchemas["cowork/memory/list"],
  "cowork/memory/upsert": jsonRpcControlResultSchemas["cowork/memory/upsert"],
  "cowork/memory/delete": jsonRpcControlResultSchemas["cowork/memory/delete"],
  "cowork/memory/advanced/list": jsonRpcControlResultSchemas["cowork/memory/advanced/list"],
  "cowork/memory/advanced/upsert": jsonRpcControlResultSchemas["cowork/memory/advanced/upsert"],
  "cowork/memory/advanced/delete": jsonRpcControlResultSchemas["cowork/memory/advanced/delete"],
  "cowork/memory/advanced/generate": jsonRpcControlResultSchemas["cowork/memory/advanced/generate"],
} as const;
