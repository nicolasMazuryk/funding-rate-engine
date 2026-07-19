/**
 * `npm run replay` — the no-live-venue trace debugger (task 0170; spec `0000` §6).
 *
 * Replays a recorded trace's events through a fresh pure core and diffs the
 * resulting transitions against the recorded ones (or a golden's, via `--expect`).
 * All the machinery lives in `src/replay/replay-engine.ts` — the same `replayTrace`
 * the golden test calls, so CLI and CI share one code path. `--promote` copies a
 * trace into `test/golden/fixtures/` to bless it as a golden.
 *
 *   npm run replay -- <file> [--expect <golden>] [--json]
 *   npm run replay -- --promote <trace> [--name <name>]
 *
 * Exit 0 on match, 1 on any mismatch or bad args. Non-test CLI code: it imports the
 * `src/replay/` composition root, never `test/` helpers.
 */

import { copyFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatReplayResult, replayTrace } from '../src/replay/replay-engine.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../test/golden/fixtures')

const USAGE = [
  'Usage:',
  '  npm run replay -- <file> [--expect <golden>] [--json]',
  '  npm run replay -- --promote <trace> [--name <name>]',
].join('\n')

/** Fail loud: print usage (+ optional reason) to stderr and exit 1. */
function fail(reason?: string): never {
  if (reason !== undefined) process.stderr.write(`replay: ${reason}\n`)
  process.stderr.write(`${USAGE}\n`)
  process.exit(1)
}

interface Args {
  readonly file?: string
  readonly expect?: string
  readonly json: boolean
  readonly promote?: string
  readonly name?: string
}

/** Hand-rolled argv parse (KISS: no dependency). Unknown flags / missing values fail loud. */
function parseArgs(argv: readonly string[]): Args {
  let file: string | undefined
  let expect: string | undefined
  let json = false
  let promote: string | undefined
  let name: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--json':
        json = true
        break
      case '--expect':
        expect = argv[++i] ?? fail('--expect needs a path')
        break
      case '--promote':
        promote = argv[++i] ?? fail('--promote needs a path')
        break
      case '--name':
        name = argv[++i] ?? fail('--name needs a value')
        break
      default:
        if (arg === undefined || arg.startsWith('--')) fail(`unknown argument: ${arg}`)
        if (file !== undefined) fail(`unexpected extra argument: ${arg}`)
        file = arg
    }
  }
  return { file, expect, json, promote, name }
}

/** `--promote`: copy a trace into `test/golden/fixtures/`, blessing it as a golden fixture. */
function promote(trace: string, name: string | undefined): never {
  const target = name ?? basename(trace)
  if (target.includes('/')) fail('--name must be a bare filename (no "/")')
  const dest = join(FIXTURES, target)
  copyFileSync(trace, dest)
  process.stdout.write(`promoted ${trace} -> ${dest}\n`)
  process.exit(0)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))

  if (args.promote !== undefined) promote(args.promote, args.name)
  if (args.file === undefined) fail('no trace file given')

  const result = replayTrace({ file: args.file, expectFile: args.expect })

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({
        match: result.match,
        recordCount: { expected: result.expected.length, actual: result.actual.length },
        firstDivergence: result.firstDivergence,
      })}\n`,
    )
  } else {
    process.stdout.write(`${formatReplayResult(result)}\n`)
  }
  process.exit(result.match ? 0 : 1)
}

main()
