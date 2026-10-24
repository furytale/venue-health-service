import { existsSync } from 'node:fs';
import { createService } from './app';
import { loadSettings } from './config/settings';
import { JsonLogger } from './adapters/logger';

const fatalLogger = new JsonLogger();
function fatal(error: unknown): never {
  fatalLogger.log('fatal', 'fatal_exception', {component: 'bootstrap', errorName: error instanceof Error ? error.name : 'UnknownError', code: error instanceof Error && 'code' in error ? error.code : undefined});
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const settings = loadSettings(process.env);
  const service = await createService(settings);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      fatalLogger.log('fatal', 'shutdown_deadline_exceeded', {component: 'bootstrap'});
      process.exit(1);
    }, settings.shutdownTimeoutMs);
    service.stop().then(() => { clearTimeout(deadline); process.exitCode = 0; }, fatal);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await service.start();
}
void main().catch(error => {
  // Only configuration errors have authored, secret-free messages.
  if (error instanceof Error && /^(Invalid configuration:|Missing configuration:)/.test(error.message)) fatalLogger.error('configuration_invalid', {component: 'bootstrap', message: error.message});
  fatal(error);
});
