//! Drawing the tree and spelling an event as a plain line.

use ratatui::Frame;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Paragraph};

use crate::model::{Progress, ProgressEvent, Status};

/// `1234` → `1.2k`, `12` → `12`; integer arithmetic only.
fn tokens(n: u64) -> String {
    if n < 1000 {
        n.to_string()
    } else {
        format!("{}.{}k", n / 1000, (n % 1000) / 100)
    }
}

fn spend(n: u64, usd: f64) -> String {
    format!("{} tok ${usd:.4}", tokens(n))
}

/// One event as a line of text, for a pipe or CI log.
#[must_use]
pub fn plain_line(event: &ProgressEvent) -> String {
    match event {
        ProgressEvent::Phase { name } => format!("phase {name}"),
        ProgressEvent::Agent { phase, agent } => format!("queued {phase}/{agent}"),
        ProgressEvent::Started { agent } => format!("start {agent}"),
        ProgressEvent::Finished {
            agent,
            tokens: n,
            cost_usd,
        } => {
            format!("done {agent} {}", spend(*n, *cost_usd))
        }
        ProgressEvent::Failed { agent, reason } => format!("fail {agent}: {reason}"),
    }
}

fn status(status: &Status) -> Span<'static> {
    match status {
        Status::Queued => Span::styled("queued ", Style::new().fg(Color::DarkGray)),
        Status::Running => Span::styled("running", Style::new().fg(Color::Yellow)),
        Status::Done => Span::styled("done   ", Style::new().fg(Color::Green)),
        Status::Failed(_) => Span::styled("failed ", Style::new().fg(Color::Red)),
    }
}

/// The phases → agents tree with a totals line, in one bordered block.
pub fn render(frame: &mut Frame<'_>, progress: &Progress) {
    let mut lines = Vec::new();
    for phase in &progress.phases {
        lines.push(Line::from(Span::styled(
            phase.name.clone(),
            Style::new().add_modifier(Modifier::BOLD),
        )));
        for row in &phase.agents {
            let mut spans = vec![
                Span::raw("  "),
                status(&row.status),
                Span::raw(format!(
                    " {:<24} {}",
                    row.id,
                    spend(row.tokens, row.cost_usd)
                )),
            ];
            if let Status::Failed(reason) = &row.status {
                spans.push(Span::styled(
                    format!("  {reason}"),
                    Style::new().fg(Color::Red),
                ));
            }
            lines.push(Line::from(spans));
        }
    }
    let (total_tokens, total_cost) = progress.totals();
    let block = Block::bordered()
        .title(" craft review ")
        .title_bottom(format!(" total {} ", spend(total_tokens, total_cost)));
    frame.render_widget(Paragraph::new(lines).block(block), frame.area());
}

#[cfg(test)]
mod tests {
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    use super::*;

    #[test]
    fn tokens_read_short() {
        assert_eq!(tokens(999), "999");
        assert_eq!(tokens(18_093), "18.0k");
        assert_eq!(tokens(1_550), "1.5k");
    }

    #[test]
    fn the_tree_shows_phase_agent_status_spend_and_total() {
        let mut p = Progress::default();
        p.apply(ProgressEvent::Agent {
            phase: "scan".into(),
            agent: "probe".into(),
        });
        p.apply(ProgressEvent::Finished {
            agent: "probe".into(),
            tokens: 2_000,
            cost_usd: 0.01,
        });
        let mut terminal = Terminal::new(TestBackend::new(60, 6)).unwrap();
        terminal.draw(|f| render(f, &p)).unwrap();
        let screen: String = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(ratatui::buffer::Cell::symbol)
            .collect();
        for want in [
            "craft review",
            "scan",
            "done",
            "probe",
            "2.0k tok $0.0100",
            "total 2.0k tok $0.0100",
        ] {
            assert!(screen.contains(want), "{want} missing from {screen:?}");
        }
    }
}
