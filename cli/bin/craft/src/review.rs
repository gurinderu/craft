//! `craft review`: for now, one agent run end to end — spec, backend, progress view, result — to
//! prove the pipe before the review pipeline lands.

use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use anyhow::{Context, Result};
use craft_agent::anthropic_api::AnthropicApi;
use craft_agent::claude_code::ClaudeCode;
use craft_agent::runner::{RunEvent, run_all};
use craft_agent::{AgentBackend, AgentRequest};
use craft_review::AgentSpec;
use craft_tui::ProgressEvent;
use tokio::sync::mpsc;

use crate::{Backend, ReviewArgs};

const PHASE: &str = "probe";

pub async fn run(args: ReviewArgs) -> Result<ExitCode> {
    let cwd = args
        .cwd
        .canonicalize()
        .with_context(|| format!("reading the review directory {}", args.cwd.display()))?;
    let spec = load_spec(args.spec.as_deref(), &args.base)?;
    match args.backend {
        Backend::ClaudeCode => {
            let craft_root = args.craft_root.clone().or_else(find_craft_root);
            let backend = ClaudeCode {
                command: args.claude.clone(),
                plugin_dirs: craft_root.into_iter().collect(),
                ..ClaudeCode::default()
            };
            run_one(backend, spec, cwd, &args).await
        }
        Backend::AnthropicApi => run_one(AnthropicApi, spec, cwd, &args).await,
    }
}

fn load_spec(path: Option<&Path>, base: &str) -> Result<AgentSpec> {
    let Some(path) = path else {
        return Ok(AgentSpec::probe(base));
    };
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading the agent spec {}", path.display()))?;
    serde_json::from_str(&text)
        .with_context(|| format!("parsing the agent spec {}", path.display()))
}

/// The nearest directory above the executable that holds craft's plugin manifest: the checkout a
/// development build sits in.
fn find_craft_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|dir| dir.join(".claude-plugin/plugin.json").is_file())
        .map(Path::to_path_buf)
}

async fn run_one<B: AgentBackend + 'static>(
    backend: B,
    spec: AgentSpec,
    cwd: PathBuf,
    args: &ReviewArgs,
) -> Result<ExitCode> {
    let (progress_tx, progress_rx) = mpsc::unbounded_channel();
    let (run_tx, run_rx) = mpsc::unbounded_channel();
    let ids = vec![spec.id.clone()];
    for event in [
        ProgressEvent::Phase { name: PHASE.into() },
        ProgressEvent::Agent {
            phase: PHASE.into(),
            agent: spec.id.clone(),
        },
    ] {
        progress_tx
            .send(event)
            .context("the progress view stopped early")?;
    }
    let bridge = tokio::spawn(bridge(run_rx, progress_tx, ids));
    let view = tokio::spawn(view(progress_rx, args.plain));

    let request = AgentRequest {
        label: spec.id.clone(),
        prompt: spec.prompt,
        model: spec.model,
        schema: spec.schema,
        allowed_tools: spec.allowed_tools,
        cwd,
    };
    let mut outcomes = run_all(Arc::new(backend), vec![request], args.concurrency, run_tx).await;
    bridge.await.context("the progress bridge failed")?;
    view.await.context("the progress view failed")??;

    let outcome = outcomes.pop().context("the runner returned no outcome")?;
    match outcome {
        Ok(reply) => {
            let result = serde_json::json!({ "agent": spec.id, "reply": reply });
            write_result(args.out.as_deref(), &result)?;
            Ok(ExitCode::SUCCESS)
        }
        Err(e) => Err(anyhow::Error::new(e).context(format!("agent {}", spec.id))),
    }
}

/// Runner events by index → view events by agent id.
async fn bridge(
    mut runs: mpsc::UnboundedReceiver<RunEvent>,
    progress: mpsc::UnboundedSender<ProgressEvent>,
    ids: Vec<String>,
) {
    let id = |index: usize| ids.get(index).cloned().unwrap_or_else(|| index.to_string());
    while let Some(event) = runs.recv().await {
        let event = match event {
            RunEvent::Started { index } => ProgressEvent::Started { agent: id(index) },
            RunEvent::Finished { index, reply } => ProgressEvent::Finished {
                agent: id(index),
                tokens: reply.usage.total(),
                cost_usd: reply.cost_usd,
            },
            RunEvent::Failed { index, error } => ProgressEvent::Failed {
                agent: id(index),
                reason: error,
            },
        };
        if progress.send(event).is_err() {
            return;
        }
    }
}

async fn view(events: mpsc::UnboundedReceiver<ProgressEvent>, plain: bool) -> Result<()> {
    if plain || !std::io::stderr().is_terminal() {
        craft_tui::run_plain(events, &mut std::io::stderr()).await?;
    } else {
        craft_tui::run_tty(events).await?;
    }
    Ok(())
}

fn write_result(out: Option<&Path>, result: &serde_json::Value) -> Result<()> {
    let text = serde_json::to_string_pretty(result)?;
    match out {
        Some(path) => std::fs::write(path, format!("{text}\n"))
            .with_context(|| format!("writing the result to {}", path.display())),
        None => {
            let mut stdout = std::io::stdout().lock();
            writeln!(stdout, "{text}")?;
            Ok(())
        }
    }
}
