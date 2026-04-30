/**
 * node-dns.ts — stub shim for node:dns and node:dns/promises.
 *
 * CF Workers has no DNS resolution API; the only code that hits this in the
 * server package is the invite test-resolution handler, which is intentionally
 * not ported to the CF deployment. All other route handlers in access.ts can
 * be safely imported without triggering these stubs.
 */

const notAvailable = (): Promise<never> =>
  Promise.reject(
    Object.assign(new Error("node:dns not available in Cloudflare Workers"), { code: "ENOTAVAIL" }),
  );

export const lookup = notAvailable;
export const resolve = notAvailable;
export const resolve4 = notAvailable;
export const resolve6 = notAvailable;

export const promises = { lookup };

export default { lookup, resolve, resolve4, resolve6, promises };
