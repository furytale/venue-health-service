import { ArgumentsHost, Body, Catch, Controller, ExceptionFilter, Get, HttpCode, HttpException, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AdmissionUseCase, QueryUseCase } from '../application/core';
import { ApplicationError, ValidationError } from '../domain/errors';
import { Kind } from '../domain/model';
import { validateMessage, validateVenueId } from '../domain/validation';
import { Settings, settingsFactory } from '../config/settings';
import { JsonLogger } from './logger';

export const SETTINGS = settingsFactory.KEY;
export class UnsupportedMediaTypeError extends ApplicationError {
  constructor() { super('UNSUPPORTED_MEDIA_TYPE', 'validation', 'Content-Type must be application/json'); }
}
export function requestId(request: Request): string {
  const value: unknown = request.res?.getHeader('x-request-id');
  return typeof value === 'string' ? value : 'unavailable';
}
export function sendError(error: unknown, request: Request, response: Response, logger: JsonLogger): void {
  let status = 500; let code = 'INTERNAL_ERROR'; let message = 'Unexpected request-processing error';
  if (error instanceof ApplicationError) {
    status = {validation: 400, conflict: 409, not_found: 404, storage: 503, internal: 500}[error.category];
    if (error instanceof UnsupportedMediaTypeError) status = 415;
    code = error.code; message = error.message;
  } else if (error instanceof HttpException && error.getStatus() === 404) {
    status = 404; code = 'NOT_FOUND'; message = 'Resource not found';
  } else if (typeof error === 'object' && error !== null && 'type' in error) {
    if (error.type === 'entity.too.large') { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body exceeds configured limit'; }
    else if (error.type === 'entity.parse.failed') { status = 400; code = 'VALIDATION_ERROR'; message = 'Malformed JSON'; }
    else if (error.type === 'encoding.unsupported' || error.type === 'charset.unsupported') { status = 415; code = 'UNSUPPORTED_MEDIA_TYPE'; message = 'Unsupported request encoding'; }
  }
  const id = requestId(request);
  logger.log(status >= 500 ? 'error' : 'warn', 'request_failed', {component: 'http', requestId: id, code, httpStatus: status});
  response.status(status).json({error: {code, message, requestId: id}});
}
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: JsonLogger) {}
  catch(error: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    sendError(error, context.getRequest<Request>(), context.getResponse<Response>(), this.logger);
  }
}
@Controller('api')
export class VenueController {
  constructor(
    @Inject(AdmissionUseCase) private readonly admission: AdmissionUseCase,
    @Inject(QueryUseCase) private readonly queries: QueryUseCase,
    @Inject(SETTINGS) private readonly settings: Settings,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}
  private admit(kind: Kind, body: unknown, request: Request) {
    const started = Date.now();
    const message = validateMessage(kind, body, this.settings.validation);
    const result = this.admission.execute(message, requestId(request));
    this.logger.info(result.duplicate ? 'admission_duplicate' : 'admission_committed', {component: 'http', requestId: result.requestId, inboxId: result.inboxId, sourceId: message.sourceId, venueId: message.venueId, durationMs: Date.now() - started});
    if (message.kind === 'report' && message.pcm?.evidenceValidation.state === 'excluded') this.logger.warn('evidence_excluded', {component: 'http', requestId: result.requestId, inboxId: result.inboxId, venueId: message.venueId, code: message.pcm.evidenceValidation.reason});
    return result;
  }
  @Post('reports') @HttpCode(202)
  report(@Body() body: unknown, @Req() request: Request) { return this.admit('report', body, request); }
  @Post('calibrations') @HttpCode(202)
  calibration(@Body() body: unknown, @Req() request: Request) { return this.admit('calibration', body, request); }
  @Post('operator-decisions') @HttpCode(202)
  operator(@Body() body: unknown, @Req() request: Request) { return this.admit('operator', body, request); }
  @Get('venues/:venueId')
  venue(@Param('venueId') id: string) { return this.queries.venue(validateVenueId(id)); }
  @Get('venues/:venueId/history')
  history(@Param('venueId') id: string, @Query('after') after: unknown, @Query('limit') limit: unknown) {
    const parse = (value: unknown, fallback: number): number => {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ValidationError('Invalid pagination');
      return Number(value);
    };
    return this.queries.history(validateVenueId(id), parse(after, 0), parse(limit, 50));
  }
  @Get('messages/:inboxId')
  message(@Param('inboxId') id: string) {
    if (id.length > 128) throw new ValidationError('Invalid inboxId');
    return this.queries.message(id);
  }
}
