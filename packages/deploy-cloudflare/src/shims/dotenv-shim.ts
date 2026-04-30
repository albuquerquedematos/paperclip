// CF Workers replacement for dotenv.
// In CF Workers, env vars come from Wrangler bindings — .env file loading is a no-op.
export const config = (_opts?: unknown) => ({ parsed: {}, error: undefined });
export const parse = (_src: string | Buffer) => ({} as Record<string, string>);
export const populate = (_target: Record<string, string>, _src: Record<string, string>) => {};
export const decrypt = (_src: string, _keyStr: string) => "";
const dotenv = { config, parse, populate, decrypt };
export default dotenv;
