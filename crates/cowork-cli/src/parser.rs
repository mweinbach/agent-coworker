/// Parsed interactive REPL user input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedReplCommand {
    Help,
    Exit,
    New,
    Restart,
    Tools,
    Skills,
    Mcp,
    Sessions,
    Compact,
    Clear,
    ClearHardCap,
    Model(String),
    Provider(String),
    Reasoning(String),
    Verbosity(String),
    ReasoningSummary(String),
    Resume(String),
    Connect(String),
    Cwd(String),
    Unknown { name: String, arg: String },
    Message(String),
}

/// Parses a single REPL input line into either a slash command or a user message.
pub fn parse_repl_input(input: &str) -> ParsedReplCommand {
    let line = input.trim();
    if line.is_empty() {
        return ParsedReplCommand::Message(String::new());
    }
    let Some(rest) = line.strip_prefix('/') else {
        return ParsedReplCommand::Message(line.to_owned());
    };

    let (cmd, arg) = match rest.find(char::is_whitespace) {
        Some(idx) => (&rest[..idx], rest[idx..].trim()),
        None => (rest, ""),
    };

    match cmd {
        "help" => ParsedReplCommand::Help,
        "exit" | "quit" => ParsedReplCommand::Exit,
        "new" => ParsedReplCommand::New,
        "restart" => ParsedReplCommand::Restart,
        "tools" => ParsedReplCommand::Tools,
        "skills" => ParsedReplCommand::Skills,
        "mcp" => ParsedReplCommand::Mcp,
        "sessions" => ParsedReplCommand::Sessions,
        "compact" => ParsedReplCommand::Compact,
        "clear" => ParsedReplCommand::Clear,
        "clear-hard-cap" => ParsedReplCommand::ClearHardCap,
        "model" => ParsedReplCommand::Model(arg.to_owned()),
        "provider" => ParsedReplCommand::Provider(arg.to_owned()),
        "reasoning" | "reasoning-effort" | "effort" => ParsedReplCommand::Reasoning(arg.to_owned()),
        "verbosity" => ParsedReplCommand::Verbosity(arg.to_owned()),
        "reasoning-summary" => ParsedReplCommand::ReasoningSummary(arg.to_owned()),
        "resume" => ParsedReplCommand::Resume(arg.to_owned()),
        "connect" => ParsedReplCommand::Connect(arg.to_owned()),
        "cwd" => ParsedReplCommand::Cwd(arg.to_owned()),
        other => ParsedReplCommand::Unknown {
            name: other.to_owned(),
            arg: arg.to_owned(),
        },
    }
}
