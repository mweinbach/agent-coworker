export interface CliArgs {
  dir?: string;
  help: boolean;
  cli: boolean;
  yolo: boolean;
  mouse: boolean;
}

export function parseCliArgs(argv: string[]): { args: CliArgs; errors: string[] } {
  const args: CliArgs = { help: false, cli: false, yolo: false, mouse: true };
  const errors: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--help" || a === "-h") {
      args.help = true;
      continue;
    }

    if (a === "--cli" || a === "-c") {
      args.cli = true;
      continue;
    }

    if (a === "--yolo" || a === "-y") {
      args.yolo = true;
      continue;
    }

    if (a === "--mouse" || a === "-m") {
      args.mouse = true;
      continue;
    }

    if (a === "--no-mouse") {
      args.mouse = false;
      continue;
    }

    if (a === "--dir" || a === "-d") {
      const v = argv[i + 1];
      if (!v || v.startsWith("-")) {
        errors.push(`Missing value for ${a}. Usage: ${a} <directory_path>`);
      } else {
        args.dir = v;
        i++;
      }
      continue;
    }

    errors.push(`Unknown argument: ${a}`);
  }

  return { args, errors };
}
