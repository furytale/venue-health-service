import 'reflect-metadata';
import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, registerAs } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import { Settings } from './config/settings';
import { AdmissionUseCase, ProcessInboxUseCase, QueryUseCase } from './application/core';
import { LifecyclePolicy } from './domain/policy';
import { DatabaseStore } from './adapters/sqlite';
import { DeliveryStore } from './adapters/delivery-store';
import { HttpDownstreamClient } from './adapters/downstream';
import { DeliveryDispatcher } from './application/delivery';
import { HttpErrorFilter, VenueController, UnsupportedMediaTypeError, sendError } from './adapters/http';
import { JsonLogger } from './adapters/logger';
import { StorageError } from './domain/errors';

export class InboxLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private outage = false;
  constructor(private readonly processor: ProcessInboxUseCase, private readonly settings: Settings, private readonly logger: JsonLogger) {}
  start(): void { this.stopped = false; this.schedule(this.settings.inbox.pollIntervalMs); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      let next = this.settings.inbox.pollIntervalMs;
      try {
        this.processor.runBatch(this.settings.inbox.batchSize);
        if (this.outage) this.logger.info('inbox_storage_recovered', {component: 'inbox'});
        this.outage = false;
      } catch (error) {
        if (!(error instanceof StorageError)) throw error;
        if (!this.outage) this.logger.error('inbox_processing_unavailable', {component: 'inbox', code: error instanceof Error && 'code' in error ? error.code : 'INTERNAL_ERROR'});
        this.outage = true;
        next = this.settings.storage.retryDelayMs;
      }
      this.schedule(next);
    }, delay);
  }
}
@Module({})
class AppModule {
  static configure(settings: Settings, store: DatabaseStore, logger: JsonLogger): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot({ignoreEnvFile: true, isGlobal: true, load: [registerAs('settings', () => settings)]})],
      controllers: [VenueController],
      providers: [
        {provide: JsonLogger, useValue: logger},
        {provide: DatabaseStore, useValue: store},
        {provide: AdmissionUseCase, useFactory: () => new AdmissionUseCase(store, {now: () => Date.now()})},
        {provide: QueryUseCase, useFactory: () => new QueryUseCase(store, settings.http.historyMaxPageSize)},
      ],
    };
  }
}
export async function createService(settings: Settings) {
  const logger = new JsonLogger(settings.logLevel);
  const store = new DatabaseStore(settings.storage.path, settings.storage.busyTimeoutMs);
  const client = new HttpDownstreamClient(settings.downstream);
  const dispatcher = new DeliveryDispatcher(new DeliveryStore(store.db), client, {
    concurrency: settings.downstream.concurrency, batchSize: settings.outbox.batchSize,
    pollIntervalMs: settings.outbox.pollIntervalMs, storageRetryDelayMs: settings.storage.retryDelayMs,
    retryBaseDelayMs: settings.retry.baseDelayMs, retryMaxDelayMs: settings.retry.maxDelayMs,
    retryJitterRatio: settings.retry.jitterRatio,
  }, () => Date.now(), Math.random, (level, event, fields) => logger.log(level, event, {component: 'delivery', ...fields}));
  const processor = new ProcessInboxUseCase(store, new LifecyclePolicy(settings.policy), settings.validation, {now: () => Date.now()}, logger);
  const inboxLoop = new InboxLoop(processor, settings, logger);
  const app = await NestFactory.create(AppModule.configure(settings, store, logger), {bodyParser: false, logger: false, abortOnError: false});
  app.use((request: Request, response: Response, next: NextFunction) => {
    response.setHeader('x-request-id', randomUUID());
    if (request.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
      sendError(new UnsupportedMediaTypeError(), request, response, logger);
      return;
    }
    next();
  });
  app.use(json({limit: settings.http.bodyLimitBytes, strict: false, inflate: false}));
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => sendError(error, request, response, logger));
  app.useGlobalFilters(new HttpErrorFilter(logger));
  await app.init();
  const httpServer: unknown = app.getHttpServer();
  if (!(httpServer instanceof Server)) throw new Error('Expected Node HTTP server');
  let closed = false;
  return {
    app, store, processor, dispatcher,
    async start(port = settings.http.port): Promise<void> {
      await app.listen(port, '127.0.0.1');
      inboxLoop.start(); dispatcher.start();
      logger.info('service_started', {component: 'bootstrap', port});
    },
    async stop(): Promise<void> {
      if (closed) return;
      closed = true;
      logger.info('shutdown_started', {component: 'bootstrap'});
      inboxLoop.stop();
      const drainMs = Math.max(1, settings.shutdownTimeoutMs - Math.min(100, Math.floor(settings.shutdownTimeoutMs / 10)));
      const httpDeadline = setTimeout(() => httpServer.closeAllConnections(), drainMs);
      // Closing the listener begins immediately; outgoing delivery is drained separately.
      const closing = app.close();
      try {
        await Promise.all([dispatcher.stop(drainMs), closing]);
        store.close();
      } finally { clearTimeout(httpDeadline); }
      logger.info('shutdown_finished', {component: 'bootstrap'});
    },
  };
}
