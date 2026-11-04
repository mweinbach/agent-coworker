use std::io::{self, Write};

use cowork_protocol::{export_protocol_schema_manifest, export_websocket_jsonrpc_schema_json};

fn main() {
    let mut emit_schema = false;
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--schema" => emit_schema = true,
            "--manifest" => emit_schema = false,
            other => {
                eprintln!("Unknown argument '{other}'. Expected --schema or --manifest.");
                std::process::exit(2);
            }
        }
    }

    let mut stdout = io::stdout().lock();
    let result: io::Result<()> = if emit_schema {
        let raw = export_websocket_jsonrpc_schema_json();
        stdout.write_all(raw.as_bytes()).and_then(|()| {
            if raw.ends_with('\n') {
                Ok(())
            } else {
                stdout.write_all(b"\n")
            }
        })
    } else {
        let manifest = export_protocol_schema_manifest();
        serde_json::to_writer(&mut stdout, &manifest)
            .map_err(io::Error::other)
            .and_then(|()| stdout.write_all(b"\n"))
    };

    if let Err(err) = result
        && err.kind() != io::ErrorKind::BrokenPipe
    {
        eprintln!("Failed to write protocol manifest output: {err}");
        std::process::exit(1);
    }
}
