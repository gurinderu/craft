// The part of pi's TUI module craft's pi extension uses (lib/pi-extension.mjs), as pi 1.5.2 documents it
// (docs/extensions.md, "Custom Rendering"; realm @nick/craft, node #504). pi supplies the module to the extensions it
// loads; it is no dependency of this repository.
declare module '@earendil-works/pi-tui' {
  export class Text {
    constructor(text: string, paddingX: number, paddingY: number)
    setText(text: string): void
  }
}
