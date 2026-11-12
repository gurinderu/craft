# Full-screen TUIs with ratatui

ratatui is **immediate-mode**: you don't mutate widgets, you **redraw the entire UI from your
app state every frame**. The whole app is a loop — draw, read an event, update state, repeat.

```toml
[dependencies]
ratatui = "0.30"
# crossterm is re-exported as ratatui::crossterm — no separate dep needed for events
```

## The minimal loop

```rust
use ratatui::{
    crossterm::event::{self, Event, KeyCode, KeyEventKind},
    widgets::{Block, Paragraph},
    DefaultTerminal, Frame,
};

fn main() -> std::io::Result<()> {
    let mut terminal = ratatui::init();   // raw mode + alternate screen + restoring panic hook
    let result = App::default().run(&mut terminal);
    ratatui::restore();                   // ALWAYS restore, even on error
    result
}

#[derive(Default)]
struct App { counter: i64, running: bool }

impl App {
    fn run(&mut self, terminal: &mut DefaultTerminal) -> std::io::Result<()> {
        self.running = true;
        while self.running {
            terminal.draw(|frame| self.draw(frame))?;   // render from state
            self.handle_events()?;                       // mutate state
        }
        Ok(())
    }

    fn draw(&self, frame: &mut Frame) {
        let widget = Paragraph::new(format!("count: {}", self.counter))
            .block(Block::bordered().title("Counter — q to quit"));
        frame.render_widget(widget, frame.area());
    }

    fn handle_events(&mut self) -> std::io::Result<()> {
        if let Event::Key(key) = event::read()? {        // blocks until an event
            if key.kind != KeyEventKind::Press { return Ok(()); }  // skip Release/Repeat (Windows / kitty protocol)
            match key.code {
                KeyCode::Char('q') => self.running = false,
                KeyCode::Up        => self.counter += 1,
                KeyCode::Down      => self.counter -= 1,
                _ => {}
            }
        }
        Ok(())
    }
}
```

Two things `ratatui::init()` does for you: enters the alternate screen + raw mode, and installs
a **panic hook that restores the terminal** — so a panic mid-render won't leave the user's shell
garbled. Still call `ratatui::restore()` on the normal path.

## Layout

Split the area with constraints; render each widget into its rect.

```rust
use ratatui::layout::{Constraint, Layout};

let [header, body, footer] = Layout::vertical([
    Constraint::Length(3),     // fixed 3 rows
    Constraint::Min(0),        // take the rest
    Constraint::Length(1),
]).areas(frame.area());

frame.render_widget(title, header);
frame.render_widget(list, body);
frame.render_widget(status, footer);
```

`Layout::horizontal`/`vertical` + `Constraint::{Length, Min, Max, Percentage, Ratio, Fill}`
compose to any layout; nest them for grids.

## Widgets

Built-ins cover most needs: `Paragraph` (text), `List`/`Table` (with `*State` for
selection/scroll), `Block` (borders/titles), `Gauge`, `Chart`, `Tabs`, `Scrollbar`. Stateful
widgets take their state via `frame.render_stateful_widget(widget, area, &mut state)`.

## Application architecture

For anything past a toy, separate **state**, **update**, and **view** rather than mutating
inside the draw call. ratatui documents three patterns; the **Elm-style** one scales best:

```
events → produce a Message → update(state, msg) → draw(state)
```

- `draw` is a pure function of state (no side effects in rendering).
- An event becomes a typed `Message`; `update` is the only place state changes.
- This keeps the loop testable: feed messages to `update`, assert on state — no terminal needed.

For larger apps see ratatui's Component and Flux patterns and the official templates.

## Don't block the render loop

`event::read()` blocks, which is fine for a pure-input app. If you also have background work
(timers, async I/O), use `event::poll(timeout)` to wake periodically, or run work on another
task/thread and send updates over a channel (→ `rust-concurrency`) that the loop drains — never
do slow work inside `draw`.

## When not to TUI

If the program runs once and prints a result, it's a CLI — use clap ([clap.md](clap.md)). Reach
for ratatui only when the user interacts with a live, stateful screen.
