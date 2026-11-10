//! Decision boundaries for `classify_rejected_anthropic_native_tool_error`.
//!
//! Anthropic's tool-search marker is `tool_search_tool`, not the OpenAI `tool_search` token.
//! `container` and `code_execution` belong to programmatic tool calling only.

use std::collections::HashMap;

use cowork_inference::ProviderTransportError;

use super::{
    NativeProgrammaticToolCallingKind, NativeToolCallingPlan, NativeToolSearchKind,
    classify_rejected_anthropic_native_tool_error,
};

struct Case {
    status: Option<u16>,
    message: &'static str,
    abort: bool,
    network: bool,
    timeout: bool,
    tool_search: bool,
    programmatic: bool,
    expect_tool_search: bool,
    expect_programmatic: bool,
}

fn plan(tool_search: bool, programmatic: bool) -> NativeToolCallingPlan {
    NativeToolCallingPlan {
        tool_search: tool_search.then_some(NativeToolSearchKind::AnthropicBm25),
        programmatic_tool_calling: programmatic
            .then_some(NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120),
        deferred_tool_names: Vec::new(),
        programmatic_tool_names: Vec::new(),
        codex_code_mode: None,
    }
}

fn error(case: &Case) -> ProviderTransportError {
    ProviderTransportError {
        status: case.status,
        message: case.message.to_string(),
        code: None,
        headers: HashMap::new(),
        is_network_transient: case.network,
        is_timeout: case.timeout,
        is_abort: case.abort,
    }
}

#[test]
fn anthropic_native_rejection_tracks_only_the_feature_the_client_error_names() {
    let cases = [
        Case {
            status: Some(400),
            message: "HTTP 400: tool_search_tool_regex_20251119 is unknown",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: true,
            expect_programmatic: false,
        },
        Case {
            status: Some(400),
            message: "HTTP 400: defer_loading is not supported",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: true,
            expect_programmatic: false,
        },
        // Bare `tool_search` is the OpenAI tool type. It must not disable Anthropic tool search.
        Case {
            status: Some(400),
            message: "HTTP 400: tool_search is not supported",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: false,
            expect_programmatic: false,
        },
        Case {
            status: Some(400),
            message: "HTTP 400: code_execution_20260120 is unsupported",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: false,
            expect_programmatic: true,
        },
        Case {
            status: Some(422),
            message: "HTTP 422: allowed_callers is invalid",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: false,
            expect_programmatic: true,
        },
        Case {
            status: Some(404),
            message: "HTTP 404: container not found",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: false,
            expect_programmatic: true,
        },
        Case {
            status: Some(400),
            message: "HTTP 400: tool_search_tool and code_execution were rejected",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: true,
            expect_programmatic: true,
        },
        Case {
            status: Some(400),
            message: "HTTP 400: defer_loading is not supported",
            abort: false,
            network: false,
            timeout: false,
            tool_search: false,
            programmatic: true,
            expect_tool_search: false,
            expect_programmatic: false,
        },
        Case {
            status: Some(400),
            message: "HTTP 400: container expired",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: false,
            expect_tool_search: false,
            expect_programmatic: false,
        },
        Case {
            status: Some(400),
            message: "HTTP 400: tools.4: extra inputs are not permitted",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: true,
            expect_programmatic: true,
        },
        Case {
            status: Some(400),
            message: "HTTP 400: tools[0]: unknown field",
            abort: false,
            network: false,
            timeout: false,
            tool_search: false,
            programmatic: true,
            expect_tool_search: false,
            expect_programmatic: true,
        },
        Case {
            status: Some(400),
            message: "HTTP 400: tools.0 is required",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: false,
            expect_programmatic: false,
        },
        Case {
            status: Some(500),
            message: "HTTP 500: tool_search_tool and code_execution are not supported",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: false,
            expect_programmatic: false,
        },
        Case {
            status: Some(429),
            message: "HTTP 429: defer_loading rate limited",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: false,
            expect_programmatic: false,
        },
        Case {
            status: Some(408),
            message: "HTTP 408: code_execution timeout",
            abort: false,
            network: false,
            timeout: true,
            tool_search: true,
            programmatic: true,
            expect_tool_search: false,
            expect_programmatic: false,
        },
        Case {
            status: Some(400),
            message: "HTTP 400: tool_search_tool is not supported",
            abort: true,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: false,
            expect_programmatic: false,
        },
        Case {
            status: None,
            message: "defer_loading is not supported",
            abort: false,
            network: true,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: false,
            expect_programmatic: false,
        },
        Case {
            status: None,
            message: "code_execution is not supported",
            abort: false,
            network: false,
            timeout: true,
            tool_search: true,
            programmatic: true,
            expect_tool_search: false,
            expect_programmatic: false,
        },
        Case {
            status: None,
            message: "container expired",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: false,
            expect_programmatic: true,
        },
    ];

    for case in cases {
        let got = classify_rejected_anthropic_native_tool_error(
            &error(&case),
            &plan(case.tool_search, case.programmatic),
        );
        assert_eq!(
            got,
            (case.expect_tool_search, case.expect_programmatic),
            "status {:?} message {:?}",
            case.status,
            case.message
        );
    }
}
