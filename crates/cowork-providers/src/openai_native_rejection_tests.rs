//! Decision boundaries for `classify_rejected_openai_native_tool_error`.
//!
//! A wrong `true` permanently drops native tool search or programmatic tool calling for the
//! cached endpoint. A wrong `false` keeps sending a feature the endpoint already rejected.

use std::collections::HashMap;

use cowork_inference::ProviderTransportError;

use super::{
    NativeProgrammaticToolCallingKind, NativeToolCallingPlan, NativeToolSearchKind,
    classify_rejected_openai_native_tool_error,
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
        tool_search: tool_search.then_some(NativeToolSearchKind::OpenAiResponses),
        programmatic_tool_calling: programmatic
            .then_some(NativeProgrammaticToolCallingKind::OpenAiResponses),
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
fn openai_native_rejection_tracks_only_the_feature_the_client_error_names() {
    let cases = [
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
        Case {
            status: Some(400),
            message: "HTTP 400: TOOL_SEARCH is unknown",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: true,
            expect_programmatic: false,
        },
        Case {
            status: Some(422),
            message: "HTTP 422: openrouter:tool_search is unrecognized",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: true,
            expect_programmatic: false,
        },
        Case {
            status: Some(404),
            message: "HTTP 404: programmatic_tool_calling is not supported",
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
            message: "HTTP 400: allowed_callers is invalid",
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
            message: "HTTP 400: defer_loading and programmatic_tool_calling are unsupported",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: true,
            expect_programmatic: true,
        },
        // A named feature the plan is not using must not clear the other feature.
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
            message: "HTTP 400: programmatic_tool_calling is not supported",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: false,
            expect_tool_search: false,
            expect_programmatic: false,
        },
        // Generic tool-schema rejections clear every native feature that was actually sent.
        Case {
            status: Some(400),
            message: "HTTP 400: tools[1].type is invalid",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: true,
            expect_programmatic: true,
        },
        Case {
            status: Some(422),
            message: "HTTP 422: param: tools unrecognized",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: false,
            expect_tool_search: true,
            expect_programmatic: false,
        },
        Case {
            status: Some(400),
            message: "HTTP 400: tools[0] is required",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: false,
            expect_programmatic: false,
        },
        // `container` is an Anthropic signal. It must not disable OpenAI programmatic calling.
        Case {
            status: Some(400),
            message: "HTTP 400: container expired",
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
            message: "HTTP 500: defer_loading and programmatic_tool_calling are not supported",
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
            message: "HTTP 429: tool_search rate limited",
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
            message: "HTTP 408: tool_search timeout",
            abort: false,
            network: false,
            timeout: true,
            tool_search: true,
            programmatic: true,
            expect_tool_search: false,
            expect_programmatic: false,
        },
        Case {
            status: Some(504),
            message: "HTTP 504: programmatic_tool_calling gateway timeout",
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
            message: "HTTP 400: tool_search is not supported",
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
            message: "tool_search is not supported",
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
            message: "programmatic_tool_calling is not supported",
            abort: false,
            network: false,
            timeout: true,
            tool_search: true,
            programmatic: true,
            expect_tool_search: false,
            expect_programmatic: false,
        },
        // A protocol error has no HTTP status and is still a client-side rejection.
        Case {
            status: None,
            message: "defer_loading is invalid",
            abort: false,
            network: false,
            timeout: false,
            tool_search: true,
            programmatic: true,
            expect_tool_search: true,
            expect_programmatic: false,
        },
    ];

    for case in cases {
        let got = classify_rejected_openai_native_tool_error(
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
