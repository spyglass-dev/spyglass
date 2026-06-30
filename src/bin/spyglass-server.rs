//! `spyglass-server` — the reporting engine binary.
//!
//! Subcommands:
//!   - `serve`    (default) Actix server exposing the RUNTIME path `POST /query`
//!                (+ `/health`). Reads cube defs from `./cubes`, logs queries
//!                to `./logs`.
//!   - `schema`   OFFLINE: dump the database's public schema as JSON.
//!   - `analyze`  OFFLINE: profile the data (row counts, cardinality, ranges,
//!                top values) as JSON — for building cubes. Can be driven by an
//!                agent to run many queries in an admin/offline setup; it is
//!                NOT a runtime/tenant path.
//!   - `bundle`   OFFLINE: schema + (optional) profile + the contents of
//!                `--source <path>` files/folders, as one JSON — everything a
//!                distri-CLI agent needs to read the code AND the data and
//!                author cube files.
//!   - `validate` OFFLINE: load the cube directory (no DB) and report cubes /
//!                measures / dimensions; non-zero exit if anything fails to
//!                parse. For agents/CI to self-check generated cubes.
//!
//! Env: `DATABASE_URL` (required), `REPORTING_CUBES` (./cubes),
//! `REPORTING_LOGS` (./logs), `REPORTING_ADDR` (127.0.0.1:8088). These are
//! read from the process environment and from a `.env` file (loaded via
//! dotenvy after `-C`, so the working dir's `.env` is picked up).
//!
//! Global flag: `-C` / `--dir <path>` (docker-style) sets the working directory
//! before running, so `./cubes`, `./logs`, and `--source` paths resolve inside
//! it — e.g. `spyglass-server -C testing serve` loads `testing/cubes`.
//!
//! Examples:
//!   spyglass-server schema > schema.json
//!   spyglass-server -C testing analyze --profile --table activity_submissions
//!   spyglass-server analyze --profile --filter workspace_id=ws_123

use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use spyglass::analyze::{AnalyzeFilter, AnalyzeOptions};
use spyglass::context::SecurityContext;
use spyglass::engine::postgres::PostgresEngine;
use spyglass::logging::JsonFileExporter;
use spyglass::model::Model;
use spyglass::query::{Query, ScalarValue};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::Arc;

// ─── Runtime server (POST /query) ──────────────────────────────────────────

struct AppState {
    model: Model,
    engine: PostgresEngine,
}

#[derive(Deserialize)]
struct QueryBody {
    query: Query,
    #[serde(default)]
    scope: BTreeMap<String, ScalarValue>,
}

async fn query(state: web::Data<AppState>, body: web::Json<QueryBody>) -> impl Responder {
    let ctx = SecurityContext {
        scope: body.scope.clone(),
    };
    match state.engine.run(&state.model, &body.query, &ctx).await {
        Ok(result) => HttpResponse::Ok().json(result),
        Err(e) => HttpResponse::BadRequest().json(serde_json::json!({ "error": e.to_string() })),
    }
}

async fn health() -> impl Responder {
    HttpResponse::Ok().json(serde_json::json!({ "ok": true }))
}

fn database_url() -> String {
    std::env::var("DATABASE_URL").unwrap_or_else(|_| {
        eprintln!("DATABASE_URL is required");
        std::process::exit(1);
    })
}

async fn connect() -> PostgresEngine {
    PostgresEngine::connect(&database_url())
        .await
        .unwrap_or_else(|e| {
            eprintln!("failed to connect to postgres: {e}");
            std::process::exit(1);
        })
}

async fn serve() -> std::io::Result<()> {
    let cubes_dir = std::env::var("REPORTING_CUBES").unwrap_or_else(|_| "./cubes".to_string());
    let model = spyglass::loader::load_dir(&cubes_dir).unwrap_or_else(|e| {
        eprintln!("failed to load cubes from {cubes_dir}: {e}");
        std::process::exit(1);
    });
    eprintln!("loaded {} cube(s) from {cubes_dir}", model.cubes.len());

    let engine = connect().await;
    let logs_dir = std::env::var("REPORTING_LOGS").unwrap_or_else(|_| "logs".to_string());
    let engine = match JsonFileExporter::new(&logs_dir) {
        Ok(exporter) => engine.with_exporter(Arc::new(exporter)),
        Err(e) => {
            eprintln!("query logging disabled ({logs_dir}: {e})");
            engine
        }
    };

    let state = web::Data::new(AppState { model, engine });
    let addr = std::env::var("REPORTING_ADDR").unwrap_or_else(|_| "127.0.0.1:8088".to_string());
    eprintln!("spyglass-server listening on {addr}");

    HttpServer::new(move || {
        App::new()
            .app_data(state.clone())
            .route("/health", web::get().to(health))
            .route("/query", web::post().to(query))
    })
    .bind(&addr)?
    .run()
    .await
}

// ─── Offline subcommands (schema / analyze) ────────────────────────────────

async fn run_schema() -> std::io::Result<()> {
    let engine = connect().await;
    let schema = engine.introspect().await.unwrap_or_else(|e| {
        eprintln!("introspection failed: {e}");
        std::process::exit(1);
    });
    println!("{}", serde_json::to_string_pretty(&schema).unwrap_or_default());
    Ok(())
}

fn parse_analyze_opts(args: &[String]) -> AnalyzeOptions {
    let mut opts = AnalyzeOptions::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--profile" => opts.profile_values = true,
            "--table" => {
                if let Some(t) = args.get(i + 1) {
                    opts.tables.get_or_insert_with(Vec::new).push(t.clone());
                    i += 1;
                }
            }
            "--filter" => {
                if let Some(kv) = args.get(i + 1) {
                    if let Some((c, v)) = kv.split_once('=') {
                        opts.filter = Some(AnalyzeFilter {
                            column: c.to_string(),
                            value: v.to_string(),
                        });
                    }
                    i += 1;
                }
            }
            "--top" => {
                if let Some(n) = args.get(i + 1).and_then(|s| s.parse::<i64>().ok()) {
                    opts.top_k = n;
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    opts
}

async fn run_analyze(args: &[String]) -> std::io::Result<()> {
    let opts = parse_analyze_opts(args);
    let engine = connect().await;
    let profile = engine.analyze(&opts).await.unwrap_or_else(|e| {
        eprintln!("analysis failed: {e}");
        std::process::exit(1);
    });
    println!("{}", serde_json::to_string_pretty(&profile).unwrap_or_default());
    Ok(())
}

// ─── bundle: schema + profile + source files (for agent cube-building) ──────

#[derive(serde::Serialize)]
struct SourceFile {
    path: String,
    bytes: usize,
    contents: String,
}

#[derive(serde::Serialize)]
struct CubegenBundle {
    schema: spyglass::RawSchema,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile: Option<spyglass::DbProfile>,
    sources: Vec<SourceFile>,
}

const SOURCE_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "sql", "md", "yml", "yaml", "toml", "json", "prisma",
];
const MAX_FILE_BYTES: usize = 200_000;

/// Recursively collect readable source files under the given paths (files or
/// dirs). Skips binaries, node_modules/target/.git, and oversized files.
fn read_sources(paths: &[String]) -> Vec<SourceFile> {
    let mut out = Vec::new();
    for p in paths {
        collect(std::path::Path::new(p), &mut out);
    }
    out
}

fn collect(path: &std::path::Path, out: &mut Vec<SourceFile>) {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if matches!(name, "node_modules" | "target" | ".git" | "dist") {
        return;
    }
    if path.is_dir() {
        if let Ok(entries) = std::fs::read_dir(path) {
            let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).collect();
            paths.sort();
            for child in paths {
                collect(&child, out);
            }
        }
        return;
    }
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if !SOURCE_EXTS.contains(&ext) {
        return;
    }
    if let Ok(contents) = std::fs::read_to_string(path) {
        if contents.len() <= MAX_FILE_BYTES {
            out.push(SourceFile {
                path: path.display().to_string(),
                bytes: contents.len(),
                contents,
            });
        }
    }
}

async fn run_bundle(args: &[String]) -> std::io::Result<()> {
    // Reuse analyze flags (--profile/--table/--filter/--top) + gather --source.
    let opts = parse_analyze_opts(args);
    let mut sources = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--source" {
            if let Some(p) = args.get(i + 1) {
                sources.push(p.clone());
                i += 1;
            }
        }
        i += 1;
    }

    let engine = connect().await;
    let schema = engine.introspect().await.unwrap_or_else(|e| {
        eprintln!("introspection failed: {e}");
        std::process::exit(1);
    });
    let profile = if opts.profile_values || opts.tables.is_some() {
        Some(engine.analyze(&opts).await.unwrap_or_else(|e| {
            eprintln!("analysis failed: {e}");
            std::process::exit(1);
        }))
    } else {
        None
    };

    let bundle = CubegenBundle {
        schema,
        profile,
        sources: read_sources(&sources),
    };
    println!("{}", serde_json::to_string_pretty(&bundle).unwrap_or_default());
    Ok(())
}

/// Extract a global working-directory flag (`-C` / `--dir` / `--cwd <path>`,
/// docker-style) from `args`, removing the flag and its value in place. All
/// relative paths (`./cubes`, `./logs`, `--source …`) then resolve inside it.
fn extract_workdir(args: &mut Vec<String>) -> Option<String> {
    let mut dir = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-C" | "--dir" | "--cwd" => {
                args.remove(i); // drop the flag
                if i < args.len() {
                    dir = Some(args.remove(i)); // take its value
                }
            }
            other if other.starts_with("--dir=") || other.starts_with("--cwd=") => {
                dir = other.split_once('=').map(|(_, v)| v.to_string());
                args.remove(i);
            }
            _ => i += 1,
        }
    }
    dir
}

/// OFFLINE: load the cube directory (no DB) and report what's in it. Exits
/// non-zero if anything fails to parse — handy for agents/CI to self-check that
/// generated cubes are well-formed.
fn run_validate() {
    let cubes_dir = std::env::var("REPORTING_CUBES").unwrap_or_else(|_| "./cubes".to_string());
    let model = spyglass::loader::load_dir(&cubes_dir).unwrap_or_else(|e| {
        eprintln!("INVALID: failed to load cubes from {cubes_dir}: {e}");
        std::process::exit(1);
    });
    if model.cubes.is_empty() {
        eprintln!("INVALID: no cubes found in {cubes_dir}");
        std::process::exit(1);
    }
    println!("OK: {} cube(s) in {cubes_dir}", model.cubes.len());
    for (name, cube) in &model.cubes {
        let tenant = cube
            .dimensions
            .iter()
            .find(|(_, d)| d.tenant)
            .map(|(k, _)| k.as_str());
        println!(
            "  {name}: {} measure(s), {} dimension(s), tenant={}",
            cube.measures.len(),
            cube.dimensions.len(),
            tenant.unwrap_or("(none!)"),
        );
    }
    // A tenant-less cube is loadable but can't be safely scoped — warn loudly.
    let untenanted: Vec<&String> = model
        .cubes
        .iter()
        .filter(|(_, c)| !c.dimensions.values().any(|d| d.tenant))
        .map(|(n, _)| n)
        .collect();
    if !untenanted.is_empty() {
        eprintln!("WARNING: cube(s) without a tenant dimension: {untenanted:?}");
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init();
    // Install the rustls crypto provider once (ring), matching zippy.
    #[cfg(feature = "tls")]
    let _ = rustls::crypto::ring::default_provider().install_default();

    let mut args: Vec<String> = std::env::args().collect();
    args.remove(0); // drop the program name

    // Docker-style working directory: `spyglass-server -C testing serve` loads
    // cubes from `testing/cubes`, logs to `testing/logs`, etc.
    if let Some(dir) = extract_workdir(&mut args) {
        if let Err(e) = std::env::set_current_dir(&dir) {
            eprintln!("failed to set working directory to '{dir}': {e}");
            std::process::exit(1);
        }
        eprintln!("working directory: {dir}");
    }

    // Load `.env` (after `-C`, so the working dir's `.env` wins; dotenvy walks
    // up to parent dirs too). Real environment variables still take precedence.
    dotenvy::dotenv().ok();

    match args.first().map(|s| s.as_str()) {
        Some("schema") => run_schema().await,
        Some("analyze") => run_analyze(&args[1..]).await,
        Some("bundle") => run_bundle(&args[1..]).await,
        Some("validate") => {
            run_validate();
            Ok(())
        }
        Some("serve") | None => serve().await,
        Some(other) => {
            eprintln!(
                "unknown subcommand '{other}'. Use: serve | schema | analyze | bundle | validate"
            );
            eprintln!("global: -C/--dir <path>  set the working directory (docker-style)");
            std::process::exit(2);
        }
    }
}
