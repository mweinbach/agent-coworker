#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThinkTagSplitState {
    pub in_think: bool,
    pub pending: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThinkTagChunkOutput {
    pub thinking_text: String,
    pub visible_text: String,
}

/// Incrementally splits inline `<think ...>...</think>` blocks from streaming text chunks across
/// arbitrary chunk boundaries without matching `<thinker>` or leaking tag markup.
pub fn split_think_tagged_text_chunk(
    state: &mut ThinkTagSplitState,
    chunk: &str,
) -> ThinkTagChunkOutput {
    let mut out = ThinkTagChunkOutput::default();
    if chunk.is_empty() {
        return out;
    }

    let mut buf = String::with_capacity(state.pending.len() + chunk.len());
    buf.push_str(&state.pending);
    buf.push_str(chunk);
    state.pending.clear();

    let mut cursor = 0usize;
    while cursor < buf.len() {
        let rest = &buf[cursor..];
        let Some(lt_rel) = rest.find('<') else {
            if state.in_think {
                out.thinking_text.push_str(rest);
            } else {
                out.visible_text.push_str(rest);
            }
            break;
        };

        if lt_rel > 0 {
            let before = &rest[..lt_rel];
            if state.in_think {
                out.thinking_text.push_str(before);
            } else {
                out.visible_text.push_str(before);
            }
            cursor += lt_rel;
            continue;
        }

        // `rest` starts with '<'
        if !state.in_think {
            const OPEN_PREFIX: &str = "<think";
            if rest.len() < OPEN_PREFIX.len() {
                if OPEN_PREFIX
                    .as_bytes()
                    .get(..rest.len())
                    .is_some_and(|p| p.eq_ignore_ascii_case(rest.as_bytes()))
                {
                    state.pending.push_str(rest);
                    break;
                }
                out.visible_text.push('<');
                cursor += 1;
                continue;
            }

            if rest.as_bytes()[..OPEN_PREFIX.len()].eq_ignore_ascii_case(OPEN_PREFIX.as_bytes()) {
                let after = &rest[OPEN_PREFIX.len()..];
                if after.is_empty() {
                    // Could still become `<think>`, `<think attr>`, or `<thinker>`
                    state.pending.push_str(rest);
                    break;
                }
                let next_byte = after.as_bytes()[0];
                if next_byte == b'>' {
                    state.in_think = true;
                    cursor += OPEN_PREFIX.len() + 1;
                    continue;
                }
                if next_byte.is_ascii_whitespace() {
                    if let Some(gt_rel) = after.find('>') {
                        state.in_think = true;
                        cursor += OPEN_PREFIX.len() + gt_rel + 1;
                        continue;
                    }
                    state.pending.push_str(rest);
                    break;
                }
            }

            // Not a `<think>` opening tag (e.g. `<thinker>` or `<div>`)
            out.visible_text.push('<');
            cursor += 1;
        } else {
            const CLOSE_PREFIX: &str = "</think";
            if rest.len() < CLOSE_PREFIX.len() {
                if CLOSE_PREFIX
                    .as_bytes()
                    .get(..rest.len())
                    .is_some_and(|p| p.eq_ignore_ascii_case(rest.as_bytes()))
                {
                    state.pending.push_str(rest);
                    break;
                }
                out.thinking_text.push('<');
                cursor += 1;
                continue;
            }

            if rest.as_bytes()[..CLOSE_PREFIX.len()].eq_ignore_ascii_case(CLOSE_PREFIX.as_bytes()) {
                let after = &rest[CLOSE_PREFIX.len()..];
                let trimmed_ws = after.trim_start_matches(|c: char| c.is_ascii_whitespace());
                if trimmed_ws.is_empty() {
                    state.pending.push_str(rest);
                    break;
                }
                if trimmed_ws.as_bytes()[0] == b'>' {
                    let ws_len = after.len() - trimmed_ws.len();
                    state.in_think = false;
                    cursor += CLOSE_PREFIX.len() + ws_len + 1;
                    continue;
                }
            }

            out.thinking_text.push('<');
            cursor += 1;
        }
    }

    out
}

/// Flushes any trailing buffered tag prefix at end-of-stream.
pub fn flush_think_tag_split_state(state: &mut ThinkTagSplitState) -> ThinkTagChunkOutput {
    let tail = std::mem::take(&mut state.pending);
    if tail.is_empty() {
        return ThinkTagChunkOutput::default();
    }
    if state.in_think {
        ThinkTagChunkOutput {
            thinking_text: tail,
            visible_text: String::new(),
        }
    } else {
        ThinkTagChunkOutput {
            thinking_text: String::new(),
            visible_text: tail,
        }
    }
}

/// Convenience helper for splitting complete strings containing `<think>...</think>` tags.
pub fn split_think_tagged_text(text: &str) -> ThinkTagChunkOutput {
    let mut state = ThinkTagSplitState::default();
    let mut out = split_think_tagged_text_chunk(&mut state, text);
    let tail = flush_think_tag_split_state(&mut state);
    out.thinking_text.push_str(&tail.thinking_text);
    out.visible_text.push_str(&tail.visible_text);
    out
}
