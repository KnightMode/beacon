#!/usr/bin/env node
/**
 * Compatibility wrapper. The local verification path is now the full E2E
 * runner, which starts its own isolated Pages dev server and local D1 state.
 */

import './e2e-local.mjs';
