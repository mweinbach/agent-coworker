import readline from "node:readline";

import { resolveProviderAuthMethodSelection, type ProviderAuthMethod } from "../parser";

async function askLine(rl: readline.Interface, prompt: string): Promise<string> {
  return await new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

export async function promptForProviderMethod(
  rl: readline.Interface,
  provider: string,
  methods: ProviderAuthMethod[]
): Promise<ProviderAuthMethod | null> {
  if (methods.length <= 1) return methods[0] ?? null;

  console.log(`Auth methods for ${provider}:`);
  for (let i = 0; i < methods.length; i++) {
    const method = methods[i]!;
    const mode = method.type === "oauth" ? `oauth${method.oauthMode ? ` (${method.oauthMode})` : ""}` : "api key";
    console.log(`  ${i + 1}. ${method.label} [${method.id}] - ${mode}`);
  }

  while (true) {
    const answer = (await askLine(rl, `Select method [1-${methods.length}] (or "cancel"): `)).trim();
    if (["cancel", "c", "q", "quit"].includes(answer.toLowerCase())) return null;
    const selected = resolveProviderAuthMethodSelection(methods, answer);
    if (selected) return selected;
    console.log("Invalid selection. Enter a number or method id.");
  }
}

export async function promptForApiKey(
  rl: readline.Interface,
  provider: string,
): Promise<string> {
  return (await askLine(rl, `${provider} API key: `)).trim();
}
