/**
 * Admit an origin, never an arbitrary request path or a URL carrying credentials.
 * Empty means the same-origin local/API-served application.
 * @param {string} value
 * @param {{allowLocal?: boolean}} [options]
 * @returns {import('./contracts.ts').PublicRuntimeConfig}
 */
export function publicRuntimeConfig(value, {allowLocal=false}={}) {
  if (!value) return {apiOrigin:'',allowLocal};
  const url=new URL(value);
  const local=allowLocal && url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname);
  if ((!local && url.protocol!=='https:') || url.username || url.password || url.pathname!=='/' || url.search || url.hash) {
    throw new Error('public_api_origin_required');
  }
  return {apiOrigin:url.origin,allowLocal};
}
