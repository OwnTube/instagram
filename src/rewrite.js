'use strict';

const config = require('./config');

const ALLOWED_HOSTS = new Set(config.allowedAssetHosts.map((h) => h.toLowerCase()));
// Hosts that serve the HTML *document* itself. References to these are page
// links, not static assets, so they are mapped to root-relative paths and flow
// through the document handler (which rewrites them) instead of the asset proxy.
const DOCUMENT_HOSTS = new Set([new URL(config.upstream).hostname.toLowerCase(), 'instagram.com']);

/**
 * URL rewriting for the fetched upstream documents.
 *
 * Scope and intent, deliberately narrow:
 *   - Only *absolute asset references* to allow-listed hosts are redirected to
 *     the local /__ig proxy. Everything else is left byte-for-byte untouched.
 *   - No JavaScript source text is ever rewritten. We do not touch <script>
 *     bodies, JSON payloads, or bundle contents. Only URL-bearing HTML
 *     attributes and CSS `url(...)` values are mapped.
 *   - Relative URLs (e.g. "/someuser/") are intentionally NOT rewritten. The
 *     browser resolves them against our own origin, so internal navigation
 *     already flows back through the loader.
 */

const NON_FETCHABLE_SCHEMES = /^(data:|blob:|javascript:|mailto:|tel:|#)/i;

/** True when we are allowed to fetch this URL on the browser's behalf. */
function isAllowedUpstreamUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed || NON_FETCHABLE_SCHEMES.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed, config.upstream);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Map an absolute upstream asset URL onto our own /__ig proxy path. */
function toProxyPath(url) {
  const parsed = new URL(url, config.upstream);
  return `${config.assetPrefix}/${parsed.host}${parsed.pathname}${parsed.search}`;
}

function mapUrl(value) {
  const trimmed = String(value).trim();
  // Only absolute URLs are mapped. A relative value is left exactly as it is
  // (the browser resolves it against our origin); resolving it here used to
  // turn non-URL text such as an HTML-escaped quote into a bogus path.
  if (!/^(?:https?:)?\/\//i.test(trimmed)) return value;
  if (!isAllowedUpstreamUrl(trimmed)) return value;
  const parsed = new URL(trimmed, config.upstream);
  if (DOCUMENT_HOSTS.has(parsed.hostname.toLowerCase())) {
    // A link to the site itself: keep it root-relative so it is handled as a
    // document request and never pushed through the static-asset proxy.
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  return toProxyPath(trimmed);
}

/**
 * Rewrite `url(...)` references inside a CSS document or declaration block.
 * With `baseUrl` (the stylesheet's own upstream URL), relative and root-relative
 * references are resolved against it first, as the browser would have done at
 * the original host; references already on the proxy are left alone.
 */
function rewriteCss(css, baseUrl) {
  if (typeof css !== 'string' || css.length === 0) return css;
  // Quotes may be HTML entities when the CSS sits in a style="" attribute.
  return css.replace(/url\(\s*(&#x27;|&#39;|&quot;|['"])?(.+?)\1\s*\)/gi, (match, q, rawUrl) => {
    const quote = q || '';
    let candidate = rawUrl;
    if (baseUrl && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(rawUrl.trim()) && !rawUrl.trim().startsWith(`${config.assetPrefix}/`)) {
      try {
        candidate = new URL(rawUrl.trim(), baseUrl).href;
      } catch {
        return match;
      }
    }
    const mapped = mapUrl(candidate);
    return mapped === candidate ? match : `url(${quote}${mapped}${quote})`;
  });
}

/** Rewrite the individual URL tokens inside a srcset value. */
function rewriteSrcset(value) {
  return value
    .split(',')
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      if (parts.length === 0) return candidate;
      const mapped = mapUrl(parts[0]);
      parts[0] = mapped;
      return parts.join(' ');
    })
    .join(', ');
}

const META_URL_KEYS = /^(og:image|og:image:url|og:image:secure_url|twitter:image|twitter:image:src|image|image_src)$/i;

/**
 * Rewrite URL-bearing attributes in an HTML document.
 *
 * Element-scoped replacements keep the blast radius small: a bare absolute URL
 * appearing inside inline JSON is not an attribute value and is preserved.
 */
function rewriteHtml(html) {
  if (typeof html !== 'string' || html.length === 0) return html;
  let output = html;

  // <script src="...">
  output = output.replace(/(<script\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi, (m, pre, q, val) => `${pre}${q}${mapUrl(val)}${q}`);

  // <link href="..."> (stylesheets, icons, preloads, preconnect targets)
  output = output.replace(/(<link\b[^>]*?\bhref\s*=\s*)(["'])(.*?)\2/gi, (m, pre, q, val) => `${pre}${q}${mapUrl(val)}${q}`);

  // srcset on <img>/<source>
  output = output.replace(/(\bsrcset\s*=\s*)(["'])(.*?)\2/gi, (m, pre, q, val) => `${pre}${q}${rewriteSrcset(val)}${q}`);

  // src / poster on <img>/<source>/<video>/<audio>/<track>
  output = output.replace(
    /(<(?:img|source|video|audio|track|iframe)\b[^>]*?\b(?:src|poster)\s*=\s*)(["'])(.*?)\2/gi,
    (m, pre, q, val) => `${pre}${q}${mapUrl(val)}${q}`,
  );

  // SVG <use href="..."> / xlink:href
  output = output.replace(
    /(<use\b[^>]*?\b(?:xlink:href|href)\s*=\s*)(["'])(.*?)\2/gi,
    (m, pre, q, val) => `${pre}${q}${mapUrl(val)}${q}`,
  );

  // <meta property="og:image" content="..."> style keys only.
  output = output.replace(
    /(<meta\b[^>]*?\b(?:property|name)\s*=\s*)(["'])([^"']+)\2([^>]*?\bcontent\s*=\s*)(["'])(.*?)\5/gi,
    (m, preKey, qKey, key, preContent, qContent, val) => {
      if (!META_URL_KEYS.test(key)) return m;
      return `${preKey}${qKey}${key}${qKey}${preContent}${qContent}${mapUrl(val)}${qContent}`;
    },
  );

  // <style> blocks: CSS url() only.
  output = output.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, body, close) => `${open}${rewriteCss(body)}${close}`);

  // Copies cached by an earlier version carry `url(/&#x27;https:...` (an
  // HTML-escaped quote turned into a path); that is never valid, so restore it.
  output = output.replace(/url\(\/(&#x27;|&#39;|&quot;)(https?:)/gi, 'url($1$2');

  // style="..." attributes: CSS url() only.
  output = output.replace(/(\bstyle\s*=\s*)(["'])(.*?)\2/gi, (m, pre, q, val) => `${pre}${q}${rewriteCss(val)}${q}`);

  return output;
}

/**
 * Resolve a /__ig/<host>/<path> request back into an absolute upstream URL.
 * Re-validates the host so the proxy cannot be pointed at arbitrary origins.
 */
function resolveProxyTarget(host, pathAndQuery) {
  if (!host || !ALLOWED_HOSTS.has(String(host).toLowerCase())) return null;
  if (typeof pathAndQuery !== 'string' || !pathAndQuery.startsWith('/')) return null;
  return `https://${host}${pathAndQuery}`;
}

module.exports = {
  ALLOWED_HOSTS,
  isAllowedUpstreamUrl,
  toProxyPath,
  mapUrl,
  rewriteCss,
  rewriteHtml,
  resolveProxyTarget,
};
