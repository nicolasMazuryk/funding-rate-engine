#!/usr/bin/env node
/**
 * PostToolUse hook (Edit|Write|MultiEdit): fast, scoped feedback after an agent edit.
 *
 * Reads the hook's stdin JSON (`tool_input.file_path`) and, for a `.ts` file inside
 * the project, runs `biome check` on just that file (fast) plus a full `tsc --noEmit`
 * (whole-project strict typecheck; this codebase's size keeps that under ~1s — see
 * task 0180 STATUS notes). This is intentionally NOT `npm run verify`: no vitest here,
 * so a single edit never pays the full test-suite cost.
 *
 * Exit 0: clean. Exit 2: problems found — printed to stderr so Claude Code feeds them
 * back to the agent as actionable context (PostToolUse exit-2 convention).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')

function readStdinFilePath() {
  try {
    const raw = readFileSync(0, 'utf8')
    if (!raw.trim()) return undefined
    const payload = JSON.parse(raw)
    return payload?.tool_input?.file_path
  } catch {
    return undefined
  }
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' })
  return result
}

const filePath = readStdinFilePath()
const checks = []

if (filePath?.endsWith('.ts') && filePath.startsWith(root)) {
  checks.push(run('npx', ['biome', 'check', filePath]))
} else {
  checks.push(run('npm', ['run', '--silent', 'check']))
}

checks.push(run('npm', ['run', '--silent', 'typecheck']))

const failed = checks.filter((r) => r.status !== 0)
if (failed.length > 0) {
  for (const r of failed) {
    process.stderr.write(r.stdout)
    process.stderr.write(r.stderr)
  }
  process.exit(2)
}

process.exit(0)
