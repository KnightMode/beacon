/** Programmatic entrypoints for the indexer service. */

export { loadConfig, type IndexerConfig } from './config.js';
export { indexRepo, type IndexResult } from './core/indexRepo.js';
export { createServer } from './server.js';
