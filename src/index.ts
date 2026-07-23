import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config';
import { logger } from './logger';
import { agentRouter } from './routes/agent.routes';
import { healthRouter } from './routes/health.routes';
import { connectorsRouter } from './routes/connectors.routes';
import { setupRouter } from './routes/setup.routes';
import { chatRouter } from './routes/chat.routes';
import { engineRouter } from './routes/engine.routes';
import { kbRouter } from './routes/kb.routes';

function buildApp(): express.Express {
  const app = express();

  app.use(express.json({ limit: '2mb' }));
  app.use(pinoHttp({ logger }));

  app.use(healthRouter);
  app.use(setupRouter);      // app-level OAuth setup (no session yet)
  app.use(agentRouter);      // /api/agent/execute — sessionAuth-guarded (autonomous runs)
  app.use(connectorsRouter); // sessionAuth-guarded
  app.use(chatRouter);       // /api/chat/* — sessionAuth-guarded
  app.use(engineRouter);     // /api/engine/test — sessionAuth-guarded
  app.use(kbRouter);         // /api/kb/* — sessionAuth-guarded

  // Final error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, 'unhandled_error');
    res.status(500).json({ error: 'internal_error', message: err.message });
  });

  return app;
}

const app = buildApp();
app.listen(config.port, () => {
  logger.info({ port: config.port, nodeEnv: config.nodeEnv }, 'archon_ai_server_started');
});
