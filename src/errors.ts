export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'LIMIT_EXCEEDED'
  | 'FITS_BAD_HEADER'
  | 'FITS_UNSUPPORTED'
  | 'FITS_DUPLICATE_KEYWORD'
  | 'FITS_NO_END'
  | 'FITS_BAD_VALUE'
  | 'FITS_TRUNCATED'
  | 'FITS_EXTRA_DATA'
  | 'FITS_OVERFLOW'
  | 'INTERNAL';

export class FitsError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public cardIndex?: number,
  ) {
    super(message);
    this.name = 'FitsError';
  }
}

export function toErrorPayload(err: unknown): { code: ErrorCode; message: string; cardIndex?: number } {
  if (err instanceof FitsError) {
    return { code: err.code, message: err.message, cardIndex: err.cardIndex };
  }
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
}
