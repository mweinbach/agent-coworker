use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildAgentVerificationItem {
    pub command: String,
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildAgentReport {
    pub status: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_changed: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_read: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification: Option<Vec<ChildAgentVerificationItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub residual_risks: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildReportInspection {
    pub report_required: bool,
    pub report_found: bool,
    pub report_valid: bool,
    pub report_block_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_diagnostic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parsed_report: Option<ChildAgentReport>,
}

static AGENT_REPORT_BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<agent_report>\s*(.*?)\s*</agent_report>").unwrap());
static FENCED_CODE_BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)```(?:json)?\s*(.*?)\s*```").unwrap());

fn validate_report_semantics(report: &ChildAgentReport) -> Result<(), String> {
    if !matches!(report.status.as_str(), "completed" | "blocked" | "failed") {
        return Err(format!(
            "Invalid report status '{}'; expected 'completed', 'blocked', or 'failed'.",
            report.status
        ));
    }
    if report.summary.trim().is_empty() {
        return Err("Report 'summary' must be a non-empty string.".to_owned());
    }
    if let Some(ref items) = report.verification {
        for item in items {
            if item.command.trim().is_empty() {
                return Err("Verification item 'command' must be non-empty.".to_owned());
            }
            if !matches!(item.outcome.as_str(), "passed" | "failed") {
                return Err(format!(
                    "Invalid verification outcome '{}'; expected 'passed' or 'failed'.",
                    item.outcome
                ));
            }
        }
    }
    Ok(())
}

fn parse_strict_report_json(raw_json: &str) -> Result<ChildAgentReport, String> {
    let report: ChildAgentReport =
        serde_json::from_str(raw_json).map_err(|e| format!("Invalid <agent_report> JSON: {e}"))?;
    validate_report_semantics(&report)?;
    Ok(report)
}

pub fn inspect_child_agent_report(
    latest_assistant_text: Option<&str>,
    report_required: bool,
) -> ChildReportInspection {
    let Some(text) = latest_assistant_text
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return ChildReportInspection {
            report_required,
            report_found: false,
            report_valid: false,
            report_block_count: 0,
            report_diagnostic: report_required.then(|| {
                "Child agent produced no assistant message containing <agent_report>.".to_owned()
            }),
            parsed_report: None,
        };
    };

    let blocks: Vec<String> = AGENT_REPORT_BLOCK_RE
        .captures_iter(text)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().trim().to_owned()))
        .collect();

    if !blocks.is_empty() {
        let count = blocks.len();
        let last_raw = blocks.last().unwrap();
        return match parse_strict_report_json(last_raw) {
            Ok(parsed) => ChildReportInspection {
                report_required,
                report_found: true,
                report_valid: true,
                report_block_count: count,
                report_diagnostic: (count > 1).then(|| {
                    format!("Found {count} <agent_report> blocks; parsed the final block.")
                }),
                parsed_report: Some(parsed),
            },
            Err(err) => ChildReportInspection {
                report_required,
                report_found: true,
                report_valid: false,
                report_block_count: count,
                report_diagnostic: Some(err),
                parsed_report: None,
            },
        };
    }

    // Legacy fallback when no `<agent_report>` tags exist:
    // 1. Fenced JSON code blocks (last-to-first)
    let fenced: Vec<String> = FENCED_CODE_BLOCK_RE
        .captures_iter(text)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().trim().to_owned()))
        .collect();
    for candidate in fenced.into_iter().rev() {
        if let Ok(parsed) = parse_strict_report_json(&candidate) {
            return ChildReportInspection {
                report_required,
                report_found: false,
                report_valid: true,
                report_block_count: 0,
                report_diagnostic: Some(
                    "Parsed legacy report without an <agent_report> footer.".to_owned(),
                ),
                parsed_report: Some(parsed),
            };
        }
    }

    // 2. Whole text or trailing `{...}` JSON object
    if let Ok(parsed) = parse_strict_report_json(text) {
        return ChildReportInspection {
            report_required,
            report_found: false,
            report_valid: true,
            report_block_count: 0,
            report_diagnostic: Some(
                "Parsed legacy report without an <agent_report> footer.".to_owned(),
            ),
            parsed_report: Some(parsed),
        };
    }
    if let Some(last_brace) = text.rfind('{')
        && text.ends_with('}')
        && let Ok(parsed) = parse_strict_report_json(&text[last_brace..])
    {
        return ChildReportInspection {
            report_required,
            report_found: false,
            report_valid: true,
            report_block_count: 0,
            report_diagnostic: Some(
                "Parsed legacy report without an <agent_report> footer.".to_owned(),
            ),
            parsed_report: Some(parsed),
        };
    }

    ChildReportInspection {
        report_required,
        report_found: false,
        report_valid: false,
        report_block_count: 0,
        report_diagnostic: report_required
            .then(|| "Missing <agent_report> block in child agent final message.".to_owned()),
        parsed_report: None,
    }
}
