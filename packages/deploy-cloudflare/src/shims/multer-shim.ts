// CF Workers replacement for multer.
// File uploads in CF Workers use Request.formData() instead of multer middleware.
// This shim provides the same API shape so the module loads without error;
// the actual upload routes will throw at request time if invoked.

class MulterError extends Error {
  code: string;
  field?: string;
  constructor(code: string, field?: string) {
    super(code);
    this.name = "MulterError";
    this.code = code;
    this.field = field;
  }
}

const noopMiddleware = (_req: unknown, _res: unknown, next: (err?: unknown) => void) => next();

function multer(_opts?: unknown) {
  const middleware = {
    single: (_field?: string) => noopMiddleware,
    array: (_field?: string, _maxCount?: number) => noopMiddleware,
    fields: (_fields?: unknown) => noopMiddleware,
    none: () => noopMiddleware,
    any: () => noopMiddleware,
  };
  return middleware;
}

multer.memoryStorage = () => ({});
multer.diskStorage = (_opts?: unknown) => ({});
multer.MulterError = MulterError;

export default multer;
export { MulterError };
