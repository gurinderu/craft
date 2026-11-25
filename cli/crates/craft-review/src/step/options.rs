//! What `start` needs, as the host or `craft review run` gives it.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::gate::GateSetup;
use crate::memory::Memory;
use crate::publish::PostSetup;
use crate::rereview;
use crate::sources::SourcesSetup;

/// What `start` needs.
#[derive(Debug, Clone, Default)]
pub struct StartOptions {
    pub cwd: PathBuf,
    pub base: Option<String>,
    pub run_dir: PathBuf,
    /// craft's checkout and plugin version, for the review-rules paths the prompts name.
    pub craft_root: Option<String>,
    pub craft_version: Option<String>,
    /// A light pass (`depth=light`): the diff-scoped lenses, one round, only Medium and above
    /// verified — and a weak assertion naming its regression, whose verifier is asked whether the
    /// change's promise is unmet (realm @nick/craft, node #619).
    pub light: bool,
    /// Start a new chain of rounds rather than build on the branch's earlier round.
    pub fresh: bool,
    /// The run reviews only the fix commits since an earlier review: a delta round, which never
    /// approves.
    pub delta: bool,
    /// Every this-many-th round of a chain reviews the whole diff again; 0, never.
    pub full_every: u32,
    /// The agent budget of the lens rounds (`--lens-agents`): a later round whose lens tasks would
    /// take the rounds past it is not bought; `None`, twice the first round's lens tasks a later
    /// round may send again (realm @nick/craft, node #634).
    pub lens_agents: Option<u32>,
    /// Where earlier runs are looked for; the run directory's parent when `None`.
    pub runs: Option<PathBuf>,
    /// Strict mode: the maintainability bar is a presumption of block.
    pub strict: bool,
    /// The launcher's own records (`priorDecisions`) as given, added to what the run recalls; `Err`
    /// names why the host's list could not be read, which refuses it and runs the review anyway.
    pub prior_decisions: Option<Result<Value, String>>,
    /// Recall the project's memory beside the scouts; without it only `prior_decisions` apply.
    pub recall: bool,
    /// Why the launcher's own recall may not have read the whole store (`--recall-degraded`): the
    /// run names it and reads as degraded; taken only with `recall` false.
    pub recall_degraded: Option<String>,
    /// Where the reviewer's profile and the sources cache are: the integration points' sources are
    /// prepared before the first tasks. `None`, none are.
    pub sources: Option<SourcesSetup>,
    /// How the mechanical gate runs its tools before the scouts; `None`, it does not run, and the
    /// report says so.
    pub gate: Option<GateSetup>,
    /// The launching run's gate to take rather than run one (`--gate-from`, the directory
    /// `craft review gate` wrote): its seeds on this run's files reach the lenses
    /// ([`crate::gate::alone::taken`]); over `gate` when both are given.
    pub gate_from: Option<PathBuf>,
    /// The consumer's own agents to run as extra lenses, as the host names them (`extraLenses`):
    /// names separated by commas or spaces, or `off`; `None`, discovered on a light pass and off
    /// on a full review ([`crate::extra::request`]).
    pub extra_lenses: Option<String>,
    /// The directory the host session runs in, whose project's `.claude/agents` discovery reads;
    /// the process's working directory when `None`.
    pub session: Option<PathBuf>,
    /// Unit mode (`unitScope`, off by default): each sliceable lens confined to a batch of the
    /// units its profile finds, a contract lens per touched unit and a coordinator after the rounds
    /// ([`crate::units`]).
    pub unit_scope: bool,
    /// The directory (or file) of the change to review (`path`), repository-relative or absolute
    /// inside the repository; `None`, the whole change ([`crate::scope`]).
    pub path: Option<String>,
    /// Publish the findings on the branch's PR when the run finishes (`comment`): the defects
    /// posted with the craft-finding marker, the doubtful ones listed for the reviewer
    /// ([`crate::publish`]); off, nothing is posted.
    pub comment: bool,
    /// The optional lenses to run (`optional`): `all`, or their names separated by commas or
    /// spaces; `None`, none ([`crate::optional`]).
    pub optional: Option<String>,
    /// A parent engine launched the run (`nested`): it builds on no earlier round of the branch
    /// and files no round record for a later one, as the engine keeps a nested run out of the chain.
    pub nested: bool,
    /// The pull request under review (`pr`), whose head `HEAD` must be or hold, else the run moves
    /// to craft's own worktree of that head, one per head and never moved (`worktrees`), refused
    /// only where it cannot: on a
    /// detached `HEAD` its head branch keys the round chain ([`rereview::branch`]); `None`, gh is
    /// asked for the open one whose head is `HEAD`.
    pub pr: Option<u64>,
    /// How gh is asked for that pull request; `None`, it is not asked and a detached `HEAD`
    /// chains nothing.
    pub chain_gh: Option<PostSetup>,
    /// Where craft lays its own worktree of a pull request given whose head `HEAD` does not hold
    /// (`~/.craft/worktrees`), the run then reviewing there ([`rereview::branch::checkout`]);
    /// `None`, such a run is refused.
    pub worktrees: Option<PathBuf>,
    /// The host `craft review run` drives the steps in (its backend), whose task agents run in the
    /// run's worktree itself; `None`, the Claude Code plugin's review engine drives them through
    /// `start` and `submit`, its task agents in the session's directory.
    pub runtime: Option<String>,
    /// A stop asked of the start in flight (`craft review run` on a stopping signal): the gate's
    /// tools, the sources' git and the consumers' name search stop, and the run opens with what
    /// they had, each saying it was stopped.
    pub cancel: crate::cancel::Cancel,
}

impl StartOptions {
    /// The memory the run starts with: the launcher's decisions, recalled as it asked.
    pub(super) fn memory(&self) -> Memory {
        Memory::open(self.prior_decisions.clone())
            .recalling(self.recall, self.recall_degraded.as_deref())
    }

    /// Where earlier runs are looked for: `runs`, else the run directory's parent.
    pub(super) fn runs_or_parent(&self) -> Option<PathBuf> {
        self.runs
            .clone()
            .or_else(|| self.run_dir.parent().map(Path::to_path_buf))
    }

    /// How the run in `dir` asks gh for the pull request a detached `HEAD` heads, its output kept
    /// in `dir/chain`.
    pub(super) fn chain_lookup(&self, dir: &Path) -> rereview::branch::Lookup<'_> {
        rereview::branch::Lookup {
            pr: self.pr,
            gh: self.chain_gh.as_ref(),
            dir: dir.join("chain"),
        }
    }
}
