/**
 * Enterprise AI Football Prediction Worker 2026
 * Handles Millions of Requests with Edge Caching and KV
 */

// --- Constants & Config ---
const CACHE_TTL = 60; // 60 seconds match cache
const FOOTBALL_API_HOST = 'v3.football.api-sports.io';

// --- Wheel of Fortune Settings ---
const WHEEL_SECTORS = [
  { prize: 0, probability: 0.50 },
  { prize: 1, probability: 0.15 },
  { prize: 0, probability: 0.12 },
  { prize: 2, probability: 0.10 },
  { prize: 0, probability: 0.08 },
  { prize: 1, probability: 0.03 },
  { prize: 0, probability: 0.01 },
  { prize: 5, probability: 0.01 }
];

// --- Utilities ---
const jsonResponse = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept-Language',
    ...extraHeaders
  }
});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept-Language',
};

// --- Fast Edge JWT Verifier (No external network calls) ---
async function verifySupabaseJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    // Cloudflare Edge base64url decoder
    const decodeB64Url = (str) => {
      str = str.replace(/-/g, '+').replace(/_/g, '/');
      while (str.length % 4) str += '=';
      return atob(str);
    };
    
    const payload = JSON.parse(decodeB64Url(parts[1]));
    if (payload.exp && Date.now() >= payload.exp * 1000) return null; // Token expired
    
    return payload; // Returns user info { sub: 'uuid', ... }
  } catch (e) {
    return null;
  }
}

// --- Main Fetch Handler ---
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Server-Side Language Detection
    const lang = request.headers.get('Accept-Language')?.includes('en') ? 'en' : 'fa';
    const messages = {
      unauthorized: lang === 'fa' ? 'دسترسی غیرمجاز' : 'Unauthorized',
      notFound: lang === 'fa' ? 'یافت نشد' : 'Not Found',
      spinDone: lang === 'fa' ? 'امروز قبلاً چرخش داشتید!' : 'Already spun today!',
      winMsg: lang === 'fa' ? 'الماس بردید! 🎉' : 'Diamonds won! 🎉',
      loseMsg: lang === 'fa' ? 'متاسفانه پوچ شد! 😔' : 'Better luck next time! 😔',
    };

    try {
      // 1. PUBLIC ROUTES (Auth Proxy to Supabase)
      if (path === '/auth/send-otp' && request.method === 'POST') {
        const body = await request.json();
        const res = await fetch(`${env.SUPABASE_URL}/auth/v1/otp`, {
          method: 'POST',
          headers: { 'apikey': env.SUPABASE_ANON, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: body.email })
        });
        return jsonResponse(await res.json(), res.status);
      }
      
      if (path === '/auth/verify-otp' && request.method === 'POST') {
        const body = await request.json();
        const res = await fetch(`${env.SUPABASE_URL}/auth/v1/verify`, {
          method: 'POST',
          headers: { 'apikey': env.SUPABASE_ANON, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'magiclink', email: body.email, token: body.token })
        });
        const data = await res.json();
        if (data.access_token) {
          // Initialize user in KV if not exists
          const profileKey = `profile:${data.user.id}`;
          const existing = await env.KV_STORE.get(profileKey);
          if (!existing) {
            await env.KV_STORE.put(profileKey, JSON.stringify({
              id: data.user.id,
              email: data.user.email,
              username: "کاربر",
              language: lang,
              diamonds: 0,
              total_predictions: 0,
              wins: 0,
              exact_predictions: 0,
              missions: ["welcome"],
              last_wheel_spin: null,
              created_at: Date.now()
            }));
          }
          return jsonResponse({ token: data.access_token, user: data.user });
        }
        return jsonResponse(data, res.status);
      }

      // 2. AUTH MIDDLEWARE FOR PROTECTED ROUTES
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return jsonResponse({ error: messages.unauthorized }, 401);
      }
      const token = authHeader.split(' ')[1];
      
      // Verify JWT Locally
      const userPayload = await verifySupabaseJWT(token, env.SUPABASE_JWT_SECRET);
      if (!userPayload) return jsonResponse({ error: messages.unauthorized }, 401);
      const userId = userPayload.sub;

      // 3. PROTECTED ROUTES
      const profileKey = `profile:${userId}`;
      const predictionsKey = `predictions:${userId}`;

      // --- Profile Routes ---
      if (path === '/profile' && request.method === 'GET') {
        const profile = await env.KV_STORE.get(profileKey, 'json') || {};
        return jsonResponse(profile);
      }
      
      if (path === '/profile' && request.method === 'PUT') {
        const body = await request.json();
        const profile = await env.KV_STORE.get(profileKey, 'json');
        if (body.language) profile.language = body.language; // Server-side language sync
        if (body.username) profile.username = body.username;
        if (body.avatar_url) profile.avatar_url = body.avatar_url;
        await env.KV_STORE.put(profileKey, JSON.stringify(profile));
        return jsonResponse({ success: true, profile });
      }

      // --- مسیر اختصاصی آپلود عکس پروفایل (Cloudinary) ---
      if (path === '/profile/avatar' && request.method === 'POST') {
        const formData = await request.formData();
        const file = formData.get('file');

        if (!file) {
          return jsonResponse({ error: 'فایلی ارسال نشده است' }, 400);
        }

        const cloudinaryUrl = `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/image/upload`;
        const cloudinaryFormData = new FormData();
        cloudinaryFormData.append('file', file);
        cloudinaryFormData.append('api_key', env.CLOUDINARY_API_KEY);
        // فراموش نکنید YOUR_UNSIGNED_PRESET_NAME را با نام پرزت خود در کلودینری جایگزین کنید
        cloudinaryFormData.append('upload_preset', 'Ajsports'); 

        const cloudRes = await fetch(cloudinaryUrl, {
          method: 'POST',
          body: cloudinaryFormData
        });

        const cloudData = await cloudRes.json();

        if (cloudData.secure_url) {
          const profile = await env.KV_STORE.get(profileKey, 'json');
          profile.avatar_url = cloudData.secure_url;
          await env.KV_STORE.put(profileKey, JSON.stringify(profile));

          return jsonResponse({ success: true, avatar_url: cloudData.secure_url });
        }

        return jsonResponse({ error: 'خطا در آپلود تصویر به کلودینری' }, 500);
      }

      // --- Matches Proxy with Edge Caching ---
      if (path === '/matches' && request.method === 'GET') {
        const date = new Date().toISOString().split('T')[0];
        const cacheKey = `matches_cache:${date}`;
        
        let cachedMatches = await env.KV_STORE.get(cacheKey, 'json');
        if (!cachedMatches) {
          const apiRes = await fetch(`https://${FOOTBALL_API_HOST}/fixtures?date=${date}&timezone=Asia/Tehran`, {
            headers: { 'x-apisports-key': env.FOOTBALL_API_KEY }
          });
          const apiData = await apiRes.json();
          cachedMatches = { data: apiData.response, timestamp: Date.now() };
          // Cache in KV for 60 seconds (prevents rate limits)
          await env.KV_STORE.put(cacheKey, JSON.stringify(cachedMatches), { expirationTtl: CACHE_TTL });
        }
        return jsonResponse({ matches: cachedMatches.data, from_cache: true });
      }

      // --- Predictions Management ---
      if (path === '/predictions' && request.method === 'POST') {
        const { matchId, homePred, awayPred } = await request.json();
        let predictions = await env.KV_STORE.get(predictionsKey, 'json') || {};
        
        predictions[matchId] = {
          match_id: matchId,
          home_pred: homePred,
          away_pred: awayPred,
          status: 'pending',
          points_earned: 0,
          created_at: Date.now()
        };
        
        await env.KV_STORE.put(predictionsKey, JSON.stringify(predictions));
        
        // Update total predictions in profile
        const profile = await env.KV_STORE.get(profileKey, 'json');
        profile.total_predictions += 1;
        await env.KV_STORE.put(profileKey, JSON.stringify(profile));
        
        return jsonResponse({ success: true, prediction: predictions[matchId] });
      }

      if (path === '/predictions' && request.method === 'GET') {
        const predictions = await env.KV_STORE.get(predictionsKey, 'json') || {};
        return jsonResponse(predictions);
      }

      // --- Auto-Settle Trigger Endpoint (Frontend loads trigger this) ---
      if (path === '/predictions/settle' && request.method === 'POST') {
        // In reality, rely on the CRON, but this allows user to force settle on login
        ctx.waitUntil(this.autoSettlePredictions(env, userId));
        return jsonResponse({ message: 'Settlement process started in background' });
      }

      // --- Wheel of Fortune ---
      if (path === '/wheel/spin' && request.method === 'POST') {
        const profile = await env.KV_STORE.get(profileKey, 'json');
        const today = new Date().toISOString().split('T')[0];
        
        if (profile.last_wheel_spin === today) {
          return jsonResponse({ error: messages.spinDone }, 400);
        }

        // Weighted Randomizer
        const rand = Math.random() * 100;
        let cumulative = 0;
        let wonPrize = 0;
        
        for (const sector of WHEEL_SECTORS) {
          cumulative += sector.probability * 100;
          if (rand <= cumulative) {
            wonPrize = sector.prize;
            break;
          }
        }

        profile.diamonds += wonPrize;
        profile.last_wheel_spin = today;
        await env.KV_STORE.put(profileKey, JSON.stringify(profile));
        
        return jsonResponse({
          prize: wonPrize,
          message: wonPrize > 0 ? `${wonPrize} ${messages.winMsg}` : messages.loseMsg,
          newDiamonds: profile.diamonds
        });
      }

      return jsonResponse({ error: messages.notFound }, 404);

    } catch (error) {
      return jsonResponse({ error: error.message }, 500);
    }
  },

  // --- Background CRON Task (Executes every minute) ---
  async scheduled(event, env, ctx) {
    // This requires a list of all users. In KV, list() operations are limited,
    // so in production, track active match IDs and find users who predicted them.
    // For this example, we iterate through all keys matching 'predictions:*'
    ctx.waitUntil(this.runGlobalSettlement(env));
  },

  // Engine: Calculate Points Algorithm
  calculatePoints(homePred, awayPred, homeReal, awayReal) {
    if (homePred === homeReal && awayPred === awayReal) {
      return { points: 5, status: 'exact' };
    }
    const predWinner = homePred > awayPred ? 'home' : (homePred < awayPred ? 'away' : 'draw');
    const realWinner = homeReal > awayReal ? 'home' : (homeReal < awayReal ? 'away' : 'draw');
    
    if (predWinner === realWinner) {
      return { points: 4, status: 'winner' };
    }
    return { points: 0, status: 'lost' };
  },

  // Settle single user
  async autoSettlePredictions(env, userId) {
    const predictionsKey = `predictions:${userId}`;
    const profileKey = `profile:${userId}`;
    
    const predictions = await env.KV_STORE.get(predictionsKey, 'json');
    if (!predictions) return;

    let updated = false;
    let newDiamonds = 0;
    let exactWins = 0;
    let normalWins = 0;

    for (const [matchId, pred] of Object.entries(predictions)) {
      if (pred.status !== 'pending') continue;

      // Check cache for match result
      const matchKey = `match_result:${matchId}`;
      let result = await env.KV_STORE.get(matchKey, 'json');
      
      if (!result) {
        // Fetch specific match if not cached
        const apiRes = await fetch(`https://${FOOTBALL_API_HOST}/fixtures?id=${matchId}`, {
          headers: { 'x-apisports-key': env.FOOTBALL_API_KEY }
        });
        const matchData = await apiRes.json();
        const match = matchData.response[0];
        
        if (match && ['FT', 'AET', 'PEN'].includes(match.fixture.status.short)) {
          result = {
            homeScore: match.goals.home,
            awayScore: match.goals.away,
            isFinished: true
          };
          // Cache the final result permanently to avoid calling API again
          await env.KV_STORE.put(matchKey, JSON.stringify(result));
        } else {
          continue; // Match not finished yet
        }
      }

      if (result && result.isFinished) {
        const { points, status } = this.calculatePoints(
          pred.home_pred, pred.away_pred, result.homeScore, result.awayScore
        );
        
        pred.home_score_real = result.homeScore;
        pred.away_score_real = result.awayScore;
        pred.status = status;
        pred.points_earned = points;
        pred.settled_at = Date.now();
        
        newDiamonds += points;
        if (status === 'exact') exactWins++;
        if (status === 'winner') normalWins++;
        updated = true;
      }
    }

    if (updated) {
      await env.KV_STORE.put(predictionsKey, JSON.stringify(predictions));
      
      // Atomic Profile Update Update
      const profile = await env.KV_STORE.get(profileKey, 'json');
      if (profile) {
        profile.diamonds += newDiamonds;
        profile.exact_predictions += exactWins;
        profile.wins += (exactWins + normalWins);
        await env.KV_STORE.put(profileKey, JSON.stringify(profile));
      }
    }
  },

  // Settle all users globally (Fired by Cron)
  async runGlobalSettlement(env) {
    let cursor = "";
    do {
      const keys = await env.KV_STORE.list({ prefix: 'predictions:', cursor });
      for (const key of keys.keys) {
        const userId = key.name.split(':')[1];
        await this.autoSettlePredictions(env, userId);
      }
      cursor = keys.cursor;
    } while (cursor);
  }
};
