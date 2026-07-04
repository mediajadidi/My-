// ============================================================================
// AJ SPORTS — UNIFIED EDGE WORKER  (v2 — پروفایل + پیش‌بینی + گردونه + مأموریت)
// ============================================================================
// یک Worker واحد و یک KV مشترک برای هر دو فرانت‌اند:
//   1) صفحه پروفایل   → مسیرهای زیر پیشوند   /api/...
//   2) صفحه پیش‌بینی   → مسیرهای بدون پیشوند  /...
// هر دو روی یک پروفایل کاربر در KV کار می‌کنند (بر اساس ایمیل/Supabase user id)
// بنابراین الماس‌ها، یوزرنیم، آواتار و تنظیمات (از جمله زبان) بین هر دو صفحه
// یکسان و همگام است.
// ============================================================================

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function err(message, status = 400, extra = {}) {
  return json({ error: message, ...extra }, status);
}

// ---------------------------------------------------------------------------
// MAIN ROUTER
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // ---- health ----
      if (path === '/health' || path === '/api/health') {
        return json({ status: 'healthy', timestamp: Date.now(), env: env.ENVIRONMENT || 'production' });
      }

      // Normalize: strip an optional leading /api so both frontends share one
      // handler table. (/api/profile  and  /profile  both land on the same code.)
      const isApiPrefixed = path.startsWith('/api/');
      const bare = isApiPrefixed ? path.slice(4) : path; // '/api/profile' -> '/profile'

      // ---------------- AUTH ----------------
      if (bare === '/auth/otp/send' && request.method === 'POST') return withEnv(handleSendOTP, request, env);
      if (bare === '/auth/send-otp' && request.method === 'POST') return withEnv(handleSendOTP, request, env);

      if (bare === '/auth/otp/verify' && request.method === 'POST') return withEnv(handleVerifyOTP, request, env, { style: 'pair' });
      if (bare === '/auth/verify-otp' && request.method === 'POST') return withEnv(handleVerifyOTP, request, env, { style: 'single' });

      if (bare === '/auth/refresh' && request.method === 'POST') return withEnv(handleRefreshToken, request, env);
      if (bare === '/auth/google' && request.method === 'POST') return withEnv(handleGoogleAuth, request, env);
      if (bare === '/auth/logout' && request.method === 'POST') return withEnv(handleLogout, request, env);
      if (bare === '/auth/session' && request.method === 'GET') return withEnv(handleSessionCheck, request, env);

      // ---------------- PROFILE ----------------
      if (bare === '/profile' && request.method === 'GET') return withEnv(handleGetProfile, request, env, { wrapped: isApiPrefixed });
      if (bare === '/profile' && request.method === 'PUT') return withEnv(handleUpdateProfile, request, env, { wrapped: isApiPrefixed });
      if ((bare === '/profile/avatar' || bare === '/avatar') && request.method === 'POST') return withEnv(handleUploadAvatar, request, env);
      if (bare === '/profile/history' && request.method === 'GET') return withEnv(handleGetHistory, request, env);
      if (bare === '/account' && request.method === 'DELETE') return withEnv(handleDeleteAccount, request, env);

      // ---------------- MATCHES / PREDICTIONS ----------------
      if (bare === '/matches' && request.method === 'GET') return withEnv(handleGetMatches, request, env, { ctx });
      if (bare === '/predictions' && request.method === 'GET') return withEnv(handleGetPredictions, request, env);
      if (bare === '/predictions' && request.method === 'POST') return withEnv(handleSavePrediction, request, env);
      if (bare === '/predictions/settle' && request.method === 'POST') return withEnv(handleSettlePredictions, request, env);

      // ---------------- LEADERBOARD ----------------
      if (bare === '/leaderboard' && request.method === 'GET') return withEnv(handleGetLeaderboard, request, env);

      // ---------------- MISSIONS ----------------
      if (bare === '/missions' && request.method === 'GET') return withEnv(handleGetMissions, request, env);
      if (bare === '/missions/claim' && request.method === 'POST') return withEnv(handleClaimMission, request, env);

      // ---------------- WHEEL ----------------
      if (bare === '/wheel/spin' && request.method === 'POST') return withEnv(handleWheelSpin, request, env);

      // ---------------- ADMIN ----------------
      if (bare === '/admin/cache/clear' && request.method === 'POST') return withEnv(handleClearCache, request, env);

      return err('Not Found', 404, { path });
    } catch (e) {
      console.error('Unhandled error:', e && e.stack ? e.stack : e);
      return err('Internal server error', 500);
    }
  },
};

async function withEnv(handler, request, env, extra) {
  return handler(request, env, extra || {});
}

// ============================================================================
// 🔐 CRYPTO HELPERS — HMAC-SHA256 signing for our own compact JWTs
// ============================================================================
function b64urlEncode(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecodeToString(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}
function utf8Encode(str) { return new TextEncoder().encode(str); }

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', utf8Encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// Compact JWT-like token: base64url(json(payload)) + '.' + base64url(hmac)
async function signToken(payload, secret) {
  const body = b64urlEncode(utf8Encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, utf8Encode(body));
  return `${body}.${b64urlEncode(sig)}`;
}

async function verifyToken(token, secret) {
  try {
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const key = await hmacKey(secret);
    const sigBytes = Uint8Array.from(b64urlDecodeToString(sig), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, utf8Encode(body));
    if (!valid) return null;
    const payload = JSON.parse(b64urlDecodeToString(body));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

async function mintAccessToken(userId, email, env) {
  return signToken({ sub: userId, email, type: 'access', exp: Date.now() + 60 * 60 * 1000 }, env.JWT_SECRET); // 1h
}
async function mintRefreshToken(userId, email, env) {
  return signToken({ sub: userId, email, type: 'refresh', exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }, env.JWT_SECRET); // 30d
}
async function mintAppToken(userId, email, env) {
  return signToken({ sub: userId, email, type: 'app', exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }, env.JWT_SECRET); // 7d (frontend پیش‌بینی)
}

async function verifyAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload || !payload.sub) return null;
  if (payload.type === 'refresh') return null; // refresh tokens cannot be used to authenticate
  return { userId: payload.sub, email: payload.email };
}

// ============================================================================
// 🗄️ PROFILE STORE (KV) — shared record between both frontends
// ============================================================================
function defaultProfile(userId, email) {
  const username = (email || 'user').split('@')[0];
  return {
    id: userId,
    email: email || '',
    username,
    diamonds: 0,
    avatar_url: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    total_predictions: 0,
    wins: 0,
    won_predictions: 0, // alias kept in sync with `wins` for the predictions frontend
    exact_predictions: 0,
    missions: [],
    sports: [],
    settings: { lang: 'fa', theme: 'dark' },
    last_wheel_spin: null,
  };
}

async function getOrCreateProfile(env, userId, email) {
  let profile = await env.KV_STORE.get(`profile:${userId}`, 'json');
  if (!profile) {
    profile = defaultProfile(userId, email);
    await saveProfile(env, profile);
    await addToUserIndex(env, userId);
  } else {
    // backfill any fields older records might be missing
    profile.settings = profile.settings || { lang: 'fa', theme: 'dark' };
    profile.sports = profile.sports || [];
    profile.missions = profile.missions || [];
    profile.won_predictions = profile.wins || 0;
  }
  return profile;
}

async function saveProfile(env, profile) {
  profile.won_predictions = profile.wins || 0; // keep alias in sync for the prediction frontend
  await env.KV_STORE.put(`profile:${profile.id}`, JSON.stringify(profile));
}

async function addToUserIndex(env, userId) {
  try {
    let index = (await env.KV_STORE.get('users:index', 'json')) || [];
    if (!index.includes(userId)) {
      index.push(userId);
      await env.KV_STORE.put('users:index', JSON.stringify(index));
    }
  } catch (e) { console.warn('addToUserIndex failed', e); }
}

// ============================================================================
// 🔐 SUPABASE HELPERS — used only to send/verify the email OTP
// ============================================================================
async function supabaseSendOTP(env, email) {
  return fetch(`${env.SUPABASE_URL}/auth/v1/otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ email, create_user: true }),
  });
}

async function supabaseVerifyOTP(env, email, token) {
  return fetch(`${env.SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ email, token, type: 'email' }),
  });
}

async function supabaseGetUser(env, accessToken) {
  return fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

// ============================================================================
// 🔐 AUTH HANDLERS
// ============================================================================
async function handleSendOTP(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON body', 400); }
  const { email } = body || {};
  if (!email || !email.includes('@')) return err('Invalid email', 400);

  const resp = await supabaseSendOTP(env, email);
  if (!resp.ok) {
    let msg = 'Failed to send OTP';
    try { msg = (await resp.json()).msg || (await resp.json()).message || msg; } catch {}
    return err(msg, resp.status);
  }
  return json({ success: true, message: 'OTP sent successfully' });
}

async function handleVerifyOTP(request, env, { style }) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON body', 400); }
  const { email, token } = body || {};
  if (!email || !token || String(token).length !== 6) return err('Invalid input', 400);

  const resp = await supabaseVerifyOTP(env, email, token);
  if (!resp.ok) {
    let msg = 'Invalid or expired code';
    try { msg = (await resp.json()).msg || msg; } catch {}
    return err(msg, resp.status || 401);
  }
  const data = await resp.json();
  const user = data.user;
  if (!user || !user.id) return err('Verification failed', 401);

  const profile = await getOrCreateProfile(env, user.id, user.email);

  if (style === 'single') {
    // فرانت پیش‌بینی: یک توکن ۷ روزه
    const appToken = await mintAppToken(user.id, user.email, env);
    await env.KV_STORE.put(`session:${user.id}`, appToken, { expirationTtl: 7 * 24 * 60 * 60 });
    return json({ success: true, token: appToken, user: profile });
  }

  // فرانت پروفایل: جفت access/refresh
  const access_token = await mintAccessToken(user.id, user.email, env);
  const refresh_token = await mintRefreshToken(user.id, user.email, env);
  await env.KV_STORE.put(`session:${user.id}`, refresh_token, { expirationTtl: 30 * 24 * 60 * 60 });
  return json({ success: true, access_token, refresh_token, user, profile });
}

async function handleRefreshToken(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON body', 400); }
  const { refresh_token } = body || {};
  if (!refresh_token) return err('Missing refresh_token', 400);

  const payload = await verifyToken(refresh_token, env.JWT_SECRET);
  if (!payload || payload.type !== 'refresh') return err('Invalid refresh token', 401);

  const stored = await env.KV_STORE.get(`session:${payload.sub}`);
  if (stored && stored !== refresh_token) return err('Refresh token revoked', 401);

  const access_token = await mintAccessToken(payload.sub, payload.email, env);
  const new_refresh = await mintRefreshToken(payload.sub, payload.email, env);
  await env.KV_STORE.put(`session:${payload.sub}`, new_refresh, { expirationTtl: 30 * 24 * 60 * 60 });

  return json({ access_token, refresh_token: new_refresh });
}

async function handleGoogleAuth(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON body', 400); }
  const { access_token } = body || {};
  if (!access_token) return err('Missing access_token', 400);

  const resp = await supabaseGetUser(env, access_token);
  if (!resp.ok) return err('Google auth failed', resp.status || 401);
  const user = await resp.json();
  if (!user || !user.id) return err('Google auth failed', 401);

  const profile = await getOrCreateProfile(env, user.id, user.email);
  if (user.user_metadata?.avatar_url && !profile.avatar_url) {
    profile.avatar_url = user.user_metadata.avatar_url;
    await saveProfile(env, profile);
  }

  const appToken = await mintAppToken(user.id, user.email, env);
  await env.KV_STORE.put(`session:${user.id}`, appToken, { expirationTtl: 7 * 24 * 60 * 60 });

  // در صورتی که فراخوانی از فرانت پروفایل باشد، جفت توکن هم برمی‌گردانیم
  const access = await mintAccessToken(user.id, user.email, env);
  const refresh = await mintRefreshToken(user.id, user.email, env);

  return json({ success: true, token: appToken, access_token: access, refresh_token: refresh, user, profile });
}

async function handleLogout(request, env) {
  const auth = await verifyAuth(request, env);
  if (auth) await env.KV_STORE.delete(`session:${auth.userId}`);
  return json({ success: true, message: 'Logged out' });
}

async function handleSessionCheck(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const profile = await getOrCreateProfile(env, auth.userId, auth.email);
  return json({ authenticated: true, user: { id: auth.userId, email: auth.email }, profile });
}

// ============================================================================
// 👤 PROFILE HANDLERS
// ============================================================================
async function handleGetProfile(request, env, { wrapped }) {
  const auth = await verifyAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const profile = await getOrCreateProfile(env, auth.userId, auth.email);
  return wrapped ? json({ profile }) : json(profile);
}

async function handleUpdateProfile(request, env, { wrapped }) {
  const auth = await verifyAuth(request, env);
  if (!auth) return err('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON body', 400); }

  const profile = await getOrCreateProfile(env, auth.userId, auth.email);

  if (typeof body.username === 'string') {
    if (body.username.trim().length < 3) return err('Username must be at least 3 characters', 400);
    profile.username = body.username.trim();
  }
  if (body.settings && typeof body.settings === 'object') {
    profile.settings = { ...profile.settings, ...body.settings };
  }
  if (Array.isArray(body.sports)) {
    profile.sports = body.sports;
  }
  profile.updated_at = Date.now();

  await saveProfile(env, profile);
  return wrapped ? json({ success: true, profile }) : json({ success: true, ...profile });
}

async function handleUploadAvatar(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return err('Unauthorized', 401);

  let formData;
  try { formData = await request.formData(); } catch { return err('Invalid form data', 400); }
  const file = formData.get('file');
  if (!file || typeof file === 'string') return err('No file provided', 400);
  if (file.size > 5 * 1024 * 1024) return err('File too large (max 5MB)', 400);
  if (!file.type || !file.type.startsWith('image/')) return err('File must be an image', 400);

  let avatarUrl;
  try {
    avatarUrl = await uploadToCloudinary(env, file, `avatars/${auth.userId}`);
  } catch (e) {
    console.error('Cloudinary upload error:', e);
    return err('Failed to upload image', 500);
  }

  const profile = await getOrCreateProfile(env, auth.userId, auth.email);
  profile.avatar_url = avatarUrl;
  profile.updated_at = Date.now();
  await saveProfile(env, profile);

  return json({ success: true, url: avatarUrl, avatar_url: avatarUrl, profile });
}

async function handleDeleteAccount(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  await env.KV_STORE.delete(`profile:${auth.userId}`);
  await env.KV_STORE.delete(`predictions:${auth.userId}`);
  await env.KV_STORE.delete(`session:${auth.userId}`);
  try {
    let index = (await env.KV_STORE.get('users:index', 'json')) || [];
    index = index.filter(id => id !== auth.userId);
    await env.KV_STORE.put('users:index', JSON.stringify(index));
  } catch {}
  return json({ success: true });
}

async function handleGetHistory(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const predictions = (await env.KV_STORE.get(`predictions:${auth.userId}`, 'json')) || {};
  const history = Object.values(predictions).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return json({ history });
}

// ============================================================================
// ☁️ CLOUDINARY — signed upload (no upload_preset required)
// ============================================================================
async function sha1Hex(str) {
  const buf = await crypto.subtle.digest('SHA-1', utf8Encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function uploadToCloudinary(env, file, folder) {
  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
  const signature = await sha1Hex(paramsToSign + env.CLOUDINARY_API_SECRET);

  const form = new FormData();
  form.append('file', file);
  form.append('api_key', env.CLOUDINARY_API_KEY);
  form.append('timestamp', String(timestamp));
  form.append('folder', folder);
  form.append('signature', signature);

  const resp = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/image/upload`, {
    method: 'POST',
    body: form,
  });
  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(errData?.error?.message || 'Cloudinary upload failed');
  }
  const data = await resp.json();
  return data.secure_url;
}

// ============================================================================
// ⚽ FOOTBALL API (API-SPORTS v3) — matches + settlement
// ============================================================================
const FOOTBALL_API_BASE = 'https://v3.football.api-sports.io';
const LOCKED_STATUSES = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'SUSP', 'INT', 'FT', 'AET', 'PEN', 'PST', 'ABD', 'AWD', 'WO', 'CANC']);
const FINAL_STATUSES = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO']);

async function fetchFixturesByDate(env, date) {
  const resp = await fetch(`${FOOTBALL_API_BASE}/fixtures?date=${date}`, {
    headers: { 'x-apisports-key': env.FOOTBALL_API_KEY },
  });
  if (!resp.ok) throw new Error(`Football API error: ${resp.status}`);
  const data = await resp.json();
  return (data.response || []).map(mapFixtureToMatch);
}

async function fetchFixtureById(env, fixtureId) {
  const resp = await fetch(`${FOOTBALL_API_BASE}/fixtures?id=${fixtureId}`, {
    headers: { 'x-apisports-key': env.FOOTBALL_API_KEY },
  });
  if (!resp.ok) throw new Error(`Football API error: ${resp.status}`);
  const data = await resp.json();
  return data.response && data.response[0] ? data.response[0] : null;
}

function mapFixtureToMatch(f) {
  const dt = new Date(f.fixture.date);
  const pad = n => String(n).padStart(2, '0');
  return {
    match_id: String(f.fixture.id),
    match_date: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`,
    match_time: `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`,
    match_status: f.fixture.status?.short || 'NS',
    league_name: f.league?.name || '',
    league_logo: f.league?.logo || '',
    match_hometeam_name: f.teams?.home?.name || '',
    match_awayteam_name: f.teams?.away?.name || '',
    team_home_badge: f.teams?.home?.logo || '',
    team_away_badge: f.teams?.away?.logo || '',
    match_hometeam_score: f.goals?.home,
    match_awayteam_score: f.goals?.away,
  };
}

// ============================================================================
// ⚽ MATCHES & PREDICTIONS HANDLERS
// ============================================================================
async function handleGetMatches(request, env, { ctx }) {
  const auth = await verifyAuth(request, env);
  if (!auth) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];

  const cacheKey = `matches:${date}`;
  const cached = await env.KV_STORE.get(cacheKey, 'json');
  const predictionsMap = (await env.KV_STORE.get(`predictions:${auth.userId}`, 'json')) || {};
  const userPredictions = Object.values(predictionsMap);

  if (cached && Date.now() - cached.timestamp < 60000) {
    return json({ matches: cached.data, predictions: predictionsMap, userPredictions, from_cache: true });
  }

  let matches;
  try {
    matches = await fetchFixturesByDate(env, date);
  } catch (e) {
    console.error('Get Matches Error:', e);
    // اگر کش قدیمی‌تری موجود است، آن را برگردان تا فرانت خالی نماند
    if (cached) return json({ matches: cached.data, predictions: predictionsMap, userPredictions, from_cache: true, stale: true });
    return err('Failed to fetch matches', 502);
  }

  await env.KV_STORE.put(cacheKey, JSON.stringify({ data: matches, timestamp: Date.now() }), { expirationTtl: 300 });

  return json({ matches, predictions: predictionsMap, userPredictions, from_cache: false });
}

async function handleGetPredictions(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const predictions = (await env.KV_STORE.get(`predictions:${auth.userId}`, 'json')) || {};
  return json({ predictions, userPredictions: Object.values(predictions) });
}

async function handleSavePrediction(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return err('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON body', 400); }
  const { matchId, homeTeam, awayTeam, homePred, awayPred } = body || {};
  const matchDate = body.matchDate || body.date || '';

  if (!matchId || homePred === undefined || awayPred === undefined || homePred === '' || awayPred === '') {
    return err('Invalid input', 400);
  }
  const hPred = parseInt(homePred, 10);
  const aPred = parseInt(awayPred, 10);
  if (Number.isNaN(hPred) || Number.isNaN(aPred) || hPred < 0 || aPred < 0) return err('Invalid score', 400);

  const predictions = (await env.KV_STORE.get(`predictions:${auth.userId}`, 'json')) || {};
  if (predictions[matchId]) return err('Prediction already exists for this match', 400);

  predictions[matchId] = {
    match_id: String(matchId),
    match_date: matchDate,
    home_team: homeTeam || '',
    away_team: awayTeam || '',
    home_pred: hPred,
    away_pred: aPred,
    home_score_real: null,
    away_score_real: null,
    status: 'pending',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await env.KV_STORE.put(`predictions:${auth.userId}`, JSON.stringify(predictions));

  const profile = await getOrCreateProfile(env, auth.userId, auth.email);
  profile.total_predictions = (profile.total_predictions || 0) + 1;
  profile.updated_at = Date.now();
  await saveProfile(env, profile);

  return json({ success: true, prediction: predictions[matchId], total: Object.keys(predictions).length });
}

async function handleSettlePredictions(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return err('Unauthorized', 401);

  const predictions = (await env.KV_STORE.get(`predictions:${auth.userId}`, 'json')) || {};
  const pendingIds = Object.keys(predictions).filter(id => predictions[id].status === 'pending');
  if (pendingIds.length === 0) return json({ success: true, settled: [], total_pending: 0 });

  const settled = [];
  const profile = await getOrCreateProfile(env, auth.userId, auth.email);
  let profileChanged = false;

  for (const matchId of pendingIds) {
    const pred = predictions[matchId];
    try {
      const fixture = await fetchFixtureById(env, matchId);
      if (!fixture) continue;
      const status = fixture.fixture?.status?.short || '';
      if (!FINAL_STATUSES.has(status)) continue;

      const homeScore = fixture.goals?.home;
      const awayScore = fixture.goals?.away;
      if (homeScore === null || homeScore === undefined || awayScore === null || awayScore === undefined) continue;

      pred.home_score_real = homeScore;
      pred.away_score_real = awayScore;

      let points = 0;
      let statusType = 'lost';
      if (pred.home_pred === homeScore && pred.away_pred === awayScore) {
        points = 5; statusType = 'exact';
      } else if (
        (pred.home_pred > pred.away_pred && homeScore > awayScore) ||
        (pred.home_pred < pred.away_pred && homeScore < awayScore) ||
        (pred.home_pred === pred.away_pred && homeScore === awayScore)
      ) {
        points = 4; statusType = 'winner';
      }

      pred.status = statusType;
      pred.points_earned = points;
      pred.settled_at = Date.now();

      if (points > 0) {
        profile.diamonds = (profile.diamonds || 0) + points;
        profile.wins = (profile.wins || 0) + 1;
        if (statusType === 'exact') profile.exact_predictions = (profile.exact_predictions || 0) + 1;
        profileChanged = true;
      }

      settled.push({ matchId, status: statusType, points });
    } catch (e) {
      console.error(`Settle match ${matchId} error:`, e);
    }
  }

  await env.KV_STORE.put(`predictions:${auth.userId}`, JSON.stringify(predictions));
  if (profileChanged) {
    profile.updated_at = Date.now();
    await saveProfile(env, profile);
  }

  const total_pending = Object.values(predictions).filter(p => p.status === 'pending').length;
  return json({ success: true, settled, total_pending });
}

// ============================================================================
// 🏆 LEADERBOARD — از روی ایندکس کاربران در KV (بدون نیاز به Postgres)
// ============================================================================
async function handleGetLeaderboard(request, env) {
  const cacheKey = 'leaderboard:top20';
  const cached = await env.KV_STORE.get(cacheKey, 'json');
  if (cached && Date.now() - cached.timestamp < 30000) {
    return json({ leaderboard: cached.data, from_cache: true });
  }

  const index = (await env.KV_STORE.get('users:index', 'json')) || [];
  const profiles = await Promise.all(index.map(id => env.KV_STORE.get(`profile:${id}`, 'json')));
  const leaderboard = profiles
    .filter(Boolean)
    .sort((a, b) => (b.diamonds || 0) - (a.diamonds || 0))
    .slice(0, 20)
    .map(p => ({ username: p.username, diamonds: p.diamonds || 0, avatar_url: p.avatar_url || null }));

  await env.KV_STORE.put(cacheKey, JSON.stringify({ data: leaderboard, timestamp: Date.now() }), { expirationTtl: 60 });
  return json({ leaderboard, from_cache: false });
}

// ============================================================================
// 🎯 MISSIONS
// ============================================================================
const MISSION_DEFINITIONS = {
  welcome: { name: 'اولین ورود', reward: 5, icon: 'fa-star', color: 'indigo' },
  first_pred: { name: 'اولین پیش‌بینی', reward: 10, icon: 'fa-futbol', color: 'blue' },
  master_pred: { name: 'استاد پیش‌بینی', reward: 20, icon: 'fa-trophy', color: 'purple' },
};

async function computeMissionEligibility(env, profile) {
  const predictions = (await env.KV_STORE.get(`predictions:${profile.id}`, 'json')) || {};
  return {
    welcome: true,
    first_pred: Object.keys(predictions).length > 0,
    master_pred: (profile.wins || 0) >= 3,
  };
}

async function handleGetMissions(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const profile = await getOrCreateProfile(env, auth.userId, auth.email);
  const claimed = profile.missions || [];
  const eligibility = await computeMissionEligibility(env, profile);

  // پاسخ سازگار با هر دو فرانت: هم claimed/eligibility مسطح، هم missions تفصیلی
  const missions = {
    welcome: { claimed: claimed.includes('welcome'), available: eligibility.welcome },
    first_pred: { claimed: claimed.includes('first_pred'), available: eligibility.first_pred },
    master_pred: { claimed: claimed.includes('master_pred'), available: eligibility.master_pred },
  };

  return json({ claimed, eligibility, missions, definitions: MISSION_DEFINITIONS });
}

async function handleClaimMission(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return err('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON body', 400); }
  const { missionId } = body || {};
  if (!missionId || !MISSION_DEFINITIONS[missionId]) return err('Invalid mission', 400);

  const profile = await getOrCreateProfile(env, auth.userId, auth.email);
  const claimed = profile.missions || [];
  if (claimed.includes(missionId)) return err('Mission already claimed', 400);

  const eligibility = await computeMissionEligibility(env, profile);
  if (!eligibility[missionId]) return err('Mission requirements not met', 400);

  const reward = MISSION_DEFINITIONS[missionId].reward;
  profile.missions = [...claimed, missionId];
  profile.diamonds = (profile.diamonds || 0) + reward;
  profile.updated_at = Date.now();
  await saveProfile(env, profile);

  return json({ success: true, reward, diamonds: profile.diamonds });
}

// ============================================================================
// 🎡 WHEEL OF FORTUNE — ۸ خانه، مطابق طراحی رنگی چرخ در فرانت
// ============================================================================
// ترتیب رنگ‌ها در CSS چرخ: [خاکستری, آبی, خاکستری, بنفش, خاکستری, آبی, خاکستری, طلایی]
const WHEEL_PRIZES = [0, 1, 0, 2, 0, 1, 0, 5];
const WHEEL_WEIGHTS = [24, 12, 24, 6, 24, 12, 24, 4]; // مجموع = 130؛ صفرها ~74%، تقریباً منطبق با طرح اصلی

function pickWeightedSegmentIndex() {
  const total = WHEEL_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < WHEEL_WEIGHTS.length; i++) {
    if (r < WHEEL_WEIGHTS[i]) return i;
    r -= WHEEL_WEIGHTS[i];
  }
  return 0;
}

async function handleWheelSpin(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return err('Unauthorized', 401);

  const profile = await getOrCreateProfile(env, auth.userId, auth.email);
  const today = new Date().toISOString().split('T')[0];
  if (profile.last_wheel_spin === today) return err('Daily spin limit reached', 400);

  const segmentIndex = pickWeightedSegmentIndex();
  const prize = WHEEL_PRIZES[segmentIndex];

  profile.diamonds = (profile.diamonds || 0) + prize;
  profile.last_wheel_spin = today;
  profile.updated_at = Date.now();
  await saveProfile(env, profile);

  return json({
    success: true,
    segmentIndex,
    prize,
    diamonds: profile.diamonds,
    message: prize > 0 ? `${prize} الماس بردید! 🎉` : 'متاسفانه پوچ شد! 😔',
  });
}

// ============================================================================
// 🛠️ ADMIN
// ============================================================================
async function handleClearCache(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth || auth.email !== env.ADMIN_EMAIL) return err('Unauthorized', 401);

  const list = await env.KV_STORE.list({ prefix: 'matches:' });
  for (const key of list.keys) await env.KV_STORE.delete(key.name);
  await env.KV_STORE.delete('leaderboard:top20');

  return json({ success: true, cleared: list.keys.length });
}
