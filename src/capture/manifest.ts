/**
 * Per-set `manifest.json` (task 0250) — what a future agent reads to judge fixture
 * staleness: which tool version + venue/network captured it, when, how many records,
 * and which sibling fixtures in the set are hand-authored synthetic (never captured).
 */

import { join } from 'node:path'
import { writeJsonFixture } from './fixture-writer.js'

/** Bumped whenever the scrub/write pipeline's normalization rules change. */
export const CAPTURE_TOOL_VERSION = '1'

export interface CaptureManifest {
  readonly set: string
  readonly venue: string
  readonly network: 'testnet' | 'prod'
  readonly capturedAtMs: number
  readonly toolVersion: string
  readonly source: string
  readonly count: number
  readonly synthetic: readonly string[]
}

export interface WriteManifestArgs {
  readonly dir: string
  readonly set: string
  readonly venue: string
  readonly network: 'testnet' | 'prod'
  readonly capturedAtMs: number
  readonly source: string
  readonly count: number
  readonly synthetic?: readonly string[]
}

export function writeManifest(args: WriteManifestArgs): void {
  const manifest: CaptureManifest = {
    set: args.set,
    venue: args.venue,
    network: args.network,
    capturedAtMs: args.capturedAtMs,
    toolVersion: CAPTURE_TOOL_VERSION,
    source: args.source,
    count: args.count,
    synthetic: args.synthetic ?? [],
  }
  writeJsonFixture(join(args.dir, 'manifest.json'), manifest)
}
