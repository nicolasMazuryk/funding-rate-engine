/**
 * ESM resolve hook: map a relative `.js` import specifier to the sibling `.ts`
 * file when only the `.ts` exists. Task 0170 tooling.
 *
 * The codebase uses `.js` import specifiers pointing at `.ts` sources (required by
 * `tsc` under `verbatimModuleSyntax` + `NodeNext`, and resolved by Vite in the test
 * runner). Node's native type stripping does NOT perform this `.js`→`.ts` remap on
 * its own, so a plain `node <entry>.ts` that imports across modules fails to
 * resolve. This hook closes that gap with zero dependencies and no build step, so
 * `npm run replay` (and any future `node`-run CLI) can execute the real sources.
 *
 * Registered via `scripts/register-ts.mjs` (`node --import ./scripts/register-ts.mjs`).
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js') && context.parentURL) {
    const tsSpecifier = `${specifier.slice(0, -3)}.ts`
    try {
      if (existsSync(fileURLToPath(new URL(tsSpecifier, context.parentURL)))) {
        return next(tsSpecifier, context)
      }
    } catch {
      // Fall through to the default resolver on any URL/path error.
    }
  }
  return next(specifier, context)
}
