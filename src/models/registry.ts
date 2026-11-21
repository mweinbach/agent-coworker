import { z } from "zod";
import anthropicClaudeFable5 from "../../config/models/anthropic/claude-fable-5.json";
import anthropicClaudeFable51 from "../../config/models/anthropic/claude-fable-5-1.json";
import anthropicClaudeFable52 from "../../config/models/anthropic/claude-fable-5-2.json";
import anthropicClaudeHaiku45 from "../../config/models/anthropic/claude-haiku-4-5.json";
import anthropicClaudeHaiku55 from "../../config/models/anthropic/claude-haiku-5-5.json";
import anthropicClaudeOpus46 from "../../config/models/anthropic/claude-opus-4-6.json";
import anthropicClaudeOpus47 from "../../config/models/anthropic/claude-opus-4-7.json";
import anthropicClaudeOpus48 from "../../config/models/anthropic/claude-opus-4-8.json";
import anthropicClaudeOpus5 from "../../config/models/anthropic/claude-opus-5.json";
import anthropicClaudeOpus55 from "../../config/models/anthropic/claude-opus-5-5.json";
import anthropicClaudeSonnet45 from "../../config/models/anthropic/claude-sonnet-4-5.json";
import anthropicClaudeSonnet46 from "../../config/models/anthropic/claude-sonnet-4-6.json";
import anthropicClaudeSonnet5 from "../../config/models/anthropic/claude-sonnet-5.json";
import anthropicClaudeSonnet55 from "../../config/models/anthropic/claude-sonnet-5-5.json";
import basetenDeepseekAiDeepseekV41Flash from "../../config/models/baseten/deepseek-ai-deepseek-v4.1-flash.json";
import basetenDeepseekAiDeepseekV4Pro0813 from "../../config/models/baseten/deepseek-ai-deepseek-v4-pro-0813.json";
import basetenMoonshotaiKimiK25 from "../../config/models/baseten/moonshotai-kimi-k2.5.json";
import basetenMoonshotaiKimiK31Pro from "../../config/models/baseten/moonshotai-kimi-k3.1-pro.json";
import basetenMoonshotaiKimiK3 from "../../config/models/baseten/moonshotai-kimi-k3.json";
import basetenNvidiaNemotron3Ultra550bA55b from "../../config/models/baseten/nvidia-nemotron-3-ultra-550b-a55b.json";
import basetenNvidiaNemotron120bA12b from "../../config/models/baseten/nvidia-nemotron-120b-a12b.json";
import basetenZaiOrgGlm53 from "../../config/models/baseten/zai-org-glm-5.3.json";
import basetenZaiOrgGlm53Flash from "../../config/models/baseten/zai-org-glm-5.3-flash.json";
import basetenZaiOrgGlm5 from "../../config/models/baseten/zai-org-glm-5.json";
import bedrockAmazonNovaLiteV10 from "../../config/models/bedrock/amazon.nova-lite-v1-0.json";
import bedrockAmazonNovaMicroV10 from "../../config/models/bedrock/amazon.nova-micro-v1-0.json";
import bedrockAmazonNovaProV10 from "../../config/models/bedrock/amazon.nova-pro-v1-0.json";
import bedrockAnthropicClaude35Haiku20241022V10 from "../../config/models/bedrock/anthropic.claude-3-5-haiku-20241022-v1-0.json";
import bedrockGlobalAmazonNova2LiteV10 from "../../config/models/bedrock/global.amazon.nova-2-lite-v1-0.json";
import bedrockGlobalAnthropicClaudeHaiku4520251001V10 from "../../config/models/bedrock/global.anthropic.claude-haiku-4-5-20251001-v1-0.json";
import bedrockGlobalAnthropicClaudeHaiku55 from "../../config/models/bedrock/global.anthropic.claude-haiku-5-5.json";
import bedrockGlobalAnthropicClaudeOpus4520251101V10 from "../../config/models/bedrock/global.anthropic.claude-opus-4-5-20251101-v1-0.json";
import bedrockGlobalAnthropicClaudeOpus46V1 from "../../config/models/bedrock/global.anthropic.claude-opus-4-6-v1.json";
import bedrockGlobalAnthropicClaudeOpus47 from "../../config/models/bedrock/global.anthropic.claude-opus-4-7.json";
import bedrockGlobalAnthropicClaudeOpus48 from "../../config/models/bedrock/global.anthropic.claude-opus-4-8.json";
import bedrockGlobalAnthropicClaudeOpus55 from "../../config/models/bedrock/global.anthropic.claude-opus-5-5.json";
import bedrockGlobalAnthropicClaudeSonnet4520250929V10 from "../../config/models/bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1-0.json";
import bedrockGlobalAnthropicClaudeSonnet46 from "../../config/models/bedrock/global.anthropic.claude-sonnet-4-6.json";
import bedrockGlobalAnthropicClaudeSonnet55 from "../../config/models/bedrock/global.anthropic.claude-sonnet-5-5.json";
import claudeCliClaudeFable5 from "../../config/models/claude-cli/claude-fable-5.json";
import claudeCliClaudeFable51 from "../../config/models/claude-cli/claude-fable-5-1.json";
import claudeCliClaudeFable52 from "../../config/models/claude-cli/claude-fable-5-2.json";
import claudeCliClaudeHaiku45 from "../../config/models/claude-cli/claude-haiku-4-5.json";
import claudeCliClaudeHaiku55 from "../../config/models/claude-cli/claude-haiku-5-5.json";
import claudeCliClaudeOpus46 from "../../config/models/claude-cli/claude-opus-4-6.json";
import claudeCliClaudeOpus47 from "../../config/models/claude-cli/claude-opus-4-7.json";
import claudeCliClaudeOpus48 from "../../config/models/claude-cli/claude-opus-4-8.json";
import claudeCliClaudeOpus5 from "../../config/models/claude-cli/claude-opus-5.json";
import claudeCliClaudeOpus55 from "../../config/models/claude-cli/claude-opus-5-5.json";
import claudeCliClaudeSonnet45 from "../../config/models/claude-cli/claude-sonnet-4-5.json";
import claudeCliClaudeSonnet46 from "../../config/models/claude-cli/claude-sonnet-4-6.json";
import claudeCliClaudeSonnet5 from "../../config/models/claude-cli/claude-sonnet-5.json";
import claudeCliClaudeSonnet55 from "../../config/models/claude-cli/claude-sonnet-5-5.json";
import codexCliGpt53CodexSpark from "../../config/models/codex-cli/gpt-5.3-codex-spark.json";
import codexCliGpt54 from "../../config/models/codex-cli/gpt-5.4.json";
import codexCliGpt54Mini from "../../config/models/codex-cli/gpt-5.4-mini.json";
import codexCliGpt55 from "../../config/models/codex-cli/gpt-5.5.json";
import codexCliGpt56Luna from "../../config/models/codex-cli/gpt-5.6-luna.json";
import codexCliGpt56Sol from "../../config/models/codex-cli/gpt-5.6-sol.json";
import codexCliGpt56Terra from "../../config/models/codex-cli/gpt-5.6-terra.json";
import codexCliGpt61Sol from "../../config/models/codex-cli/gpt-6.1-sol.json";
import codexCliGpt61Terra from "../../config/models/codex-cli/gpt-6.1-terra.json";
import codexCliGpt62Astra from "../../config/models/codex-cli/gpt-6.2-astra.json";
import codexCliGpt62Sol from "../../config/models/codex-cli/gpt-6.2-sol.json";
import codexCliGpt6Astra from "../../config/models/codex-cli/gpt-6-astra.json";
import codexCliGpt6Luna from "../../config/models/codex-cli/gpt-6-luna.json";
import firepassAccountsFireworksRoutersKimiFastLatest from "../../config/models/firepass/accounts-fireworks-routers-kimi-fast-latest.json";
import firepassAccountsFireworksRoutersKimiK2p6Turbo from "../../config/models/firepass/accounts-fireworks-routers-kimi-k2p6-turbo.json";
import fireworksAccountsFireworksModelsDeepseekV4Pro from "../../config/models/fireworks/accounts-fireworks-models-deepseek-v4-pro.json";
import fireworksAccountsFireworksModelsDeepseekV4p1Flash1017 from "../../config/models/fireworks/accounts-fireworks-models-deepseek-v4p1-flash-1017.json";
import fireworksAccountsFireworksModelsGlm5p1 from "../../config/models/fireworks/accounts-fireworks-models-glm-5p1.json";
import fireworksAccountsFireworksModelsGlm5p3 from "../../config/models/fireworks/accounts-fireworks-models-glm-5p3.json";
import fireworksAccountsFireworksModelsGlm5p3Flash from "../../config/models/fireworks/accounts-fireworks-models-glm-5p3-flash.json";
import fireworksAccountsFireworksModelsKimiK2p6 from "../../config/models/fireworks/accounts-fireworks-models-kimi-k2p6.json";
import fireworksAccountsFireworksModelsKimiK3 from "../../config/models/fireworks/accounts-fireworks-models-kimi-k3.json";
import fireworksAccountsFireworksModelsKimiK3p1Pro from "../../config/models/fireworks/accounts-fireworks-models-kimi-k3p1-pro.json";
import fireworksAccountsFireworksModelsMinimaxM2p7 from "../../config/models/fireworks/accounts-fireworks-models-minimax-m2p7.json";
import fireworksAccountsFireworksModelsMinimaxM3 from "../../config/models/fireworks/accounts-fireworks-models-minimax-m3.json";
import fireworksAccountsFireworksModelsMinimaxM3p1Flash from "../../config/models/fireworks/accounts-fireworks-models-minimax-m3p1-flash.json";
import fireworksAccountsFireworksModelsQwen3p6Plus from "../../config/models/fireworks/accounts-fireworks-models-qwen3p6-plus.json";
import fireworksAccountsFireworksModelsQwen3p8Max from "../../config/models/fireworks/accounts-fireworks-models-qwen3p8-max.json";
import googleGemini31FlashLite from "../../config/models/google/gemini-3.1-flash-lite.json";
import googleGemini31ProPreview from "../../config/models/google/gemini-3.1-pro-preview.json";
import googleGemini31ProPreviewCustomtools from "../../config/models/google/gemini-3.1-pro-preview-customtools.json";
import googleGemini35Flash from "../../config/models/google/gemini-3.5-flash.json";
import googleGemini35FlashLite from "../../config/models/google/gemini-3.5-flash-lite.json";
import googleGemini36Flash from "../../config/models/google/gemini-3.6-flash.json";
import googleGemini38Flash from "../../config/models/google/gemini-3.8-flash.json";
import googleGemini3FlashPreview from "../../config/models/google/gemini-3-flash-preview.json";
import googleGemini4Argon from "../../config/models/google/gemini-4-argon.json";
import googleGemini4Carbon from "../../config/models/google/gemini-4-carbon.json";
import googleGemini4Hydrogen from "../../config/models/google/gemini-4-hydrogen.json";
import googleGemini4Neon from "../../config/models/google/gemini-4-neon.json";
import minimaxMinimaxM31Flash from "../../config/models/minimax/MiniMax-M3.1-Flash.json";
import minimaxMinimaxM3 from "../../config/models/minimax/MiniMax-M3.json";
import nvidiaGoogleGemma431bIt from "../../config/models/nvidia/google-gemma-4-31b-it.json";
import nvidiaMetaMuseGlimmer30b from "../../config/models/nvidia/meta-muse-glimmer-30b.json";
import nvidiaMinimaxaiMinimaxM31Flash from "../../config/models/nvidia/minimaxai-minimax-m3.1-flash.json";
import nvidiaMistralaiMistralLarge41tA52b from "../../config/models/nvidia/mistralai-mistral-large-4-1t-a52b.json";
import nvidiaMoonshotaiKimiK31Pro from "../../config/models/nvidia/moonshotai-kimi-k3.1-pro.json";
import nvidiaNvidiaNemotron35BoltE4b from "../../config/models/nvidia/nvidia-nemotron-3.5-bolt-e4b.json";
import nvidiaNvidiaNemotron35Lightning30bA3b from "../../config/models/nvidia/nvidia-nemotron-3.5-lightning-30b-a3b.json";
import nvidiaNvidiaNemotron35SuperVl120bA12b from "../../config/models/nvidia/nvidia-nemotron-3.5-super-vl-120b-a12b.json";
import nvidiaNvidiaNemotron3NanoOmni30bA3bReasoning from "../../config/models/nvidia/nvidia-nemotron-3-nano-omni-30b-a3b-reasoning.json";
import nvidiaNvidiaNemotron3Super120bA12b from "../../config/models/nvidia/nvidia-nemotron-3-super-120b-a12b.json";
import nvidiaNvidiaNemotron3Ultra550bA55b from "../../config/models/nvidia/nvidia-nemotron-3-ultra-550b-a55b.json";
import nvidiaPoolsideLagunaXs21 from "../../config/models/nvidia/poolside-laguna-xs-2.1.json";
import nvidiaStepfunAiStep5Preview from "../../config/models/nvidia/stepfun-ai-step-5-preview.json";
import nvidiaZAiGlm53Flash from "../../config/models/nvidia/z-ai-glm-5.3-flash.json";
import openaiGpt52 from "../../config/models/openai/gpt-5.2.json";
import openaiGpt52Pro from "../../config/models/openai/gpt-5.2-pro.json";
import openaiGpt54 from "../../config/models/openai/gpt-5.4.json";
import openaiGpt54Mini from "../../config/models/openai/gpt-5.4-mini.json";
import openaiGpt54Nano from "../../config/models/openai/gpt-5.4-nano.json";
import openaiGpt54Pro from "../../config/models/openai/gpt-5.4-pro.json";
import openaiGpt55 from "../../config/models/openai/gpt-5.5.json";
import openaiGpt5Mini from "../../config/models/openai/gpt-5-mini.json";
import openaiGpt61Terra from "../../config/models/openai/gpt-6.1-terra.json";
import openaiGpt62Astra from "../../config/models/openai/gpt-6.2-astra.json";
import openaiGpt62Sol from "../../config/models/openai/gpt-6.2-sol.json";
import openaiGpt6Luna from "../../config/models/openai/gpt-6-luna.json";
import opencodeGoBeamFree from "../../config/models/opencode-go/beam-free.json";
import opencodeGoClaudeHaiku55 from "../../config/models/opencode-go/claude-haiku-5-5.json";
import opencodeGoDeepseekV41Flash from "../../config/models/opencode-go/deepseek-v4.1-flash.json";
import opencodeGoDeepseekV4Flash from "../../config/models/opencode-go/deepseek-v4-flash.json";
import opencodeGoDeepseekV4Pro from "../../config/models/opencode-go/deepseek-v4-pro.json";
import opencodeGoGemini4Argon from "../../config/models/opencode-go/gemini-4-argon.json";
import opencodeGoGlm51 from "../../config/models/opencode-go/glm-5.1.json";
import opencodeGoGlm53 from "../../config/models/opencode-go/glm-5.3.json";
import opencodeGoGlm53Flash from "../../config/models/opencode-go/glm-5.3-flash.json";
import opencodeGoGlm5 from "../../config/models/opencode-go/glm-5.json";
import opencodeGoGpt56Luna from "../../config/models/opencode-go/gpt-5.6-luna.json";
import opencodeGoGpt6Luna from "../../config/models/opencode-go/gpt-6-luna.json";
import opencodeGoGrok47 from "../../config/models/opencode-go/grok-4.7.json";
import opencodeGoHy3 from "../../config/models/opencode-go/hy3.json";
import opencodeGoHy3Preview from "../../config/models/opencode-go/hy3-preview.json";
import opencodeGoHy4 from "../../config/models/opencode-go/hy4.json";
import opencodeGoHy4FlashFree from "../../config/models/opencode-go/hy4-flash-free.json";
import opencodeGoHy4Preview from "../../config/models/opencode-go/hy4-preview.json";
import opencodeGoIcemanContributorFree from "../../config/models/opencode-go/iceman-contributor-free.json";
import opencodeGoKimiK25 from "../../config/models/opencode-go/kimi-k2.5.json";
import opencodeGoKimiK26 from "../../config/models/opencode-go/kimi-k2.6.json";
import opencodeGoKimiK27Code from "../../config/models/opencode-go/kimi-k2.7-code.json";
import opencodeGoKimiK31Pro from "../../config/models/opencode-go/kimi-k3.1-pro.json";
import opencodeGoKimiK3 from "../../config/models/opencode-go/kimi-k3.json";
import opencodeGoLongcat20 from "../../config/models/opencode-go/longcat-2.0.json";
import opencodeGoLongcat25Free from "../../config/models/opencode-go/longcat-2.5-free.json";
import opencodeGoMimoV25 from "../../config/models/opencode-go/mimo-v2.5.json";
import opencodeGoMimoV25Pro from "../../config/models/opencode-go/mimo-v2.5-pro.json";
import opencodeGoMimoV26Flash from "../../config/models/opencode-go/mimo-v2.6-flash.json";
import opencodeGoMimoV26Pro from "../../config/models/opencode-go/mimo-v2.6-pro.json";
import opencodeGoMimoV2Omni from "../../config/models/opencode-go/mimo-v2-omni.json";
import opencodeGoMimoV2Pro from "../../config/models/opencode-go/mimo-v2-pro.json";
import opencodeGoMinimaxM25 from "../../config/models/opencode-go/minimax-m2.5.json";
import opencodeGoMinimaxM27 from "../../config/models/opencode-go/minimax-m2.7.json";
import opencodeGoMinimaxM31Flash from "../../config/models/opencode-go/minimax-m3.1-flash.json";
import opencodeGoMinimaxM3 from "../../config/models/opencode-go/minimax-m3.json";
import opencodeGoMuseSpark12Contributor from "../../config/models/opencode-go/muse-spark-1.2-contributor.json";
import opencodeGoMuseSpark13Contributor from "../../config/models/opencode-go/muse-spark-1.3-contributor.json";
import opencodeGoQwen35Plus from "../../config/models/opencode-go/qwen3.5-plus.json";
import opencodeGoQwen36Plus from "../../config/models/opencode-go/qwen3.6-plus.json";
import opencodeGoQwen37Max from "../../config/models/opencode-go/qwen3.7-max.json";
import opencodeGoQwen37Plus from "../../config/models/opencode-go/qwen3.7-plus.json";
import opencodeGoQwen38Flash from "../../config/models/opencode-go/qwen3.8-flash.json";
import opencodeGoQwen38Max from "../../config/models/opencode-go/qwen3.8-max.json";
import opencodeGoQwen4Max from "../../config/models/opencode-go/qwen4-max.json";
import opencodeGoStep5Preview from "../../config/models/opencode-go/step-5-preview.json";
import opencodeZenBeamFree from "../../config/models/opencode-zen/beam-free.json";
import opencodeZenBigPickle from "../../config/models/opencode-zen/big-pickle.json";
import opencodeZenClaudeFable5 from "../../config/models/opencode-zen/claude-fable-5.json";
import opencodeZenClaudeFable51 from "../../config/models/opencode-zen/claude-fable-5-1.json";
import opencodeZenClaudeFable52 from "../../config/models/opencode-zen/claude-fable-5-2.json";
import opencodeZenClaudeHaiku45 from "../../config/models/opencode-zen/claude-haiku-4-5.json";
import opencodeZenClaudeHaiku55 from "../../config/models/opencode-zen/claude-haiku-5-5.json";
import opencodeZenClaudeOpus41 from "../../config/models/opencode-zen/claude-opus-4-1.json";
import opencodeZenClaudeOpus45 from "../../config/models/opencode-zen/claude-opus-4-5.json";
import opencodeZenClaudeOpus46 from "../../config/models/opencode-zen/claude-opus-4-6.json";
import opencodeZenClaudeOpus47 from "../../config/models/opencode-zen/claude-opus-4-7.json";
import opencodeZenClaudeOpus48 from "../../config/models/opencode-zen/claude-opus-4-8.json";
import opencodeZenClaudeOpus5 from "../../config/models/opencode-zen/claude-opus-5.json";
import opencodeZenClaudeOpus55 from "../../config/models/opencode-zen/claude-opus-5-5.json";
import opencodeZenClaudeSonnet4 from "../../config/models/opencode-zen/claude-sonnet-4.json";
import opencodeZenClaudeSonnet45 from "../../config/models/opencode-zen/claude-sonnet-4-5.json";
import opencodeZenClaudeSonnet46 from "../../config/models/opencode-zen/claude-sonnet-4-6.json";
import opencodeZenClaudeSonnet5 from "../../config/models/opencode-zen/claude-sonnet-5.json";
import opencodeZenClaudeSonnet55 from "../../config/models/opencode-zen/claude-sonnet-5-5.json";
import opencodeZenDeepseekV41Flash from "../../config/models/opencode-zen/deepseek-v4.1-flash.json";
import opencodeZenDeepseekV41FlashFree from "../../config/models/opencode-zen/deepseek-v4.1-flash-free.json";
import opencodeZenDeepseekV4Flash from "../../config/models/opencode-zen/deepseek-v4-flash.json";
import opencodeZenDeepseekV4FlashFree from "../../config/models/opencode-zen/deepseek-v4-flash-free.json";
import opencodeZenDeepseekV4Pro from "../../config/models/opencode-zen/deepseek-v4-pro.json";
import opencodeZenFlint40bFree from "../../config/models/opencode-zen/flint-40b-free.json";
import opencodeZenGemini31Pro from "../../config/models/opencode-zen/gemini-3.1-pro.json";
import opencodeZenGemini35Flash from "../../config/models/opencode-zen/gemini-3.5-flash.json";
import opencodeZenGemini35FlashLite from "../../config/models/opencode-zen/gemini-3.5-flash-lite.json";
import opencodeZenGemini36Flash from "../../config/models/opencode-zen/gemini-3.6-flash.json";
import opencodeZenGemini37Flash from "../../config/models/opencode-zen/gemini-3.7-flash.json";
import opencodeZenGemini38Flash from "../../config/models/opencode-zen/gemini-3.8-flash.json";
import opencodeZenGemini3Flash from "../../config/models/opencode-zen/gemini-3-flash.json";
import opencodeZenGemini4Argon from "../../config/models/opencode-zen/gemini-4-argon.json";
import opencodeZenGemini4Carbon from "../../config/models/opencode-zen/gemini-4-carbon.json";
import opencodeZenGemini4Hydrogen from "../../config/models/opencode-zen/gemini-4-hydrogen.json";
import opencodeZenGemini4Neon from "../../config/models/opencode-zen/gemini-4-neon.json";
import opencodeZenGlm51 from "../../config/models/opencode-zen/glm-5.1.json";
import opencodeZenGlm53 from "../../config/models/opencode-zen/glm-5.3.json";
import opencodeZenGlm53Flash from "../../config/models/opencode-zen/glm-5.3-flash.json";
import opencodeZenGlm5 from "../../config/models/opencode-zen/glm-5.json";
import opencodeZenGpt51 from "../../config/models/opencode-zen/gpt-5.1.json";
import opencodeZenGpt51Codex from "../../config/models/opencode-zen/gpt-5.1-codex.json";
import opencodeZenGpt51CodexMax from "../../config/models/opencode-zen/gpt-5.1-codex-max.json";
import opencodeZenGpt51CodexMini from "../../config/models/opencode-zen/gpt-5.1-codex-mini.json";
import opencodeZenGpt52 from "../../config/models/opencode-zen/gpt-5.2.json";
import opencodeZenGpt52Codex from "../../config/models/opencode-zen/gpt-5.2-codex.json";
import opencodeZenGpt53Codex from "../../config/models/opencode-zen/gpt-5.3-codex.json";
import opencodeZenGpt53CodexSpark from "../../config/models/opencode-zen/gpt-5.3-codex-spark.json";
import opencodeZenGpt54 from "../../config/models/opencode-zen/gpt-5.4.json";
import opencodeZenGpt54Mini from "../../config/models/opencode-zen/gpt-5.4-mini.json";
import opencodeZenGpt54Nano from "../../config/models/opencode-zen/gpt-5.4-nano.json";
import opencodeZenGpt54Pro from "../../config/models/opencode-zen/gpt-5.4-pro.json";
import opencodeZenGpt55 from "../../config/models/opencode-zen/gpt-5.5.json";
import opencodeZenGpt55Pro from "../../config/models/opencode-zen/gpt-5.5-pro.json";
import opencodeZenGpt56Luna from "../../config/models/opencode-zen/gpt-5.6-luna.json";
import opencodeZenGpt56Sol from "../../config/models/opencode-zen/gpt-5.6-sol.json";
import opencodeZenGpt56Terra from "../../config/models/opencode-zen/gpt-5.6-terra.json";
import opencodeZenGpt5 from "../../config/models/opencode-zen/gpt-5.json";
import opencodeZenGpt5Codex from "../../config/models/opencode-zen/gpt-5-codex.json";
import opencodeZenGpt5Nano from "../../config/models/opencode-zen/gpt-5-nano.json";
import opencodeZenGpt61Sol from "../../config/models/opencode-zen/gpt-6.1-sol.json";
import opencodeZenGpt62Astra from "../../config/models/opencode-zen/gpt-6.2-astra.json";
import opencodeZenGpt62Sol from "../../config/models/opencode-zen/gpt-6.2-sol.json";
import opencodeZenGpt6Astra from "../../config/models/opencode-zen/gpt-6-astra.json";
import opencodeZenGpt6Luna from "../../config/models/opencode-zen/gpt-6-luna.json";
import opencodeZenGpt6Sol from "../../config/models/opencode-zen/gpt-6-sol.json";
import opencodeZenGrok45 from "../../config/models/opencode-zen/grok-4.5.json";
import opencodeZenGrok46 from "../../config/models/opencode-zen/grok-4.6.json";
import opencodeZenGrok47 from "../../config/models/opencode-zen/grok-4.7.json";
import opencodeZenGrokBuild01 from "../../config/models/opencode-zen/grok-build-0.1.json";
import opencodeZenHy4FlashFree from "../../config/models/opencode-zen/hy4-flash-free.json";
import opencodeZenIcemanFree from "../../config/models/opencode-zen/iceman-free.json";
import opencodeZenKimiK25 from "../../config/models/opencode-zen/kimi-k2.5.json";
import opencodeZenKimiK26 from "../../config/models/opencode-zen/kimi-k2.6.json";
import opencodeZenKimiK27Code from "../../config/models/opencode-zen/kimi-k2.7-code.json";
import opencodeZenKimiK3 from "../../config/models/opencode-zen/kimi-k3.json";
import opencodeZenLongcat25Free from "../../config/models/opencode-zen/longcat-2.5-free.json";
import opencodeZenMimoV25Free from "../../config/models/opencode-zen/mimo-v2.5-free.json";
import opencodeZenMimoV26FlashFree from "../../config/models/opencode-zen/mimo-v2.6-flash-free.json";
import opencodeZenMinimaxM25 from "../../config/models/opencode-zen/minimax-m2.5.json";
import opencodeZenMinimaxM27 from "../../config/models/opencode-zen/minimax-m2.7.json";
import opencodeZenMinimaxM3 from "../../config/models/opencode-zen/minimax-m3.json";
import opencodeZenMinimaxM3Free from "../../config/models/opencode-zen/minimax-m3-free.json";
import opencodeZenMistralLarge4 from "../../config/models/opencode-zen/mistral-large-4.json";
import opencodeZenMuseEmber10 from "../../config/models/opencode-zen/muse-ember-1.0.json";
import opencodeZenMuseSpark12 from "../../config/models/opencode-zen/muse-spark-1.2.json";
import opencodeZenMuseSpark13 from "../../config/models/opencode-zen/muse-spark-1.3.json";
import opencodeZenMuseWonder10 from "../../config/models/opencode-zen/muse-wonder-1.0.json";
import opencodeZenNemotron35LightningFree from "../../config/models/opencode-zen/nemotron-3.5-lightning-free.json";
import opencodeZenNemotron35SuperVlFree from "../../config/models/opencode-zen/nemotron-3.5-super-vl-free.json";
import opencodeZenNemotron3UltraFree from "../../config/models/opencode-zen/nemotron-3-ultra-free.json";
import opencodeZenNorthMiniCodeFree from "../../config/models/opencode-zen/north-mini-code-free.json";
import opencodeZenQwen35Plus from "../../config/models/opencode-zen/qwen3.5-plus.json";
import opencodeZenQwen36Plus from "../../config/models/opencode-zen/qwen3.6-plus.json";
import opencodeZenQwen36PlusFree from "../../config/models/opencode-zen/qwen3.6-plus-free.json";
import opencodeZenQwen38Flash from "../../config/models/opencode-zen/qwen3.8-flash.json";
import opencodeZenQwen38Max from "../../config/models/opencode-zen/qwen3.8-max.json";
import opencodeZenTidepoolAlphaFree from "../../config/models/opencode-zen/tidepool-alpha-free.json";
import togetherDeepseekAiDeepseekV41Flash from "../../config/models/together/deepseek-ai-deepseek-v4.1-flash.json";
import togetherDeepseekAiDeepseekV41Flash1017 from "../../config/models/together/deepseek-ai-deepseek-v4.1-flash-1017.json";
import togetherDeepseekAiDeepseekV4Pro0813 from "../../config/models/together/deepseek-ai-deepseek-v4-pro-0813.json";
import togetherMinimaxaiMinimaxM31Flash from "../../config/models/together/minimaxai-minimax-m3.1-flash.json";
import togetherMoonshotaiKimiK25 from "../../config/models/together/moonshotai-kimi-k2.5.json";
import togetherMoonshotaiKimiK31Pro from "../../config/models/together/moonshotai-kimi-k3.1-pro.json";
import togetherMoonshotaiKimiK3 from "../../config/models/together/moonshotai-kimi-k3.json";
import togetherQwenQwen359b from "../../config/models/together/qwen-qwen3.5-9b.json";
import togetherQwenQwen35397bA17b from "../../config/models/together/qwen-qwen3.5-397b-a17b.json";
import togetherQwenQwen37Max from "../../config/models/together/qwen-qwen3.7-max.json";
import togetherQwenQwen38Flash from "../../config/models/together/qwen-qwen3.8-flash.json";
import togetherQwenQwen4Max from "../../config/models/together/qwen-qwen4-max.json";
import togetherZaiOrgGlm53 from "../../config/models/together/zai-org-glm-5.3.json";
import togetherZaiOrgGlm53Flash from "../../config/models/together/zai-org-glm-5.3-flash.json";
import togetherZaiOrgGlm5 from "../../config/models/together/zai-org-glm-5.json";
import { MODEL_REGISTRY_PROVIDER_NAMES } from "../generated/providerSpecs";
import { CATALOG_REASONING_EFFORT_VALUES } from "../shared/openaiCompatibleOptions";
import type { ProviderName } from "../types";

// Providers with a static model registry under config/models/<provider>/ (every provider in
// config/providers.json except local-discovery ones such as LM Studio).
const STATIC_MODEL_PROVIDER_NAMES = MODEL_REGISTRY_PROVIDER_NAMES;

type StaticModelProviderName = (typeof STATIC_MODEL_PROVIDER_NAMES)[number];

const providerNameSchema = z.enum(STATIC_MODEL_PROVIDER_NAMES);

const supportedModelSchema = z
  .object({
    id: z.string().trim().min(1),
    provider: providerNameSchema,
    displayName: z.string().trim().min(1),
    // Vendor-published cutoff strings are user-facing metadata, not a normalized date field.
    knowledgeCutoff: z.string().trim().min(1),
    supportsImageInput: z.boolean(),
    promptTemplate: z.string().trim().min(1),
    providerOptionsDefaults: z.record(z.string(), z.unknown()),
    /**
     * Reasoning efforts the runtime actually honors for this model. Omit for
     * models without configurable reasoning; consumers fall back to the full
     * OpenAI effort list when absent.
     */
    supportedReasoningEfforts: z.array(z.enum(CATALOG_REASONING_EFFORT_VALUES)).min(1).optional(),
    isDefault: z.boolean(),
  })
  .strict();

export type SupportedModel = z.infer<typeof supportedModelSchema>;

const RAW_MODEL_REGISTRY_ENTRIES = [
  anthropicClaudeFable51,
  anthropicClaudeFable52,
  anthropicClaudeFable5,
  anthropicClaudeHaiku45,
  anthropicClaudeHaiku55,
  anthropicClaudeOpus46,
  anthropicClaudeOpus47,
  anthropicClaudeOpus48,
  anthropicClaudeOpus55,
  anthropicClaudeOpus5,
  anthropicClaudeSonnet45,
  anthropicClaudeSonnet46,
  anthropicClaudeSonnet55,
  anthropicClaudeSonnet5,
  basetenDeepseekAiDeepseekV4Pro0813,
  basetenDeepseekAiDeepseekV41Flash,
  basetenMoonshotaiKimiK25,
  basetenMoonshotaiKimiK31Pro,
  basetenMoonshotaiKimiK3,
  basetenNvidiaNemotron120bA12b,
  basetenNvidiaNemotron3Ultra550bA55b,
  basetenZaiOrgGlm53Flash,
  basetenZaiOrgGlm53,
  basetenZaiOrgGlm5,
  bedrockAmazonNovaLiteV10,
  bedrockAmazonNovaMicroV10,
  bedrockAmazonNovaProV10,
  bedrockAnthropicClaude35Haiku20241022V10,
  bedrockGlobalAmazonNova2LiteV10,
  bedrockGlobalAnthropicClaudeHaiku4520251001V10,
  bedrockGlobalAnthropicClaudeHaiku55,
  bedrockGlobalAnthropicClaudeOpus4520251101V10,
  bedrockGlobalAnthropicClaudeOpus46V1,
  bedrockGlobalAnthropicClaudeOpus47,
  bedrockGlobalAnthropicClaudeOpus48,
  bedrockGlobalAnthropicClaudeOpus55,
  bedrockGlobalAnthropicClaudeSonnet4520250929V10,
  bedrockGlobalAnthropicClaudeSonnet46,
  bedrockGlobalAnthropicClaudeSonnet55,
  claudeCliClaudeFable51,
  claudeCliClaudeFable52,
  claudeCliClaudeFable5,
  claudeCliClaudeHaiku45,
  claudeCliClaudeHaiku55,
  claudeCliClaudeOpus46,
  claudeCliClaudeOpus47,
  claudeCliClaudeOpus48,
  claudeCliClaudeOpus55,
  claudeCliClaudeOpus5,
  claudeCliClaudeSonnet45,
  claudeCliClaudeSonnet46,
  claudeCliClaudeSonnet55,
  claudeCliClaudeSonnet5,
  codexCliGpt53CodexSpark,
  codexCliGpt54Mini,
  codexCliGpt54,
  codexCliGpt55,
  codexCliGpt56Luna,
  codexCliGpt56Sol,
  codexCliGpt56Terra,
  codexCliGpt6Astra,
  codexCliGpt6Luna,
  codexCliGpt61Sol,
  codexCliGpt61Terra,
  codexCliGpt62Astra,
  codexCliGpt62Sol,
  firepassAccountsFireworksRoutersKimiFastLatest,
  firepassAccountsFireworksRoutersKimiK2p6Turbo,
  fireworksAccountsFireworksModelsDeepseekV4Pro,
  fireworksAccountsFireworksModelsDeepseekV4p1Flash1017,
  fireworksAccountsFireworksModelsGlm5p1,
  fireworksAccountsFireworksModelsGlm5p3Flash,
  fireworksAccountsFireworksModelsGlm5p3,
  fireworksAccountsFireworksModelsKimiK2p6,
  fireworksAccountsFireworksModelsKimiK3,
  fireworksAccountsFireworksModelsKimiK3p1Pro,
  fireworksAccountsFireworksModelsMinimaxM2p7,
  fireworksAccountsFireworksModelsMinimaxM3,
  fireworksAccountsFireworksModelsMinimaxM3p1Flash,
  fireworksAccountsFireworksModelsQwen3p6Plus,
  fireworksAccountsFireworksModelsQwen3p8Max,
  googleGemini3FlashPreview,
  googleGemini31FlashLite,
  googleGemini31ProPreviewCustomtools,
  googleGemini31ProPreview,
  googleGemini35FlashLite,
  googleGemini35Flash,
  googleGemini36Flash,
  googleGemini38Flash,
  googleGemini4Argon,
  googleGemini4Carbon,
  googleGemini4Hydrogen,
  googleGemini4Neon,
  minimaxMinimaxM31Flash,
  minimaxMinimaxM3,
  nvidiaGoogleGemma431bIt,
  nvidiaMetaMuseGlimmer30b,
  nvidiaMinimaxaiMinimaxM31Flash,
  nvidiaMistralaiMistralLarge41tA52b,
  nvidiaMoonshotaiKimiK31Pro,
  nvidiaNvidiaNemotron3NanoOmni30bA3bReasoning,
  nvidiaNvidiaNemotron3Super120bA12b,
  nvidiaNvidiaNemotron3Ultra550bA55b,
  nvidiaNvidiaNemotron35BoltE4b,
  nvidiaNvidiaNemotron35Lightning30bA3b,
  nvidiaNvidiaNemotron35SuperVl120bA12b,
  nvidiaPoolsideLagunaXs21,
  nvidiaStepfunAiStep5Preview,
  nvidiaZAiGlm53Flash,
  openaiGpt5Mini,
  openaiGpt52Pro,
  openaiGpt52,
  openaiGpt54Mini,
  openaiGpt54Nano,
  openaiGpt54Pro,
  openaiGpt54,
  openaiGpt55,
  openaiGpt6Luna,
  openaiGpt61Terra,
  openaiGpt62Astra,
  openaiGpt62Sol,
  opencodeGoBeamFree,
  opencodeGoClaudeHaiku55,
  opencodeGoDeepseekV4Flash,
  opencodeGoDeepseekV4Pro,
  opencodeGoDeepseekV41Flash,
  opencodeGoGemini4Argon,
  opencodeGoGlm51,
  opencodeGoGlm53Flash,
  opencodeGoGlm53,
  opencodeGoGlm5,
  opencodeGoGpt56Luna,
  opencodeGoGpt6Luna,
  opencodeGoGrok47,
  opencodeGoHy3Preview,
  opencodeGoHy3,
  opencodeGoHy4FlashFree,
  opencodeGoHy4Preview,
  opencodeGoHy4,
  opencodeGoIcemanContributorFree,
  opencodeGoKimiK25,
  opencodeGoKimiK26,
  opencodeGoKimiK27Code,
  opencodeGoKimiK31Pro,
  opencodeGoKimiK3,
  opencodeGoLongcat20,
  opencodeGoLongcat25Free,
  opencodeGoMimoV2Omni,
  opencodeGoMimoV2Pro,
  opencodeGoMimoV25Pro,
  opencodeGoMimoV25,
  opencodeGoMimoV26Flash,
  opencodeGoMimoV26Pro,
  opencodeGoMinimaxM25,
  opencodeGoMinimaxM27,
  opencodeGoMinimaxM31Flash,
  opencodeGoMinimaxM3,
  opencodeGoMuseSpark12Contributor,
  opencodeGoMuseSpark13Contributor,
  opencodeGoQwen35Plus,
  opencodeGoQwen36Plus,
  opencodeGoQwen37Max,
  opencodeGoQwen37Plus,
  opencodeGoQwen38Flash,
  opencodeGoQwen38Max,
  opencodeGoQwen4Max,
  opencodeGoStep5Preview,
  opencodeZenBeamFree,
  opencodeZenBigPickle,
  opencodeZenClaudeFable51,
  opencodeZenClaudeFable52,
  opencodeZenClaudeFable5,
  opencodeZenClaudeHaiku45,
  opencodeZenClaudeHaiku55,
  opencodeZenClaudeOpus41,
  opencodeZenClaudeOpus45,
  opencodeZenClaudeOpus46,
  opencodeZenClaudeOpus47,
  opencodeZenClaudeOpus48,
  opencodeZenClaudeOpus55,
  opencodeZenClaudeOpus5,
  opencodeZenClaudeSonnet45,
  opencodeZenClaudeSonnet46,
  opencodeZenClaudeSonnet4,
  opencodeZenClaudeSonnet55,
  opencodeZenClaudeSonnet5,
  opencodeZenDeepseekV4FlashFree,
  opencodeZenDeepseekV4Flash,
  opencodeZenDeepseekV4Pro,
  opencodeZenDeepseekV41FlashFree,
  opencodeZenDeepseekV41Flash,
  opencodeZenFlint40bFree,
  opencodeZenGemini3Flash,
  opencodeZenGemini31Pro,
  opencodeZenGemini35FlashLite,
  opencodeZenGemini35Flash,
  opencodeZenGemini36Flash,
  opencodeZenGemini37Flash,
  opencodeZenGemini38Flash,
  opencodeZenGemini4Argon,
  opencodeZenGemini4Carbon,
  opencodeZenGemini4Hydrogen,
  opencodeZenGemini4Neon,
  opencodeZenGlm51,
  opencodeZenGlm53Flash,
  opencodeZenGlm53,
  opencodeZenGlm5,
  opencodeZenGpt5Codex,
  opencodeZenGpt5Nano,
  opencodeZenGpt51CodexMax,
  opencodeZenGpt51CodexMini,
  opencodeZenGpt51Codex,
  opencodeZenGpt51,
  opencodeZenGpt52Codex,
  opencodeZenGpt52,
  opencodeZenGpt53CodexSpark,
  opencodeZenGpt53Codex,
  opencodeZenGpt54Mini,
  opencodeZenGpt54Nano,
  opencodeZenGpt54Pro,
  opencodeZenGpt54,
  opencodeZenGpt55Pro,
  opencodeZenGpt55,
  opencodeZenGpt56Luna,
  opencodeZenGpt56Sol,
  opencodeZenGpt56Terra,
  opencodeZenGpt5,
  opencodeZenGpt6Astra,
  opencodeZenGpt6Luna,
  opencodeZenGpt6Sol,
  opencodeZenGpt61Sol,
  opencodeZenGpt62Astra,
  opencodeZenGpt62Sol,
  opencodeZenGrok45,
  opencodeZenGrok46,
  opencodeZenGrok47,
  opencodeZenGrokBuild01,
  opencodeZenHy4FlashFree,
  opencodeZenIcemanFree,
  opencodeZenKimiK25,
  opencodeZenKimiK26,
  opencodeZenKimiK27Code,
  opencodeZenKimiK3,
  opencodeZenLongcat25Free,
  opencodeZenMimoV25Free,
  opencodeZenMimoV26FlashFree,
  opencodeZenMinimaxM25,
  opencodeZenMinimaxM27,
  opencodeZenMinimaxM3Free,
  opencodeZenMinimaxM3,
  opencodeZenMistralLarge4,
  opencodeZenMuseEmber10,
  opencodeZenMuseSpark12,
  opencodeZenMuseSpark13,
  opencodeZenMuseWonder10,
  opencodeZenNemotron3UltraFree,
  opencodeZenNemotron35LightningFree,
  opencodeZenNemotron35SuperVlFree,
  opencodeZenNorthMiniCodeFree,
  opencodeZenQwen35Plus,
  opencodeZenQwen36PlusFree,
  opencodeZenQwen36Plus,
  opencodeZenQwen38Flash,
  opencodeZenQwen38Max,
  opencodeZenTidepoolAlphaFree,
  togetherDeepseekAiDeepseekV4Pro0813,
  togetherDeepseekAiDeepseekV41Flash1017,
  togetherDeepseekAiDeepseekV41Flash,
  togetherMinimaxaiMinimaxM31Flash,
  togetherMoonshotaiKimiK25,
  togetherMoonshotaiKimiK31Pro,
  togetherMoonshotaiKimiK3,
  togetherQwenQwen35397bA17b,
  togetherQwenQwen359b,
  togetherQwenQwen37Max,
  togetherQwenQwen38Flash,
  togetherQwenQwen4Max,
  togetherZaiOrgGlm53Flash,
  togetherZaiOrgGlm53,
  togetherZaiOrgGlm5,
] as const;
// This list needs to stay in sync with the imports above; adding a model requires both
// supplying the JSON file and including it in this array so buildRegistry actually sees it.

function buildRegistry(entries: SupportedModel[]) {
  const byProvider = Object.fromEntries(
    STATIC_MODEL_PROVIDER_NAMES.map((provider) => [provider, [] as SupportedModel[]]),
  ) as Record<StaticModelProviderName, SupportedModel[]>;
  const byKey = new Map<string, SupportedModel>();
  const defaults = new Map<StaticModelProviderName, SupportedModel>();

  for (const entry of entries) {
    byProvider[entry.provider].push(entry);
    const key = `${entry.provider}:${entry.id}`;
    if (byKey.has(key)) {
      throw new Error(`Duplicate model registry entry for ${key}.`);
    }
    byKey.set(key, entry);
    if (entry.isDefault) {
      if (defaults.has(entry.provider)) {
        throw new Error(`Multiple default models configured for provider ${entry.provider}.`);
      }
      defaults.set(entry.provider, entry);
    }
  }

  for (const provider of STATIC_MODEL_PROVIDER_NAMES) {
    if (byProvider[provider].length === 0) {
      throw new Error(`No supported models configured for provider ${provider}.`);
    }
    if (!defaults.has(provider)) {
      throw new Error(`No default model configured for provider ${provider}.`);
    }
    byProvider[provider].sort((a, b) => a.id.localeCompare(b.id));
  }

  return { byProvider, byKey, defaults };
}

const MODEL_REGISTRY_ENTRIES = RAW_MODEL_REGISTRY_ENTRIES.map((entry) =>
  supportedModelSchema.parse(entry),
).sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
const MODEL_REGISTRY = buildRegistry(MODEL_REGISTRY_ENTRIES);

/**
 * Legacy model ID aliases for backward compatibility.
 * Maps deprecated/legacy model IDs to their canonical replacements.
 */
const LEGACY_MODEL_ALIASES: Record<string, string> = {
  "openai:gpt-5.1": "openai:gpt-5.4",
  "openai:gpt-5.2-codex": "openai:gpt-5.4",
  "codex-cli:gpt-5-codex": "codex-cli:gpt-5.4",
  "codex-cli:gpt-5.1": "codex-cli:gpt-5.4",
  "codex-cli:gpt-5.1-codex": "codex-cli:gpt-5.4",
  "codex-cli:gpt-5.1-codex-max": "codex-cli:gpt-5.4",
  "codex-cli:gpt-5.1-codex-mini": "codex-cli:gpt-5.4",
  "codex-cli:gpt-5.2-codex": "codex-cli:gpt-5.4",
  "google:gemini-3-pro-preview": "google:gemini-3.1-pro-preview-customtools",
  "google:gemini-3.1-flash-lite-preview": "google:gemini-3.1-flash-lite",
};

type LikelyModelProvider = "openai" | "anthropic" | "google";

function inferLikelyProviderForModelId(modelId: string): LikelyModelProvider | null {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("claude-")) return "anthropic";
  if (normalized.startsWith("gemini-")) return "google";
  if (
    normalized.startsWith("gpt-6") ||
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("gpt-4o") ||
    /^o(?:1|3|4)(?:$|[-.])/.test(normalized) ||
    /(^|[-.])codex(?:$|[-.])/.test(normalized)
  ) {
    return "openai";
  }
  return null;
}

function providerMatchesLikelyModelProvider(
  provider: ProviderName,
  expectedProvider: LikelyModelProvider,
): boolean {
  if (expectedProvider === "openai") {
    return provider === "openai" || provider === "codex-cli";
  }
  if (expectedProvider === "anthropic") {
    return provider === "anthropic" || provider === "claude-cli";
  }
  return provider === expectedProvider;
}

export function describeModelProviderMismatch(
  provider: ProviderName,
  modelId: string,
): string | null {
  const expectedProvider = inferLikelyProviderForModelId(modelId);
  if (!expectedProvider || providerMatchesLikelyModelProvider(provider, expectedProvider)) {
    return null;
  }
  if (expectedProvider === "openai") {
    return `"${modelId}" looks like an OpenAI model; use provider openai instead (Responses API).`;
  }
  if (expectedProvider === "google") {
    return `"${modelId}" looks like a Google model; use provider google instead.`;
  }
  return `"${modelId}" looks like an Anthropic model; use provider anthropic instead.`;
}

export { MODEL_REGISTRY_ENTRIES };

function isStaticRegistryProvider(provider: ProviderName): provider is StaticModelProviderName {
  return (STATIC_MODEL_PROVIDER_NAMES as readonly string[]).includes(provider);
}

export function listSupportedModels(provider: ProviderName): readonly SupportedModel[] {
  return isStaticRegistryProvider(provider) ? MODEL_REGISTRY.byProvider[provider] : [];
}

export function getSupportedModel(provider: ProviderName, modelId: string): SupportedModel | null {
  if (!isStaticRegistryProvider(provider)) return null;
  const trimmed = modelId.trim();
  const key = `${provider}:${trimmed}`;
  // Check legacy aliases first
  const aliasedKey = LEGACY_MODEL_ALIASES[key];
  const lookupKey = aliasedKey ?? key;
  return MODEL_REGISTRY.byKey.get(lookupKey) ?? null;
}

export function defaultSupportedModel(provider: ProviderName): SupportedModel {
  if (!isStaticRegistryProvider(provider)) {
    throw new Error(
      `Provider ${provider} uses dynamic model discovery and has no static default model.`,
    );
  }
  const entry = MODEL_REGISTRY.defaults.get(provider);
  if (!entry) throw new Error(`Missing default model for provider ${provider}.`);
  return entry;
}

export function defaultModelIdForProvider(provider: ProviderName): string {
  return defaultSupportedModel(provider).id;
}

export function listSupportedModelIds(provider: ProviderName): readonly string[] {
  return listSupportedModels(provider).map((entry) => entry.id);
}

export function supportsImageInput(provider: ProviderName, modelId: string): boolean {
  return getSupportedModel(provider, modelId)?.supportsImageInput ?? false;
}
