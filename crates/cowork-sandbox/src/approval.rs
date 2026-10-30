use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::env_utils::host_platform;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandRiskLevel {
    Safe,
    Review,
    Dangerous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandApprovalReasonCode {
    SafeAutoApproved,
    RequiresManualReview,
    MatchesDangerousPattern,
    SandboxDeniedEscalation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandApprovalClassification {
    pub risk_level: CommandRiskLevel,
    pub reason_code: CommandApprovalReasonCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_pattern: Option<String>,
}

struct CompiledPattern {
    regex: Regex,
    label: &'static str,
}

fn posix_dangerous_patterns() -> &'static [CompiledPattern] {
    static PATTERNS: OnceLock<Vec<CompiledPattern>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (r"\bsudo\b", "sudo"),
            (r"(^|[\s;&|])su(\s|$)", "su"),
            (r"\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force)", "rm -f"),
            (r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+/", "rm -r /"),
            (r"\bchmod\s+777\b", "chmod 777"),
            (r"\bchown\b", "chown"),
            (r"\bmkfs\b", "mkfs"),
            (r"\bdd\s+if=", "dd if="),
            (r">\s*/dev/sd", "> /dev/sd"),
            (r"\bcurl\b.*\|\s*(ba)?sh", "curl | sh"),
            (r"\bwget\b.*\|\s*(ba)?sh", "wget | sh"),
            (r"\bgit\s+push\s+.*--force", "git push --force"),
            (r"\bgit\s+reset\s+--hard", "git reset --hard"),
            (r"\bgit\s+clean\s+-[a-zA-Z]*f", "git clean -f"),
            (r"\bkill\s+-9\b", "kill -9"),
            (r"\bkillall\b", "killall"),
            (r"\bpkill\b", "pkill"),
            (r"\bshutdown\b", "shutdown"),
            (r"\breboot\b", "reboot"),
            (
                r"\bsystemctl\s+(stop|disable|mask)\b",
                "systemctl stop/disable/mask",
            ),
            (r"\blaunchctl\s+unload\b", "launchctl unload"),
            (r"\bnpm\s+publish\b", "npm publish"),
            (r"\bdocker\s+rm\b", "docker rm"),
            (r"\bdocker\s+system\s+prune\b", "docker system prune"),
            (r"\bDROP\s+(TABLE|DATABASE)\b", "DROP TABLE/DATABASE"),
            (r"\bTRUNCATE\s+TABLE\b", "TRUNCATE TABLE"),
        ]
        .into_iter()
        .map(|(pat, label)| CompiledPattern {
            regex: Regex::new(&format!("(?i){pat}")).expect("valid POSIX approval regex"),
            label,
        })
        .collect()
    })
}

fn powershell_extra_dangerous_patterns() -> &'static [CompiledPattern] {
    static PATTERNS: OnceLock<Vec<CompiledPattern>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (r"\bRemove-Item\b[^\r\n;|]*\s-(Recurse|Force)\b", "Remove-Item -Recurse/-Force"),
            (r"\b(rd|rmdir)\b[^\r\n;|]*\s/s\b", "rmdir /s"),
            (r"\bdel\b[^\r\n;|]*\s/[fqs]\b", "del /f|/q|/s"),
            (r"\bFormat-Volume\b", "Format-Volume"),
            (r"\bClear-Disk\b", "Clear-Disk"),
            (r"\bStop-Computer\b", "Stop-Computer"),
            (r"\bRestart-Computer\b", "Restart-Computer"),
            (r"\bStop-Process\b[^\r\n;|]*\s-Force\b", "Stop-Process -Force"),
            (r"\btaskkill\b[^\r\n;|]*\s/f\b", "taskkill /f"),
            (r"\breg\s+delete\b", "reg delete"),
            (r"\bsc(\.exe)?\s+(stop|delete|config)\b", "sc stop/delete/config"),
            (r"\bStop-Service\b", "Stop-Service"),
            (r"\bSet-Service\b[^\r\n;|]*Disabled", "Set-Service Disabled"),
            (r"\b(Invoke-Expression|iex)\b", "Invoke-Expression"),
            (r"\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^\r\n]*\|\s*(Invoke-Expression|iex|pwsh|powershell)\b", "iwr | iex"),
            (r"\bStart-Process\b[^\r\n;|]*-Verb\s+RunAs\b", "Start-Process -Verb RunAs"),
            (r"\brunas\b", "runas"),
            (r"\bicacls\b[^\r\n;|]*/grant\b", "icacls /grant"),
        ]
        .into_iter()
        .map(|(pat, label)| CompiledPattern {
            regex: Regex::new(&format!("(?i){pat}")).expect("valid PowerShell approval regex"),
            label,
        })
        .collect()
    })
}

const POSIX_SAFE_PREFIXES: &[&str] = &[
    "ls",
    "pwd",
    "echo",
    "cat",
    "head",
    "tail",
    "wc",
    "file",
    "stat",
    "which",
    "whereis",
    "type",
    "uname",
    "whoami",
    "id",
    "date",
    "cal",
    "df",
    "du",
    "free",
    "uptime",
    "env",
    "printenv",
    "git status",
    "git log",
    "git diff",
    "git show",
    "git branch",
    "git tag",
    "git remote",
    "git rev-parse",
    "find",
    "fd",
    "rg",
    "grep",
    "ag",
    "tree",
    "jq",
    "yq",
    "sort",
    "uniq",
    "cut",
    "tr",
    "diff",
    "comm",
    "node --version",
    "bun --version",
    "python --version",
    "python3 --version",
    "npm list",
    "npm ls",
    "bun pm ls",
];

const POWERSHELL_SAFE_PREFIXES: &[&str] = &[
    "ls",
    "dir",
    "pwd",
    "echo",
    "cat",
    "type",
    "whoami",
    "hostname",
    "ver",
    "get-childitem",
    "gci",
    "get-location",
    "gl",
    "get-content",
    "gc",
    "get-item",
    "gi",
    "get-itemproperty",
    "gp",
    "test-path",
    "resolve-path",
    "select-string",
    "sls",
    "measure-object",
    "measure",
    "where.exe",
    "get-command",
    "gcm",
    "get-date",
    "get-process",
    "gps",
    "git status",
    "git log",
    "git diff",
    "git show",
    "git branch",
    "git tag",
    "git remote",
    "git rev-parse",
    "rg",
    "fd",
    "jq",
    "node --version",
    "bun --version",
    "python --version",
    "python3 --version",
    "npm list",
    "npm ls",
    "bun pm ls",
];

/// Classifies a shell command for pre-execution approval or post-denial sandbox escalation.
pub fn classify_command_detailed(
    command: &str,
    reason: Option<&str>,
    platform_override: Option<&str>,
) -> CommandApprovalClassification {
    let platform = platform_override.unwrap_or(host_platform());
    let trimmed = command.trim();

    for pat in posix_dangerous_patterns() {
        if pat.regex.is_match(trimmed) {
            return CommandApprovalClassification {
                risk_level: CommandRiskLevel::Dangerous,
                reason_code: if reason == Some("sandbox_denied") {
                    CommandApprovalReasonCode::SandboxDeniedEscalation
                } else {
                    CommandApprovalReasonCode::MatchesDangerousPattern
                },
                matched_pattern: Some(pat.label.to_owned()),
            };
        }
    }

    if platform == "win32" {
        for pat in powershell_extra_dangerous_patterns() {
            if pat.regex.is_match(trimmed) {
                return CommandApprovalClassification {
                    risk_level: CommandRiskLevel::Dangerous,
                    reason_code: if reason == Some("sandbox_denied") {
                        CommandApprovalReasonCode::SandboxDeniedEscalation
                    } else {
                        CommandApprovalReasonCode::MatchesDangerousPattern
                    },
                    matched_pattern: Some(pat.label.to_owned()),
                };
            }
        }
    }

    if reason == Some("sandbox_denied") {
        return CommandApprovalClassification {
            risk_level: CommandRiskLevel::Review,
            reason_code: CommandApprovalReasonCode::SandboxDeniedEscalation,
            matched_pattern: None,
        };
    }

    let has_shell_chaining = trimmed.contains('|')
        || trimmed.contains('>')
        || trimmed.contains(';')
        || trimmed.contains("&&")
        || trimmed.contains("||")
        || trimmed.contains('`')
        || trimmed.contains("$(");

    if !has_shell_chaining {
        if platform == "win32" {
            let lower = trimmed.to_ascii_lowercase();
            if POWERSHELL_SAFE_PREFIXES.iter().any(|p| {
                lower == *p
                    || lower
                        .strip_prefix(p)
                        .is_some_and(|rest| rest.starts_with(char::is_whitespace))
            }) {
                return CommandApprovalClassification {
                    risk_level: CommandRiskLevel::Safe,
                    reason_code: CommandApprovalReasonCode::SafeAutoApproved,
                    matched_pattern: None,
                };
            }
        } else if POSIX_SAFE_PREFIXES.iter().any(|p| {
            trimmed == *p
                || trimmed
                    .strip_prefix(p)
                    .is_some_and(|rest| rest.starts_with(char::is_whitespace))
        }) {
            return CommandApprovalClassification {
                risk_level: CommandRiskLevel::Safe,
                reason_code: CommandApprovalReasonCode::SafeAutoApproved,
                matched_pattern: None,
            };
        }
    }

    CommandApprovalClassification {
        risk_level: CommandRiskLevel::Review,
        reason_code: CommandApprovalReasonCode::RequiresManualReview,
        matched_pattern: None,
    }
}
