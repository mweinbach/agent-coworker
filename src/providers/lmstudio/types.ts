export type LmStudioLoadedInstance = {
  id: string;
  config: {
    context_length: number;
    eval_batch_size?: number;
    flash_attention?: boolean;
    num_experts?: number;
    offload_kv_cache_to_gpu?: boolean;
  };
};

export type LmStudioModel = {
  type: "llm" | "embedding";
  publisher: string;
  key: string;
  display_name?: string | null;
  architecture?: string | null;
  quantization?: {
    name?: string | null;
    bits_per_weight?: number | null;
  } | null;
  size_bytes: number;
  params_string?: string | null;
  loaded_instances: LmStudioLoadedInstance[];
  max_context_length: number;
  format?: "gguf" | "mlx" | null;
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
  } | null;
  description?: string | null;
};

export type LmStudioListModelsResponse = {
  models: LmStudioModel[];
};

export type LmStudioLoadResponse = {
  type: "llm" | "embedding";
  instance_id: string;
  load_time_seconds: number;
  status: "loaded";
  load_config?: {
    context_length: number;
    eval_batch_size?: number;
    flash_attention?: boolean;
    num_experts?: number;
    offload_kv_cache_to_gpu?: boolean;
  };
};

export type LmStudioUnloadResponse = {
  status?: string;
};

export type LmStudioProviderOptions = {
  baseUrl?: string;
  contextLength?: number;
  autoLoad?: boolean;
  reloadOnContextMismatch?: boolean;
};
