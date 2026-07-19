/**
 * Registers the `.js`→`.ts` resolve hook (`ts-js-resolve.mjs`) so `node` can run
 * the repo's TypeScript sources, which import each other with `.js` specifiers.
 * Task 0170 tooling; used as `node --import ./scripts/register-ts.mjs <entry>.ts`.
 */

import { register } from 'node:module'

register('./ts-js-resolve.mjs', import.meta.url)
