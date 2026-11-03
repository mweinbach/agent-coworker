//! Sanitize server-supplied text before writing it to the terminal.
//!
//! Hardened port of TS `src/cli/repl/sanitizeTerminal.ts` (`sanitizeTerminalOutput`). Strips
//! control sequences that a malicious or compromised model/server response could use to alter
//! terminal state, while preserving safe SGR sequences (`ESC [ <digits ; :> m`) used for colors,
//! bold, underline, etc.
//!
//! [`TerminalSanitizer`] is a small VT parser that carries its state across writes, so a
//! sequence split across streamed deltas (e.g. an OSC 52 clipboard write whose `BEL` arrives in a
//! later chunk) is still removed. Everything except printable text, `\n`, `\t` and validated SGR
//! sequences is dropped:
//! - OSC (`ESC ]` / U+009D) … `BEL` / `ESC \` / U+009C: title, clipboard (OSC 52), hyperlinks.
//! - DCS (`ESC P` / U+0090), SOS (`ESC X` / U+0098), PM (`ESC ^` / U+009E), APC (`ESC _` /
//!   U+009F), each through `ESC \` / U+009C (or `BEL`).
//! - Every CSI (`ESC [` / U+009B) whose final byte is not `m` or whose parameters are not plain
//!   SGR parameters (e.g. `ESC [ 2 J`, `ESC [ 6 n`, `ESC [ > 4 m`).
//! - Every other escape sequence (`ESC c`, `ESC 7`, `ESC ( B`, …), all remaining C0 controls
//!   (including `\r`, `\x08`, `BEL`, `SO`/`SI`), `DEL` and all C1 controls (U+0080..=U+009F).
//!
//! Unlike the TS regexes, an unterminated string sequence is dropped (it swallows the rest of the
//! write and, for the streaming sanitizer, continues into the next one) rather than passed through.

const ESC: char = '\u{1b}';
const BEL: char = '\u{7}';
/// C1 String Terminator.
const ST: char = '\u{9c}';
/// Longest SGR parameter string forwarded; longer CSI sequences are dropped.
const MAX_SGR_PARAMS: usize = 64;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
enum State {
    #[default]
    Ground,
    /// Saw `ESC`.
    Escape,
    /// Inside `ESC <intermediates>` (e.g. `ESC ( B`), waiting for the final byte.
    EscapeIntermediate,
    /// Inside a CSI sequence; `params` holds the parameter bytes while they are still valid SGR.
    Csi { params: String, sgr_ok: bool },
    /// Inside an OSC/DCS/SOS/PM/APC string, dropping everything until its terminator.
    Str,
    /// Inside a string sequence, saw `ESC` (a following `\` terminates it).
    StrEscape,
}

/// Streaming terminal sanitizer: feed each chunk of server text through [`Self::push`]; escape
/// state carries over between chunks so split sequences are still stripped.
#[derive(Debug, Clone, Default)]
pub struct TerminalSanitizer {
    state: State,
}

impl TerminalSanitizer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sanitizes the next chunk of a stream and returns the text that is safe to write.
    pub fn push(&mut self, chunk: &str) -> String {
        let mut out = String::with_capacity(chunk.len());
        for ch in chunk.chars() {
            self.step(ch, &mut out);
        }
        out
    }

    /// Forgets any partially received escape sequence (it is dropped, never emitted).
    pub fn reset(&mut self) {
        self.state = State::Ground;
    }

    fn step(&mut self, ch: char, out: &mut String) {
        match std::mem::take(&mut self.state) {
            State::Ground => self.ground(ch, out),
            State::Escape => match ch {
                '[' => {
                    self.state = State::Csi {
                        params: String::new(),
                        sgr_ok: true,
                    }
                }
                ']' | 'P' | 'X' | '^' | '_' => self.state = State::Str,
                '\u{20}'..='\u{2f}' => self.state = State::EscapeIntermediate,
                // Two-character escape (`ESC c`, `ESC 7`, `ESC \`, …): dropped.
                '\u{30}'..='\u{7e}' => {}
                // Anything else aborts the escape; the char is handled as ordinary input.
                _ => self.ground(ch, out),
            },
            State::EscapeIntermediate => match ch {
                '\u{20}'..='\u{2f}' => self.state = State::EscapeIntermediate,
                '\u{30}'..='\u{7e}' => {}
                _ => self.ground(ch, out),
            },
            State::Csi { mut params, sgr_ok } => match ch {
                '\u{40}'..='\u{7e}' => {
                    if ch == 'm' && sgr_ok {
                        out.push(ESC);
                        out.push('[');
                        out.push_str(&params);
                        out.push('m');
                    }
                }
                '\u{20}'..='\u{3f}' => {
                    let is_sgr_param = ch.is_ascii_digit() || ch == ';' || ch == ':';
                    let sgr_ok = sgr_ok && is_sgr_param && params.len() < MAX_SGR_PARAMS;
                    if sgr_ok {
                        params.push(ch);
                    } else {
                        params.clear();
                    }
                    self.state = State::Csi { params, sgr_ok };
                }
                // A control or non-ASCII char aborts the CSI; handle it as ordinary input.
                _ => self.ground(ch, out),
            },
            State::Str => match ch {
                BEL | ST => {}
                ESC => self.state = State::StrEscape,
                _ => self.state = State::Str,
            },
            State::StrEscape => match ch {
                '\\' | BEL | ST => {}
                ESC => self.state = State::StrEscape,
                _ => self.state = State::Str,
            },
        }
    }

    fn ground(&mut self, ch: char, out: &mut String) {
        match ch {
            ESC => self.state = State::Escape,
            '\u{9b}' => {
                self.state = State::Csi {
                    params: String::new(),
                    sgr_ok: true,
                }
            }
            '\u{9d}' | '\u{90}' | '\u{98}' | '\u{9e}' | '\u{9f}' => self.state = State::Str,
            '\n' | '\t' => out.push(ch),
            c if is_control(c) => {}
            c => out.push(c),
        }
    }
}

/// C0 controls, `DEL` and C1 controls.
fn is_control(ch: char) -> bool {
    matches!(ch, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}')
}

/// Sanitizes one complete piece of server-supplied text before it is written to the terminal.
/// An unterminated escape sequence at the end is dropped. For streamed deltas use a
/// [`TerminalSanitizer`] that lives for the whole stream.
pub fn sanitize_terminal_output(text: &str) -> String {
    if !text.chars().any(is_control) {
        return text.to_owned();
    }
    TerminalSanitizer::new().push(text)
}

/// Bidirectional-override/isolate characters that can visually reorder text ("Trojan Source").
fn is_bidi_control(ch: char) -> bool {
    matches!(
        ch,
        '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
    )
}

/// Renders a server-supplied field shown inside an interactive prompt (approval command/reason,
/// question text, option labels) so it cannot rewrite the prompt: every C0/C1 control (`ESC`,
/// `\r`, `\x08`, `BEL`, U+0080..=U+009F, …), `DEL` and bidi override is shown as a visible escape
/// (`\r`, `\x1b`, `\u{9b}`, …) instead of being interpreted by the terminal.
///
/// `newline_indent`: `None` escapes `\n` as `\n` too (single-line fields such as a command);
/// `Some(indent)` keeps line breaks but starts every continuation line with `indent`, so a
/// multi-line field cannot impersonate a top-level prompt line.
pub fn sanitize_prompt_field(text: &str, newline_indent: Option<&str>) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\n' => match newline_indent {
                Some(indent) => {
                    out.push('\n');
                    out.push_str(indent);
                }
                None => out.push_str("\\n"),
            },
            '\t' => out.push('\t'),
            '\r' => out.push_str("\\r"),
            '\u{1b}' => out.push_str("\\x1b"),
            c if c <= '\u{7f}' && is_control(c) => {
                out.push_str(&format!("\\x{:02x}", c as u32));
            }
            c if is_control(c) || is_bidi_control(c) => {
                out.push_str(&format!("\\u{{{:x}}}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{TerminalSanitizer, sanitize_prompt_field, sanitize_terminal_output as s};

    /// Feeds `chunks` through one streaming sanitizer and concatenates the output.
    fn stream(chunks: &[&str]) -> String {
        let mut sanitizer = TerminalSanitizer::new();
        chunks.iter().map(|c| sanitizer.push(c)).collect()
    }

    // Ported from TS `test/cli-sanitize-terminal.test.ts`.
    #[test]
    fn passes_through_plain_and_empty_text() {
        assert_eq!(s("hello world"), "hello world");
        assert_eq!(s(""), "");
        assert_eq!(s("tab\there\nnext line"), "tab\there\nnext line");
    }

    #[test]
    fn preserves_safe_sgr_sequences() {
        for text in [
            "\x1b[31mred text\x1b[0m",
            "\x1b[1mbold\x1b[0m",
            "\x1b[4munderline\x1b[0m",
            "\x1b[mreset",
            "\x1b[38;5;196mx\x1b[38:2::1:2:3my\x1b[0m",
        ] {
            assert_eq!(s(text), text);
            assert_eq!(stream(&[text]), text);
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
    fn drops_unterminated_and_stray_sequences() {
        // Unterminated strings are dropped (stricter than the TS regexes, which kept them).
        assert_eq!(s("a\x1b]0;open"), "a");
        assert_eq!(s("a\x1bPopen\x07b"), "ab");
        assert_eq!(s("trailing\x1b"), "trailing");
        // Non-ASCII text around a stripped sequence survives intact.
        assert_eq!(s("héllo\x1b]0;t\x07wörld"), "héllowörld");
        // A doubled ESC and a lone ST are dropped; text between sequences survives.
        assert_eq!(s("\x1b\x1b]0;t\x07Pdata\x1b\\x"), "Pdatax");
        // Other escapes: full reset, cursor save/restore, charset designation, keypad mode.
        assert_eq!(s("a\x1bcb\x1b7c\x1b8d\x1b(Be\x1b=f"), "abcdef");
    }

    #[test]
    fn strips_osc_52_split_across_deltas() {
        assert_eq!(
            stream(&["before\x1b", "]52;c;SGVs", "bG8=", "\x07after"]),
            "beforeafter"
        );
        assert_eq!(
            stream(&["x\x1b]52;c;SGVsbG8=\x1b", "\\y"]),
            "xy",
            "ESC \\ terminator split across deltas"
        );
        assert_eq!(stream(&["a\x1bP", "dcs payload", "\x1b\\b"]), "ab");
        // A split SGR is reassembled and kept.
        assert_eq!(
            stream(&["\x1b[3", "1mred\x1b", "[0m"]),
            "\x1b[31mred\x1b[0m"
        );
    }

    #[test]
    fn strips_c1_control_introducers() {
        assert_eq!(s("a\u{9d}52;c;SGVsbG8=\u{7}b"), "ab");
        assert_eq!(s("a\u{9d}0;title\u{9c}b"), "ab");
        assert_eq!(s("a\u{90}dcs\u{9c}b"), "ab");
        assert_eq!(s("a\u{98}sos\u{1b}\\b"), "ab");
        assert_eq!(s("a\u{9e}pm\u{9c}b\u{9f}apc\u{9c}c"), "abc");
        assert_eq!(s("a\u{9b}2Jb"), "ab");
        // Other C1 controls (NEL, IND, RI, …) are dropped outright.
        assert_eq!(s("a\u{85}b\u{84}c\u{8d}d"), "abcd");
        assert_eq!(stream(&["a\u{9d}52;c;", "SGVs\u{7}b"]), "ab");
        // An 8-bit SGR is forwarded only in its 7-bit form.
        assert_eq!(s("a\u{9b}31mb"), "a\x1b[31mb");
    }

    #[test]
    fn strips_non_sgr_csi_sequences() {
        assert_eq!(s("a\x1b[2Jb"), "ab");
        assert_eq!(s("a\x1b[6nb"), "ab");
        assert_eq!(s("a\x1b[Hb\x1b[10;20Hc\x1b[?1049hd\x1b[Ke"), "abcde");
        // Private-marker / intermediate forms that end in `m` are not SGR.
        assert_eq!(s("a\x1b[>4;2mb\x1b[?1mc\x1b[1 md"), "abcd");
        assert_eq!(stream(&["a\x1b[", "2", "J", "b"]), "ab");
        assert_eq!(stream(&["a\x1b[6", "nb"]), "ab");
        // Oversized parameter strings are dropped.
        let long = format!("a\x1b[{}mb", "1;".repeat(100));
        assert_eq!(s(&long), "ab");
    }

    #[test]
    fn strips_dangerous_c0_controls() {
        assert_eq!(s("a\rb\x08c\x07d\x0ee\x0ff\x7fg\x00h"), "abcdefgh");
        assert_eq!(s("line\r\nnext"), "line\nnext");
    }

    #[test]
    fn sanitizer_reset_drops_pending_sequence() {
        let mut sanitizer = TerminalSanitizer::new();
        assert_eq!(sanitizer.push("a\x1b]52;c;"), "a");
        sanitizer.reset();
        assert_eq!(sanitizer.push("plain"), "plain");
    }

    #[test]
    fn prompt_field_escapes_every_control() {
        assert_eq!(
            sanitize_prompt_field("rm -rf /\rls\x08\x08", None),
            "rm -rf /\\rls\\x08\\x08"
        );
        assert_eq!(
            sanitize_prompt_field("a\x1b[2K\x1b[1Ab\x1b]52;c;Zm9v\x07", None),
            "a\\x1b[2K\\x1b[1Ab\\x1b]52;c;Zm9v\\x07"
        );
        assert_eq!(
            sanitize_prompt_field("a\u{9b}2Jb\u{9d}0;t\u{9c}\u{85}", None),
            "a\\u{9b}2Jb\\u{9d}0;t\\u{9c}\\u{85}"
        );
        assert_eq!(sanitize_prompt_field("x\x7fy\x00", None), "x\\x7fy\\x00");
        assert_eq!(
            sanitize_prompt_field("safe\u{202e}txt.exe", None),
            "safe\\u{202e}txt.exe"
        );
        assert_eq!(sanitize_prompt_field("tab\there é", None), "tab\there é");
    }

    #[test]
    fn prompt_field_newline_handling() {
        assert_eq!(
            sanitize_prompt_field("echo hi\nApprove? [y/N]: y", None),
            "echo hi\\nApprove? [y/N]: y"
        );
        assert_eq!(
            sanitize_prompt_field("line one\n[approval] fake", Some("    ")),
            "line one\n    [approval] fake"
        );
        assert_eq!(sanitize_prompt_field("a\r\nb", Some("  ")), "a\\r\n  b");
    }
}
