import type readline from "node:readline";

import { type ProviderAuthMethod, resolveProviderAuthMethodSelection } from "../parser";

async function askLine(rl: readline.Interface, prompt: string): Promise<string> {
  return await new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

export async function promptForProviderMethod(
  rl: readline.Interface,
  provider: string,
  methods: ProviderAuthMethod[],
): Promise<ProviderAuthMethod | null> {
  if (methods.length <= 1) return methods[0] ?? null;

  console.log(`Auth methods for ${provider}:`);
  for (let i = 0; i < methods.length; i++) {
    const method = methods[i];
    if (!method) continue;
    const mode =
      method.type === "oauth"
        ? `oauth${method.oauthMode ? ` (${method.oauthMode})` : ""}`
        : "api key";
    console.log(`  ${i + 1}. ${method.label} [${method.id}] - ${mode}`);
  }

  while (true) {
    const answer = (
      await askLine(rl, `Select method [1-${methods.length}] (or "cancel"): `)
    ).trim();
    if (["cancel", "c", "q", "quit"].includes(answer.toLowerCase())) return null;
    const selected = resolveProviderAuthMethodSelection(methods, answer);
    if (selected) return selected;
    console.log("Invalid selection. Enter a number or method id.");
  }
}

async function askSecretLine(rl: readline.Interface, prompt: string): Promise<string> {
  const rlAny = rl as unknown as { _writeToOutput: (str: string) => void };
  const originalWrite = rlAny._writeToOutput;
  let isMuted = false;

  rlAny._writeToOutput = (stringToWrite: string) => {
    if (isMuted) {
      if (stringToWrite === "\r\n" || stringToWrite === "\n" || stringToWrite === "\r") {
        originalWrite.call(rl, stringToWrite);
      }
    } else {
      originalWrite.call(rl, stringToWrite);
    }
  };

  try {
    const promise = new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => {
        resolve(answer);
      });
    });
    isMuted = true;
    const answer = await promise;
    return answer;
  } finally {
    rlAny._writeToOutput = originalWrite;
  }
}

export async function promptForApiKey(rl: readline.Interface, provider: string): Promise<string> {
  return (await askSecretLine(rl, `${provider} API key: `)).trim();
}

export async function promptForProviderFields(
  rl: readline.Interface,
  provider: string,
  method: ProviderAuthMethod,
): Promise<Record<string, string> | null> {
  const fields = method.fields ?? [];
  if (fields.length === 0) return {};

  const values: Record<string, string> = {};
  for (const field of fields) {
    const suffix = field.required ? " (required)" : "";
    const placeholder = field.placeholder ? ` [${field.placeholder}]` : "";
    const isSecret = field.kind === "password" || field.secret === true;
    const answer = (
      isSecret
        ? await askSecretLine(rl, `${provider} ${field.label}${suffix}${placeholder}: `)
        : await askLine(rl, `${provider} ${field.label}${suffix}${placeholder}: `)
    ).trim();
    if (!answer && field.required) {
      console.log(`${field.label} is required.`);
      return null;
    }
    if (answer) {
      values[field.id] = answer;
    }
  }

  return values;
}
