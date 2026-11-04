/// Classic BPF instruction matching Linux `<linux/filter.h>` `struct sock_filter`.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinuxSeccompInstruction {
    pub code: u16,
    pub jt: u8,
    pub jf: u8,
    pub k: u32,
}

// Classic BPF opcodes.
pub const BPF_LD_ABS: u16 = 0x20;
pub const BPF_ALU_AND_K: u16 = 0x54;
pub const BPF_JMP_JA: u16 = 0x05;
pub const BPF_JMP_JEQ_K: u16 = 0x15;
pub const BPF_JMP_JGE_K: u16 = 0x35;
pub const BPF_RET_K: u16 = 0x06;

// Linux audit architectures (`<linux/audit.h>`).
pub const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;
pub const AUDIT_ARCH_AARCH64: u32 = 0xc000_00b7;
pub const AUDIT_ARCH_I386: u32 = 0x4000_0003;
pub const X32_SYSCALL_BIT: u32 = 0x4000_0000;

// Seccomp return values (`<linux/seccomp.h>`).
pub const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
pub const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
pub const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
pub const LINUX_EPERM: u32 = 1;
pub const LINUX_ENOSYS: u32 = 38;
pub const SECCOMP_RET_ERRNO_EPERM: u32 = SECCOMP_RET_ERRNO | LINUX_EPERM;
pub const SECCOMP_RET_ERRNO_ENOSYS: u32 = SECCOMP_RET_ERRNO | LINUX_ENOSYS;

// Linux socket domains & types (`<linux/socket.h>`).
pub const LINUX_AF_UNIX: u32 = 1;
pub const LINUX_AF_INET: u32 = 2;
pub const LINUX_AF_INET6: u32 = 10;
pub const LINUX_AF_NETLINK: u32 = 16;
pub const LINUX_AF_PACKET: u32 = 17;
pub const LINUX_AF_VSOCK: u32 = 40;
pub const LINUX_SOCK_STREAM: u32 = 1;
pub const LINUX_SOCK_DGRAM: u32 = 2;
pub const LINUX_SOCK_SEQPACKET: u32 = 5;
pub const LINUX_SOCK_CLOEXEC: u32 = 0x0008_0000;
pub const LINUX_SOCK_NONBLOCK: u32 = 0x0000_0800;
pub const LINUX_SOCKET_TYPE_MASK: u32 = !(LINUX_SOCK_CLOEXEC | LINUX_SOCK_NONBLOCK);

// Syscall numbers.
pub const X86_64_SYS_SOCKET: u32 = 41;
pub const X86_64_SYS_SOCKETPAIR: u32 = 53;
pub const AARCH64_SYS_SOCKET: u32 = 198;
pub const AARCH64_SYS_SOCKETPAIR: u32 = 199;
pub const SYS_IO_URING_SETUP: u32 = 425;
pub const SYS_IO_URING_ENTER: u32 = 426;
pub const SYS_IO_URING_REGISTER: u32 = 427;

// `struct seccomp_data` field byte offsets (little-endian x86_64 & aarch64).
const SECCOMP_OFFSET_NR: u32 = 0;
const SECCOMP_OFFSET_ARCH: u32 = 4;
const SECCOMP_OFFSET_ARG0_LO: u32 = 16;
const SECCOMP_OFFSET_ARG1_LO: u32 = 24;

/// Maximum classic BPF instructions emitted by `build_linux_socket_filter_fixed`.
pub const MAX_LINUX_SECCOMP_INSNS: usize = 32;

#[derive(Clone, Copy)]
enum Label {
    X86Dispatch = 0,
    Arm64Dispatch = 1,
    CheckCommon = 2,
    CheckSocket = 3,
    CheckSocketpair = 4,
    RetAllow = 5,
    RetEperm = 6,
    RetEnosys = 7,
}
const NUM_LABELS: usize = 8;

#[derive(Clone, Copy)]
struct PendingFixup {
    insn_idx: usize,
    is_ja: bool,
    true_label: Option<Label>,
    false_label: Option<Label>,
}

/// Zero-heap stack assembler for classic BPF programs, safe to invoke inside `pre_exec`.
struct StackBpfAsm {
    insns: [LinuxSeccompInstruction; MAX_LINUX_SECCOMP_INSNS],
    len: usize,
    labels: [Option<usize>; NUM_LABELS],
    fixups: [PendingFixup; MAX_LINUX_SECCOMP_INSNS],
    fixups_len: usize,
}

impl StackBpfAsm {
    const fn new() -> Self {
        Self {
            insns: [LinuxSeccompInstruction {
                code: 0,
                jt: 0,
                jf: 0,
                k: 0,
            }; MAX_LINUX_SECCOMP_INSNS],
            len: 0,
            labels: [None; NUM_LABELS],
            fixups: [PendingFixup {
                insn_idx: 0,
                is_ja: false,
                true_label: None,
                false_label: None,
            }; MAX_LINUX_SECCOMP_INSNS],
            fixups_len: 0,
        }
    }

    fn bind(&mut self, label: Label) {
        self.labels[label as usize] = Some(self.len);
    }

    fn emit(&mut self, code: u16, jt: u8, jf: u8, k: u32) {
        self.insns[self.len] = LinuxSeccompInstruction { code, jt, jf, k };
        self.len += 1;
    }

    fn emit_ja(&mut self, target: Label) {
        let idx = self.len;
        self.emit(BPF_JMP_JA, 0, 0, 0);
        self.fixups[self.fixups_len] = PendingFixup {
            insn_idx: idx,
            is_ja: true,
            true_label: Some(target),
            false_label: None,
        };
        self.fixups_len += 1;
    }

    fn emit_cond(
        &mut self,
        code: u16,
        k: u32,
        true_label: Option<Label>,
        false_label: Option<Label>,
    ) {
        let idx = self.len;
        self.emit(code, 0, 0, k);
        if true_label.is_some() || false_label.is_some() {
            self.fixups[self.fixups_len] = PendingFixup {
                insn_idx: idx,
                is_ja: false,
                true_label,
                false_label,
            };
            self.fixups_len += 1;
        }
    }

    fn finish(mut self) -> ([LinuxSeccompInstruction; MAX_LINUX_SECCOMP_INSNS], usize) {
        for i in 0..self.fixups_len {
            let fix = self.fixups[i];
            let base = fix.insn_idx + 1;
            if fix.is_ja {
                let target = self.labels[fix.true_label.unwrap() as usize].unwrap();
                self.insns[fix.insn_idx].k = (target - base) as u32;
            } else {
                if let Some(tl) = fix.true_label {
                    let target = self.labels[tl as usize].unwrap();
                    self.insns[fix.insn_idx].jt = (target - base) as u8;
                }
                if let Some(fl) = fix.false_label {
                    let target = self.labels[fl as usize].unwrap();
                    self.insns[fix.insn_idx].jf = (target - base) as u8;
                }
            }
        }
        (self.insns, self.len)
    }
}

/// Builds the Linux seccomp-BPF syscall filter into a stack-allocated array without heap allocation
/// (100% async-signal-safe for `CommandExt::pre_exec`).
///
/// Enforces:
/// - Foreign architecture (`!= x86_64 && != aarch64`) -> `SECCOMP_RET_KILL_PROCESS`
/// - x86_64 x32 ABI (`nr >= 0x40000000`) -> `ENOSYS`
/// - `io_uring_setup` / `io_uring_enter` / `io_uring_register` -> `ENOSYS`
/// - `socket(AF_UNIX, ...)` -> `EPERM` (blocks host Unix-domain sockets inside shared `/`)
/// - When `deny_network == true`, `socket(AF_INET | AF_INET6 | AF_NETLINK | AF_PACKET | AF_VSOCK, ...)` -> `EPERM`
/// - `socketpair(...)` -> allows ONLY `AF_UNIX` + `SOCK_STREAM` (plus `SOCK_CLOEXEC | SOCK_NONBLOCK`);
///   rejects `SOCK_DGRAM` / `SOCK_SEQPACKET` (blocking `SCM_RIGHTS` fd-passing tricks) with `EPERM`.
pub fn build_linux_socket_filter_fixed(
    deny_network: bool,
) -> ([LinuxSeccompInstruction; MAX_LINUX_SECCOMP_INSNS], usize) {
    let mut a = StackBpfAsm::new();

    // 1. Validate architecture.
    a.emit(BPF_LD_ABS, 0, 0, SECCOMP_OFFSET_ARCH);
    a.emit_cond(
        BPF_JMP_JEQ_K,
        AUDIT_ARCH_X86_64,
        Some(Label::X86Dispatch),
        None,
    );
    a.emit_cond(
        BPF_JMP_JEQ_K,
        AUDIT_ARCH_AARCH64,
        Some(Label::Arm64Dispatch),
        None,
    );
    a.emit(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS);

    // 2. x86_64 syscall dispatch + x32 ABI guard.
    a.bind(Label::X86Dispatch);
    a.emit(BPF_LD_ABS, 0, 0, SECCOMP_OFFSET_NR);
    a.emit_cond(BPF_JMP_JGE_K, X32_SYSCALL_BIT, Some(Label::RetEnosys), None);
    a.emit_cond(
        BPF_JMP_JEQ_K,
        X86_64_SYS_SOCKET,
        Some(Label::CheckSocket),
        None,
    );
    a.emit_cond(
        BPF_JMP_JEQ_K,
        X86_64_SYS_SOCKETPAIR,
        Some(Label::CheckSocketpair),
        None,
    );
    a.emit_ja(Label::CheckCommon);

    // 3. aarch64 syscall dispatch.
    a.bind(Label::Arm64Dispatch);
    a.emit(BPF_LD_ABS, 0, 0, SECCOMP_OFFSET_NR);
    a.emit_cond(
        BPF_JMP_JEQ_K,
        AARCH64_SYS_SOCKET,
        Some(Label::CheckSocket),
        None,
    );
    a.emit_cond(
        BPF_JMP_JEQ_K,
        AARCH64_SYS_SOCKETPAIR,
        Some(Label::CheckSocketpair),
        None,
    );

    // 4. Shared io_uring block (`425`, `426`, `427`).
    a.bind(Label::CheckCommon);
    a.emit_cond(
        BPF_JMP_JEQ_K,
        SYS_IO_URING_SETUP,
        Some(Label::RetEnosys),
        None,
    );
    a.emit_cond(
        BPF_JMP_JEQ_K,
        SYS_IO_URING_ENTER,
        Some(Label::RetEnosys),
        None,
    );
    a.emit_cond(
        BPF_JMP_JEQ_K,
        SYS_IO_URING_REGISTER,
        Some(Label::RetEnosys),
        Some(Label::RetAllow),
    );

    // 5. `socket(domain, ...)` check.
    a.bind(Label::CheckSocket);
    a.emit(BPF_LD_ABS, 0, 0, SECCOMP_OFFSET_ARG0_LO);
    if deny_network {
        a.emit_cond(BPF_JMP_JEQ_K, LINUX_AF_UNIX, Some(Label::RetEperm), None);
        a.emit_cond(BPF_JMP_JEQ_K, LINUX_AF_INET, Some(Label::RetEperm), None);
        a.emit_cond(BPF_JMP_JEQ_K, LINUX_AF_INET6, Some(Label::RetEperm), None);
        a.emit_cond(BPF_JMP_JEQ_K, LINUX_AF_NETLINK, Some(Label::RetEperm), None);
        a.emit_cond(BPF_JMP_JEQ_K, LINUX_AF_PACKET, Some(Label::RetEperm), None);
        a.emit_cond(
            BPF_JMP_JEQ_K,
            LINUX_AF_VSOCK,
            Some(Label::RetEperm),
            Some(Label::RetAllow),
        );
    } else {
        a.emit_cond(
            BPF_JMP_JEQ_K,
            LINUX_AF_UNIX,
            Some(Label::RetEperm),
            Some(Label::RetAllow),
        );
    }

    // 6. `socketpair(domain, type, ...)` check.
    a.bind(Label::CheckSocketpair);
    a.emit(BPF_LD_ABS, 0, 0, SECCOMP_OFFSET_ARG0_LO);
    a.emit_cond(BPF_JMP_JEQ_K, LINUX_AF_UNIX, None, Some(Label::RetEperm));
    a.emit(BPF_LD_ABS, 0, 0, SECCOMP_OFFSET_ARG1_LO);
    a.emit(BPF_ALU_AND_K, 0, 0, LINUX_SOCKET_TYPE_MASK);
    a.emit_cond(
        BPF_JMP_JEQ_K,
        LINUX_SOCK_STREAM,
        Some(Label::RetAllow),
        Some(Label::RetEperm),
    );

    // 7. Terminal returns.
    a.bind(Label::RetAllow);
    a.emit(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW);
    a.bind(Label::RetEperm);
    a.emit(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM);
    a.bind(Label::RetEnosys);
    a.emit(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_ENOSYS);

    a.finish()
}

/// Builds the Linux seccomp-BPF filter as a `Vec<LinuxSeccompInstruction>`.
pub fn build_linux_socket_filter(deny_network: bool) -> Vec<LinuxSeccompInstruction> {
    let (buf, len) = build_linux_socket_filter_fixed(deny_network);
    buf[..len].to_vec()
}

/// Pure-Rust classic BPF evaluator over a synthetic `struct seccomp_data` buffer so unit tests on
/// any host OS (macOS, Linux, Windows) can verify exact syscall filter behavior.
pub fn evaluate_seccomp_bpf(
    program: &[LinuxSeccompInstruction],
    arch: u32,
    nr: u32,
    args: [u64; 6],
) -> Result<u32, &'static str> {
    if program.is_empty() {
        return Err("empty BPF program");
    }
    let mut data = [0u8; 64];
    data[0..4].copy_from_slice(&nr.to_le_bytes());
    data[4..8].copy_from_slice(&arch.to_le_bytes());
    // bytes 8..16: instruction_pointer = 0
    for (idx, arg) in args.iter().enumerate() {
        let off = 16 + idx * 8;
        data[off..off + 8].copy_from_slice(&arg.to_le_bytes());
    }

    let mut acc: u32 = 0;
    let mut pc: usize = 0;
    let mut steps: usize = 0;

    while pc < program.len() {
        steps += 1;
        if steps > 1024 {
            return Err("BPF loop limit exceeded");
        }
        let insn = program[pc];
        match insn.code {
            BPF_LD_ABS => {
                let off = insn.k as usize;
                if off + 4 > data.len() {
                    return Err("BPF out-of-bounds seccomp_data load");
                }
                acc = u32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]);
                pc += 1;
            }
            BPF_ALU_AND_K => {
                acc &= insn.k;
                pc += 1;
            }
            BPF_JMP_JA => {
                pc = pc + 1 + (insn.k as usize);
            }
            BPF_JMP_JEQ_K => {
                let delta = if acc == insn.k { insn.jt } else { insn.jf };
                pc = pc + 1 + (delta as usize);
            }
            BPF_JMP_JGE_K => {
                let delta = if acc >= insn.k { insn.jt } else { insn.jf };
                pc = pc + 1 + (delta as usize);
            }
            BPF_RET_K => {
                return Ok(insn.k);
            }
            _ => return Err("unsupported classic BPF opcode"),
        }
    }
    Err("BPF program fell off end without RET")
}

/// Applies `PR_SET_NO_NEW_PRIVS` + `PR_SET_SECCOMP` (`SECCOMP_MODE_FILTER`) in the calling thread.
///
/// Async-signal-safe on Linux: performs zero heap allocations and zero locks, so it can run
/// directly inside `std::os::unix::process::CommandExt::pre_exec` or before `execvp`.
#[cfg(target_os = "linux")]
pub fn apply_linux_seccomp_filter(deny_network: bool) -> std::io::Result<()> {
    #[repr(C)]
    struct SockFprog {
        len: libc::c_ushort,
        filter: *const LinuxSeccompInstruction,
    }

    let (buf, len) = build_linux_socket_filter_fixed(deny_network);
    let prog = SockFprog {
        len: len as libc::c_ushort,
        filter: buf.as_ptr(),
    };

    // SAFETY: `prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)` and `prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog)`
    // pass valid kernel constants and a stack-resident `sock_fprog` pointing to `len` valid `sock_filter` entries.
    unsafe {
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        if libc::prctl(
            libc::PR_SET_SECCOMP,
            libc::SECCOMP_MODE_FILTER,
            &prog as *const SockFprog,
            0,
            0,
        ) != 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Registers a Linux `pre_exec` hook on `cmd` that installs the native Rust seccomp-BPF filter
/// in the forked child immediately before `execve`.
#[cfg(target_os = "linux")]
pub fn install_linux_seccomp_pre_exec(cmd: &mut std::process::Command, deny_network: bool) {
    use std::os::unix::process::CommandExt;
    // SAFETY: `apply_linux_seccomp_filter` uses only stack memory and raw `prctl` syscalls
    // (async-signal-safe between `fork` and `exec`).
    unsafe {
        cmd.pre_exec(move || apply_linux_seccomp_filter(deny_network));
    }
}
