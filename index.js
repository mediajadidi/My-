// ============================================================================
// AJ SPORTS — UNIFIED EDGE WORKER
// ----------------------------------------------------------------------------
// One worker, two frontends:
//   • Prediction tab   -> routes with NO prefix   (/profile, /matches, ...)
//   • Profile tab      -> routes with "/api" prefix (/api/profile, ...)
// Both read/write the SAME KV-backed profile & prediction records, so a
// change made from either tab (username, avatar, language, diamonds, ...)
// is instantly visible to the other — including the language switch.
//
// Design goals (see README.md for the full rationale):
//   1. Byte-for-byte compatible request/response contracts with the two
//      existing frontends (verified directly against their source).
//   2. Two-tier edge caching (Cloudflare Cache API + KV) in front of the
//      free football API so it is called far less than once-per-user.
//   3. Fully local (non-network) auth verification on the hot path, so
//      millions of authenticated requests never have to call Supabase.
//   4. Server-side language switch: every string the WORKER itself
//      generates (errors, messages) is emitted in the user's stored
//      profile language (fa/en), shared across both tabs.
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────
// 0. CONFIG / CONSTANTS
// ─────────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

// Scoring — kept identical to the current production formula:
//   exact score  = 5 diamonds
//   correct winner/draw direction = 3 diamonds (winner) / 2 diamonds (draw)
// NOTE: the previous worker only distinguished exact/winner/lost, but the
// profile-tab history UI already renders a distinct "draw" status pill,
// so a draw-specific value is required. 3/2 are reasonable, commonly used
// defaults — tune POINTS below if your real numbers differ, nothing else
// needs to change.
const POINTS = { exact: 5, winner: 3, draw: 2, lost: 0 };

// 8 physical wheel segments (360° / 45° = 8), matching the frontend's
// rotation math: rotate = -(360*8 + segmentIndex*45 + 22.5).
// The AWARDED prize still follows the exact original probability curve
// (50% / 30% / 15% / 5%) — segment choice is purely cosmetic (which slice
// the wheel visually lands on), never affects the odds.
const WHEEL_SEGMENTS = [0, 1, 0, 2, 0, 1, 0, 5];
const WHEEL_ODDS = [
  { upTo: 50, prize: 0 },
  { upTo: 80, prize: 1 },
  { upTo: 95, prize: 2 },
  { upTo: 100, prize: 5 },
];

const MISSION_DEFINITIONS = {
  welcome: { reward: 5 },
  first_pred: { reward: 10 },
  master_pred: { reward: 20 },
};
const MASTER_PRED_WINS_REQUIRED = 3;

const MATCH_CACHE_TTL_MS = 60 * 1000;        // edge-fresh window
const MATCH_CACHE_KV_TTL = 300;              // KV hard TTL (seconds)
const MATCH_RESULT_CACHE_KV_TTL = 30;        // per-match settle result cache
const LEADERBOARD_CACHE_TTL_MS = 30 * 1000;
const LEADERBOARD_KV_TTL = 60;
const SUPABASE_USER_CACHE_TTL = 300;         // seconds, for network-fallback auth
const UPSTREAM_TIMEOUT_MS = 8000;

const I18N = {
  fa: {
    invalid_email: 'ایمیل نامعتبر است',
    otp_send_failed: 'ارسال کد با خطا مواجه شد',
    otp_invalid: 'کد وارد شده نامعتبر یا منقضی شده است',
    unauthorized: 'لطفاً ابتدا وارد حساب خود شوید',
    username_short: 'نام کاربری باید حداقل ۳ حرف باشد',
    file_missing: 'فایلی ارسال نشده است',
    file_too_large: 'حجم فایل نباید بیشتر از ۵ مگابایت باشد',
    file_not_image: 'فایل باید تصویر باشد',
    upload_failed: 'آپلود عکس با خطا مواجه شد',
    profile_not_found: 'پروفایل یافت نشد',
    prediction_exists: 'برای این مسابقه قبلاً پیش‌بینی ثبت شده است',
    invalid_input: 'اطلاعات ارسالی نامعتبر است',
    mission_invalid: 'ماموریت نامعتبر است',
    mission_claimed: 'این ماموریت قبلاً دریافت شده است',
    mission_not_eligible: 'شرایط دریافت این ماموریت هنوز فراهم نیست',
    daily_spin_used: 'شانس امروز شما قبلاً استفاده شده است',
    matches_fetch_failed: 'دریافت مسابقات با خطا مواجه شد، لطفاً کمی بعد دوباره تلاش کنید',
    not_found: 'یافت نشد',
    internal_error: 'خطای داخلی سرور، لطفاً دوباره تلاش کنید',
    rate_limited: 'تعداد درخواست‌ها بیش از حد مجاز است، کمی صبر کنید',
  },
  en: {
    invalid_email: 'Invalid email address',
    otp_send_failed: 'Failed to send verification code',
    otp_invalid: 'The code is invalid or has expired',
    unauthorized: 'Please sign in first',
    username_short: 'Username must be at least 3 characters',
    file_missing: 'No file was provided',
    file_too_large: 'File size must not exceed 5MB',
    file_not_image: 'File must be an image',
    upload_failed: 'Failed to upload image',
    profile_not_found: 'Profile not found',
    prediction_exists: 'A prediction already exists for this match',
    invalid_input: 'Invalid input',
    mission_invalid: 'Invalid mission',
    mission_claimed: 'This mission has already been claimed',
    mission_not_eligible: 'You are not yet eligible for this mission',
    daily_spin_used: 'You have already used today\'s spin',
    matches_fetch_failed: 'Failed to load matches, please try again shortly',
    not_found: 'Not found',
    internal_error: 'Internal server error, please try again',
    rate_limited: 'Too many requests, please slow down',
  },
};

function tr(lang, key, fallback) {
  const dict = I18N[lang] || I18N.fa;
  return dict[key] || fallback || key;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. ENTRYPOINT
// ─────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // Normalize: profile-tab routes are prefixed with /api, prediction-tab
      // routes are not. We detect the prefix once and route both families
      // through the same handlers, passing an `isApi` flag only where the
      // two contracts genuinely differ (see notes inline).
      const isApi = path.startsWith('/api/');
      const p = isApi ? path.slice(4) : path; // strip "/api" -> keep leading "/"

      if (p === '/health') return json({ status: 'healthy', ts: Date.now() }, 200);

      // ---------------- AUTH ----------------
      if (p === '/auth/send-otp' && request.method === 'POST') return handleSendOtp(request, env, ctx, isApi);
      if (p === '/auth/otp/send' && request.method === 'POST') return handleSendOtp(request, env, ctx, true);

      if (p === '/auth/verify-otp' && request.method === 'POST') return handleVerifyOtp(request, env, ctx, false);
      if (p === '/auth/otp/verify' && request.method === 'POST') return handleVerifyOtp(request, env, ctx, true);

      if (p === '/auth/google' && request.method === 'POST') return handleGoogleAuth(request, env, ctx);
      if (p === '/auth/refresh' && request.method === 'POST') return handleSupabaseRefresh(request, env);
      if (p === '/auth/logout' && request.method === 'POST') return handleLogout(request, env, ctx);

      // ---------------- PROFILE ----------------
      if (p === '/profile' && request.method === 'GET') return handleGetProfile(request, env, ctx, isApi);
      if (p === '/profile' && request.method === 'PUT') return handleUpdateProfile(request, env, ctx, isApi);
      if (p === '/profile/history' && request.method === 'GET') return handleProfileHistory(request, env, ctx);
      if (p === '/avatar' && request.method === 'POST') return handleUploadAvatar(request, env, ctx, isApi);
      if (p === '/profile/avatar' && request.method === 'POST') return handleUploadAvatar(request, env, ctx, isApi);
      if (p === '/account' && request.method === 'DELETE') return handleDeleteAccount(request, env, ctx);

      // ---------------- MATCHES / PREDICTIONS ----------------
      if (p === '/matches' && request.method === 'GET') return handleGetMatches(request, env, ctx);
      if (p === '/predictions' && request.method === 'GET') return handleGetPredictions(request, env, ctx);
      if (p === '/predictions' && request.method === 'POST') return handleSavePrediction(request, env, ctx);
      if (p === '/predictions/settle' && request.method === 'POST') return handleSettlePredictions(request, env, ctx);

      // ---------------- LEADERBOARD / MISSIONS / WHEEL ----------------
      if (p === '/leaderboard' && request.method === 'GET') return handleLeaderboard(request, env, ctx);
      if (p === '/missions' && request.method === 'GET') return handleGetMissions(request, env, ctx);
      if (p === '/missions/claim' && request.method === 'POST') return handleClaimMission(request, env, ctx);
      if (p === '/wheel/spin' && request.method === 'POST') return handleWheelSpin(request, env, ctx);

      // ---------------- ADMIN ----------------
      if (p === '/admin/cache/clear' && request.method === 'POST') return handleClearCache(request, env);

      return json({ error: 'Not Found', path }, 404);
    } catch (err) {
      console.error('Unhandled error:', err && err.stack ? err.stack : err);
      return json({ error: tr('fa', 'internal_error') }, 500);
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// 2. RESPONSE / MISC HELPERS
// ─────────────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function b64urlEncode(bytes) {
  let str = typeof bytes === 'string' ? btoa(unescape(encodeURIComponent(bytes))) : btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecodeToString(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  return decodeURIComponent(escape(atob(b64)));
}
function b64urlDecodeToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64urlEncode(sig);
}
async function hmacVerify(secret, data, signatureB64url) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sigBytes = b64urlDecodeToBytes(signatureB64url);
  return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─────────────────────────────────────────────────────────────────────────
// 3. CUSTOM WORKER TOKEN (used by the prediction-tab / non-/api routes)
//    Fully local sign + verify, no network call, scales to millions of
//    requests per minute at negligible CPU cost.
// ─────────────────────────────────────────────────────────────────────────

async function issueWorkerToken(userId, email, env) {
  const payload = { userId, email, iat: Date.now(), exp: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  const encodedPayload = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacSign(env.JWT_SECRET, encodedPayload);
  return `${encodedPayload}.${sig}`;
}

async function verifyWorkerToken(token, env) {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [encodedPayload, sig] = parts;
    const valid = await hmacVerify(env.JWT_SECRET, encodedPayload, sig);
    if (!valid) return null;
    const payload = JSON.parse(b64urlDecodeToString(encodedPayload));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return { userId: payload.userId, email: payload.email };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 4. SUPABASE HELPERS
//    Auth verification for the /api/* (profile-tab) routes, which send the
//    real Supabase access_token as the bearer. We try, in order:
//      a) local HS256 verification using SUPABASE_JWT_SECRET (zero network
//         calls — set this env var for full edge-speed auth)
//      b) network call to Supabase /auth/v1/user, result cached in KV for
//         SUPABASE_USER_CACHE_TTL seconds keyed by a hash of the token, so
//         even without the JWT secret configured, repeat requests from the
//         same session stay fast and Supabase isn't hammered.
// ─────────────────────────────────────────────────────────────────────────

function decodeJwtPayloadUnsafe(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(b64urlDecodeToString(parts[1]));
  } catch {
    return null;
  }
}

async function verifySupabaseAccessTokenLocal(token, env) {
  if (!env.SUPABASE_JWT_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payloadPart, sig] = parts;
  try {
    const valid = await hmacVerify(env.SUPABASE_JWT_SECRET, `${header}.${payloadPart}`, sig);
    if (!valid) return null;
    const payload = JSON.parse(b64urlDecodeToString(payloadPart));
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    if (payload.sub == null) return null;
    return { userId: payload.sub, email: payload.email || null };
  } catch {
    return null;
  }
}

async function verifySupabaseAccessTokenNetwork(token, env) {
  const cacheKey = `sbauthcache:${await sha256Hex(token)}`;
  const cached = await env.KV_STORE.get(cacheKey, 'json');
  if (cached) return cached;

  const res = await fetchWithTimeout(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user || !user.id) return null;

  const resolved = { userId: user.id, email: user.email || null };
  await env.KV_STORE.put(cacheKey, JSON.stringify(resolved), { expirationTtl: SUPABASE_USER_CACHE_TTL });
  return resolved;
}

async function supabaseSendOtp(email, env) {
  return fetchWithTimeout(`${env.SUPABASE_URL}/auth/v1/otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ email, create_user: true }),
  });
}

async function supabaseVerifyOtp(email, token, env) {
  return fetchWithTimeout(`${env.SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ email, token, type: 'email' }),
  });
}

async function supabaseRefreshToken(refreshToken, env) {
  return fetchWithTimeout(`${env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}

// Best-effort write-through to a `profiles` table in Supabase (used only to
// serve the leaderboard cheaply via a single indexed SQL query instead of
// scanning KV). Uses a proper upsert with a real filter — the previous
// version PATCHed /rest/v1/profiles with no `id=eq.` filter, which would
// have silently overwritten every row's username. Fixed here.
async function syncProfileToSupabase(profile, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return; // optional feature
  try {
    await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/profiles?on_conflict=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        id: profile.id,
        username: profile.username,
        avatar_url: profile.avatar_url,
        diamonds: profile.diamonds || 0,
      }),
    });
  } catch (e) {
    console.warn('Supabase profile sync failed (non-fatal):', e);
  }
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 5. UNIFIED AUTH — accepts either token type transparently
// ─────────────────────────────────────────────────────────────────────────

async function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  // 1) Our own worker-issued token (2 segments) — fully local, fastest path.
  if (token.split('.').length === 2) {
    const worker = await verifyWorkerToken(token, env);
    if (worker) return worker;
  }

  // 2) A real Supabase JWT (3 segments) — verify locally if we have the
  //    project's JWT secret, otherwise fall back to a cached network check.
  if (token.split('.').length === 3) {
    const local = await verifySupabaseAccessTokenLocal(token, env);
    if (local) return local;
    const viaNetwork = await verifySupabaseAccessTokenNetwork(token, env);
    if (viaNetwork) return viaNetwork;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// 6. PROFILE STORE
// ─────────────────────────────────────────────────────────────────────────

function defaultProfile(userId, email) {
  const now = Date.now();
  return {
    id: userId,
    email: email || null,
    username: (email || 'user').split('@')[0],
    avatar_url: null,
    diamonds: 0,
    total_predictions: 0,
    won_predictions: 0,
    exact_predictions: 0,
    missions: [],
    last_wheel_spin: null,
    sports: [],
    settings: { lang: 'fa', theme: 'dark' },
    created_at: now,
    updated_at: now,
  };
}

async function getOrCreateProfile(userId, email, env) {
  let profile = await env.KV_STORE.get(`profile:${userId}`, 'json');
  if (!profile) {
    profile = defaultProfile(userId, email);
    await env.KV_STORE.put(`profile:${userId}`, JSON.stringify(profile));
  } else if (!profile.settings) {
    profile.settings = { lang: 'fa', theme: 'dark' };
  }
  return profile;
}

async function saveProfile(profile, env, ctx) {
  profile.updated_at = Date.now();
  await env.KV_STORE.put(`profile:${profile.id}`, JSON.stringify(profile));
  if (ctx) ctx.waitUntil(syncProfileToSupabase(profile, env));
}

function langForProfile(profile) {
  return profile && profile.settings && profile.settings.lang === 'en' ? 'en' : 'fa';
}

// ─────────────────────────────────────────────────────────────────────────
// 7. AUTH HANDLERS
// ─────────────────────────────────────────────────────────────────────────

async function handleSendOtp(request, env, ctx, isApi) {
  const { email } = await readJson(request);
  const lang = detectRequestLang(request);
  if (!email || !email.includes('@')) return json({ error: tr(lang, 'invalid_email') }, 400);

  // Lightweight abuse guard: max 5 sends / 5 min per email, edge-cached.
  const rl = await rateLimited(`rl:otp:${email.toLowerCase()}`, 5, 300, env);
  if (rl) return json({ error: tr(lang, 'rate_limited') }, 429);

  const res = await supabaseSendOtp(email, env);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return json({ error: err.message || tr(lang, 'otp_send_failed') }, res.status);
  }
  return json(isApi ? { success: true } : { success: true, message: 'OTP sent' });
}

async function handleVerifyOtp(request, env, ctx, isApi) {
  const { email, token } = await readJson(request);
  const lang = detectRequestLang(request);
  if (!email || !token || String(token).length !== 6) {
    return json({ error: tr(lang, 'invalid_input') }, 400);
  }

  const res = await supabaseVerifyOtp(email, token, env);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return json({ error: err.message || tr(lang, 'otp_invalid') }, res.status || 400);
  }
  const data = await res.json();
  const user = data.user;
  const profile = await getOrCreateProfile(user.id, user.email, env);
  await saveProfile(profile, env, ctx);

  if (isApi) {
    // Profile-tab contract: hand back the real Supabase session tokens.
    return json({ access_token: data.access_token, refresh_token: data.refresh_token, profile });
  }
  // Prediction-tab contract: hand back our own signed worker token + flat profile-as-user.
  const workerToken = await issueWorkerToken(user.id, user.email, env);
  return json({ token: workerToken, user: profile });
}

async function handleGoogleAuth(request, env, ctx) {
  // The frontend already completed the Supabase OAuth flow client-side and
  // hands us the resulting Supabase access_token — we just verify it and
  // mint our own worker token from it (prediction-tab only uses this route).
  const { access_token } = await readJson(request);
  const lang = detectRequestLang(request);
  if (!access_token) return json({ error: tr(lang, 'invalid_input') }, 400);

  const resolved = await verifySupabaseAccessTokenLocal(access_token, env) || await verifySupabaseAccessTokenNetwork(access_token, env);
  if (!resolved) return json({ error: tr(lang, 'unauthorized') }, 401);

  const profile = await getOrCreateProfile(resolved.userId, resolved.email, env);
  await saveProfile(profile, env, ctx);
  const workerToken = await issueWorkerToken(resolved.userId, resolved.email, env);
  return json({ token: workerToken, user: profile });
}

async function handleSupabaseRefresh(request, env) {
  const { refresh_token } = await readJson(request);
  const lang = detectRequestLang(request);
  if (!refresh_token) return json({ error: tr(lang, 'invalid_input') }, 400);
  const res = await supabaseRefreshToken(refresh_token, env);
  if (!res.ok) return json({ error: tr(lang, 'unauthorized') }, 401);
  const data = await res.json();
  return json({ access_token: data.access_token, refresh_token: data.refresh_token || refresh_token });
}

async function handleLogout(request, env, ctx) {
  const auth = await authenticate(request, env);
  // Logout is best-effort/local-token based (JWTs cannot be truly revoked
  // without a deny-list); clearing client-side storage is what the two
  // frontends already do. We just clear any cached session artifacts.
  if (auth) ctx.waitUntil(env.KV_STORE.delete(`session:${auth.userId}`));
  return json({ success: true });
}

// ─────────────────────────────────────────────────────────────────────────
// 8. PROFILE HANDLERS
// ─────────────────────────────────────────────────────────────────────────

async function handleGetProfile(request, env, ctx, isApi) {
  const auth = await authenticate(request, env);
  const lang = detectRequestLang(request);
  if (!auth) return json({ error: tr(lang, 'unauthorized') }, 401);
  const profile = await getOrCreateProfile(auth.userId, auth.email, env);
  return json(isApi ? { profile } : profile);
}

async function handleUpdateProfile(request, env, ctx, isApi) {
  const auth = await authenticate(request, env);
  const lang0 = detectRequestLang(request);
  if (!auth) return json({ error: tr(lang0, 'unauthorized') }, 401);

  const body = await readJson(request);
  const profile = await getOrCreateProfile(auth.userId, auth.email, env);
  const lang = langForProfile(profile);

  if (body.username !== undefined) {
    if (!body.username || body.username.trim().length < 3) {
      return json({ error: tr(lang, 'username_short') }, 400);
    }
    profile.username = body.username.trim();
  }
  if (Array.isArray(body.sports)) {
    profile.sports = body.sports;
  }
  if (body.settings && typeof body.settings === 'object') {
    profile.settings = { ...profile.settings, ...body.settings };
    // ↳ This is the server-side language switch: profile.settings.lang is
    //   the single source of truth read by BOTH tabs on every request.
  }

  await saveProfile(profile, env, ctx);
  return json(isApi ? { success: true, profile } : { success: true, profile });
}

async function handleProfileHistory(request, env, ctx) {
  const auth = await authenticate(request, env);
  const lang = detectRequestLang(request);
  if (!auth) return json({ error: tr(lang, 'unauthorized') }, 401);

  const predictions = (await env.KV_STORE.get(`predictions:${auth.userId}`, 'json')) || {};
  const history = Object.values(predictions)
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    .map((p) => ({
      home_team: p.home_team,
      away_team: p.away_team,
      home_pred: p.home_pred,
      away_pred: p.away_pred,
      status: p.status,
      match_date: p.match_date,
    }));

  return json({ history });
}

async function handleUploadAvatar(request, env, ctx, isApi) {
  const auth = await authenticate(request, env);
  const lang0 = detectRequestLang(request);
  if (!auth) return json({ error: tr(lang0, 'unauthorized') }, 401);

  const profile = await getOrCreateProfile(auth.userId, auth.email, env);
  const lang = langForProfile(profile);

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: tr(lang, 'file_missing') }, 400);
  }
  const file = formData.get('file');
  if (!file || typeof file === 'string') return json({ error: tr(lang, 'file_missing') }, 400);
  if (file.size > 5 * 1024 * 1024) return json({ error: tr(lang, 'file_too_large') }, 400);
  if (!file.type || !file.type.startsWith('image/')) return json({ error: tr(lang, 'file_not_image') }, 400);

  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_UPLOAD_PRESET) {
    return json({ error: tr(lang, 'upload_failed') }, 500);
  }

  const cloudForm = new FormData();
  cloudForm.append('file', file);
  cloudForm.append('upload_preset', env.CLOUDINARY_UPLOAD_PRESET);
  cloudForm.append('folder', 'avatars');

  let cloudRes;
  try {
    cloudRes = await fetchWithTimeout(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`, {
      method: 'POST',
      body: cloudForm,
    });
  } catch {
    return json({ error: tr(lang, 'upload_failed') }, 502);
  }
  if (!cloudRes.ok) return json({ error: tr(lang, 'upload_failed') }, 502);

  const cloudData = await cloudRes.json();
  profile.avatar_url = cloudData.secure_url;
  await saveProfile(profile, env, ctx);

  return json({ success: true, avatar_url: profile.avatar_url, profile });
}

async function handleDeleteAccount(request, env, ctx) {
  const auth = await authenticate(request, env);
  const lang = detectRequestLang(request);
  if (!auth) return json({ error: tr(lang, 'unauthorized') }, 401);

  await Promise.all([
    env.KV_STORE.delete(`profile:${auth.userId}`),
    env.KV_STORE.delete(`predictions:${auth.userId}`),
    env.KV_STORE.delete(`session:${auth.userId}`),
  ]);
  return json({ success: true });
}

// ─────────────────────────────────────────────────────────────────────────
// 9. MATCHES (two-tier edge cache: Cache API -> KV -> upstream)
// ─────────────────────────────────────────────────────────────────────────

async function handleGetMatches(request, env, ctx) {
  const auth = await authenticate(request, env);
  const lang0 = detectRequestLang(request);
  if (!auth) return json({ error: tr(lang0, 'unauthorized') }, 401);

  const url = new URL(request.url);
  const date = url.searchParams.get('date') || todayStr();
  const profile = await getOrCreateProfile(auth.userId, auth.email, env);
  const lang = langForProfile(profile);

  const matches = await getMatchesForDate(date, env, ctx);
  if (matches === null) {
    return json({ error: tr(lang, 'matches_fetch_failed') }, 502);
  }

  const predictionsMap = (await env.KV_STORE.get(`predictions:${auth.userId}`, 'json')) || {};
  const userPredictions = Object.values(predictionsMap);

  return json({ matches, userPredictions });
}

// Cloudflare's `caches.default` sits in front of KV: it can serve a hot
// date to every visitor at that PoP without even reading KV, and KV in
// turn means we call the upstream football API roughly once per TTL
// window GLOBALLY — not once per user, which is what keeps a free-tier
// football API alive under millions of requests.
async function getMatchesForDate(date, env, ctx) {
  const cacheKeyUrl = `https://cache.internal/matches/${date}`;
  const cache = caches.default;
  const cacheReq = new Request(cacheKeyUrl);

  const edgeHit = await cache.match(cacheReq);
  if (edgeHit) return edgeHit.json();

  const kvKey = `matches:${date}`;
  const cached = await env.KV_STORE.get(kvKey, 'json');
  const isFresh = cached && Date.now() - cached.timestamp < MATCH_CACHE_TTL_MS;

  if (isFresh) {
    ctx.waitUntil(putEdgeCache(cache, cacheReq, cached.data));
    return cached.data;
  }

  // Stale-while-revalidate: serve what we have immediately (if any) and
  // refresh in the background, so users never wait on the upstream API.
  if (cached) {
    ctx.waitUntil(refreshMatches(date, env, ctx, cache, cacheReq));
    return cached.data;
  }

  // Nothing cached at all — fetch synchronously this one time.
  const fresh = await fetchMatchesFromUpstream(date, env);
  if (fresh === null) return null;
  await env.KV_STORE.put(kvKey, JSON.stringify({ data: fresh, timestamp: Date.now() }), { expirationTtl: MATCH_CACHE_KV_TTL });
  ctx.waitUntil(putEdgeCache(cache, cacheReq, fresh));
  return fresh;
}

async function refreshMatches(date, env, ctx, cache, cacheReq) {
  const fresh = await fetchMatchesFromUpstream(date, env);
  if (fresh === null) return; // keep serving stale data if upstream fails
  await env.KV_STORE.put(`matches:${date}`, JSON.stringify({ data: fresh, timestamp: Date.now() }), { expirationTtl: MATCH_CACHE_KV_TTL });
  await putEdgeCache(cache, cacheReq, fresh);
}

async function putEdgeCache(cache, cacheReq, data) {
  const resp = new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${Math.floor(MATCH_CACHE_TTL_MS / 1000)}` },
  });
  await cache.put(cacheReq, resp);
}

async function fetchMatchesFromUpstream(date, env) {
  if (!env.API_FOOTBALL_KEY) return null;
  try {
    const apiUrl = `https://apiv3.apifootball.com/?action=get_events&from=${date}&to=${date}&APIkey=${env.API_FOOTBALL_KEY}`;
    const res = await fetchWithTimeout(apiUrl, {}, UPSTREAM_TIMEOUT_MS);
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('Upstream matches fetch failed:', e);
    return null;
  }
}

async function getMatchResultCached(matchId, env) {
  const kvKey = `matchresult:${matchId}`;
  const cached = await env.KV_STORE.get(kvKey, 'json');
  if (cached) return cached;
  if (!env.API_FOOTBALL_KEY) return null;
  try {
    const apiUrl = `https://apiv3.apifootball.com/?action=get_events&match_id=${matchId}&APIkey=${env.API_FOOTBALL_KEY}`;
    const res = await fetchWithTimeout(apiUrl);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data[0]) return null;
    await env.KV_STORE.put(kvKey, JSON.stringify(data[0]), { expirationTtl: MATCH_RESULT_CACHE_KV_TTL });
    return data[0];
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 10. PREDICTIONS
// ─────────────────────────────────────────────────────────────────────────

async function handleGetPredictions(request, env, ctx) {
  const auth = await authenticate(request, env);
  const lang = detectRequestLang(request);
  if (!auth) return json({ error: tr(lang, 'unauthorized') }, 401);
  const predictions = (await env.KV_STORE.get(`predictions:${auth.userId}`, 'json')) || {};
  return json({ predictions });
}

async function handleSavePrediction(request, env, ctx) {
  const auth = await authenticate(request, env);
  const lang0 = detectRequestLang(request);
  if (!auth) return json({ error: tr(lang0, 'unauthorized') }, 401);

  const body = await readJson(request);
  const matchId = body.matchId;
  const matchDate = body.matchDate || body.date;
  const homeTeam = body.homeTeam;
  const awayTeam = body.awayTeam;
  const homePred = body.homePred;
  const awayPred = body.awayPred;

  const profile = await getOrCreateProfile(auth.userId, auth.email, env);
  const lang = langForProfile(profile);

  if (!matchId || homePred === undefined || awayPred === undefined) {
    return json({ error: tr(lang, 'invalid_input') }, 400);
  }

  const predictions = (await env.KV_STORE.get(`predictions:${auth.userId}`, 'json')) || {};
  if (predictions[matchId]) {
    return json({ error: tr(lang, 'prediction_exists') }, 400);
  }

  predictions[matchId] = {
    match_id: matchId,
    match_date: matchDate,
    home_team: homeTeam,
    away_team: awayTeam,
    home_pred: parseInt(homePred, 10),
    away_pred: parseInt(awayPred, 10),
    home_score_real: null,
    away_score_real: null,
    status: 'pending',
    points_earned: 0,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await env.KV_STORE.put(`predictions:${auth.userId}`, JSON.stringify(predictions));

  profile.total_predictions = (profile.total_predictions || 0) + 1;
  await saveProfile(profile, env, ctx);

  return json({ success: true, prediction: predictions[matchId], total: Object.keys(predictions).length });
}

async function handleSettlePredictions(request, env, ctx) {
  const auth = await authenticate(request, env);
  const lang = detectRequestLang(request);
  if (!auth) return json({ error: tr(lang, 'unauthorized') }, 401);

  const predictions = (await env.KV_STORE.get(`predictions:${auth.userId}`, 'json')) || {};
  const profile = await getOrCreateProfile(auth.userId, auth.email, env);
  const settled = [];
  let profileChanged = false;

  const finalStatuses = new Set(['finished', 'ft', 'aet', 'pen', 'awarded', 'int', 'after pen.']);

  for (const [matchId, pred] of Object.entries(predictions)) {
    if (pred.status !== 'pending') continue;

    const match = await getMatchResultCached(matchId, env);
    if (!match) continue;
    const status = (match.match_status || '').toLowerCase();
    if (!finalStatuses.has(status)) continue;

    const homeScore = parseInt(match.match_hometeam_score, 10);
    const awayScore = parseInt(match.match_awayteam_score, 10);
    if (Number.isNaN(homeScore) || Number.isNaN(awayScore)) continue;

    pred.home_score_real = homeScore;
    pred.away_score_real = awayScore;

    const { statusType, points } = scorePrediction(pred.home_pred, pred.away_pred, homeScore, awayScore);
    pred.status = statusType;
    pred.points_earned = points;
    pred.settled_at = Date.now();
    pred.updated_at = Date.now();

    if (points > 0) {
      profile.diamonds = (profile.diamonds || 0) + points;
      profile.won_predictions = (profile.won_predictions || 0) + 1;
      if (statusType === 'exact') profile.exact_predictions = (profile.exact_predictions || 0) + 1;
      profileChanged = true;
    }
    settled.push({ matchId, status: statusType, points });
  }

  await env.KV_STORE.put(`predictions:${auth.userId}`, JSON.stringify(predictions));
  if (profileChanged) await saveProfile(profile, env, ctx);

  return json({
    success: true,
    settled,
    total_pending: Object.values(predictions).filter((p) => p.status === 'pending').length,
  });
}

function scorePrediction(homePred, awayPred, homeScore, awayScore) {
  if (homePred === homeScore && awayPred === awayScore) {
    return { statusType: 'exact', points: POINTS.exact };
  }
  const predictedDraw = homePred === awayPred;
  const actualDraw = homeScore === awayScore;
  if (predictedDraw && actualDraw) {
    return { statusType: 'draw', points: POINTS.draw };
  }
  const predictedHomeWin = homePred > awayPred;
  const actualHomeWin = homeScore > awayScore;
  if (!predictedDraw && !actualDraw && predictedHomeWin === actualHomeWin) {
    return { statusType: 'winner', points: POINTS.winner };
  }
  return { statusType: 'lost', points: POINTS.lost };
}

// ─────────────────────────────────────────────────────────────────────────
// 11. LEADERBOARD
// ─────────────────────────────────────────────────────────────────────────

async function handleLeaderboard(request, env, ctx) {
  const cache = caches.default;
  const cacheReq = new Request('https://cache.internal/leaderboard');
  const edgeHit = await cache.match(cacheReq);
  if (edgeHit) return json({ leaderboard: await edgeHit.json() });

  const kvKey = 'leaderboard:top20';
  const cached = await env.KV_STORE.get(kvKey, 'json');
  if (cached && Date.now() - cached.timestamp < LEADERBOARD_CACHE_TTL_MS) {
    ctx.waitUntil(putEdgeCache(cache, cacheReq, cached.data));
    return json({ leaderboard: cached.data });
  }

  let leaderboard = [];
  if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
    try {
      const res = await fetchWithTimeout(
        `${env.SUPABASE_URL}/rest/v1/profiles?select=username,diamonds,avatar_url&order=diamonds.desc&limit=20`,
        { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` } }
      );
      if (res.ok) leaderboard = await res.json();
    } catch (e) {
      console.warn('Leaderboard fetch failed:', e);
    }
  }
  // Fall back to whatever we last had cached rather than showing an empty
  // board if Supabase is briefly unavailable.
  if (leaderboard.length === 0 && cached) leaderboard = cached.data;

  await env.KV_STORE.put(kvKey, JSON.stringify({ data: leaderboard, timestamp: Date.now() }), { expirationTtl: LEADERBOARD_KV_TTL });
  ctx.waitUntil(putEdgeCache(cache, cacheReq, leaderboard));
  return json({ leaderboard });
}

// ─────────────────────────────────────────────────────────────────────────
// 12. MISSIONS
//     Response contract verified against the live frontend:
//       GET /missions -> { claimed: string[], eligibility: { first_pred, master_pred } }
// ─────────────────────────────────────────────────────────────────────────

async function handleGetMissions(request, env, ctx) {
  const auth = await authenticate(request, env);
  const lang = detectRequestLang(request);
  if (!auth) return json({ error: tr(lang, 'unauthorized') }, 401);

  const profile = await getOrCreateProfile(auth.userId, auth.email, env);
  const predictions = (await env.KV_STORE.get(`predictions:${auth.userId}`, 'json')) || {};
  const claimed = profile.missions || [];

  const eligibility = {
    welcome: true,
    first_pred: Object.keys(predictions).length > 0,
    master_pred: (profile.won_predictions || 0) >= MASTER_PRED_WINS_REQUIRED,
  };

  return json({ claimed, eligibility });
}

async function handleClaimMission(request, env, ctx) {
  const auth = await authenticate(request, env);
  const lang0 = detectRequestLang(request);
  if (!auth) return json({ error: tr(lang0, 'unauthorized') }, 401);

  const { missionId } = await readJson(request);
  const profile = await getOrCreateProfile(auth.userId, auth.email, env);
  const lang = langForProfile(profile);

  if (!missionId || !MISSION_DEFINITIONS[missionId]) return json({ error: tr(lang, 'mission_invalid') }, 400);

  const claimed = profile.missions || [];
  if (claimed.includes(missionId)) return json({ error: tr(lang, 'mission_claimed') }, 400);

  const predictions = (await env.KV_STORE.get(`predictions:${auth.userId}`, 'json')) || {};
  let eligible = true;
  if (missionId === 'first_pred') eligible = Object.keys(predictions).length > 0;
  if (missionId === 'master_pred') eligible = (profile.won_predictions || 0) >= MASTER_PRED_WINS_REQUIRED;

  if (!eligible) return json({ error: tr(lang, 'mission_not_eligible') }, 400);

  const reward = MISSION_DEFINITIONS[missionId].reward;
  profile.missions = [...claimed, missionId];
  profile.diamonds = (profile.diamonds || 0) + reward;
  await saveProfile(profile, env, ctx);

  return json({ success: true, reward, diamonds: profile.diamonds });
}

// ─────────────────────────────────────────────────────────────────────────
// 13. WHEEL OF FORTUNE
// ─────────────────────────────────────────────────────────────────────────

async function handleWheelSpin(request, env, ctx) {
  const auth = await authenticate(request, env);
  const lang0 = detectRequestLang(request);
  if (!auth) return json({ error: tr(lang0, 'unauthorized') }, 401);

  const profile = await getOrCreateProfile(auth.userId, auth.email, env);
  const lang = langForProfile(profile);

  const today = todayStr();
  if (profile.last_wheel_spin === today) return json({ error: tr(lang, 'daily_spin_used') }, 400);

  const roll = Math.random() * 100;
  const tier = WHEEL_ODDS.find((t) => roll <= t.upTo) || WHEEL_ODDS[WHEEL_ODDS.length - 1];
  const prize = tier.prize;

  const candidateSlices = WHEEL_SEGMENTS.map((v, i) => (v === prize ? i : -1)).filter((i) => i !== -1);
  const segmentIndex = candidateSlices.length
    ? candidateSlices[Math.floor(Math.random() * candidateSlices.length)]
    : Math.floor(Math.random() * WHEEL_SEGMENTS.length);

  profile.diamonds = (profile.diamonds || 0) + prize;
  profile.last_wheel_spin = today;
  await saveProfile(profile, env, ctx);

  return json({ success: true, segmentIndex, prize, diamonds: profile.diamonds });
}

// ─────────────────────────────────────────────────────────────────────────
// 14. ADMIN
// ─────────────────────────────────────────────────────────────────────────

async function handleClearCache(request, env) {
  const adminToken = request.headers.get('X-Admin-Token');
  if (!env.ADMIN_TOKEN || adminToken !== env.ADMIN_TOKEN) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const list = await env.KV_STORE.list({ prefix: 'matches:' });
  for (const key of list.keys) await env.KV_STORE.delete(key.name);
  await env.KV_STORE.delete('leaderboard:top20');
  return json({ success: true, cleared: list.keys.length });
}

// ─────────────────────────────────────────────────────────────────────────
// 15. RATE LIMITING (KV fixed-window counter — good enough for auth abuse)
// ─────────────────────────────────────────────────────────────────────────

async function rateLimited(key, limit, windowSeconds, env) {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const fullKey = `${key}:${bucket}`;
  const current = parseInt((await env.KV_STORE.get(fullKey)) || '0', 10);
  if (current >= limit) return true;
  await env.KV_STORE.put(fullKey, String(current + 1), { expirationTtl: windowSeconds + 5 });
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// 16. LANGUAGE DETECTION FOR UNAUTHENTICATED / PRE-PROFILE REQUESTS
// ─────────────────────────────────────────────────────────────────────────

function detectRequestLang(request) {
  const url = new URL(request.url);
  const q = url.searchParams.get('lang');
  if (q === 'en' || q === 'fa') return q;
  const accept = request.headers.get('Accept-Language') || '';
  if (accept.toLowerCase().startsWith('en')) return 'en';
  return 'fa';
}
