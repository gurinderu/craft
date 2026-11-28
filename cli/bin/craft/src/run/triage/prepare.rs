//! Refuse a new source on resume before asking the host; run agents in the recorded repository.
use std::num::NonZeroUsize;
use std::path::PathBuf;

use anyhow::{Result, bail};
use clap::ValueEnum;
use craft_triage::step::StartOptions;

use super::RunArgs;
use crate::run::events::Sink;
use crate::run::host::Host;

pub(super) struct Prepared {
    pub(super) start: Option<StartOptions>,
    pub(super) resume: Option<PathBuf>,
    pub(super) repo: PathBuf,
    pub(super) root: PathBuf,
    pub(super) host: Host,
    pub(super) concurrency: NonZeroUsize,
}

pub(super) fn prepare(mut a: RunArgs, sink: Sink) -> Result<Prepared> {
    if a.host.delegate
        && [&a.start.prior_ledger, &a.start.prior_decisions]
            .iter()
            .any(|p| p.as_deref().is_some_and(|p| p.as_os_str() == "-"))
    {
        bail!("--delegate cannot share stdin with --prior-ledger or --prior-decisions (-)");
    }
    let resume = a.run.as_deref().map(std::path::absolute).transpose()?;
    let (mut start, repo) = if let Some(dir) = &resume {
        (None, craft_triage::state::load(dir)?.cwd)
    } else {
        if !a.start.report.is_empty() {
            a.start.report = std::path::absolute(&a.start.report)?.display().to_string();
        }
        a.start
            .record
            .get_or_insert_with(|| env!("CARGO_PKG_VERSION").to_owned());
        let mut opts = crate::triage::options(&a.start)?;
        opts.args.runtime = a
            .host
            .backend
            .to_possible_value()
            .map(|v| v.get_name().to_owned());
        let repo = craft_triage::step::check_start(&opts)?;
        (Some(opts), repo)
    };
    let (concurrency, host, root) =
        super::super::ready(&a.host, a.craft_root.as_deref(), &repo, sink)
            .map_err(anyhow::Error::msg)?;
    if let Some(record) = start.as_mut().and_then(|s| s.args.record.as_mut())
        && a.start.record_root.is_none()
    {
        record.root = root.display().to_string();
    }
    Ok(Prepared {
        start,
        resume,
        repo,
        root,
        host,
        concurrency,
    })
}
