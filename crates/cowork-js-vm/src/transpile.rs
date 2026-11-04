use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::{Statement, TSModuleReference};
use oxc_codegen::Codegen;
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{TransformOptions, Transformer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompileIssue {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "ok")]
pub enum WorkflowCompileResult {
    #[serde(rename = "true")]
    Ok {
        js: String,
        #[serde(rename = "sourceHash")]
        source_hash: String,
    },
    #[serde(rename = "false")]
    Err { issues: Vec<CompileIssue> },
}

impl WorkflowCompileResult {
    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Ok { .. })
    }
}

/// Strips TypeScript syntax via `oxc_parser` -> `oxc_semantic::SemanticBuilder` ->
/// `oxc_transformer::Transformer::build_with_scoping` -> `oxc_codegen::Codegen`.
pub fn strip_typescript(source: &str, filename: &str) -> Result<String, Vec<CompileIssue>> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(filename).unwrap_or_else(|_| SourceType::ts());
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .into_iter()
            .map(|e| CompileIssue {
                path: "script".to_owned(),
                message: format!("script failed to parse: {e}"),
            })
            .collect());
    }

    let mut program = parsed.program;
    let semantic_ret = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .with_enum_eval(true)
        .build(&program);
    if !semantic_ret.diagnostics.is_empty() {
        return Err(semantic_ret
            .diagnostics
            .into_iter()
            .map(|e| CompileIssue {
                path: "script".to_owned(),
                message: format!("script failed semantic check: {e}"),
            })
            .collect());
    }

    let scoping = semantic_ret.semantic.into_scoping();
    let transform_options = TransformOptions::default();
    let transform_ret = Transformer::new(&allocator, Path::new(filename), &transform_options)
        .build_with_scoping(scoping, &mut program);
    if !transform_ret.diagnostics.is_empty() {
        return Err(transform_ret
            .diagnostics
            .into_iter()
            .map(|e| CompileIssue {
                path: "script".to_owned(),
                message: format!("script failed to transpile: {e}"),
            })
            .collect());
    }

    Ok(Codegen::new().build(&program).code)
}

/// Wraps a `codeMode` async function body into an ES module, rejects static imports / breakout
/// declarations, and strips TypeScript syntax via `SemanticBuilder` + `Transformer`.
pub fn compile_code_mode_module(code: &str) -> Result<String, String> {
    let wrapped = format!(
        "export default async function(tools: any): Promise<any> {{ \"use strict\";\n{code}\n}}"
    );
    let allocator = Allocator::default();
    let source_type = SourceType::ts();
    let parsed = Parser::new(&allocator, &wrapped, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        let joined = parsed
            .diagnostics
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; ");
        if joined.to_ascii_lowercase().contains("import") {
            return Err(format!("imports are not available in code mode: {joined}"));
        }
        return Err(format!("code mode syntax error: {joined}"));
    }

    if !parsed.module_record.requested_modules.is_empty() {
        return Err("imports are not available in code mode".to_owned());
    }

    let mut program = parsed.program;
    if program.body.len() != 1
        || !matches!(
            program.body.first(),
            Some(Statement::ExportDefaultDeclaration(_))
        )
    {
        for stmt in &program.body {
            if matches!(
                stmt,
                Statement::ImportDeclaration(_)
                    | Statement::ExportAllDeclaration(_)
                    | Statement::TSImportEqualsDeclaration(_)
            ) {
                return Err("imports are not available in code mode".to_owned());
            }
        }
        return Err("code mode body may not break out of its async function wrapper".to_owned());
    }

    let semantic_ret = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .with_enum_eval(true)
        .build(&program);
    if !semantic_ret.diagnostics.is_empty() {
        let joined = semantic_ret
            .diagnostics
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("code mode semantic error: {joined}"));
    }

    let scoping = semantic_ret.semantic.into_scoping();
    let transform_options = TransformOptions::default();
    let transform_ret = Transformer::new(&allocator, Path::new("codemode.ts"), &transform_options)
        .build_with_scoping(scoping, &mut program);
    if !transform_ret.diagnostics.is_empty() {
        let joined = transform_ret
            .diagnostics
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("code mode transform error: {joined}"));
    }

    Ok(Codegen::new().build(&program).code)
}

/// Compiles and validates a workflow TypeScript module:
/// 1. Rejects empty scripts or parse errors.
/// 2. Enforces zero external imports (both static `import`/`export ... from` and dynamic `import(...)`).
/// 3. Enforces exported `meta` and `default` value bindings.
/// 4. Runs `oxc_semantic::SemanticBuilder` + `oxc_transformer::Transformer::build_with_scoping` + `oxc_codegen::Codegen`.
pub fn compile_workflow_source(source: &str) -> WorkflowCompileResult {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return WorkflowCompileResult::Err {
            issues: vec![CompileIssue {
                path: "script".to_owned(),
                message: "script is empty".to_owned(),
            }],
        };
    }

    let allocator = Allocator::default();
    let source_type = SourceType::ts();
    let parsed = Parser::new(&allocator, trimmed, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        let msg = parsed
            .diagnostics
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; ");
        return WorkflowCompileResult::Err {
            issues: vec![CompileIssue {
                path: "script".to_owned(),
                message: format!("script failed to parse: {msg}"),
            }],
        };
    }

    let module_record = parsed.module_record;
    let mut program = parsed.program;

    let semantic_ret = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .with_enum_eval(true)
        .build(&program);
    if !semantic_ret.diagnostics.is_empty() {
        let msg = semantic_ret
            .diagnostics
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; ");
        return WorkflowCompileResult::Err {
            issues: vec![CompileIssue {
                path: "script".to_owned(),
                message: format!("script failed to parse: {msg}"),
            }],
        };
    }

    let mut found_imports = Vec::<String>::new();
    for spec in module_record.requested_modules.keys() {
        found_imports.push(spec.as_str().to_owned());
    }
    for stmt in &program.body {
        if let Statement::TSImportEqualsDeclaration(decl) = stmt {
            let label = match &decl.module_reference {
                TSModuleReference::ExternalModuleReference(ext) => ext
                    .expression
                    .span
                    .source_text(trimmed)
                    .trim_matches(['"', '\''])
                    .to_owned(),
                _ => decl.id.name.as_str().to_owned(),
            };
            if !found_imports.contains(&label) {
                found_imports.push(label);
            }
        }
    }
    for dyn_imp in &module_record.dynamic_imports {
        let raw_arg = dyn_imp
            .module_request
            .source_text(trimmed)
            .trim()
            .trim_matches(['"', '\'']);
        let label = if raw_arg.is_empty() {
            "dynamic import()".to_owned()
        } else {
            raw_arg.to_owned()
        };
        if !found_imports.contains(&label) {
            found_imports.push(label);
        }
    }

    let has_meta_export = module_record.local_export_entries.iter().any(|entry| {
        !entry.is_type
            && entry
                .export_name
                .span()
                .is_some_and(|sp| sp.source_text(trimmed) == "meta")
    });
    let has_default_export = module_record
        .local_export_entries
        .iter()
        .any(|entry| !entry.is_type && entry.export_name.default_export_span().is_some());

    let mut issues = Vec::<CompileIssue>::new();
    if !found_imports.is_empty() {
        issues.push(CompileIssue {
            path: "imports".to_owned(),
            message: format!(
                "workflow scripts may not import anything (found: {}). Everything you need is provided as the argument to the default export.",
                found_imports.join(", ")
            ),
        });
    }
    if !has_meta_export {
        issues.push(CompileIssue {
            path: "exports.meta".to_owned(),
            message:
                "script must `export const meta = { name, description, phases }` as a pure literal"
                    .to_owned(),
        });
    }
    if !has_default_export {
        issues.push(CompileIssue {
            path: "exports.default".to_owned(),
            message: "script must `export default async function run({ agent, parallel, pipeline, phase, log, args, budget }) { ... }`".to_owned(),
        });
    }
    if !issues.is_empty() {
        return WorkflowCompileResult::Err { issues };
    }

    let scoping = semantic_ret.semantic.into_scoping();
    let transform_options = TransformOptions::default();
    let transform_ret = Transformer::new(&allocator, Path::new("workflow.ts"), &transform_options)
        .build_with_scoping(scoping, &mut program);
    if !transform_ret.diagnostics.is_empty() {
        let msg = transform_ret
            .diagnostics
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; ");
        return WorkflowCompileResult::Err {
            issues: vec![CompileIssue {
                path: "script".to_owned(),
                message: format!("script failed to transpile: {msg}"),
            }],
        };
    }

    let js = Codegen::new().build(&program).code;
    let mut hasher = Sha256::new();
    hasher.update(trimmed.as_bytes());
    let source_hash = hex::encode(hasher.finalize());

    WorkflowCompileResult::Ok { js, source_hash }
}
