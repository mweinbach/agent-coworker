//! Sanitize server-supplied text before writing it to the terminal.
//!
//! Port of TS `src/cli/repl/sanitizeTerminal.ts` (`sanitizeTerminalOutput`). Strips escape
//! sequences that a malicious or compromised model/server response could use to alter terminal
//! state, while preserving safe SGR sequences (`ESC [ … m`) used for colors, bold, underline, etc.
//!
//! Sequences removed (only when terminated, exactly like the TS regexes):
//! - OSC (`ESC ]` … `BEL` or `ESC \`): terminal title, clipboard (OSC 52), hyperlinks (OSC 8).
//! - DCS (`ESC P`), APC (`ESC _`), PM (`ESC ^`), SOS (`ESC X`), each terminated by `ESC \`.
//!
//! Like TS, sanitization is applied per write (per streamed delta), and unterminated sequences
//! are left untouched.

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;

/// Sanitizes server-supplied text before it is written to the terminal.
pub fn sanitize_terminal_output(text: &str) -> String {
    // Fast path: no escape characters at all -> nothing to sanitize.
    if !text.contains('\u{1b}') && !text.contains('\u{7}') {
        return text.to_owned();
    }
    // Same order as TS: OSC pass first, then the DCS/APC/PM/SOS pass over its result.
    let without_osc = strip_strings(text.as_bytes(), |b| b == b']', true);
    let sanitized = strip_strings(
        &without_osc,
        |b| matches!(b, b'P' | b'_' | b'^' | b'X'),
        false,
    );
    // Only whole ASCII sequences are removed, so the remaining bytes stay valid UTF-8.
    String::from_utf8(sanitized)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Mirrors a global, lazy `ESC <intro> [\s\S]*? (BEL | ESC \)` regex replace with "": scanning
/// left to right, each `ESC <intro>` with a later terminator is removed through the earliest
/// terminator; an introducer without a terminator is kept and scanning resumes at the next byte.
fn strip_strings(input: &[u8], is_intro: impl Fn(u8) -> bool, bel_terminates: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == ESC
            && i + 1 < input.len()
            && is_intro(input[i + 1])
            && let Some(end) = find_terminator(input, i + 2, bel_terminates)
        {
            i = end;
            continue;
        }
        out.push(input[i]);
        i += 1;
    }
    out
}

/// Returns the index just past the earliest terminator at or after `from`.
fn find_terminator(input: &[u8], from: usize, bel_terminates: bool) -> Option<usize> {
    let mut j = from;
    while j < input.len() {
        if bel_terminates && input[j] == BEL {
            return Some(j + 1);
        }
        if input[j] == ESC && input.get(j + 1) == Some(&b'\\') {
            return Some(j + 2);
        }
        j += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::sanitize_terminal_output as s;

    // Ported from TS `test/cli-sanitize-terminal.test.ts`.
    #[test]
    fn passes_through_plain_and_empty_text() {
        assert_eq!(s("hello world"), "hello world");
        assert_eq!(s(""), "");
    }

    #[test]
    fn preserves_safe_sgr_sequences() {
        for text in [
            "\x1b[31mred text\x1b[0m",
            "\x1b[1mbold\x1b[0m",
            "\x1b[4munderline\x1b[0m",
        ] {
            assert_eq!(s(text), text);
        }
    }

    #[test]
    fn strips_osc_sequences() {
        assert_eq!(s("before\x1b]0;evil title\x07after"), "beforeafter");
        assert_eq!(s("before\x1b]0;evil title\x1b\\after"), "beforeafter");
        assert_eq!(s("before\x1b]52;c;SGVsbG8=\x07after"), "beforeafter");
        assert_eq!(
            s("before\x1b]8;;https://evil.com\x07click\x1b]8;;\x07after"),
            "beforeclickafter"
        );
    }

    #[test]
    fn strips_dcs_apc_pm_sos_sequences() {
        assert_eq!(
            s("before\x1bPdevice control data\x1b\\after"),
            "beforeafter"
        );
        assert_eq!(s("before\x1b_application data\x1b\\after"), "beforeafter");
        assert_eq!(s("before\x1b^privacy message\x1b\\after"), "beforeafter");
        assert_eq!(s("before\x1bXstring data\x1b\\after"), "beforeafter");
    }

    #[test]
    fn strips_multiple_and_mixed_sequences() {
        assert_eq!(
            s("\x1b]0;title\x07Hello \x1bPdcs\x1b\\World\x1b_apc\x1b\\!"),
            "Hello World!"
        );
        assert_eq!(
            s("\x1b[32mgreen\x1b[0m\x1b]0;evil\x07 text"),
            "\x1b[32mgreen\x1b[0m text"
        );
    }

    #[test]
    fn handles_multiline_content_and_payloads() {
        assert_eq!(
            s("line1\n\x1b]2;sneaky\x07line2\nline3"),
            "line1\nline2\nline3"
        );
        assert_eq!(s("before\x1b]0;multi\nline\ntitle\x07after"), "beforeafter");
    }

    #[test]
    fn matches_ts_regex_edge_cases() {
        // Unterminated sequences are kept (the TS regexes do not match them).
        assert_eq!(s("a\x1b]0;open"), "a\x1b]0;open");
        assert_eq!(s("a\x1bPopen\x07"), "a\x1bPopen\x07");
        // Non-ASCII text around a stripped sequence survives intact.
        assert_eq!(s("héllo\x1b]0;t\x07wörld"), "héllowörld");
        // The DCS pass runs over the OSC pass's output, like the sequential TS replaces.
        assert_eq!(s("\x1b\x1b]0;t\x07Pdata\x1b\\x"), "x");
    }
}
