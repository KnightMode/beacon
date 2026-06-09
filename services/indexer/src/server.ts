/**
 * Indexer HTTP service. The github-webhook queue consumer POSTs index jobs to
 * `/index` (bearer-authenticated with INDEXER_SHARED_SECRET). Tree-sitter
 * parsing runs here in Node — never inside a request Worker.
 */

import express, { type Request, type Response } from 'express';
import { type IndexJob } from '@scintel/shared';
import { loadConfig, type IndexerConfig } from './config.js';
import { indexRepo } from './core/indexRepo.js';
import { log } from './logger.js';

export function createServer(config: IndexerConfig): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'indexer' });
  });

  app.post('/index', async (req: Request, res: Response) => {
    const auth = req.header('authorization') ?? '';
    if (auth !== `Bearer ${config.indexerSharedSecret}`) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }

    const job = req.body as IndexJob;
    if (!job || !job.repoFullName || !job.jobType) {
      res.status(400).json({ ok: false, error: 'invalid job payload' });
      return;
    }

    try {
      const result = await indexRepo(config, job);
      res.json({ ok: true, result });
    } catch (err) {
      log.error('index request failed', {
        repo: job.repoFullName,
        error: (err as Error).message,
      });
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  return app;
}

function main(): void {
  const config = loadConfig();
  const app = createServer(config);
  app.listen(config.port, () => {
    log.info('indexer listening', { port: config.port });
  });
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  main();
}
