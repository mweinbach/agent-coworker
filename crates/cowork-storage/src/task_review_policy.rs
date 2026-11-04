//! Task review round tracking, `TaskContextSnapshot`, `TaskDirective`, and
//! canonical `materialFingerprint` computation.
//!
//! Mirrors `src/server/tasks/taskReviewPolicy.ts` and directive/context types
//! in `src/shared/tasks.ts`.

use std::collections::HashMap;
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{CollatorBorrowed, CollatorPreferences};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::artifact_store::sha256_hex;
use crate::task_types::{
    TaskActivity, TaskActivityKind, TaskArtifact, TaskArtifactDetail, TaskBlocker, TaskDecision,
    TaskQuestion, TaskQuestionUrgency, TaskRecord, TaskRequirement, TaskRequirementKind,
    TaskReviewRecord, TaskReviewVerdict, TaskStatus, WorkItem, WorkItemStatus,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskContextSnapshot {
    pub id: String,
    pub title: String,
    pub objective: String,
    pub context: String,
    pub source_session_id: Option<String>,
    pub status: TaskStatus,
    pub revision: i64,
    pub requirements: Vec<TaskRequirement>,
    pub work_items: Vec<WorkItem>,
    pub decisions: Vec<TaskDecision>,
    pub questions: Vec<TaskQuestion>,
    pub blockers: Vec<TaskBlocker>,
    pub artifacts: Vec<TaskArtifact>,
    pub active_thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_rounds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<Vec<TaskActivity>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviews: Option<Vec<TaskReviewRecord>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskDirectiveContinuation {
    Continue,
    PauseForInput,
}

impl TaskDirectiveContinuation {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Continue => "continue",
            Self::PauseForInput => "pause_for_input",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDirectiveResult {
    pub task: TaskRecord,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviews: Option<Vec<TaskReviewRecord>>,
    pub continuation: TaskDirectiveContinuation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskReviewMaterialReference {
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreationResult {
    pub task: TaskRecord,
    pub workspace_disposition: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDirectiveRequirementInput {
    pub kind: TaskRequirementKind,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permanence: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDirectiveWorkItemInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<WorkItemStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_outputs: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDirectiveQuestionOptionInput {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDirectiveQuestionInput {
    pub header: String,
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    pub blocking: bool,
    pub urgency: TaskQuestionUrgency,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<TaskDirectiveQuestionOptionInput>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended_option_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TaskDirective {
    #[serde(rename_all = "camelCase")]
    UpdatePlan {
        idempotency_key: String,
        expected_revision: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        objective: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        requirements: Option<Vec<TaskDirectiveRequirementInput>>,
        work_items: Vec<TaskDirectiveWorkItemInput>,
    },
    #[serde(rename_all = "camelCase")]
    MarkWorkItem {
        idempotency_key: String,
        expected_revision: i64,
        work_item_id: String,
        status: WorkItemStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        completion_evidence: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    RecordDecision {
        idempotency_key: String,
        expected_revision: i64,
        question: String,
        resolution: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        confidence: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        supersedes: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ReportProgress {
        idempotency_key: String,
        summary: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        work_item_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ReportBlocker {
        idempotency_key: String,
        expected_revision: i64,
        description: String,
        blocking: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        work_item_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    RequestInput {
        idempotency_key: String,
        expected_revision: i64,
        questions: Vec<TaskDirectiveQuestionInput>,
    },
    #[serde(rename_all = "camelCase")]
    RegisterArtifact {
        idempotency_key: String,
        expected_revision: i64,
        path: String,
        title: String,
        kind: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        artifact_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        base_version_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        change_summary: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        work_item_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        provenance: Option<Map<String, Value>>,
    },
    #[serde(rename_all = "camelCase")]
    RecordReview {
        idempotency_key: String,
        expected_revision: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_material_fingerprint: Option<String>,
        reviewer_agent_id: String,
        reviewer_provider: String,
        reviewer_model: String,
        verdict: TaskReviewVerdict,
        feedback: String,
    },
    #[serde(rename_all = "camelCase")]
    AddressReview {
        idempotency_key: String,
        expected_revision: i64,
        review_id: String,
        implementation_summary: String,
    },
    #[serde(rename_all = "camelCase")]
    ProposeCompletion {
        idempotency_key: String,
        expected_revision: i64,
        summary: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        caveats: Option<Vec<String>>,
    },
    #[serde(rename_all = "camelCase")]
    CreateThread {
        idempotency_key: String,
        expected_revision: i64,
        title: String,
        work_item_id: String,
    },
}

impl TaskDirective {
    pub fn idempotency_key(&self) -> &str {
        match self {
            Self::UpdatePlan {
                idempotency_key, ..
            }
            | Self::MarkWorkItem {
                idempotency_key, ..
            }
            | Self::RecordDecision {
                idempotency_key, ..
            }
            | Self::ReportProgress {
                idempotency_key, ..
            }
            | Self::ReportBlocker {
                idempotency_key, ..
            }
            | Self::RequestInput {
                idempotency_key, ..
            }
            | Self::RegisterArtifact {
                idempotency_key, ..
            }
            | Self::RecordReview {
                idempotency_key, ..
            }
            | Self::AddressReview {
                idempotency_key, ..
            }
            | Self::ProposeCompletion {
                idempotency_key, ..
            }
            | Self::CreateThread {
                idempotency_key, ..
            } => idempotency_key,
        }
    }

    pub fn directive_type_name(&self) -> &'static str {
        match self {
            Self::UpdatePlan { .. } => "update_plan",
            Self::MarkWorkItem { .. } => "mark_work_item",
            Self::RecordDecision { .. } => "record_decision",
            Self::ReportProgress { .. } => "report_progress",
            Self::ReportBlocker { .. } => "report_blocker",
            Self::RequestInput { .. } => "request_input",
            Self::RegisterArtifact { .. } => "register_artifact",
            Self::RecordReview { .. } => "record_review",
            Self::AddressReview { .. } => "address_review",
            Self::ProposeCompletion { .. } => "propose_completion",
            Self::CreateThread { .. } => "create_thread",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskReviewRound {
    pub review_id: String,
    pub round: i64,
    pub verdict: TaskReviewVerdict,
    pub feedback: String,
    pub reviewer_agent_id: String,
    pub reviewer_provider: String,
    pub reviewer_model: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material_snapshot: Option<Map<String, Value>>,
    pub addressed_at: Option<String>,
    pub implementation_summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskReviewArtifactFileSnapshot {
    pub artifact_id: String,
    pub path: String,
    pub canonical_workspace_relative_path: String,
    pub sha256: String,
    pub size_bytes: u64,
}

pub fn get_task_review_rounds_from_records(reviews: &[TaskReviewRecord]) -> Vec<TaskReviewRound> {
    let mut sorted = reviews.to_vec();
    sorted.sort_by(|a, b| {
        a.round
            .cmp(&b.round)
            .then_with(|| js_locale_compare(&a.created_at, &b.created_at))
    });
    sorted
        .into_iter()
        .map(|r| TaskReviewRound {
            review_id: r.id,
            round: r.round,
            verdict: r.verdict,
            feedback: r.feedback,
            reviewer_agent_id: r.reviewer_agent_id,
            reviewer_provider: r.reviewer_provider,
            reviewer_model: r.reviewer_model,
            created_at: r.created_at,
            task_revision: Some(r.task_revision),
            material_fingerprint: Some(r.material_fingerprint),
            material_snapshot: Some(r.material_snapshot),
            addressed_at: r.addressed_at,
            implementation_summary: r.implementation_summary,
        })
        .collect()
}

pub fn get_task_review_rounds_from_activity(activity: &[TaskActivity]) -> Vec<TaskReviewRound> {
    let mut ordered = activity.to_vec();
    ordered.sort_by_key(|a| a.seq);
    let mut rounds: Vec<TaskReviewRound> = Vec::new();
    let mut idx_by_id: HashMap<String, usize> = HashMap::new();

    for entry in ordered {
        if entry.kind == TaskActivityKind::ReviewCompleted {
            let Some(detail_raw) = entry.detail.as_deref() else {
                continue;
            };
            let Ok(Value::Object(det)) = serde_json::from_str::<Value>(detail_raw) else {
                continue;
            };
            let (
                Some(round),
                Some(verdict_str),
                Some(feedback),
                Some(reviewer_agent_id),
                Some(reviewer_provider),
                Some(reviewer_model),
            ) = (
                det.get("round").and_then(Value::as_i64).filter(|r| *r > 0),
                det.get("verdict").and_then(Value::as_str),
                det.get("feedback")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
                det.get("reviewerAgentId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
                det.get("reviewerProvider")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
                det.get("reviewerModel")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
            )
            else {
                continue;
            };
            let Some(verdict) = TaskReviewVerdict::parse(verdict_str) else {
                continue;
            };
            let r = TaskReviewRound {
                review_id: entry.id.clone(),
                round,
                verdict,
                feedback: feedback.to_owned(),
                reviewer_agent_id: reviewer_agent_id.to_owned(),
                reviewer_provider: reviewer_provider.to_owned(),
                reviewer_model: reviewer_model.to_owned(),
                created_at: entry.created_at,
                task_revision: None,
                material_fingerprint: None,
                material_snapshot: None,
                addressed_at: None,
                implementation_summary: None,
            };
            idx_by_id.insert(entry.id, rounds.len());
            rounds.push(r);
            continue;
        }
        if entry.kind == TaskActivityKind::ReviewAddressed {
            let Some(detail_raw) = entry.detail.as_deref() else {
                continue;
            };
            let Ok(Value::Object(det)) = serde_json::from_str::<Value>(detail_raw) else {
                continue;
            };
            let (Some(rev_id), Some(imp_sum)) = (
                det.get("reviewId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
                det.get("implementationSummary")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
            ) else {
                continue;
            };
            if let Some(&idx) = idx_by_id.get(rev_id)
                && rounds[idx].addressed_at.is_none()
            {
                rounds[idx].addressed_at = Some(entry.created_at);
                rounds[idx].implementation_summary = Some(imp_sum.to_owned());
            }
        }
    }
    rounds
}

pub fn get_task_review_rounds_for_context(context: &TaskContextSnapshot) -> Vec<TaskReviewRound> {
    if let Some(reviews) = &context.reviews {
        get_task_review_rounds_from_records(reviews)
    } else if let Some(activity) = &context.activity {
        get_task_review_rounds_from_activity(activity)
    } else {
        Vec::new()
    }
}

pub fn get_pending_task_review(rounds: &[TaskReviewRound]) -> Option<&TaskReviewRound> {
    rounds
        .iter()
        .find(|r| r.verdict != TaskReviewVerdict::Pass && r.addressed_at.is_none())
}

/// Canonical JSON serialization with sorted object keys (`stableStringify` parity).
pub fn stable_normalize_json(value: &Value) -> Value {
    match value {
        Value::Array(arr) => Value::Array(arr.iter().map(stable_normalize_json).collect()),
        Value::Object(obj) => {
            let mut keys: Vec<&String> = obj.keys().collect();
            keys.sort();
            let mut out = Map::new();
            for k in keys {
                if let Some(v) = obj.get(k) {
                    out.insert(k.clone(), stable_normalize_json(v));
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// `JSON.stringify(stableNormalize(value))` parity: object keys sorted by UTF-16 code units
/// (`Array.prototype.sort`) except that array-index keys (`"2"`, `"10"`) come first in numeric
/// order, as JavaScript objects enumerate them, and numbers rendered the way JavaScript renders them (`1`, not
/// `1.0`), so fingerprints persisted by the TypeScript server stay valid after migration.
pub fn stable_stringify(value: &Value) -> String {
    let mut out = String::new();
    write_js_canonical_json(value, &mut out);
    out
}

fn write_js_canonical_json(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number_to_string(n)),
        Value::String(s) => write_json_string(s, out),
        Value::Array(arr) => {
            out.push('[');
            for (i, item) in arr.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_js_canonical_json(item, out);
            }
            out.push(']');
        }
        Value::Object(obj) => {
            let mut keys: Vec<&String> = obj.keys().collect();
            keys.sort_by(|a, b| js_object_key_order(a, b));
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(key, out);
                out.push(':');
                write_js_canonical_json(&obj[key], out);
            }
            out.push('}');
        }
    }
}

/// Key order `JSON.stringify` emits for the object `stableNormalize` built by inserting
/// `Object.keys(record).sort()`: ECMAScript `OrdinaryOwnPropertyKeys` lists array-index keys
/// first in ascending numeric order, then the remaining string keys in insertion order, which
/// here is the UTF-16 code-unit order of `Array.prototype.sort`.
fn js_object_key_order(a: &str, b: &str) -> std::cmp::Ordering {
    match (js_array_index(a), js_array_index(b)) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.encode_utf16().cmp(b.encode_utf16()),
    }
}

/// ECMAScript array index: a canonical decimal string (`ToString(ToUint32(key)) === key`, so no
/// sign, leading zero, or fraction) whose value is below `2^32 - 1`.
fn js_array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    let value: u64 = key.parse().ok()?;
    u32::try_from(value).ok().filter(|v| *v != u32::MAX)
}

fn write_json_string(s: &str, out: &mut String) {
    // serde_json's string escaping matches `JSON.stringify` for well-formed strings.
    out.push_str(&serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_owned()));
}

fn js_number_to_string(n: &serde_json::Number) -> String {
    // Integers beyond 2^53 go through the double conversion JavaScript applied when parsing.
    const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
    if let Some(i) = n.as_i64()
        && i.unsigned_abs() <= MAX_SAFE_INTEGER
    {
        return i.to_string();
    }
    if let Some(u) = n.as_u64()
        && u <= MAX_SAFE_INTEGER
    {
        return u.to_string();
    }
    n.as_f64()
        .map(js_f64_to_string)
        .unwrap_or_else(|| "null".to_owned())
}

/// `Number.prototype.toString()` for a finite double (ECMA-262 `Number::toString`), as used by
/// `JSON.stringify`. Non-finite values serialize as `null`.
pub fn js_f64_to_string(x: f64) -> String {
    if !x.is_finite() {
        return "null".to_owned();
    }
    if x == 0.0 {
        // Covers -0, which JavaScript renders as "0".
        return "0".to_owned();
    }
    // Rust's `{:e}` emits the shortest round-trip digits, e.g. `1.2345e-7`.
    let sci = format!("{:e}", x.abs());
    let (mantissa, exponent) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().unwrap_or(0) + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        let (int_part, frac_part) = digits.split_at(n as usize);
        format!("{int_part}.{frac_part}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let exp = n - 1;
        let sign = if exp >= 0 { '+' } else { '-' };
        let (first, rest) = digits.split_at(1);
        if rest.is_empty() {
            format!("{first}e{sign}{}", exp.abs())
        } else {
            format!("{first}.{rest}e{sign}{}", exp.abs())
        }
    };
    if x < 0.0 { format!("-{body}") } else { body }
}

/// `String.prototype.localeCompare` parity. With no locale argument, Bun and Node compare with
/// ICU's root collation at its default options (tertiary strength, punctuation not ignored, no
/// numeric ordering), which is what ICU4X's root `Collator` with default options implements.
/// Used for every ordering the TypeScript code expressed with `localeCompare`, so material
/// snapshots, and therefore persisted review fingerprints, keep their legacy array order.
pub fn js_locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    root_collator().compare(a, b)
}

fn root_collator() -> &'static CollatorBorrowed<'static> {
    static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
        CollatorBorrowed::try_new(CollatorPreferences::default(), CollatorOptions::default())
            .expect("compiled ICU root collation data is always available")
    });
    &COLLATOR
}

/// `sortByStableValue` parity: a stable sort of `items` by
/// `stableStringify(projector(item)).localeCompare(...)`.
fn sort_by_stable_key<'a, T, F>(items: impl IntoIterator<Item = &'a T>, projector: F) -> Vec<&'a T>
where
    T: 'a,
    F: Fn(&T) -> Value,
{
    let mut keyed: Vec<(String, &T)> = items
        .into_iter()
        .map(|item| (stable_stringify(&projector(item)), item))
        .collect();
    // `sort_by` is stable, like `Array.prototype.sort`: collation-equal keys keep input order.
    keyed.sort_by(|a, b| js_locale_compare(&a.0, &b.0));
    keyed.into_iter().map(|(_, item)| item).collect()
}

/// `[...strings].sort()` parity: JavaScript's default sort compares UTF-16 code units.
fn sort_utf16(strings: &[String]) -> Vec<String> {
    let mut sorted = strings.to_vec();
    sorted.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    sorted
}

/// Builds the canonical `TaskReviewMaterialSnapshot` matching `src/server/tasks/taskReviewPolicy.ts`.
pub fn build_task_review_material_snapshot(
    task: &TaskRecord,
    artifact_details: &[TaskArtifactDetail],
    artifact_files: &[TaskReviewArtifactFileSnapshot],
) -> Map<String, Value> {
    let details_by_id: HashMap<&str, &TaskArtifactDetail> = artifact_details
        .iter()
        .map(|d| (d.artifact.id.as_str(), d))
        .collect();
    let files_by_id: HashMap<&str, &TaskReviewArtifactFileSnapshot> = artifact_files
        .iter()
        .map(|f| (f.artifact_id.as_str(), f))
        .collect();

    let active_reqs: Vec<&TaskRequirement> = task
        .requirements
        .iter()
        .filter(|r| r.status == "active")
        .collect();
    let sorted_reqs: Vec<Value> = sort_by_stable_key(active_reqs, |r| {
        json!([r.kind.as_str(), &r.text, &r.permanence, &r.source])
    })
    .into_iter()
    .map(|r| {
        json!({
            "kind": r.kind.as_str(),
            "text": r.text,
            "source": r.source,
            "permanence": r.permanence,
            "status": r.status,
        })
    })
    .collect();

    let sorted_work_items: Vec<Value> =
        sort_by_stable_key(&task.work_items, |w| json!([w.position, &w.id]))
            .into_iter()
            .map(|w| {
                let deps = sort_utf16(&w.depends_on);
                let eos = sort_utf16(&w.expected_outputs);
                json!({
                    "id": w.id,
                    "title": w.title,
                    "description": w.description,
                    "status": w.status.as_str(),
                    "dependsOn": deps,
                    "assignedThreadId": w.assigned_thread_id,
                    "expectedOutputs": eos,
                    "completionEvidence": w.completion_evidence,
                    "position": w.position,
                })
            })
            .collect();

    let relevant_decisions: Vec<&TaskDecision> = task
        .decisions
        .iter()
        .filter(|d| d.status == "active")
        .collect();
    let sorted_decisions: Vec<Value> = sort_by_stable_key(relevant_decisions, |d| {
        json!([&d.question, &d.resolution, &d.scope])
    })
    .into_iter()
    .map(|d| {
        json!({
            "question": d.question,
            "resolution": d.resolution,
            "source": d.source,
            "scope": d.scope,
            "confidence": d.confidence,
            "status": d.status,
        })
    })
    .collect();

    let relevant_questions: Vec<&TaskQuestion> = task
        .questions
        .iter()
        .filter(|q| q.status.as_str() != "superseded")
        .collect();
    let sorted_questions: Vec<Value> = sort_by_stable_key(relevant_questions, |q| {
        json!([q.status.as_str(), q.blocking, &q.question])
    })
    .into_iter()
    .map(|q| {
        let opts = sort_by_stable_key(&q.options, |o| json!(o.id));
        json!({
            "threadId": q.thread_id,
            "workItemId": q.work_item_id,
            "header": q.header,
            "question": q.question,
            "context": q.context,
            "blocking": q.blocking,
            "urgency": q.urgency.as_str(),
            "defaultAction": q.default_action,
            "options": opts,
            "recommendedOptionId": q.recommended_option_id,
            "status": q.status.as_str(),
            "answer": q.answer,
            "answerOptionId": q.answer_option_id,
            "resolutionSource": q.resolution_source,
        })
    })
    .collect();

    let relevant_blockers: Vec<&TaskBlocker> = task
        .blockers
        .iter()
        .filter(|b| b.status == "active")
        .collect();
    let sorted_blockers: Vec<Value> = sort_by_stable_key(relevant_blockers, |b| {
        json!([b.blocking, &b.work_item_id, &b.description])
    })
    .into_iter()
    .map(|b| {
        json!({
            "workItemId": b.work_item_id,
            "description": b.description,
            "blocking": b.blocking,
            "status": b.status,
        })
    })
    .collect();

    let sorted_artifacts: Vec<Value> =
        sort_by_stable_key(&task.artifacts, |a| json!([&a.path, &a.id]))
            .into_iter()
            .map(|a| {
                let detail = details_by_id.get(a.id.as_str()).copied();
                let live_file = files_by_id
                    .get(a.id.as_str())
                    .and_then(|f| serde_json::to_value(f).ok())
                    .unwrap_or(Value::Null);
                let versions: Vec<Value> = detail
                    .map(|d| {
                        d.versions
                            .iter()
                            .map(|v| {
                                json!({
                                    "id": v.id,
                                    "version": v.version,
                                    "parentVersionId": v.parent_version_id,
                                    "sha256": v.sha256,
                                    "sizeBytes": v.size_bytes,
                                    "mediaType": v.media_type,
                                    "reviewStatus": v.review_status.as_str(),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let active_rev = detail
                    .and_then(|d| d.active_revision.as_ref())
                    .map(|rev| {
                        json!({
                            "id": rev.id,
                            "workItemId": rev.work_item_id,
                            "taskThreadId": rev.task_thread_id,
                            "baseVersionId": rev.base_version_id,
                            "priorVersionId": rev.prior_version_id,
                            "status": rev.status.as_str(),
                            "instruction": rev.instruction,
                        })
                    })
                    .unwrap_or(Value::Null);

                json!({
                    "id": a.id,
                    "workItemId": a.work_item_id,
                    "threadId": a.thread_id,
                    "path": a.path,
                    "kind": a.kind,
                    "title": a.title,
                    "provenance": a.provenance,
                    "liveFile": live_file,
                    "latestVersionId": detail.and_then(|d| d.latest_version_id.clone()),
                    "acceptedVersionId": detail.and_then(|d| d.accepted_version_id.clone()),
                    "versions": versions,
                    "activeRevision": active_rev,
                })
            })
            .collect();

    let snapshot = json!({
        "schemaVersion": 1,
        "objective": task.objective,
        "context": task.context,
        "requirements": sorted_reqs,
        "workItems": sorted_work_items,
        "decisions": sorted_decisions,
        "questions": sorted_questions,
        "blockers": sorted_blockers,
        "artifacts": sorted_artifacts,
    });

    match stable_normalize_json(&snapshot) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

pub fn fingerprint_task_review_material(snapshot: &Map<String, Value>) -> String {
    let canonical = stable_stringify(&Value::Object(snapshot.clone()));
    sha256_hex(canonical.as_bytes())
}
