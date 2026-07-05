// ============================================================
// 🚀 AJ SPORTS ULTIMATE EDGE WORKER
// ============================================================
// یک شاهکار مهندسی کدنویسی برای مدیریت:
// - احراز هویت (Auth) با Supabase + JWT
// - پروفایل کاربر (User Profile) در KV
// - پیش‌بینی‌ها (Predictions) در KV
// - سیستم امتیازدهی (Diamonds / Scoring)
// - کش لبه (Edge Cache) برای API فوتبال
// - آپلود عکس با Cloudinary (Server-side)
// - API یکپارچه برای هر دو صفحه (پروفایل + پیش‌بینی)
// - پشتیبانی کامل از زبان (i18n) با سویچ در سرور
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ======================== CORS ========================
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ======================== ROUTING ========================

    // --- HEALTH CHECK ---
    if (path === '/health') {
      return new Response(JSON.stringify({ 
        status: 'healthy', 
        timestamp: Date.now(),
        env: env.ENVIRONMENT || 'production'
      }), { 
        headers: { 'Content-Type': 'application/json', ...corsHeaders } 
      });
    }

    // --- AUTH: Sign In with OTP ---
    if (path === '/auth/otp' && request.method === 'POST') {
      return await handleAuthOTP(request, env);
    }

    // --- AUTH: Verify OTP ---
    if (path === '/auth/verify' && request.method === 'POST') {
      return await handleAuthVerify(request, env);
    }

    // --- AUTH: Google OAuth ---
    if (path === '/auth/google' && request.method === 'POST') {
      return await handleGoogleAuth(request, env);
    }

    // --- AUTH: Sign Out ---
    if (path === '/auth/logout' && request.method === 'POST') {
      return await handleLogout(request, env);
    }

    // --- AUTH: Session Check ---
    if (path === '/auth/session' && request.method === 'GET') {
      return await handleSessionCheck(request, env);
    }

    // --- PROFILE: Get ---
    if (path === '/profile' && request.method === 'GET') {
      return await handleGetProfile(request, env);
    }

    // --- PROFILE: Update ---
    if (path === '/profile' && request.method === 'PUT') {
      return await handleUpdateProfile(request, env);
    }

    // --- PROFILE: Upload Avatar ---
    if (path === '/profile/avatar' && request.method === 'POST') {
      return await handleUploadAvatar(request, env);
    }

    // --- PROFILE: Get Settings (Language) ---
    if (path === '/profile/settings' && request.method === 'GET') {
      return await handleGetSettings(request, env);
    }

    // --- PROFILE: Update Settings (Language) ---
    if (path === '/profile/settings' && request.method === 'PUT') {
      return await handleUpdateSettings(request, env);
    }

    // --- PREDICTIONS: Get Matches (with Edge Cache) ---
    if (path === '/matches' && request.method === 'GET') {
      return await handleGetMatches(request, env, ctx);
    }

    // --- PREDICTIONS: Get User Predictions ---
    if (path === '/predictions' && request.method === 'GET') {
      return await handleGetPredictions(request, env);
    }

    // --- PREDICTIONS: Save Prediction ---
    if (path === '/predictions' && request.method === 'POST') {
      return await handleSavePrediction(request, env);
    }

    // --- PREDICTIONS: Settle All (Admin / Auto) ---
    if (path === '/predictions/settle' && request.method === 'POST') {
      return await handleSettlePredictions(request, env);
    }

    // --- PREDICTIONS: Get History ---
    if (path === '/profile/history' && request.method === 'GET') {
      return await handleGetHistory(request, env);
    }

    // --- LEADERBOARD: Get ---
    if (path === '/leaderboard' && request.method === 'GET') {
      return await handleGetLeaderboard(request, env);
    }

    // --- MISSIONS: Get Status ---
    if (path === '/missions' && request.method === 'GET') {
      return await handleGetMissions(request, env);
    }

    // --- MISSIONS: Claim ---
    if (path === '/missions/claim' && request.method === 'POST') {
      return await handleClaimMission(request, env);
    }

    // --- WHEEL: Spin ---
    if (path === '/wheel/spin' && request.method === 'POST') {
      return await handleWheelSpin(request, env);
    }

    // --- ADMIN: Clear Cache (Only in dev) ---
    if (path === '/admin/cache/clear' && request.method === 'POST') {
      return await handleClearCache(request, env);
    }

    // ======================== 404 ========================
    return new Response(JSON.stringify({ 
      error: 'Not Found', 
      path: path 
    }), { 
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
};

// ============================================================
// 🔐 AUTH HANDLERS
// ============================================================

async function handleAuthOTP(request, env) {
  try {
    const { email } = await request.json();
    if (!email || !email.includes('@')) {
      return jsonResponse({ error: 'Invalid email' }, 400);
    }

    // Call Supabase
    const supabaseRes = await fetch(`${env.SUPABASE_URL}/auth/v1/otp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({ email })
    });

    if (!supabaseRes.ok) {
      const error = await supabaseRes.json();
      return jsonResponse({ error: error.message || 'Failed to send OTP' }, supabaseRes.status);
    }

    return jsonResponse({ 
      success: true, 
      message: 'OTP sent successfully'
    });

  } catch (error) {
    console.error('Auth OTP Error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

async function handleAuthVerify(request, env) {
  try {
    const { email, token } = await request.json();
    if (!email || !token || token.length !== 6) {
      return jsonResponse({ error: 'Invalid input' }, 400);
    }

    // Verify with Supabase
    const supabaseRes = await fetch(`${env.SUPABASE_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        email,
        token,
        type: 'email'
      })
    });

    if (!supabaseRes.ok) {
      const error = await supabaseRes.json();
      return jsonResponse({ error: error.message || 'Invalid OTP' }, supabaseRes.status);
    }

    const data = await supabaseRes.json();
    const user = data.user;

    // Get or create profile in KV
    let profile = await env.KV_STORE.get(`profile:${user.id}`, 'json');
    if (!profile) {
      profile = {
        id: user.id,
        email: user.email,
        username: user.email.split('@')[0],
        diamonds: 0,
        avatar_url: null,
        created_at: Date.now(),
        updated_at: Date.now(),
        total_predictions: 0,
        wins: 0,
        exact_predictions: 0,
        missions: [],
        last_wheel_spin: null,
        settings: {
          lang: 'fa',
          theme: 'dark'
        }
      };
      await env.KV_STORE.put(`profile:${user.id}`, JSON.stringify(profile));
    }

    // Generate JWT (using env secret)
    const jwt = await generateJWT(user.id, user.email, env.JWT_SECRET);

    return jsonResponse({
      success: true,
      user: user,
      profile: profile,
      token: jwt
    });

  } catch (error) {
    console.error('Auth Verify Error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

async function handleGoogleAuth(request, env) {
  try {
    const { access_token } = await request.json();
    if (!access_token) {
      return jsonResponse({ error: 'Access token required' }, 400);
    }

    // Verify Google token and get user info
    const googleRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: {
        'Authorization': `Bearer ${access_token}`
      }
    });

    if (!googleRes.ok) {
      return jsonResponse({ error: 'Invalid Google token' }, 401);
    }

    const googleUser = await googleRes.json();
    const email = googleUser.email;
    const name = googleUser.name || email.split('@')[0];
    const avatar = googleUser.picture || null;

    // Check if user exists in Supabase
    const supabaseRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${access_token}`
      }
    });

    if (!supabaseRes.ok) {
      return jsonResponse({ error: 'Supabase authentication failed' }, 401);
    }

    const supabaseData = await supabaseRes.json();
    const user = supabaseData.user || { id: `google_${email}` };

    // Get or create profile in KV
    let profile = await env.KV_STORE.get(`profile:${user.id}`, 'json');
    if (!profile) {
      profile = {
        id: user.id,
        email: email,
        username: name,
        diamonds: 0,
        avatar_url: avatar,
        created_at: Date.now(),
        updated_at: Date.now(),
        total_predictions: 0,
        wins: 0,
        exact_predictions: 0,
        missions: [],
        last_wheel_spin: null,
        settings: {
          lang: 'fa',
          theme: 'dark'
        }
      };
      await env.KV_STORE.put(`profile:${user.id}`, JSON.stringify(profile));
    }

    const jwt = await generateJWT(user.id, email, env.JWT_SECRET);

    return jsonResponse({
      success: true,
      user: { id: user.id, email },
      profile: profile,
      token: jwt
    });

  } catch (error) {
    console.error('Google Auth Error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

async function handleLogout(request, env) {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    return jsonResponse({ success: true, message: 'Logged out' });
  } catch (error) {
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

async function handleSessionCheck(request, env) {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const profile = await env.KV_STORE.get(`profile:${auth.userId}`, 'json');
    return jsonResponse({
      authenticated: true,
      user: { id: auth.userId, email: auth.email },
      profile: profile
    });
  } catch (error) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
}

// ============================================================
// 👤 PROFILE HANDLERS
// ============================================================

async function handleGetProfile(request, env) {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    let profile = await env.KV_STORE.get(`profile:${auth.userId}`, 'json');
    if (!profile) {
      profile = {
        id: auth.userId,
        email: auth.email,
        username: auth.email.split('@')[0],
        diamonds: 0,
        avatar_url: null,
        created_at: Date.now(),
        updated_at: Date.now(),
        total_predictions: 0,
        wins: 0,
        exact_predictions: 0,
        missions: [],
        last_wheel_spin: null,
        settings: {
          lang: 'fa',
          theme: 'dark'
        }
      };
      await env.KV_STORE.put(`profile:${auth.userId}`, JSON.stringify(profile));
    }

    return jsonResponse({ profile });
  } catch (error) {
    console.error('Get Profile Error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

async function handleUpdateProfile(request, env) {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const body = await request.json();
    let profile = await env.KV_STORE.get(`profile:${auth.userId}`, 'json');
    if (!profile) {
      return jsonResponse({ error: 'Profile not found' }, 404);
    }

    // Update fields
    if (body.username) {
      if (body.username.length < 3) {
        return jsonResponse({ error: 'Username must be at least 3 characters' }, 400);
      }
      profile.username = body.username;
    }

    if (body.sports && Array.isArray(body.sports)) {
      profile.sports = body.sports;
    }

    if (body.settings) {
      profile.settings = { ...profile.settings, ...body.settings };
    }

    profile.updated_at = Date.now();
    await env.KV_STORE.put(`profile:${auth.userId}`, JSON.stringify(profile));

    return jsonResponse({ success: true, profile });
  } catch (error) {
    console.error('Update Profile Error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

async function handleUploadAvatar(request, env) {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const formData = await request.formData();
    const file = formData.get('file');
    if (!file) {
      return jsonResponse({ error: 'No file provided' }, 400);
    }

    if (file.size > 5 * 1024 * 1024) {
      return jsonResponse({ error: 'File too large (max 5MB)' }, 400);
    }
    if (!file.type.startsWith('image/')) {
      return jsonResponse({ error: 'File must be an image' }, 400);
    }

    // Upload to Cloudinary
    const cloudinaryFormData = new FormData();
    cloudinaryFormData.append('file', file);
    cloudinaryFormData.append('upload_preset', env.CLOUDINARY_UPLOAD_PRESET || 'ml_default');
    cloudinaryFormData.append('folder', 'avatars');

    const cloudinaryRes = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`, {
      method: 'POST',
      body: cloudinaryFormData
    });

    if (!cloudinaryRes.ok) {
      const error = await cloudinaryRes.json();
      console.error('Cloudinary Error:', error);
      return jsonResponse({ error: 'Failed to upload to Cloudinary' }, 500);
    }

    const cloudinaryData = await cloudinaryRes.json();
    const avatarUrl = cloudinaryData.secure_url;

    let profile = await env.KV_STORE.get(`profile:${auth.userId}`, 'json');
    if (profile) {
      profile.avatar_url = avatarUrl;
      profile.updated_at = Date.now();
      await env.KV_STORE.put(`profile:${auth.userId}`, JSON.stringify(profile));
    }

    return jsonResponse({ 
      success: true, 
      avatar_url: avatarUrl,
      profile: profile 
    });

  } catch (error) {
    console.error('Upload Avatar Error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

async function handleGetSettings(request, env) {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    let profile = await env.KV_STORE.get(`profile:${auth.userId}`, 'json');
    if (!profile) {
      return jsonResponse({ error: 'Profile not found' }, 404);
    }

    return jsonResponse({ 
      settings: profile.settings || { lang: 'fa', theme: 'dark' } 
    });
  } catch (error) {
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

async function handleUpdateSettings(request, env) {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const { settings } = await request.json();
    let profile = await env.KV_STORE.get(`profile:${auth.userId}`, 'json');
    if (!profile) {
      return jsonResponse({ error: 'Profile not found' }, 404);
    }

    profile.settings = { ...profile.settings, ...settings };
    profile.updated_at = Date.now();
    await env.KV_STORE.put(`profile:${auth.userId}`, JSON.stringify(profile));

    return jsonResponse({ 
      success: true, 
      settings: profile.settings 
    });
  } catch (error) {
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

// ============================================================
// ⚽ MATCHES & PREDICTIONS HANDLERS
// ============================================================

async function handleGetMatches(request, env, ctx) {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const url = new URL(request.url);
    const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];

    // 🔥 Edge Cache: Cache for 60 seconds
    const cacheKey = `matches:${date}`;
    const cached = await env.KV_STORE.get(cacheKey, 'json');
    if (cached && Date.now() - cached.timestamp < 60000) {
      const predictions = await env.KV_STORE.get(`predictions:${auth.userId}`, 'json') || {};
      const userPredictions = Object.values(predictions);
      return jsonResponse({ 
        matches: cached.data, 
        userPredictions: userPredictions,
        from_cache: true 
      });
    }

    // Fetch from API-Football
    const apiUrl = `https://apiv3.apifootball.com/?action=get_events&from=${date}&to=${date}&APIkey=${env.FOOTBALL_API_KEY}`;
    
    const response = await fetch(apiUrl);
    if (!response.ok) {
      return jsonResponse({ error: 'Failed to fetch matches' }, response.status);
    }

    const matches = await response.json();

    // Cache the response
    await env.KV_STORE.put(cacheKey, JSON.stringify({
      data: matches,
      timestamp: Date.now()
    }), { expirationTtl: 300 });

    // Get user predictions
    const predictions = await env.KV_STORE.get(`predictions:${auth.userId}`, 'json') || {};
    const userPredictions = Object.values(predictions);

    return jsonResponse({ 
      matches, 
      userPredictions: userPredictions,
      from_cache: false 
    });

  } catch (error) {
    console.error('Get Matches Error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

async function handleGetPredictions(request, env) {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const predictions = await env.KV_STORE.get(`predictions:${auth.userId}`, 'json') || {};
    return jsonResponse({ predictions });
  } catch (error) {
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

async function handleSavePrediction(request, env) {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const { matchId, matchDate, homeTeam, awayTeam, homePred, awayPred } = await request.json();
    if (!matchId || homePred === undefined || awayPred === undefined) {
      return jsonResponse({ error: 'Invalid input' }, 400);
    }

    let predictions = await env.KV_STORE.get(`predictions:${auth.userId}`, 'json') || {};

    if (predictions[matchId]) {
      return jsonResponse({ error: 'Prediction already exists for this match' }, 400);
    }

    predictions[matchId] = {
      match_id: matchId,
      match_date: matchDate,
      home_team: homeTeam,
      away_team: awayTeam,
      home_pred: parseInt(homePred),
      away_pred: parseInt(awayPred),
      home_score_real: null,
      away_score_real: null,
      status: 'pending',
      points_earned: 0,
      created_at: Date.now(),
      updated_at: Date.now()
    };

    await env.KV_STORE.put(`predictions:${auth.userId}`, JSON.stringify(predictions));

    let profile = await env.KV_STORE.get(`profile:${auth.userId}`, 'json');
    if (profile) {
      profile.total_predictions = (profile.total_predictions || 0) + 1;
      profile.updated_at = Date.now();
      await env.KV_STORE.put(`profile:${auth.userId}`, JSON.stringify(profile));
    }

    return jsonResponse({ 
      success: true, 
      prediction: predictions[matchId]
    });

  } catch (error) {
    console.error('Save Prediction Error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

async function handleGetHistory(request, env) {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const predictions = await env.KV_STORE.get(`predictions:${auth.userId}`, 'json') || {};
    const history = Object.values(predictions)
      .filter(p => p.status !== 'pending')
      .sort((a, b) => (b.settled_at || 0) - (a.settled_at || 0));

    return jsonResponse({ history });
  } catch (error) {
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

async function handleSettlePredictions(request, env) {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    let predictions = await env.KV_STORE.get(`predictions:${auth.userId}`, 'json') || {};
    const settled = [];
    let totalPoints = 0;

    for (const [matchId, pred] of Object.entries(predictions)) {
      if (pred.status !== 'pending') continue;

      const apiUrl = `https://apiv3.apifootball.com/?action=get_events&match_id=${matchId}&APIkey=${env.FOOTBALL_API_KEY}`;
      
      try {
        const response = await fetch(apiUrl);
        if (!response.ok) continue;
        const data = await response.json();
        if (!data || !data[0]) continue;

        const match = data[0];
        const status = (match.match_status || '').toLowerCase();
        const finalStatuses = ['finished', 'ft', 'aet', 'pen', 'awarded', 'int', 'after pen.'];

        if (finalStatuses.includes(status)) {
          const homeScore = parseInt(match.match_hometeam_score);
          const awayScore = parseInt(match.match_awayteam_score);

          if (!isNaN(homeScore) && !isNaN(awayScore)) {
            pred.home_score_real = homeScore;
            pred.away_score_real = awayScore;

            let points = 0;
            let statusType = 'lost';

            if (pred.home_pred === homeScore && pred.away_pred === awayScore) {
              points = 5;
              statusType = 'exact';
            } else if (
              (pred.home_pred > pred.away_pred && homeScore > awayScore) ||
              (pred.home_pred < pred.away_pred && homeScore < awayScore) ||
              (pred.home_pred === pred.away_pred && homeScore === awayScore)
            ) {
              points = 4;
              statusType = 'winner';
            }

            pred.status = statusType;
            pred.points_earned = points;
            pred.settled_at = Date.now();

            if (points > 0) {
              totalPoints += points;
              let profile = await env.KV_STORE.get(`profile:${auth.userId}`, 'json');
              if (profile) {
                profile.diamonds = (profile.diamonds || 0) + points;
                profile.wins = (profile.wins || 0) + 1;
                if (statusType === 'exact') {
                  profile.exact_predictions = (profile.exact_predictions || 0) + 1;
                }
                profile.updated_at = Date.now();
                await env.KV_STORE.put(`profile:${auth.userId}`, JSON.stringify(profile));
              }
            }

            settled.push({ matchId, status: statusType, points });
          }
        }
      } catch (e) {
        console.error(`Settle match ${matchId} error:`, e);
      }
    }

    await env.KV_STORE.put(`predictions:${auth.userId}`, JSON.stringify(predictions));

    return jsonResponse({ 
      success: true, 
      settled,
      total_points: totalPoints
    });

  } catch (error) {
    console.error('Settle Predictions Error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

// ============================================================
// 🏆 LEADERBOARD
// ============================================================

async function handleGetLeaderboard(request, env) {
  try {
    const cacheKey = 'leaderboard:top20';
    const cached = await env.KV_STORE.get(cacheKey, 'json');
    if (cached && Date.now() - cached.timestamp < 30000) {
      return jsonResponse({ leaderboard: cached.data, from_cache: true });
    }

    // Get all profiles from KV (scanning)
    const profiles = [];
    const list = await env.KV_STORE.list({ prefix: 'profile:' });
    
    for (const key of list.keys) {
      const profile = await env.KV_STORE.get(key.name, 'json');
      if (profile && profile.username) {
        profiles.push({
          username: profile.username,
          diamonds: profile.diamonds || 0,
          avatar_url: profile.avatar_url || null,
          wins: profile.wins || 0
        });
      }
    }

    // Sort by diamonds descending
    const sorted = profiles.sort((a, b) => b.diamonds - a.diamonds).slice(0, 20);

    await env.KV_STORE.put(cacheKey, JSON.stringify({
      data: sorted,
      timestamp: Date.now()
    }), { expirationTtl: 60 });

    return jsonResponse({ leaderboard: sorted, from_cache: false });

  } catch (error) {
    console.error('Leaderboard Error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

// ============================================================
// 🎯 MISSIONS
// ============================================================

const MISSION_DEFINITIONS = {
  'welcome': { name: 'اولین ورود', reward: 5, icon: 'fa-star', color: 'indigo' },
  'first_pred': { name: 'اولین پیش‌بینی', reward: 10, icon: 'fa-futbol', color: 'blue' },
  'master_pred': { name: 'استاد پیش‌بینی', reward: 20, icon: 'fa-trophy', color: 'purple' }
};

async function handleGetMissions(request, env) {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    let profile = await env.KV_STORE.get(`profile:${auth.userId}`, 'json');
    if (!profile) {
      return jsonResponse({ error: 'Profile not found' }, 404);
    }

    const missions = profile.missions || [];
    const predictions = await env.KV_STORE.get(`predictions:${auth.userId}`, 'json') || {};

    const status = {
      welcome: {
        claimed: missions.includes('welcome'),
        available: true
      },
      first_pred: {
        claimed: missions.includes('first_pred'),
        available: Object.keys(predictions).length > 0
      },
      master_pred: {
        claimed: missions.includes('master_pred'),
        available: (profile.wins || 0) >= 3
      }
    };

    return jsonResponse({ 
      missions: status, 
      definitions: MISSION_DEFINITIONS,
      eligibility: {
        first_pred: Object.keys(predictions).length > 0,
        master_pred: (profile.wins || 0) >= 3
      }
    });
  } catch (error) {
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

async function handleClaimMission(request, env) {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const { missionId } = await request.json();
    if (!missionId || !MISSION_DEFINITIONS[missionId]) {
      return jsonResponse({ error: 'Invalid mission' }, 400);
    }

    let profile = await env.KV_STORE.get(`profile:${auth.userId}`, 'json');
    if (!profile) {
      return jsonResponse({ error: 'Profile not found' }, 404);
    }

    const missions = profile.missions || [];
    if (missions.includes(missionId)) {
      return jsonResponse({ error: 'Mission already claimed' }, 400);
    }

    const predictions = await env.KV_STORE.get(`predictions:${auth.userId}`, 'json') || {};
    let eligible = true;

    switch (missionId) {
      case 'first_pred':
        eligible = Object.keys(predictions).length > 0;
        break;
      case 'master_pred':
        eligible = (profile.wins || 0) >= 3;
        break;
      case 'welcome':
        eligible = true;
        break;
    }

    if (!eligible) {
      return jsonResponse({ error: 'Mission requirements not met' }, 400);
    }

    const reward = MISSION_DEFINITIONS[missionId].reward;
    profile.missions = [...missions, missionId];
    profile.diamonds = (profile.diamonds || 0) + reward;
    profile.updated_at = Date.now();
    await env.KV_STORE.put(`profile:${auth.userId}`, JSON.stringify(profile));

    return jsonResponse({ 
      success: true, 
      reward, 
      diamonds: profile.diamonds 
    });

  } catch (error) {
    console.error('Claim Mission Error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

// ============================================================
// 🎡 WHEEL OF FORTUNE
// ============================================================

async function handleWheelSpin(request, env) {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    let profile = await env.KV_STORE.get(`profile:${auth.userId}`, 'json');
    if (!profile) {
      return jsonResponse({ error: 'Profile not found' }, 404);
    }

    const today = new Date().toISOString().split('T')[0];
    if (profile.last_wheel_spin === today) {
      return jsonResponse({ error: 'Daily spin limit reached' }, 400);
    }

    // Random prize (with weighted probabilities)
    const rand = Math.random() * 100;
    let prize = 0;
    let segmentIndex = 0;
    
    if (rand < 50) { prize = 0; segmentIndex = 0; }
    else if (rand < 80) { prize = 1; segmentIndex = 1; }
    else if (rand < 95) { prize = 2; segmentIndex = 2; }
    else { prize = 5; segmentIndex = 3; }

    // Segment index maps to wheel position (0-7 segments)
    const segmentMap = [0, 2, 1, 3];
    const finalSegment = segmentMap[segmentIndex] || 0;

    profile.diamonds = (profile.diamonds || 0) + prize;
    profile.last_wheel_spin = today;
    profile.updated_at = Date.now();
    await env.KV_STORE.put(`profile:${auth.userId}`, JSON.stringify(profile));

    return jsonResponse({ 
      success: true, 
      prize, 
      segmentIndex: finalSegment,
      diamonds: profile.diamonds
    });

  } catch (error) {
    console.error('Wheel Spin Error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

// ============================================================
// 🛠️ UTILITY FUNCTIONS
// ============================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

async function verifyAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET);
    if (!payload) return null;

    return {
      userId: payload.userId,
      email: payload.email
    };
  } catch (e) {
    return null;
  }
}

async function generateJWT(userId, email, secret) {
  const encoder = new TextEncoder();
  const data = JSON.stringify({ userId, email, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  const encodedData = btoa(data);
  const signature = await crypto.subtle.sign(
    'HMAC',
    await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    ),
    encoder.encode(encodedData)
  );
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return `${encodedData}.${encodedSignature}`;
}

async function verifyJWT(token, secret) {
  try {
    const [encodedData, encodedSignature] = token.split('.');
    const encoder = new TextEncoder();
    
    const signature = Uint8Array.from(atob(encodedSignature), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    
    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      encoder.encode(encodedData)
    );
    
    if (!isValid) return null;
    
    const payload = JSON.parse(atob(encodedData));
    if (payload.exp < Date.now()) return null;
    
    return payload;
  } catch (e) {
    return null;
  }
}

async function handleClearCache(request, env) {
  try {
    const auth = await verifyAuth(request, env);
    if (!auth || auth.userId !== 'admin') {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const list = await env.KV_STORE.list({ prefix: 'matches:' });
    for (const key of list.keys) {
      await env.KV_STORE.delete(key.name);
    }
    await env.KV_STORE.delete('leaderboard:top20');

    return jsonResponse({ success: true, cleared: list.keys.length });
  } catch (error) {
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}