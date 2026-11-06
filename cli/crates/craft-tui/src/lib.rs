//! Review progress in the terminal, fed by [`ProgressEvent`]s on a channel: [`run_tty`] draws a
//! phases → agents tree with each agent's status, tokens and cost; [`run_plain`] prints one line
//! per event for a pipe or CI. Both return the final [`Progress`] once the channel closes.

mod model;
mod view;

use std::io::{self, Write};
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::terminal::{self, EnterAlternateScreen, LeaveAlternateScreen};
use crossterm::{cursor, execute};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use tokio::sync::mpsc;

pub use model::{AgentRow, PhaseRow, Progress, ProgressEvent, Status};
pub use view::{plain_line, render};

/// Prints one line per event to `out` until the channel closes.
///
/// # Errors
/// A failed write to `out`.
pub async fn run_plain<W: Write>(
    mut events: mpsc::UnboundedReceiver<ProgressEvent>,
    out: &mut W,
) -> io::Result<Progress> {
    let mut progress = Progress::default();
    while let Some(event) = events.recv().await {
        writeln!(out, "{}", plain_line(&event))?;
        progress.apply(event);
    }
    out.flush()?;
    Ok(progress)
}

const TICK: Duration = Duration::from_millis(250);

/// Draws the tree on stderr's alternate screen until the channel closes; `q` or Ctrl-C stops it
/// early with [`io::ErrorKind::Interrupted`]. The terminal is restored on every way out.
///
/// # Errors
/// A terminal that cannot be set up or drawn to, or the viewer's interrupt.
pub async fn run_tty(mut events: mpsc::UnboundedReceiver<ProgressEvent>) -> io::Result<Progress> {
    let _screen = Screen::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stderr()))?;
    let mut progress = Progress::default();
    let mut tick = tokio::time::interval(TICK);
    loop {
        terminal.draw(|frame| render(frame, &progress))?;
        tokio::select! {
            event = events.recv() => match event {
                Some(event) => progress.apply(event),
                None => break,
            },
            _ = tick.tick() => {
                if interrupted()? {
                    return Err(io::Error::new(io::ErrorKind::Interrupted, "stopped by the viewer"));
                }
            }
        }
    }
    terminal.draw(|frame| render(frame, &progress))?;
    Ok(progress)
}

/// Raw mode swallows Ctrl-C's signal, so the key is read here.
fn interrupted() -> io::Result<bool> {
    while event::poll(Duration::ZERO)? {
        if let Event::Key(KeyEvent {
            code, modifiers, ..
        }) = event::read()?
        {
            let ctrl_c = code == KeyCode::Char('c') && modifiers.contains(KeyModifiers::CONTROL);
            if ctrl_c || code == KeyCode::Char('q') {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Raw mode and the alternate screen, left when dropped.
struct Screen;

impl Screen {
    fn enter() -> io::Result<Self> {
        terminal::enable_raw_mode()?;
        let screen = Self;
        execute!(io::stderr(), EnterAlternateScreen, cursor::Hide)?;
        Ok(screen)
    }
}

impl Drop for Screen {
    fn drop(&mut self) {
        // Best effort: a terminal that cannot be restored has nobody left to tell.
        let _left = execute!(io::stderr(), cursor::Show, LeaveAlternateScreen);
        let _cooked = terminal::disable_raw_mode();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn plain_prints_a_line_per_event_and_returns_the_final_state() {
        let (tx, rx) = mpsc::unbounded_channel();
        tx.send(ProgressEvent::Phase {
            name: "scan".into(),
        })
        .unwrap();
        tx.send(ProgressEvent::Agent {
            phase: "scan".into(),
            agent: "a".into(),
        })
        .unwrap();
        tx.send(ProgressEvent::Started { agent: "a".into() })
            .unwrap();
        tx.send(ProgressEvent::Finished {
            agent: "a".into(),
            tokens: 1500,
            cost_usd: 0.25,
        })
        .unwrap();
        drop(tx);
        let mut out = Vec::new();
        let progress = run_plain(rx, &mut out).await.unwrap();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "phase scan\nqueued scan/a\nstart a\ndone a 1.5k tok $0.2500\n"
        );
        assert_eq!(progress.phases[0].agents[0].status, Status::Done);
    }
}
