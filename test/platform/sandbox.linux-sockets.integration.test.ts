import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { hostArch, hostPlatform } from "../../src/platform/host";
import { buildBwrapCommand } from "../../src/platform/sandbox/bwrap";
import { findBwrap, isBwrapUsable } from "../../src/platform/sandbox/detect";
import type { SandboxPolicy } from "../../src/platform/sandbox/policy";

// CI sets this to turn missing prerequisites into failures, never green skips.
// Requires native Linux, bubblewrap/user namespaces, and /usr/bin/python3.
const required = process.env.RUN_LINUX_SANDBOX_INTEGRATION === "1";
const linux = hostPlatform() === "linux";
const bwrap = linux ? findBwrap() : null;
const available = bwrap !== null && isBwrapUsable(bwrap);
const nativeDescribe = linux && (required || available) ? describe : describe.skip;
const python = "/usr/bin/python3";

function assertSuccess(result: ReturnType<typeof spawnSync>): void {
  expect({
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stderr: result.stderr?.toString(),
  }).toEqual({ status: 0, signal: null, error: undefined, stderr: "" });
}

function runPython(script: string, args: string[] = []): ReturnType<typeof spawnSync> {
  return spawnSync(python, ["-I", "-S", "-c", script, ...args], {
    encoding: "utf8",
    timeout: 3_000,
  });
}

async function listen(server: net.Server, endpoint: string | number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (typeof endpoint === "string") server.listen(endpoint, resolve);
    else server.listen(endpoint, "127.0.0.1", resolve);
  });
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

nativeDescribe("Linux socket mediation (native kernel enforcement)", () => {
  let root: string;
  let workspace: string;

  beforeAll(() => {
    expect(available).toBe(true);
    assertSuccess(runPython("import ctypes, socket"));
  });

  beforeEach(() => {
    root = fs.mkdtempSync("/tmp/cowork-linux-sockets-");
    workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function policy(network: boolean): SandboxPolicy {
    return { kind: "workspace-write", writableRoots: [workspace], network };
  }

  function command(script: string, sandboxPolicy: SandboxPolicy, args: string[] = []) {
    return buildBwrapCommand(
      { file: python, args: ["-I", "-S", "-c", script, ...args] },
      sandboxPolicy,
      workspace,
      { program: bwrap as string },
    );
  }

  function run(script: string, sandboxPolicy = policy(false), args: string[] = []) {
    const wrapped = command(script, sandboxPolicy, args);
    return spawnSync(wrapped.file, wrapped.args, { encoding: "utf8", timeout: 3_000 });
  }

  for (const kind of ["read-only", "no-project-write", "workspace-write"] as const) {
    test.each([false, true])(
      `${kind}, network=%s: denies arbitrary host pathname sockets, including writable aliases`,
      async (network) => {
        const endpoint = path.join(root, "host.sock");
        const alias = path.join(workspace, "alias.sock");
        const server = net.createServer((socket) => socket.end());
        const sandboxPolicy: SandboxPolicy =
          kind === "workspace-write"
            ? policy(network)
            : { kind, network, projectRoots: [workspace] };
        // Generate the plan BEFORE the socket exists: enumerating known socket
        // paths during construction cannot satisfy this regression.
        const script = `
import errno, socket, sys
for endpoint in sys.argv[1:]:
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(1)
        s.connect(endpoint)
    except OSError as error:
        assert error.errno in (errno.EPERM, errno.EACCES), error
    else:
        raise AssertionError("host socket reached: " + endpoint)
`;
        const wrapped = command(script, sandboxPolicy, [endpoint, alias]);
        await listen(server, endpoint);
        fs.symlinkSync(endpoint, alias);
        try {
          assertSuccess(
            runPython(
              "import socket, sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1])",
              [endpoint],
            ),
          );
          assertSuccess(
            spawnSync(wrapped.file, wrapped.args, { encoding: "utf8", timeout: 3_000 }),
          );
        } finally {
          await close(server);
        }
      },
    );
  }

  test("network-only full-access policy also denies Unix datagram sockets", () => {
    assertSuccess(
      run(
        `
import errno, socket
try:
    socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
except OSError as error:
    assert error.errno == errno.EPERM, error
else:
    raise AssertionError("Unix datagram socket was allowed")
`,
        { kind: "danger-full-access", network: false },
      ),
    );
  });

  test.each(["connect", "sendto"])(
    "denies datagram socketpair host %s, including bidirectional reconnect",
    (operation) => {
      const childScript = `
import errno, socket, sys
try:
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
except OSError as error:
    assert error.errno == errno.EPERM, error
    print("DENIED")
    sys.exit(0)
a.bind(sys.argv[1])
a.settimeout(1)
if sys.argv[3] == "connect":
    a.connect(sys.argv[2])
    a.send(b"sandbox-to-host")
    print("RECEIVED:" + a.recv(100).decode())
else:
    a.sendto(b"sandbox-to-host", sys.argv[2])
    print("SENT")
`;
      const wrapped = command(childScript, policy(false), ["CLIENT", "HOST", operation]);
      const coordinator = `
import json, os, socket, subprocess, sys, threading
command = json.loads(sys.argv[1])
client_path, host_path = sys.argv[2:4]
command["args"][-3:-1] = [client_path, host_path]
host = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
host.bind(host_path)
host.settimeout(0.02)
received = []
replies = []
stop = threading.Event()
def echo():
    while not stop.is_set():
        try:
            message, sender = host.recvfrom(100)
        except socket.timeout:
            continue
        received.append(message.decode())
        try:
            host.sendto(b"host-to-sandbox", sender)
            replies.append("sent")
        except OSError as error:
            replies.append(error.errno)
worker = threading.Thread(target=echo)
worker.start()
try:
    result = subprocess.run([command["file"]] + command["args"], capture_output=True,
                            text=True, timeout=2)
    # Drain any queued one-way datagram before stopping the host.
    stop.wait(0.04)
finally:
    stop.set()
    worker.join()
    host.close()
    for endpoint in (host_path, client_path):
        if os.path.exists(endpoint):
            os.unlink(endpoint)
print(json.dumps({"status": result.returncode, "stdout": result.stdout.strip(),
                  "stderr": result.stderr, "received": received, "replies": replies}))
`;
      const probe = (inner: { file: string; args: string[] }) => {
        const result = runPython(coordinator, [
          JSON.stringify(inner),
          path.join(workspace, "client.sock"),
          path.join(root, "host.sock"),
        ]);
        assertSuccess(result);
        return JSON.parse(result.stdout.toString());
      };
      // Unsandboxed positive control proves the actual host send/receive
      // channel, rather than treating failure to reach any daemon as a pass.
      const control = probe({
        file: python,
        args: ["-I", "-S", "-c", childScript, "CLIENT", "HOST", operation],
      });
      expect(control).toMatchObject({
        status: 0,
        stderr: "",
        received: ["sandbox-to-host"],
        stdout: operation === "connect" ? "RECEIVED:host-to-sandbox" : "SENT",
      });
      if (operation === "connect") expect(control.replies).toEqual(["sent"]);
      expect(probe(wrapped)).toEqual({
        status: 0,
        stderr: "",
        stdout: "DENIED",
        received: [],
        replies: [],
      });
    },
  );

  test.each(["SOCK_STREAM", "SOCK_SEQPACKET"])(
    "%s pairs cannot acquire host peers through binding, disconnect, shutdown, or peer close",
    (type) => {
      const childScript = `
import ctypes, errno, os, socket, sys
kind = getattr(socket, sys.argv[3])
libc = ctypes.CDLL(None, use_errno=True)
for phase in ("live", "AF_UNSPEC", "shutdown", "peer-close", "shutdown-peer-close"):
    try:
        a, b = socket.socketpair(socket.AF_UNIX, kind)
    except OSError as error:
        assert error.errno == errno.EPERM
        print("DENIED", flush=True)
        sys.exit(0)
    a.settimeout(0.2)
    b.settimeout(0.2)
    endpoint = sys.argv[1] + "-" + phase
    a.bind(endpoint)
    # Binding is allowed, but must not change the pair's send/receive peer.
    a.sendall(b"to-peer")
    assert b.recv(100) == b"to-peer"
    b.sendall(b"from-peer")
    assert a.recv(100) == b"from-peer"
    try:
        a.sendto(b"addressed-send", sys.argv[2])
    except OSError as error:
        assert error.errno == errno.EISCONN, error
    else:
        # SEQPACKET ignores the supplied address and sends to its paired peer.
        assert kind == socket.SOCK_SEQPACKET
        assert b.recv(100) == b"addressed-send"
    if phase == "AF_UNSPEC":
        address = ctypes.create_string_buffer(b"\\x00\\x00")
        assert libc.connect(a.fileno(), address, 2) == -1
        assert ctypes.get_errno() in (errno.EINVAL, errno.EAFNOSUPPORT)
    if "shutdown" in phase:
        a.shutdown(socket.SHUT_RDWR)
    if "peer-close" in phase:
        b.close()
    try:
        a.connect(sys.argv[2])
    except OSError as error:
        assert error.errno == errno.EISCONN, error
    else:
        raise AssertionError("pair reconnected to host")
    # listen() can succeed even on a bound pair. Test the host-facing result,
    # rather than assuming a successful listen implies a connectable endpoint.
    try:
        a.listen()
    except OSError as error:
        assert error.errno == errno.EINVAL
    print(endpoint, flush=True)
    assert sys.stdin.readline().strip() == "checked"
    a.close()
    b.close()
    os.unlink(endpoint)
`;
      const coordinator = `
import errno, json, os, select, socket, subprocess, sys
command = json.loads(sys.argv[1])
client_path, host_path, type_name = sys.argv[2:5]
command["args"][-3:-1] = [client_path, host_path]
kind = getattr(socket, type_name)
host = socket.socket(socket.AF_UNIX, kind)
host.bind(host_path)
host.listen()
host.settimeout(0.2)
# Prove this ephemeral host listener can accept real connections.
control = socket.socket(socket.AF_UNIX, kind)
control.connect(host_path)
accepted, _ = host.accept()
control.close()
accepted.close()
child = subprocess.Popen([command["file"]] + command["args"], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
checked = []
try:
    for line in child.stdout:
        endpoint = line.strip()
        if endpoint == "DENIED":
            checked.append(endpoint)
            break
        assert endpoint.startswith(client_path + "-")
        # Neither a stream/seqpacket client nor an unrelated datagram sender
        # may inject data into the bound socketpair from the host.
        with socket.socket(socket.AF_UNIX, kind) as sender:
            sender.settimeout(0.2)
            try:
                sender.connect(endpoint)
            except OSError as error:
                assert error.errno == errno.ECONNREFUSED, error
            else:
                raise AssertionError("host connected to bound socketpair")
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sender:
            try:
                sender.sendto(b"host-injection", endpoint)
            except OSError as error:
                assert error.errno in (errno.EPROTOTYPE, errno.ECONNREFUSED), error
            else:
                raise AssertionError("host injected datagram into socketpair")
        assert not select.select([host], [], [], 0)[0], "pair reached host listener"
        checked.append(endpoint.removeprefix(client_path + "-"))
        child.stdin.write("checked\\n")
        child.stdin.flush()
    status = child.wait(timeout=1)
    stderr = child.stderr.read()
    assert status == 0 and stderr == "", (status, stderr)
    print(json.dumps(checked))
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    host.close()
    os.unlink(host_path)
`;
      const probe = (inner: { file: string; args: string[] }) => {
        const result = runPython(coordinator, [
          JSON.stringify(inner),
          path.join(workspace, "pair"),
          path.join(root, "host.sock"),
          type,
        ]);
        assertSuccess(result);
        return JSON.parse(result.stdout.toString());
      };
      const phases = ["live", "AF_UNSPEC", "shutdown", "peer-close", "shutdown-peer-close"];
      expect(
        probe({
          file: python,
          args: ["-I", "-S", "-c", childScript, "CLIENT", "HOST", type],
        }),
      ).toEqual(phases);
      expect(probe(command(childScript, policy(false), ["CLIENT", "HOST", type]))).toEqual(
        type === "SOCK_STREAM" ? phases : ["DENIED"],
      );
    },
  );

  test("socketpair permits only Unix streams, including flags and truncated syscall arguments", () => {
    assertSuccess(
      run(`
import ctypes, errno, os, socket
libc = ctypes.CDLL(None, use_errno=True)
number = {"x86_64": 53, "aarch64": 199}[os.uname().machine]
for domain in (socket.AF_UNIX, socket.AF_INET):
    for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM, socket.SOCK_SEQPACKET):
        for flags in (0, socket.SOCK_CLOEXEC, socket.SOCK_NONBLOCK,
                      socket.SOCK_CLOEXEC | socket.SOCK_NONBLOCK):
            fds = (ctypes.c_int * 2)(-1, -1)
            result = libc.syscall(number, ctypes.c_ulonglong(0x100000000 | domain),
                                  ctypes.c_ulonglong(0x100000000 | kind | flags), 0, fds)
            if domain == socket.AF_UNIX and kind == socket.SOCK_STREAM:
                assert result == 0, ctypes.get_errno()
                os.close(fds[0])
                os.close(fds[1])
            else:
                assert result == -1 and ctypes.get_errno() == errno.EPERM
`),
    );
  });

  test("preserves anonymous socketpair IPC and inherited enforcement after exec", () => {
    assertSuccess(
      run(`
import errno, os, socket, subprocess, sys
a, b = socket.socketpair()
a.sendall(b"ok")
assert b.recv(2) == b"ok"
a.close()
b.close()
child = subprocess.run([sys.executable, "-I", "-S", "-c", """
import errno, socket
try:
    socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
except OSError as error:
    assert error.errno == errno.EPERM
else:
    raise AssertionError("child bypassed mediation")
"""], check=True)
`),
    );
  });

  test.each([false, true])("TCP follows the explicit network policy (%s)", async (network) => {
    const server = net.createServer((socket) => socket.end());
    await listen(server, 0);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("TCP server did not bind");
      const script = `
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(1)
try:
    s.connect(("127.0.0.1", int(sys.argv[1])))
except OSError:
    assert sys.argv[2] == "denied"
else:
    assert sys.argv[2] == "allowed"
`;
      assertSuccess(runPython(script, [String(address.port), "allowed"]));
      assertSuccess(
        run(script, policy(network), [String(address.port), network ? "allowed" : "denied"]),
      );
    } finally {
      await close(server);
    }
  });

  test("blocks direct socket syscalls and io_uring alternate socket operations", () => {
    assertSuccess(
      run(`
import ctypes, errno, os
libc = ctypes.CDLL(None, use_errno=True)
number = {"x86_64": 41, "aarch64": 198}[os.uname().machine]
# The kernel truncates the socket domain to 32 bits.
assert libc.syscall(number, ctypes.c_ulonglong(0x100000001), 1, 0) == -1
assert ctypes.get_errno() == errno.EPERM
for syscall in (425, 426, 427):
    assert libc.syscall(syscall, 0, 0, 0, 0, 0, 0) == -1
    assert ctypes.get_errno() == errno.ENOSYS
if os.uname().machine == "x86_64":
    assert libc.syscall(0x40000029, 1, 1, 0) == -1
    assert ctypes.get_errno() == errno.ENOSYS
`),
    );
  });

  test.skipIf(hostArch() !== "x64")("kills the i386 compatibility syscall bypass on x86-64", () => {
    // A harmless getpid through int 0x80 proves the foreign-ABI entry path is
    // killed, not just native socket(2). No multilib compiler/runtime needed.
    const script = `
import ctypes, mmap, resource
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
code = mmap.mmap(-1, mmap.PAGESIZE, prot=mmap.PROT_READ | mmap.PROT_WRITE | mmap.PROT_EXEC)
code.write(bytes.fromhex("b8 14 00 00 00 cd 80 c3"))
address = ctypes.addressof(ctypes.c_char.from_buffer(code))
ctypes.CFUNCTYPE(ctypes.c_int)(address)()
`;
    assertSuccess(runPython(script));
    const result = run(script);
    expect(result.error).toBeUndefined();
    expect(result.signal === "SIGSYS" || result.status === 128 + 31).toBe(true);
  });

  test("fails closed before the command when the kernel refuses filter installation", () => {
    // An outer seccomp filter refuses prctl, forcing a real setup failure in
    // the launcher rather than mocking its success/error handling.
    const instructions = [
      [0x20, 0, 0, 0],
      [0x15, 0, 1, hostArch() === "x64" ? 157 : 167],
      [0x06, 0, 0, 0x00050001],
      [0x06, 0, 0, 0x7fff0000],
    ];
    const bytes = Buffer.alloc(instructions.length * 8);
    for (const [index, instruction] of instructions.entries()) {
      bytes.writeUInt16LE(instruction[0], index * 8);
      bytes[index * 8 + 2] = instruction[1];
      bytes[index * 8 + 3] = instruction[2];
      bytes.writeUInt32LE(instruction[3], index * 8 + 4);
    }
    const filterPath = path.join(root, "deny-prctl.bpf");
    fs.writeFileSync(filterPath, bytes);
    const fd = fs.openSync(filterPath, "r");
    const marker = path.join(workspace, "must-not-run");
    const wrapped = command("import sys; open(sys.argv[1], 'w').write('escape')", policy(false), [
      marker,
    ]);
    try {
      const result = spawnSync(wrapped.file, ["--seccomp", "3", ...wrapped.args], {
        stdio: ["ignore", "pipe", "pipe", fd],
        encoding: "utf8",
        timeout: 3_000,
      });
      expect(result.status).toBe(125);
      expect(result.stderr).toContain("Linux sandbox socket mediation failed:");
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.closeSync(fd);
    }
  });

  test("fails closed when the system launcher is unavailable", () => {
    const marker = path.join(workspace, "must-not-run");
    const wrapped = command("import sys; open(sys.argv[1], 'w').write('escape')", policy(false), [
      marker,
    ]);
    const separator = wrapped.args.indexOf("--");
    // Mask only the interpreter executable in this disposable mount namespace.
    wrapped.args.splice(separator, 0, "--ro-bind", "/dev/null", fs.realpathSync(python));
    const result = spawnSync(wrapped.file, wrapped.args, { encoding: "utf8", timeout: 3_000 });
    expect(result.status).not.toBe(0);
    expect(result.error).toBeUndefined();
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("ordinary shell and Bun subprocesses retain workspace writes and filesystem denials", () => {
    const wrapped = buildBwrapCommand(
      {
        file: "/bin/sh",
        args: [
          "-c",
          'printf ok > allowed.txt && "$1" -e \'const p = Bun.spawnSync(["/bin/echo", "ok"]); if(p.exitCode !== 0) process.exit(1)\'',
          "sandbox-smoke",
          process.execPath,
        ],
      },
      policy(false),
      workspace,
      { program: bwrap as string },
    );
    assertSuccess(spawnSync(wrapped.file, wrapped.args, { encoding: "utf8", timeout: 3_000 }));
    expect(fs.readFileSync(path.join(workspace, "allowed.txt"), "utf8")).toBe("ok");
    assertSuccess(
      run(
        `
import errno, sys
try:
    open(sys.argv[1], "w").write("escape")
except OSError as error:
    assert error.errno in (errno.EROFS, errno.EACCES, errno.EPERM)
else:
    raise AssertionError("outside write was allowed")
`,
        policy(false),
        [path.join(root, "outside.txt")],
      ),
    );
  });
});
