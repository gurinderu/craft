// The engines' type check, run through the TypeScript API rather than the CLI: one program gives both
// the diagnostics (formatted exactly as `tsc --pretty false` prints them) and the checker that counts
// where an engine's values are `any` — spelled or not (lib/engine-any-sites.mjs, realm @nick/craft, #136).
/** @typedef {typeof import('../opencode/plugin/node_modules/typescript/lib/typescript.js')} TS */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Program} Program */

/**
 * `tsc -p <config> --pretty false`, in process: the same config parse, the same pre-emit diagnostics,
 * the same text. `status` is 1 when any diagnostic is an error, as the CLI's exit code.
 * @param {TS} ts @param {string} configPath
 * @returns {{ program: Program | null, text: string, status: number }}
 */
export function compileProject(ts, configPath) {
  /** @type {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Diagnostic[]} */
  const fatal = []
  const host = { getCurrentDirectory: () => ts.sys.getCurrentDirectory(), getCanonicalFileName: (/** @type {string} */ f) => f, getNewLine: () => '\n' }
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: d => { fatal.push(d) } })
  if (!parsed) return { program: null, text: ts.formatDiagnostics(fatal, host), status: 1 }
  const program = ts.createProgram({
    rootNames: parsed.fileNames, options: parsed.options, ...(parsed.projectReferences ? { projectReferences: parsed.projectReferences } : {}),
    configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(parsed),
  })
  const diags = [...fatal, ...ts.getPreEmitDiagnostics(program)]
  return { program, text: ts.formatDiagnostics(diags, host), status: diags.some(d => d.category === ts.DiagnosticCategory.Error) ? 1 : 0 }
}
