import { openAiNativeConnectorsEventSchema } from "../../../../src/shared/openaiNativeConnectors";

export * from "../../../../src/shared/openaiNativeConnectors";

export const openAiNativeConnectorSchema =
  openAiNativeConnectorsEventSchema.shape.connectors.element;

export type OpenAiNativeConnectorConfigEntry = {
  enabled: boolean;
};
