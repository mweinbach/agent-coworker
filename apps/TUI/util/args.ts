export function parseArgs(argv: string[]): {
  serverUrl: string;
  help: boolean;
  useMouse: boolean;
} {
  let serverUrl = "ws://127.0.0.1:7337/ws";
  let useMouse = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--server" || arg === "-s") {
      const value = argv[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      serverUrl = value;
      i++;
      continue;
    }
    if (arg === "--mouse" || arg === "-m") {
      useMouse = true;
      continue;
    }
    if (arg === "--no-mouse") {
      useMouse = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") return { serverUrl, help: true, useMouse };
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { serverUrl, help: false, useMouse };
}
