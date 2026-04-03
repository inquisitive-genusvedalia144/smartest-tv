/**
 * smartest-tv Resolution API — Cloudflare Worker
 *
 * Endpoints:
 *   POST /v1/resolve        — Resolve content ID (with optional Polar license key)
 *   GET  /v1/cache           — Full community cache
 *   GET  /v1/cache/:platform/:slug — Single cache entry
 *   POST /v1/cache/:platform/:slug — Contribute a cache entry
 *   GET  /v1/trending/:platform    — Trending content
 *
 * Auth:
 *   Free tier: 100 resolves/day per IP (no key needed)
 *   Pro tier:  Unlimited resolves (Polar license key in X-License-Key header)
 *
 * Environment variables (set in wrangler.toml or dashboard):
 *   POLAR_ORGANIZATION_ID  — Your Polar organization ID
 *   CACHE_KV               — KV namespace binding for cache data
 *   RATE_LIMIT_KV          — KV namespace binding for rate limiting
 */

const POLAR_VALIDATE_URL = "https://api.polar.sh/v1/customer-portal/license-keys/validate";
const FREE_DAILY_LIMIT = 100;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-License-Key, Authorization",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // --- POST /v1/resolve ---
      if (path === "/v1/resolve" && request.method === "POST") {
        return await handleResolve(request, env);
      }

      // --- GET /v1/cache ---
      if (path === "/v1/cache" && request.method === "GET") {
        return await handleGetFullCache(env);
      }

      // --- GET /v1/cache/:platform/:slug ---
      const cacheMatch = path.match(/^\/v1\/cache\/(\w+)\/(.+)$/);
      if (cacheMatch && request.method === "GET") {
        return await handleGetCacheEntry(env, cacheMatch[1], cacheMatch[2]);
      }

      // --- POST /v1/cache/:platform/:slug ---
      if (cacheMatch && request.method === "POST") {
        return await handleContribute(request, env, cacheMatch[1], cacheMatch[2]);
      }

      // --- GET /v1/trending/:platform ---
      const trendingMatch = path.match(/^\/v1\/trending\/(\w+)$/);
      if (trendingMatch && request.method === "GET") {
        return await handleTrending(env, trendingMatch[1], url.searchParams);
      }

      return jsonResponse({ error: "not_found", message: `Unknown endpoint: ${path}` }, 404);
    } catch (err) {
      return jsonResponse({ error: "internal", message: err.message }, 500);
    }
  },
};


// ---------------------------------------------------------------------------
// Resolve endpoint (the money maker)
// ---------------------------------------------------------------------------

async function handleResolve(request, env) {
  const body = await request.json();
  const { platform, query, season, episode, title_id } = body;

  if (!platform || !query) {
    return jsonResponse({ error: "bad_request", message: "platform and query required" }, 400);
  }

  // --- Auth: check license key ---
  const licenseKey = request.headers.get("X-License-Key") || "";
  const tier = licenseKey ? await validateLicenseKey(licenseKey, env) : "free";

  // --- Rate limiting for free tier ---
  if (tier === "free") {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const allowed = await checkRateLimit(env, ip);
    if (!allowed) {
      return jsonResponse({
        error: "rate_limited",
        message: `Free tier limit reached (${FREE_DAILY_LIMIT}/day). Get unlimited: https://polar.sh/Hybirdss/smartest-tv`,
        tier: "free",
        limit: FREE_DAILY_LIMIT,
      }, 429);
    }
  }

  // --- 1. Check cache first ---
  const slug = slugify(query);
  const cached = await getCacheEntry(env, platform, slug);
  if (cached) {
    let contentId = null;
    if (platform === "netflix" && season != null && episode != null) {
      contentId = resolveNetflixEpisode(cached, season, episode);
    } else if (platform === "youtube") {
      contentId = cached.video_id || cached;
    } else if (platform === "spotify") {
      contentId = cached.uri || cached;
    } else {
      contentId = cached;
    }

    if (contentId) {
      return jsonResponse({
        content_id: String(contentId),
        source: "cache",
        tier,
      });
    }
  }

  // --- 2. Cache miss → return not_found (resolution happens in _engine) ---
  // The Worker only serves cached data. Actual scraping/resolution is done
  // by the _engine on the client side (PyPI install) or by admin scripts.
  return jsonResponse({
    error: "not_found",
    message: `No cached entry for ${platform}:${slug}`,
    tier,
  }, 404);
}


// ---------------------------------------------------------------------------
// Polar license key validation
// ---------------------------------------------------------------------------

async function validateLicenseKey(key, env) {
  try {
    const resp = await fetch(POLAR_VALIDATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key,
        organization_id: env.POLAR_ORGANIZATION_ID,
      }),
    });

    if (!resp.ok) return "free";

    const data = await resp.json();
    // Polar returns the license key object with status
    if (data.id && data.status === "granted") {
      return "pro";
    }
    return "free";
  } catch {
    // If Polar is down, be generous — treat as pro
    return "pro";
  }
}


// ---------------------------------------------------------------------------
// Rate limiting (KV-based, per-IP daily)
// ---------------------------------------------------------------------------

async function checkRateLimit(env, ip) {
  if (!env.RATE_LIMIT_KV) return true; // No KV = no rate limiting

  const today = new Date().toISOString().split("T")[0]; // "2026-04-03"
  const key = `rl:${ip}:${today}`;

  const current = parseInt(await env.RATE_LIMIT_KV.get(key) || "0", 10);
  if (current >= FREE_DAILY_LIMIT) {
    return false;
  }

  // Increment (TTL = 24h to auto-cleanup)
  await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: 86400 });
  return true;
}


// ---------------------------------------------------------------------------
// Cache operations
// ---------------------------------------------------------------------------

async function handleGetFullCache(env) {
  if (!env.CACHE_KV) return jsonResponse({}, 200);
  const data = await env.CACHE_KV.get("full_cache", "json");
  return jsonResponse(data || {});
}

async function handleGetCacheEntry(env, platform, slug) {
  if (!env.CACHE_KV) return jsonResponse({ data: null }, 200);
  const data = await env.CACHE_KV.get(`${platform}:${slug}`, "json");
  if (data) {
    return jsonResponse({ data });
  }
  return jsonResponse({ data: null }, 200);
}

async function handleContribute(request, env, platform, slug) {
  if (!env.CACHE_KV) return jsonResponse({ error: "no_storage" }, 500);

  // Validate platform
  if (!["netflix", "youtube", "spotify"].includes(platform)) {
    return jsonResponse({ error: "invalid_platform" }, 400);
  }

  // Validate slug format
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return jsonResponse({ error: "invalid_slug" }, 400);
  }

  const body = await request.json();

  // Store in pending queue (not live cache)
  await env.CACHE_KV.put(`pending:${platform}:${slug}`, JSON.stringify({
    data: body,
    ip: request.headers.get("CF-Connecting-IP"),
    ts: Date.now(),
  }), { expirationTtl: 604800 }); // 7 day TTL

  return jsonResponse({ status: "pending", message: "Contribution queued for review" });
}


// ---------------------------------------------------------------------------
// Trending
// ---------------------------------------------------------------------------

async function handleTrending(env, platform, params) {
  if (!env.CACHE_KV) return jsonResponse([], 200);

  const limit = Math.min(parseInt(params.get("limit") || "10", 10), 50);
  const data = await env.CACHE_KV.get(`trending:${platform}`, "json");

  if (data && Array.isArray(data)) {
    return jsonResponse(data.slice(0, limit));
  }
  return jsonResponse([]);
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveNetflixEpisode(showData, season, episode) {
  if (!showData || !showData.seasons) return null;
  const seasonData = showData.seasons[String(season)];
  if (!seasonData) return null;
  const firstId = seasonData.first_episode_id;
  const count = seasonData.episode_count || 0;
  if (firstId && episode >= 1 && episode <= count) {
    return String(firstId + episode - 1);
  }
  return null;
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}
