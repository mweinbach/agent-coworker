import { describe, expect, test } from "bun:test";

import {
  childEnv,
  dedupePathDirs,
  defaultChildEnv,
  findEnvKey,
  getEnv,
  mergePathDirs,
  minimalSandboxEnv,
  pathDelimiter,
  readPathValue,
  runtimePathDirs,
  sandboxEnvAllowlist,
  setEnv,
  splitPathValue,
} from "../../src/platform/env";

const ALL_PLATFORMS: NodeJS.Platform[] = ["win32", "darwin", "linux"];
const POSIX_PLATFORMS: NodeJS.Platform[] = ["darwin", "linux"];

describe("getEnv / findEnvKey", () => {
  test("win32: case-insensitive lookup returns the value and preserved spelling", () => {
    const env = { Path: "C:\\Windows", FOO: "bar" };
    expect(getEnv(env, "PATH", "win32")).toBe("C:\\Windows");
    expect(getEnv(env, "path", "win32")).toBe("C:\\Windows");
    expect(findEnvKey(env, "PATH", "win32")).toBe("Path");
    expect(findEnvKey(env, "foo", "win32")).toBe("FOO");
  });

  test("win32: exact spelling wins over a case-insensitive match", () => {
    const env = { PATH: "exact", Path: "folded" };
    expect(getEnv(env, "PATH", "win32")).toBe("exact");
    expect(findEnvKey(env, "PATH", "win32")).toBe("PATH");
  });

  for (const platform of POSIX_PLATFORMS) {
    test(`${platform}: exact key only — never case-folds`, () => {
      const env = { Path: "wrong-case", PATH: "/usr/bin" };
      expect(getEnv(env, "PATH", platform)).toBe("/usr/bin");
      expect(getEnv(env, "path", platform)).toBeUndefined();
      expect(findEnvKey(env, "path", platform)).toBeUndefined();
      expect(findEnvKey(env, "Path", platform)).toBe("Path");
    });

    test(`${platform}: differently-cased key is NOT found (the 7-copy bug is not replicated)`, () => {
      const env = { Path: "C:-style-spelling" };
      expect(getEnv(env, "PATH", platform)).toBeUndefined();
    });
  }

  for (const platform of ALL_PLATFORMS) {
    test(`${platform}: missing key returns undefined`, () => {
      expect(getEnv({}, "PATH", platform)).toBeUndefined();
      expect(findEnvKey({}, "PATH", platform)).toBeUndefined();
    });
  }
});

describe("setEnv", () => {
  test("win32: writes to the existing spelling instead of adding a second key", () => {
    const env: Record<string, string | undefined> = { Path: "old" };
    setEnv(env, "PATH", "new", "win32");
    expect(env).toEqual({ Path: "new" });
  });

  test("win32: uses the given name when no spelling exists", () => {
    const env: Record<string, string | undefined> = {};
    setEnv(env, "PATH", "v", "win32");
    expect(env).toEqual({ PATH: "v" });
  });

  for (const platform of POSIX_PLATFORMS) {
    test(`${platform}: writes the exact key, leaving other spellings untouched`, () => {
      const env: Record<string, string | undefined> = { Path: "keep" };
      setEnv(env, "PATH", "new", platform);
      expect(env).toEqual({ Path: "keep", PATH: "new" });
    });
  }
});

describe("pathDelimiter / readPathValue", () => {
  test("delimiter is ';' on win32 and ':' on POSIX", () => {
    expect(pathDelimiter("win32")).toBe(";");
    expect(pathDelimiter("darwin")).toBe(":");
    expect(pathDelimiter("linux")).toBe(":");
  });

  test("default platform parameter follows the host", () => {
    expect(pathDelimiter()).toBe(process.platform === "win32" ? ";" : ":");
  });

  test("win32: reads PATH through the inherited 'Path' spelling", () => {
    expect(readPathValue({ Path: "C:\\bin" }, "win32")).toBe("C:\\bin");
  });

  for (const platform of POSIX_PLATFORMS) {
    test(`${platform}: exact PATH key only`, () => {
      expect(readPathValue({ PATH: "/bin" }, platform)).toBe("/bin");
      expect(readPathValue({ Path: "/bin" }, platform)).toBe("");
    });
  }

  for (const platform of ALL_PLATFORMS) {
    test(`${platform}: unset PATH reads as ""`, () => {
      expect(readPathValue({}, platform)).toBe("");
    });
  }
});

describe("splitPathValue", () => {
  test("win32: plain split on ';'", () => {
    expect(splitPathValue("C:\\a;C:\\b", "win32")).toEqual(["C:\\a", "C:\\b"]);
  });

  test("win32: double-quoted entries may contain ';' and lose their quotes", () => {
    expect(splitPathValue('C:\\a;"C:\\dir;with;semis";C:\\b', "win32")).toEqual([
      "C:\\a",
      "C:\\dir;with;semis",
      "C:\\b",
    ]);
  });

  test("win32: partial quoting inside an entry", () => {
    expect(splitPathValue('C:\\pre";mid;"post;C:\\b', "win32")).toEqual([
      "C:\\pre;mid;post",
      "C:\\b",
    ]);
  });

  test("win32: unterminated quote consumes the rest as one entry", () => {
    expect(splitPathValue('C:\\a;"C:\\open;rest', "win32")).toEqual(["C:\\a", "C:\\open;rest"]);
  });

  test("win32: empty entries are dropped", () => {
    expect(splitPathValue(";;C:\\a;;", "win32")).toEqual(["C:\\a"]);
    expect(splitPathValue("", "win32")).toEqual([]);
  });

  for (const platform of POSIX_PLATFORMS) {
    test(`${platform}: plain ':' split, quotes are literal characters`, () => {
      expect(splitPathValue("/a:/b", platform)).toEqual(["/a", "/b"]);
      expect(splitPathValue('/a:"/q:uote"', platform)).toEqual(["/a", '"/q', 'uote"']);
    });

    test(`${platform}: empty entries are dropped`, () => {
      expect(splitPathValue("::/a::", platform)).toEqual(["/a"]);
      expect(splitPathValue("", platform)).toEqual([]);
    });
  }
});

describe("dedupePathDirs", () => {
  test("win32: case-folded dedupe keeps the first spelling", () => {
    expect(dedupePathDirs(["C:\\Bin", "c:\\bin", "C:\\other"], "win32")).toEqual([
      "C:\\Bin",
      "C:\\other",
    ]);
  });

  for (const platform of POSIX_PLATFORMS) {
    test(`${platform}: case-sensitive — differently-cased dirs are distinct`, () => {
      expect(dedupePathDirs(["/Bin", "/bin", "/bin"], platform)).toEqual(["/Bin", "/bin"]);
    });
  }

  for (const platform of ALL_PLATFORMS) {
    test(`${platform}: empty entries are dropped, order preserved`, () => {
      expect(dedupePathDirs(["", "/a", "", "/b", "/a"], platform)).toEqual(["/a", "/b"]);
    });
  }
});

describe("mergePathDirs", () => {
  test("win32: prepend writes back to the inherited 'Path' spelling", () => {
    const result = mergePathDirs({ Path: "C:\\old", FOO: "x" }, ["C:\\new"], {
      position: "prepend",
      platform: "win32",
    });
    expect(result).toEqual({ Path: "C:\\new;C:\\old", FOO: "x" });
  });

  test("win32: dedupes case-insensitively against existing entries", () => {
    const result = mergePathDirs({ Path: "c:\\dup;C:\\keep" }, ["C:\\Dup"], {
      position: "prepend",
      platform: "win32",
    });
    expect(result.Path).toBe("C:\\Dup;C:\\keep");
  });

  test("win32: append places dirs after existing entries", () => {
    const result = mergePathDirs({ Path: "C:\\a" }, ["C:\\z"], {
      position: "append",
      platform: "win32",
    });
    expect(result.Path).toBe("C:\\a;C:\\z");
  });

  for (const platform of POSIX_PLATFORMS) {
    test(`${platform}: prepend and append with ':' delimiter under exact 'PATH'`, () => {
      const pre = mergePathDirs({ PATH: "/old" }, ["/new"], { position: "prepend", platform });
      expect(pre.PATH).toBe("/new:/old");
      const post = mergePathDirs({ PATH: "/old" }, ["/new"], { position: "append", platform });
      expect(post.PATH).toBe("/old:/new");
    });

    test(`${platform}: a 'Path'-spelled key is not treated as PATH`, () => {
      const result = mergePathDirs({ Path: "/not-path" }, ["/new"], {
        position: "prepend",
        platform,
      });
      expect(result.PATH).toBe("/new");
      expect(result.Path).toBe("/not-path");
    });
  }

  for (const platform of ALL_PLATFORMS) {
    test(`${platform}: creates PATH when absent and drops undefined values`, () => {
      const result = mergePathDirs({ GONE: undefined, KEEP: "y" }, ["/only"], {
        position: "append",
        platform,
      });
      expect(getEnv(result, "PATH", platform)).toBe("/only");
      expect(Object.hasOwn(result, "GONE")).toBe(false);
      expect(result.KEEP).toBe("y");
    });
  }
});

describe("runtimePathDirs", () => {
  const win32Runtime = {
    bin: "C:\\rt\\bin",
    node: "C:\\rt\\node\\node.exe",
    python: "C:\\rt\\python\\python.exe",
    git: "C:\\rt\\git\\cmd\\git.exe",
    popplerBin: "C:\\rt\\poppler\\bin",
  };
  const posixRuntime = {
    bin: "/rt/bin",
    node: "/rt/node/bin/node",
    python: "/rt/python/bin/python3",
    git: "/rt/git/bin/git",
    popplerBin: "/rt/poppler/bin",
  };

  test("win32: <pythonDir>\\Scripts is appended right after the python dir", () => {
    expect(runtimePathDirs(win32Runtime, "win32")).toEqual([
      "C:\\rt\\bin",
      "C:\\rt\\node",
      "C:\\rt\\python",
      "C:\\rt\\python\\Scripts",
      "C:\\rt\\git\\cmd",
      "C:\\rt\\poppler\\bin",
    ]);
  });

  for (const platform of POSIX_PLATFORMS) {
    test(`${platform}: no Scripts dir is ever added`, () => {
      const dirs = runtimePathDirs(posixRuntime, platform);
      expect(dirs).toEqual([
        "/rt/bin",
        "/rt/node/bin",
        "/rt/python/bin",
        "/rt/git/bin",
        "/rt/poppler/bin",
      ]);
      expect(dirs.some((dir) => dir.includes("Scripts"))).toBe(false);
    });
  }

  for (const platform of ALL_PLATFORMS) {
    test(`${platform}: omitted fields contribute nothing`, () => {
      expect(runtimePathDirs({}, platform)).toEqual([]);
    });
  }

  test("python-only runtime yields python dir (+ Scripts on win32 only)", () => {
    expect(runtimePathDirs({ python: "C:\\py\\python.exe" }, "win32")).toEqual([
      "C:\\py",
      "C:\\py\\Scripts",
    ]);
    expect(runtimePathDirs({ python: "/py/bin/python3" }, "linux")).toEqual(["/py/bin"]);
    expect(runtimePathDirs({ python: "/py/bin/python3" }, "darwin")).toEqual(["/py/bin"]);
  });

  test("win32: overlapping dirs are deduped case-insensitively", () => {
    const dirs = runtimePathDirs({ bin: "C:\\rt\\bin", node: "C:\\RT\\BIN\\node.exe" }, "win32");
    expect(dirs).toEqual(["C:\\rt\\bin"]);
  });
});

describe("defaultChildEnv", () => {
  const win32Base = {
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    COMSPEC: "C:\\Windows\\system32\\cmd.exe",
    Path: "C:\\Windows;C:\\bin",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    USERPROFILE: "C:\\Users\\me",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\me",
    APPDATA: "C:\\Users\\me\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    ProgramData: "C:\\ProgramData",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    TEMP: "C:\\tmp",
    TMP: "C:\\tmp",
    NUMBER_OF_PROCESSORS: "16",
    SECRET_TOKEN: "leak-me-not",
  };

  test("win32: guarantees every profile/system var, preserving inherited spellings", () => {
    const env = defaultChildEnv("win32", win32Base);
    expect(env).toEqual({
      SystemRoot: "C:\\Windows",
      windir: "C:\\Windows",
      COMSPEC: "C:\\Windows\\system32\\cmd.exe",
      Path: "C:\\Windows;C:\\bin",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: "C:\\Users\\me",
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\me",
      APPDATA: "C:\\Users\\me\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      ProgramData: "C:\\ProgramData",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      TEMP: "C:\\tmp",
      TMP: "C:\\tmp",
      NUMBER_OF_PROCESSORS: "16",
    });
    expect(Object.hasOwn(env, "SECRET_TOKEN")).toBe(false);
  });

  test("win32: matches oddly-cased inherited spellings case-insensitively", () => {
    const env = defaultChildEnv("win32", { systemroot: "C:\\Windows", comspec: "cmd" });
    expect(env).toEqual({ systemroot: "C:\\Windows", comspec: "cmd" });
  });

  for (const platform of POSIX_PLATFORMS) {
    test(`${platform}: copies PATH/HOME/LANG/LC_*/TERM/SHELL/USER/TMPDIR only, exact keys`, () => {
      const env = defaultChildEnv(platform, {
        PATH: "/bin",
        HOME: "/home/me",
        LANG: "en_US.UTF-8",
        LC_ALL: "C",
        LC_CTYPE: "en_US.UTF-8",
        LC_MESSAGES: "C",
        TERM: "xterm",
        SHELL: "/bin/zsh",
        USER: "me",
        TMPDIR: "/tmp",
        APPDATA: "not-a-posix-var",
        SECRET_TOKEN: "leak-me-not",
        Path: "wrong-case",
      });
      expect(env).toEqual({
        PATH: "/bin",
        HOME: "/home/me",
        LANG: "en_US.UTF-8",
        LC_ALL: "C",
        LC_CTYPE: "en_US.UTF-8",
        LC_MESSAGES: "C",
        TERM: "xterm",
        SHELL: "/bin/zsh",
        USER: "me",
        TMPDIR: "/tmp",
      });
    });

    test(`${platform}: 'Path' spelling is not treated as PATH`, () => {
      expect(defaultChildEnv(platform, { Path: "/bin" })).toEqual({});
    });
  }

  for (const platform of ALL_PLATFORMS) {
    test(`${platform}: missing and undefined base values are simply absent`, () => {
      expect(defaultChildEnv(platform, {})).toEqual({});
      expect(defaultChildEnv(platform, { PATH: undefined })).toEqual({});
    });
  }
});

describe("childEnv", () => {
  test("win32: an override 'path' replaces inherited 'Path' — never a second key", () => {
    const env = childEnv({ path: "C:\\override" }, "win32");
    // Build against a controlled base by checking key-count semantics directly.
    const keys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
    expect(keys).toHaveLength(1);
    expect(env[keys[0] as string]).toBe("C:\\override");
  });

  test("win32: undefined override deletes the inherited key case-insensitively", () => {
    const env = childEnv({ path: undefined }, "win32");
    expect(Object.keys(env).some((key) => key.toLowerCase() === "path")).toBe(false);
  });

  test("win32: novel override keys are added with their given spelling", () => {
    const env = childEnv({ MY_CUSTOM_VAR: "1" }, "win32");
    expect(env.MY_CUSTOM_VAR).toBe("1");
  });

  for (const platform of POSIX_PLATFORMS) {
    test(`${platform}: overrides use exact keys — 'path' does not replace PATH`, () => {
      const env = childEnv({ path: "/override" }, platform);
      expect(env.path).toBe("/override");
      // Whatever PATH the host contributes must be untouched by the lowercase override.
      if (Object.hasOwn(process.env, "PATH") && typeof process.env.PATH === "string") {
        expect(env.PATH).toBe(process.env.PATH);
      }
    });
  }

  for (const platform of ALL_PLATFORMS) {
    test(`${platform}: result contains only string values`, () => {
      const env = childEnv({ A: "1", B: undefined }, platform);
      for (const value of Object.values(env)) {
        expect(typeof value).toBe("string");
      }
      expect(Object.hasOwn(env, "B")).toBe(false);
    });
  }
});

describe("sandboxEnvAllowlist", () => {
  const base = [
    "CI",
    "COLORTERM",
    "COMSPEC",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "PATH",
    "PATHEXT",
    "SHELL",
    "SystemRoot",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "USER",
    "USERNAME",
    "WINDIR",
    "COWORK_RUNTIME_DIR",
    "COWORK_RUNTIME_VERSION",
    "COWORK_RUNTIME_ASSET",
    "COWORK_RUNTIME_BIN",
    "COWORK_RUNTIME_NODE",
    "COWORK_RUNTIME_PYTHON",
    "COWORK_RUNTIME_GIT",
    "COWORK_RUNTIME_NODE_MODULES",
    "COWORK_RUNTIME_NODE_RESOLVER",
    "COWORK_RUNTIME_POPPLER_BIN",
    "COWORK_RUNTIME_SOFFICE",
    "COWORK_RUNTIME_LIBREOFFICE_DIR",
    "COWORK_RUNTIME_LIBREOFFICE_BINARY",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PYTHONDONTWRITEBYTECODE",
    "SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION",
  ];
  const win32Extra = [
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "PYTHONUTF8",
    "PYTHONIOENCODING",
  ];

  for (const platform of ALL_PLATFORMS) {
    test(`${platform}: contains the full shared base list`, () => {
      const allowlist = sandboxEnvAllowlist(platform);
      for (const name of base) {
        expect(allowlist.has(name)).toBe(true);
      }
    });
  }

  test("win32: adds the profile/config and Python encoding vars", () => {
    const allowlist = sandboxEnvAllowlist("win32");
    for (const name of win32Extra) {
      expect(allowlist.has(name)).toBe(true);
    }
    expect(allowlist.size).toBe(base.length + win32Extra.length);
  });

  for (const platform of POSIX_PLATFORMS) {
    test(`${platform}: does NOT include the win32-only additions`, () => {
      const allowlist = sandboxEnvAllowlist(platform);
      for (const name of win32Extra) {
        expect(allowlist.has(name)).toBe(false);
      }
      expect(allowlist.size).toBe(base.length);
    });
  }
});

describe("minimalSandboxEnv", () => {
  test("win32: preserves the inherited key spelling ('Path', not 'PATH')", () => {
    const env = minimalSandboxEnv(
      { Path: "C:\\Windows;C:\\bin", userprofile: "C:\\Users\\me" },
      "win32",
    );
    expect(env).toEqual({ Path: "C:\\Windows;C:\\bin", userprofile: "C:\\Users\\me" });
  });

  test("win32: exact spelling is preferred when present", () => {
    const env = minimalSandboxEnv({ PATH: "exact", HOME: "C:\\Users\\me" }, "win32");
    expect(env).toEqual({ PATH: "exact", HOME: "C:\\Users\\me" });
  });

  test("win32: profile vars from the allowlist extension pass through", () => {
    const env = minimalSandboxEnv(
      {
        APPDATA: "C:\\Users\\me\\AppData\\Roaming",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        PYTHONUTF8: "1",
        SECRET_TOKEN: "leak-me-not",
      },
      "win32",
    );
    expect(env).toEqual({
      APPDATA: "C:\\Users\\me\\AppData\\Roaming",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      PYTHONUTF8: "1",
    });
  });

  for (const platform of POSIX_PLATFORMS) {
    test(`${platform}: exact-key matching only — 'path' does not satisfy PATH`, () => {
      const env = minimalSandboxEnv({ path: "/bin", PATH: "/usr/bin", HOME: "/home/me" }, platform);
      expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/me" });
    });

    test(`${platform}: win32-only profile vars are stripped`, () => {
      const env = minimalSandboxEnv({ APPDATA: "x", USERPROFILE: "y", PATH: "/bin" }, platform);
      expect(env).toEqual({ PATH: "/bin" });
    });
  }

  for (const platform of ALL_PLATFORMS) {
    test(`${platform}: non-allowlisted and undefined values never leak`, () => {
      const env = minimalSandboxEnv(
        { AWS_SECRET_ACCESS_KEY: "nope", PATH: undefined, CI: "true" },
        platform,
      );
      expect(env).toEqual({ CI: "true" });
    });

    test(`${platform}: cowork runtime pointers survive`, () => {
      const env = minimalSandboxEnv(
        { COWORK_RUNTIME_BIN: "/rt/bin", NODE_OPTIONS: "--import=x" },
        platform,
      );
      expect(env).toEqual({ COWORK_RUNTIME_BIN: "/rt/bin", NODE_OPTIONS: "--import=x" });
    });
  }
});
