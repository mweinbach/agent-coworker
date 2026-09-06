/**
 * Runs INSIDE bubblewrap, before any user-controlled executable. Python's
 * isolated/no-site flags prevent cwd, PYTHONPATH, and sitecustomize imports.
 * The harness must still pass its minimal sandbox environment (in particular
 * no LD_PRELOAD/LD_LIBRARY_PATH), just as for bubblewrap itself.
 *
 * A read-only bind does not prevent connecting to pathname Unix sockets, even
 * in a new network namespace. Deny their creation rather than enumerating
 * socket paths (which misses writable aliases and sockets created later).
 * Only AF_UNIX/SOCK_STREAM socketpairs remain available for child/runtime IPC.
 * Datagram pairs can reconnect or sendto host sockets; allowlisting socket()
 * alone is insufficient. Stream pairs cannot disconnect/reconnect, and binding
 * them to a pathname does not make them connectable by unrelated host sockets.
 *
 * Requires the system /usr/bin/python3 with ctypes, Linux seccomp, and a native
 * x86-64 or AArch64 ABI. Every setup failure stops before exec: no fallback.
 * Bundled as source text so compiled Bun sidecars need no adjacent .py file,
 * writable helper cache, libseccomp installation, or runtime compilation.
 */
export const LINUX_SOCKET_FILTER_LAUNCHER = `
import ctypes
import errno
import os
import sys

def launch():
    architectures = {
        "x86_64": (0xc000003e, 41, 53),
        "aarch64": (0xc00000b7, 198, 199),
    }
    machine = os.uname().machine
    if machine not in architectures or sys.byteorder != "little":
        raise RuntimeError("unsupported Linux seccomp architecture: " + machine)
    arch, socket_syscall, socketpair_syscall = architectures[machine]

    class Filter(ctypes.Structure):
        _fields_ = [
            ("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
            ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint),
        ]

    class Program(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]

    # Classic BPF over struct seccomp_data. Reject foreign ABIs before checking
    # syscall numbers: e.g. i386 socketcall must never bypass the native rule.
    load, equal, greater_equal, and_bits, ret = 0x20, 0x15, 0x35, 0x54, 0x06
    kill_process, allow, error = 0x80000000, 0x7fff0000, 0x00050000
    instructions = [
        (load, 0, 0, 4),                 # seccomp_data.arch
        (equal, 1, 0, arch),
        (ret, 0, 0, kill_process),
        (load, 0, 0, 0),                 # seccomp_data.nr
    ]
    if machine == "x86_64":
        # x32 shares AUDIT_ARCH_X86_64 but has a distinct syscall table.
        instructions += [
            (greater_equal, 0, 1, 0x40000000),
            (ret, 0, 0, error | errno.ENOSYS),
        ]
    # io_uring can create/connect sockets without executing socket(2). Disable
    # its entire syscall entry surface; ENOSYS lets normal runtimes fall back.
    for number in (425, 426, 427):
        instructions += [(equal, 0, 1, number), (ret, 0, 0, error | errno.ENOSYS)]
    instructions += [
        (equal, 0, 4, socket_syscall),
        (load, 0, 0, 16),                # low 32 bits of args[0] (int domain)
        (equal, 0, 1, 1),                # AF_UNIX / AF_LOCAL, every socket type
        (ret, 0, 0, error | errno.EPERM),
        (ret, 0, 0, allow),
        (equal, 1, 0, socketpair_syscall),
        (ret, 0, 0, allow),
        (load, 0, 0, 16),                # socketpair domain must be AF_UNIX
        (equal, 0, 4, 1),
        (load, 0, 0, 24),                # low 32 bits of args[1] (int type)
        (and_bits, 0, 0, 0xfff7f7ff),    # strip only SOCK_CLOEXEC | SOCK_NONBLOCK
        (equal, 0, 1, 1),                # SOCK_STREAM only, never DGRAM/SEQPACKET
        (ret, 0, 0, allow),
        (ret, 0, 0, error | errno.EPERM),
    ]
    filters = (Filter * len(instructions))(*(Filter(*item) for item in instructions))
    program = Program(len(instructions), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int] + [ctypes.c_ulong] * 4
    libc.prctl.restype = ctypes.c_int
    # PR_SET_NO_NEW_PRIVS is irreversible and survives exec, as does seccomp.
    for operation, arg2, arg3 in ((38, 1, 0), (22, 2, ctypes.addressof(program))):
        if libc.prctl(operation, arg2, arg3, 0, 0) != 0:
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))
    if len(sys.argv) < 3 or sys.argv[1] != "--":
        raise RuntimeError("missing sandbox command")
    os.execvp(sys.argv[2], sys.argv[2:])

try:
    launch()
except Exception as error:
    print("Linux sandbox socket mediation failed: " + str(error), file=sys.stderr)
    sys.exit(125)
`;
