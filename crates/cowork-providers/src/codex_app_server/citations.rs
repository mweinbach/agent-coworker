//! Provider citation sources referenced by tool output (`providerCitationSources.ts` parity).
//!
//! Codex web/search tools return text whose inline markers (`turn0search7`) point at sources
//! listed nearby. Tool results that reference such markers are projected as
//! `{ contentItems, citationSources }` so clients can resolve the markers in assistant text.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value, json};

const RESULT_KEYS: [&str; 4] = ["output", "result", "content", "contentItems"];

fn reference_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(turn\d+[a-z]+\d+)").expect("valid regex"))
}

fn reference_id_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^turn\d+[a-z]+\d+$").expect("valid regex"))
}

/// `extractToolResultText` parity.
fn tool_result_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Array(entries) => {
            let parts: Vec<String> = entries
                .iter()
                .filter_map(tool_result_text)
                .filter(|s| !s.is_empty())
                .collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        Value::Object(map) => {
            if let Some(Value::String(s)) = map.get("value") {
                return Some(s.clone());
            }
            if let Some(Value::String(s)) = map.get("text") {
                return Some(s.clone());
            }
            RESULT_KEYS
                .iter()
                .filter_map(|key| map.get(*key))
                .filter_map(tool_result_text)
                .find(|text| !text.is_empty())
        }
        _ => None,
    }
}

/// `normalizeHttpCitationUrl` parity.
fn normalize_http_url(value: &str) -> Option<String> {
    let url = value
        .trim()
        .trim_end_matches([')', ',', '.', ';', ':'])
        .to_owned();
    let parsed = url::Url::parse(&url).ok()?;
    matches!(parsed.scheme(), "http" | "https").then_some(url)
}

/// `citationSourceFromProviderLine` parity: the first URL on the line plus its title prefix.
fn source_from_line(line: &str) -> Option<Map<String, Value>> {
    static PAREN: OnceLock<Regex> = OnceLock::new();
    static BARE: OnceLock<Regex> = OnceLock::new();
    static MD_TITLE: OnceLock<Regex> = OnceLock::new();
    let paren = PAREN
        .get_or_init(|| Regex::new(r"(?i)\((https?://[^)\s]+)\)").expect("valid regex"))
        .captures(line);
    let (offset, raw_url) = match paren {
        Some(caps) => (caps.get(0)?.start(), caps.get(1)?.as_str()),
        None => {
            let m = BARE
                .get_or_init(|| Regex::new(r"(?i)https?://[^\s<]+").expect("valid regex"))
                .find(line)?;
            (m.start(), m.as_str())
        }
    };
    let url = normalize_http_url(raw_url)?;
    let title_prefix = line[..offset].trim();
    let title_prefix = title_prefix
        .strip_suffix('(')
        .unwrap_or(title_prefix)
        .trim();
    let title_prefix = title_prefix
        .trim_end_matches(['-', '–', '—', ':', '|'])
        .trim();
    let markdown_title = MD_TITLE
        .get_or_init(|| Regex::new(r"\[([^\]]+)\]$").expect("valid regex"))
        .captures(title_prefix)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().trim())
        .filter(|t| !t.is_empty());
    let title = markdown_title.unwrap_or(title_prefix);
    let mut source = Map::new();
    source.insert("url".into(), Value::String(url));
    if !title.is_empty() {
        source.insert("title".into(), Value::String(title.to_owned()));
    }
    Some(source)
}

/// `extractStructuredReferencedCitationSources` parity.
fn structured_sources(value: &Value) -> Vec<Value> {
    let Some(map) = value.as_object() else {
        return Vec::new();
    };
    if let Some(Value::Array(entries)) = map.get("citationSources") {
        return entries
            .iter()
            .filter_map(|entry| {
                let entry = entry.as_object()?;
                let url = normalize_http_url(entry.get("url")?.as_str()?)?;
                let reference_id = entry.get("referenceId")?.as_str()?.trim();
                if !reference_id_pattern().is_match(reference_id) {
                    return None;
                }
                let mut source = json!({ "url": url, "referenceId": reference_id });
                if let Some(title) = entry
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                {
                    source["title"] = Value::String(title.to_owned());
                }
                Some(source)
            })
            .collect();
    }
    RESULT_KEYS
        .iter()
        .filter_map(|key| map.get(*key))
        .map(structured_sources)
        .find(|sources| !sources.is_empty())
        .unwrap_or_default()
}

/// `extractReferencedCitationSourcesFromToolResult` parity: sources whose provider reference
/// markers appear in the tool output, each as `{ url, title?, referenceId }`.
pub fn referenced_citation_sources(result: &Value) -> Vec<Value> {
    let structured = structured_sources(result);
    if !structured.is_empty() {
        return structured;
    }
    let Some(text) = tool_result_text(result).filter(|t| t.contains("cite")) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut sources = Vec::new();
    let mut nearest: Option<Map<String, Value>> = None;
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(source) = source_from_line(line) {
            nearest = Some(source);
        }
        let Some(nearest) = nearest.as_ref() else {
            continue;
        };
        for caps in reference_pattern().captures_iter(line) {
            let reference_id = caps[1].to_owned();
            if !seen.insert(reference_id.clone()) {
                continue;
            }
            let mut source = nearest.clone();
            source.insert("referenceId".into(), Value::String(reference_id));
            sources.push(Value::Object(source));
        }
    }
    sources
}

fn source_key(source: &Value) -> Option<&str> {
    source
        .get("referenceId")
        .or_else(|| source.get("url"))
        .and_then(Value::as_str)
}

/// `projectedToolOutput` parity: output referencing citation sources (its own plus
/// `additional`, deduped by reference id or URL) becomes `{ contentItems, citationSources }`.
pub fn projected_tool_output(output: Value, additional: &[Value]) -> Value {
    let mut sources = referenced_citation_sources(&output);
    let mut seen: HashSet<String> = sources
        .iter()
        .filter_map(source_key)
        .map(ToOwned::to_owned)
        .collect();
    for source in additional {
        let Some(key) = source_key(source) else {
            continue;
        };
        if seen.insert(key.to_owned()) {
            sources.push(source.clone());
        }
    }
    if sources.is_empty() {
        output
    } else {
        json!({ "contentItems": output, "citationSources": sources })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_markers_resolve_to_the_nearest_preceding_source() {
        let output = json!([{ "type": "inputText", "text":
            "cite results:\n[Rust Blog](https://blog.rust-lang.org/2026/01/01/x.html) turn0search0\n\
             also turn0search0 and turn0search1\nhttps://example.com/a, turn1fetch2\nno marker here" }]);
        assert_eq!(
            referenced_citation_sources(&output),
            vec![
                json!({ "url": "https://blog.rust-lang.org/2026/01/01/x.html",
                    "title": "Rust Blog", "referenceId": "turn0search0" }),
                json!({ "url": "https://blog.rust-lang.org/2026/01/01/x.html",
                    "title": "Rust Blog", "referenceId": "turn0search1" }),
                json!({ "url": "https://example.com/a", "referenceId": "turn1fetch2" }),
            ]
        );
        // Without a `cite` marker the text is not scanned.
        assert!(referenced_citation_sources(&json!("https://x.dev turn0search0")).is_empty());
    }

    #[test]
    fn structured_sources_win_and_projection_dedupes_additional_sources() {
        let output = json!({ "result": { "citationSources": [
            { "url": "https://a.dev/", "referenceId": " turn0search3 ", "title": " A " },
            { "url": "ftp://b.dev/", "referenceId": "turn0search4" },
            { "url": "https://c.dev/", "referenceId": "bogus" },
        ] } });
        let a = json!({ "url": "https://a.dev/", "referenceId": "turn0search3", "title": "A" });
        assert_eq!(referenced_citation_sources(&output), vec![a.clone()]);
        let extra = json!({ "url": "https://d.dev/", "referenceId": "turn2search1" });
        assert_eq!(
            projected_tool_output(output.clone(), &[a.clone(), extra.clone()]),
            json!({ "contentItems": output, "citationSources": [a, extra] })
        );
        assert_eq!(projected_tool_output(json!("plain"), &[]), json!("plain"));
    }
}
