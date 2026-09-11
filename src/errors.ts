export class AppError extends Error {
  constructor(
    message: string,
    readonly code: 'authentication' | 'permission' | 'conflict' | 'propagation_pending' | 'provider_error' | 'configuration',
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: 'internal_error', message: 'The operation failed. Check the server logs using the operation ID.' };
}
