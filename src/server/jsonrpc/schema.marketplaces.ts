import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
} from "../../shared/jsonrpcControlSchemas";

export const jsonRpcMarketplacesRequestSchemas = {
  "cowork/marketplaces/read": jsonRpcControlRequestSchemas["cowork/marketplaces/read"],
  "cowork/marketplaces/detail": jsonRpcControlRequestSchemas["cowork/marketplaces/detail"],
  "cowork/marketplaces/add": jsonRpcControlRequestSchemas["cowork/marketplaces/add"],
  "cowork/marketplaces/remove": jsonRpcControlRequestSchemas["cowork/marketplaces/remove"],
} as const;

export const jsonRpcMarketplacesResultSchemas = {
  "cowork/marketplaces/read": jsonRpcControlResultSchemas["cowork/marketplaces/read"],
  "cowork/marketplaces/detail": jsonRpcControlResultSchemas["cowork/marketplaces/detail"],
  "cowork/marketplaces/add": jsonRpcControlResultSchemas["cowork/marketplaces/add"],
  "cowork/marketplaces/remove": jsonRpcControlResultSchemas["cowork/marketplaces/remove"],
} as const;
