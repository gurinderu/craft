// Test infrastructure: an executable written by a child process (`cat > tmp && chmod +x && mv`, as the Rust tests'
// write_executable does), never by the test process itself: a test that execs a file it holds open for writing can
// fail with ETXTBSY under a parallel runner.
import { execFileSync } from 'node:child_process'

/** Write `text` to `file` as an executable, through sh. @param {string} file @param {string} text */
export function writeExecutable(file, text) {
  execFileSync('sh', ['-c', 'cat > "$1.tmp" && chmod +x "$1.tmp" && mv "$1.tmp" "$1"', 'sh', file], { input: text })
}
