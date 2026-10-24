export type ErrorCategory = 'validation' | 'conflict' | 'not_found' | 'storage' | 'internal';
export class ApplicationError extends Error {
  constructor(readonly code: string, readonly category: ErrorCategory, message: string, readonly internalCause?: unknown) {
    super(message); this.name = new.target.name;
  }
}
export class ValidationError extends ApplicationError {
  constructor(message = 'Invalid request payload') { super('VALIDATION_ERROR', 'validation', message); }
}
export class ConflictError extends ApplicationError {
  constructor() { super('MESSAGE_ID_CONFLICT', 'conflict', 'Message identity already has a different payload'); }
}
export class NotFoundError extends ApplicationError {
  constructor() { super('NOT_FOUND', 'not_found', 'Resource not found'); }
}
export class StorageError extends ApplicationError {
  constructor(cause?: unknown) { super('STORAGE_UNAVAILABLE', 'storage', 'Reliable storage is unavailable', cause); }
}
