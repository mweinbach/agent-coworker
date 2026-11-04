use std::collections::{HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const RESULT_OPEN: &str = "<workflow_result>";
const RESULT_CLOSE: &str = "</workflow_result>";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowJournalEntry {
    pub index: usize,
    pub digest: String,
    pub phase: Option<String>,
    pub label: Option<String>,
    pub result: Value,
    pub agent_id: Option<String>,
    pub usd_cost: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct WorkflowJournalOpenOptions {
    pub project_cowork_dir: PathBuf,
    pub run_id: String,
    pub resume_from_run_id: Option<String>,
    pub persist: bool,
}

pub fn assert_safe_workflow_run_id(run_id: &str) -> Result<String, String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^wf_[A-Za-z0-9][A-Za-z0-9_-]{0,63}$").expect("valid workflow run id regex")
    });
    let trimmed = run_id.trim();
    if !re.is_match(trimmed) {
        return Err(format!(
            "invalid workflow run id \"{run_id}\": expected wf_ followed by letters, digits, _ or -"
        ));
    }
    Ok(trimmed.to_owned())
}

pub fn workflow_run_dir(project_cowork_dir: &Path, run_id: &str) -> Result<PathBuf, String> {
    let safe_id = assert_safe_workflow_run_id(run_id)?;
    let root = project_cowork_dir.join("workflows").join("runs");
    let candidate = root.join(&safe_id);
    let rel = candidate
        .strip_prefix(&root)
        .map_err(|_| format!("workflow run id escapes the runs directory: {run_id}"))?;
    if rel.as_os_str().is_empty() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!(
            "workflow run id escapes the runs directory: {run_id}"
        ));
    }
    Ok(candidate)
}

/// Deterministic canonical JSON serializer matching `src/workflows/journal.ts` (`canonicalize`).
pub fn canonicalize_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => if *b { "true" } else { "false" }.to_owned(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else if let Some(f) = n.as_f64() {
                if f.is_finite() {
                    if f.fract() == 0.0 && f.abs() < (i64::MAX as f64) {
                        format!("{}", f as i64)
                    } else {
                        f.to_string()
                    }
                } else {
                    "null".to_owned()
                }
            } else {
                "null".to_owned()
            }
        }
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_owned()),
        Value::Array(items) => {
            let joined = items
                .iter()
                .map(canonicalize_json)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{joined}]")
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let joined = keys
                .into_iter()
                .map(|k| {
                    let key_json = serde_json::to_string(k).unwrap_or_else(|_| "\"\"".to_owned());
                    let val_json = canonicalize_json(&map[k]);
                    format!("{key_json}:{val_json}")
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{joined}}}")
        }
    }
}

pub fn hash_workflow_args(args: &Value) -> String {
    let effective = if args.is_null() { &json!({}) } else { args };
    let canonical = canonicalize_json(effective);
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn digest_agent_call(args_hash: &str, prompt: &str, opts: &Value) -> String {
    let envelope = json!({
        "argsHash": args_hash,
        "prompt": prompt,
        "opts": opts,
    });
    let canonical = canonicalize_json(&envelope);
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hex::encode(hasher.finalize())
}

/// Append-only run journal backing `resumeFromRunId` order-independent multiset replay.
pub struct WorkflowJournal {
    file_path: Option<PathBuf>,
    cached: Mutex<HashMap<String, VecDeque<WorkflowJournalEntry>>>,
    write_lock: tokio::sync::Mutex<()>,
}

impl WorkflowJournal {
    pub async fn open(opts: WorkflowJournalOpenOptions) -> Result<Self, String> {
        if !opts.persist {
            return Ok(Self {
                file_path: None,
                cached: Mutex::new(HashMap::new()),
                write_lock: tokio::sync::Mutex::new(()),
            });
        }
        let dir = workflow_run_dir(&opts.project_cowork_dir, &opts.run_id)?;
        let prior_dir = match opts.resume_from_run_id.as_deref() {
            Some(resume_id) => Some(workflow_run_dir(&opts.project_cowork_dir, resume_id)?),
            None => None,
        };

        let (file_path, prior_entries) =
            tokio::task::spawn_blocking(move || -> Result<_, String> {
                fs::create_dir_all(&dir).map_err(|e| {
                    format!(
                        "failed creating workflow run directory {}: {e}",
                        dir.display()
                    )
                })?;
                let entries = match prior_dir {
                    Some(ref pdir) => read_journal_entries(&pdir.join("journal.jsonl")),
                    None => Vec::new(),
                };
                Ok((dir.join("journal.jsonl"), entries))
            })
            .await
            .map_err(|e| format!("workflow journal open join error: {e}"))??;

        let mut buckets: HashMap<String, Vec<WorkflowJournalEntry>> = HashMap::new();
        for entry in prior_entries {
            buckets.entry(entry.digest.clone()).or_default().push(entry);
        }
        let mut cached = HashMap::with_capacity(buckets.len());
        for (digest, mut list) in buckets {
            list.sort_by_key(|e| e.index);
            cached.insert(digest, VecDeque::from(list));
        }

        Ok(Self {
            file_path: Some(file_path),
            cached: Mutex::new(cached),
            write_lock: tokio::sync::Mutex::new(()),
        })
    }

    pub fn lookup(&self, digest: &str) -> Option<WorkflowJournalEntry> {
        let mut guard = self.cached.lock();
        let bucket = guard.get_mut(digest)?;
        let next = bucket.pop_front();
        if bucket.is_empty() {
            guard.remove(digest);
        }
        next
    }

    pub async fn append(&self, entry: &WorkflowJournalEntry) -> Result<(), String> {
        let Some(ref path) = self.file_path else {
            return Ok(());
        };
        let mut line = serde_json::to_string(entry)
            .map_err(|e| format!("failed serializing workflow journal entry: {e}"))?;
        line.push('\n');

        let _guard = self.write_lock.lock().await;
        let path_cloned = path.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path_cloned)
                .map_err(|e| {
                    format!(
                        "failed opening workflow journal {}: {e}",
                        path_cloned.display()
                    )
                })?;
            file.write_all(line.as_bytes())
                .and_then(|_| file.flush())
                .map_err(|e| {
                    format!(
                        "failed appending workflow journal {}: {e}",
                        path_cloned.display()
                    )
                })
        })
        .await
        .map_err(|e| format!("workflow journal write join error: {e}"))?
    }

    pub async fn flush(&self) -> Result<(), String> {
        let _guard = self.write_lock.lock().await;
        Ok(())
    }
}

fn read_journal_entries(file_path: &Path) -> Vec<WorkflowJournalEntry> {
    let Ok(raw) = fs::read_to_string(file_path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<WorkflowJournalEntry>(trimmed) {
            Ok(entry) => {
                if entry
                    .agent_id
                    .as_deref()
                    .is_some_and(|id| id.starts_with("dry-"))
                    && entry
                        .result
                        .as_str()
                        .is_some_and(|s| s.starts_with("[dry-run] "))
                {
                    continue;
                }
                out.push(entry);
            }
            Err(_) => {
                // A torn final line (process killed mid-write) truncates the replay prefix
                // cleanly rather than failing the resume outright.
                break;
            }
        }
    }
    out
}

pub fn build_schema_system_instruction() -> String {
    [
        "## Workflow structured-output mode",
        "",
        "This call is consumed by a workflow JSON-schema validator.",
        &format!("Return exactly one {RESULT_OPEN}...{RESULT_CLOSE} block and nothing else."),
        "The workflow output contract in the user message replaces role-level final-response and report-footer instructions for this call.",
        "Do not emit prose, markdown fences, an \"Answer\" prefix, or an <agent_report> block.",
    ]
    .join("\n")
}

pub fn build_schema_instruction(schema: &Value) -> String {
    let pretty = serde_json::to_string_pretty(schema).unwrap_or_else(|_| "{}".to_owned());
    [
        "",
        "## Required output format",
        "",
        &format!("Reply with ONLY one {RESULT_OPEN}...{RESULT_CLOSE} block containing"),
        "a single JSON value that validates against this JSON Schema:",
        "",
        "```json",
        &pretty,
        "```",
        "",
        &format!("Example: {RESULT_OPEN}{{\"field\": \"value\"}}{RESULT_CLOSE}"),
        "",
        "Write nothing before or after the block. Do not wrap it in a code fence or add an <agent_report> footer.",
    ]
    .join("\n")
}

pub fn build_repair_instruction(issues: &[String]) -> String {
    let mut lines = vec![
        format!("Your {RESULT_OPEN} block did not validate. Problems:"),
        String::new(),
    ];
    for issue in issues {
        lines.push(format!("- {issue}"));
    }
    lines.push(String::new());
    lines.push(format!(
        "Reply with ONLY a corrected {RESULT_OPEN}...{RESULT_CLOSE} block. No other text."
    ));
    lines.join("\n")
}

pub fn extract_result_envelope(text: Option<&str>) -> Option<String> {
    let raw = text?;
    let open = raw.rfind(RESULT_OPEN)?;
    let start = open + RESULT_OPEN.len();
    let tail = &raw[start..];
    let body = match tail.find(RESULT_CLOSE) {
        Some(close_offset) => &tail[..close_offset],
        None => tail,
    };
    let trimmed = body.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SchemaValidation {
    Ok(Value),
    Invalid(Vec<String>),
}

impl SchemaValidation {
    pub fn ok_value(&self) -> Option<&Value> {
        match self {
            Self::Ok(v) => Some(v),
            Self::Invalid(_) => None,
        }
    }

    pub fn issues(&self) -> &[String] {
        match self {
            Self::Ok(_) => &[],
            Self::Invalid(issues) => issues,
        }
    }
}

/// Validates a child's extracted `<workflow_result>` JSON envelope against a caller-supplied
/// JSON Schema via `jsonschema 0.60`. Returns `Err(...)` only when the schema itself is malformed.
pub fn validate_against_json_schema(
    schema: &Value,
    raw_envelope: Option<&str>,
) -> Result<SchemaValidation, String> {
    if !schema.is_object() {
        return Err(
            "workflow agent schema is not a usable JSON Schema: schema must be an object"
                .to_owned(),
        );
    }
    let validator = jsonschema::validator_for(schema)
        .map_err(|e| format!("workflow agent schema is not a usable JSON Schema: {e}"))?;

    let Some(envelope) = raw_envelope else {
        return Ok(SchemaValidation::Invalid(vec![format!(
            "no {RESULT_OPEN} block was found in the final message"
        )]));
    };

    let parsed: Value = match serde_json::from_str(envelope) {
        Ok(v) => v,
        Err(e) => {
            return Ok(SchemaValidation::Invalid(vec![format!(
                "the block was not valid JSON: {e}"
            )]));
        }
    };

    let mut issues = Vec::new();
    for err in validator.iter_errors(&parsed) {
        let loc = err.instance_path().to_string();
        let path = if loc.is_empty() {
            "(root)".to_owned()
        } else {
            loc.trim_start_matches('/').replace('/', ".")
        };
        issues.push(format!("{path}: {err}"));
    }

    if issues.is_empty() {
        Ok(SchemaValidation::Ok(parsed))
    } else {
        Ok(SchemaValidation::Invalid(issues))
    }
}
