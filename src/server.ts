import path from 'node:path';
import express from 'express';
import { createApp } from './app.js';
import { config } from './config.js';
import { recoveryTick } from './services/recovery.js';
import { tick } from './services/worker.js';

const app = createApp();
if (config.serveWeb) {
  app.use(express.static(path.resolve('dist/web')));
  app.get('/{*path}', (_req, res) => {
    res.sendFile(path.resolve('dist/web/index.html'));
  });
}
const server = app.listen(config.port, config.host, (error?: Error) => {
  if (error) return;
  console.log(
    `Relay API listening on ${config.host}:${config.port} (${config.demo ? 'DEMO: in-memory data, no external sends' : 'connected mode'})`,
  );
});
server.on('error', () => {
  console.error(
    'Relay could not listen on its configured port. Stop the existing server before starting another instance.',
  );
  process.exit(1);
});
const timer = setInterval(() => {
  void tick().catch(() =>
    console.error(JSON.stringify({ level: 'error', event: 'worker_tick_failed' })),
  );
}, 2000);
timer.unref();
const recoveryTimer = setInterval(() => {
  void recoveryTick().catch(() =>
    console.error(JSON.stringify({ level: 'error', event: 'recovery_tick_failed' })),
  );
}, 10000);
recoveryTimer.unref();
void recoveryTick().catch(() =>
  console.error(JSON.stringify({ level: 'error', event: 'recovery_start_failed' })),
);
process.on('SIGTERM', () => {
  clearInterval(timer);
  clearInterval(recoveryTimer);
  server.close();
});
process.on('SIGINT', () => {
  clearInterval(timer);
  clearInterval(recoveryTimer);
  server.close();
});
