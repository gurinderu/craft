// The part of the UI modules OpenCode 2.x supplies to its TUI plugins that tui/tui.mjs uses (observed on opencode
// 2.2.7 by a probe TUI plugin; realm @nick/craft, nodes #503, #512). They are no dependency of this plugin: the host
// provides them in-process. Re-read on each 2.x bump.
declare module '@opentui/solid' {
  export function createElement(tag: string): unknown
  export function insert(el: unknown, value: () => string): void
  export function setProp(el: unknown, name: string, value: unknown): void
  export function effect(fn: () => void): void
}

declare module 'solid-js' {
  export function createSignal<T>(value: T): [() => T, (value: T) => void]
}
