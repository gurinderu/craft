// The TUI plugin entry OpenCode 2.x loads from the directory install.sh links as `plugins/craft-review-footer/`: a TUI
// plugin is a directory there (a single file is skipped), whose `tui` module default-exports `{ id, setup }`, and it
// carries no `index`/`server` module, so the server does not load it a second time (observed on opencode 2.2.7; realm
// @nick/craft, nodes #503, #512). OpenCode 1.x ignores directories in plugins/. The host supplies both UI modules.
import { createElement, effect, insert, setProp } from '@opentui/solid'
import { createSignal } from 'solid-js'
import { footerPlugin } from '../review-footer.mjs'

export default footerPlugin({ createElement, effect, insert, setProp, createSignal })
