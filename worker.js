// ============================================
// 🎥 AJ Sports Video Platform - Cloudflare Worker
// 🌐 Domain: videos.ajsports.ir
// ============================================

const YOUTUBE_API_KEY = 'AIzaSyCKBbpYov7TL3DzxhzuAzGq1ujkp77dHtU';

const CHANNELS = {
  fifa: 'UCpcTrCXblq78GZrTUTLWeBw',
  premierleague: 'UCD4EOyXKjfDUhBI6k-5QJ_g',
  uefa: 'UC8xmq5k3ZxL4MUjaxdXbTcA',
  laliga: 'UCT9dx7j32tq4V2YQq4QoFkA',
  bundesliga: 'UCGAjv7E8ahcHDKr7aJ7_8RQ',
  afc: 'UCjIVZgJdBYZ4FXyH7JwXGKA',
  nbcsports: 'UCqZQJzTlJ8PkLhxGvVXtQGw',
  espnfc: 'UCnRdZ6TlRzVHNYQrYS4ZxOQ',
  btsport: 'UCtK5Q7fRqFPgkW9gCkzXntg',
  beinsports: 'UCzjDhjBEqYpQnjtHGnRpBxQ',
  skysports: 'UCNAf1k0yIxGuF9VQoMJkqLA',
  hayterstv: 'UCWPgDMOFnflnCjxJh8MxhDw',
  efl: 'UCBWj8VXE4qK-FLDVtNrGi3g',
  cbssports: 'UCb7C8FQwGJNjPnTKmNKo7dA',
  foxsoccer: 'UCqRPnK2L4Q2Xo8mBQyBzNcA',
  tntsports: 'UCKkrGz7kD7jFqRQYHqXyPHA'
};

const MAX_RESULTS = 15;
const CACHE_TTL = 1800;
const MAX_TOTAL_VIDEOS = 80;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ============ API: دریافت لیست ویدیوها ============
    if (path === '/api/videos') {
      try {
        const cacheKey = 'videos_cache_v2';
        const cached = await env.VIDEO_CACHE.get(cacheKey);
        
        if (cached) {
          const data = JSON.parse(cached);
          return new Response(JSON.stringify(data), {
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json; charset=utf-8',
              'X-Cache': 'HIT'
            }
          });
        }

        const allVideos = [];
        const fetchPromises = Object.entries(CHANNELS).map(async ([name, id]) => {
          try {
            const videos = await fetchChannelVideos(id, name);
            return videos;
          } catch (e) {
            console.error(`Error fetching ${name}:`, e.message);
            return [];
          }
        });

        const results = await Promise.allSettled(fetchPromises);
        
        results.forEach(result => {
          if (result.status === 'fulfilled') {
            allVideos.push(...result.value);
          }
        });

        allVideos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
        
        const finalVideos = allVideos.slice(0, MAX_TOTAL_VIDEOS);
        
        const response = {
          success: true,
          lastUpdated: new Date().toISOString(),
          totalChannels: Object.keys(CHANNELS).length,
          totalVideos: finalVideos.length,
          videos: finalVideos
        };

        const jsonResponse = JSON.stringify(response);
        
        ctx.waitUntil(
          env.VIDEO_CACHE.put(cacheKey, jsonResponse, { 
            expirationTtl: CACHE_TTL 
          })
        );

        return new Response(jsonResponse, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json; charset=utf-8',
            'X-Cache': 'MISS'
          }
        });

      } catch (error) {
        return new Response(JSON.stringify({
          success: false,
          error: error.message
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
        });
      }
    }

    // ============ صفحه اصلی ============
    if (path === '/' || path === '/videos' || path === '/index.html') {
      return new Response(generateMainPage(), {
        headers: { 
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    // ============ Health Check ============
    if (path === '/health') {
      return new Response(JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString()
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};

async function fetchChannelVideos(channelId, channelName) {
  try {
    const channelUrl = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&id=${channelId}&key=${YOUTUBE_API_KEY}`;
    
    const channelResponse = await fetch(channelUrl);
    if (!channelResponse.ok) return [];
    
    const channelData = await channelResponse.json();
    if (!channelData.items?.length) return [];
    
    const channel = channelData.items[0];
    const uploadsPlaylistId = channel.contentDetails.relatedPlaylists.uploads;
    const channelTitle = channel.snippet.title;
    
    const videosUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=${MAX_RESULTS}&playlistId=${uploadsPlaylistId}&key=${YOUTUBE_API_KEY}`;
    
    const videosResponse = await fetch(videosUrl);
    if (!videosResponse.ok) return [];
    
    const videosData = await videosResponse.json();
    if (!videosData.items?.length) return [];
    
    return videosData.items.map(item => ({
      id: item.snippet.resourceId.videoId,
      title: item.snippet.title,
      description: item.snippet.description?.slice(0, 200) || '',
      thumbnail: item.snippet.thumbnails?.maxres?.url || 
                 item.snippet.thumbnails?.high?.url || 
                 item.snippet.thumbnails?.medium?.url ||
                 item.snippet.thumbnails?.default?.url,
      channelId: channelId,
      channelName: channelName,
      channelTitle: channelTitle,
      publishedAt: item.snippet.publishedAt,
      embedUrl: `https://www.youtube-nocookie.com/embed/${item.snippet.resourceId.videoId}?autoplay=1`,
      youtubeUrl: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`
    }));
    
  } catch (error) {
    console.error(`Failed to fetch channel ${channelName}:`, error);
    return [];
  }
}

function generateMainPage() {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AJ Sports - ویدیوهای ورزشی</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(135deg, #0a0e27 0%, #1a1a3e 100%);
      color: #ffffff;
      min-height: 100vh;
      direction: rtl;
    }
    
    .header {
      background: rgba(0,0,0,0.3);
      backdrop-filter: blur(20px);
      padding: 20px;
      text-align: center;
      border-bottom: 2px solid rgba(255,255,255,0.1);
    }
    
    .header h1 {
      font-size: 2.5em;
      background: linear-gradient(45deg, #ff6b6b, #ffd93d, #6bcf7f);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 10px;
    }
    
    .header p { color: #aaa; font-size: 1.1em; }
    
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    
    .main-player-section {
      background: #000;
      border-radius: 16px;
      overflow: hidden;
      margin-bottom: 30px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    }
    
    .video-wrapper {
      position: relative;
      padding-top: 56.25%;
      background: #000;
    }
    
    .video-wrapper iframe {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border: none;
    }
    
    .video-details {
      padding: 20px;
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(10px);
    }
    
    .video-details h2 { font-size: 1.5em; margin-bottom: 10px; color: #fff; }
    
    .meta-info {
      display: flex;
      gap: 15px;
      color: #aaa;
      font-size: 0.9em;
      flex-wrap: wrap;
    }
    
    .meta-info span {
      background: rgba(255,255,255,0.1);
      padding: 5px 15px;
      border-radius: 20px;
    }
    
    .stats-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      flex-wrap: wrap;
      gap: 10px;
    }
    
    .stats-bar .count { color: #ffd93d; font-size: 1.1em; }
    
    .refresh-btn {
      background: linear-gradient(45deg, #ff6b6b, #ee5a24);
      color: white;
      border: none;
      padding: 10px 25px;
      border-radius: 25px;
      cursor: pointer;
      font-size: 1em;
      transition: transform 0.2s;
    }
    
    .refresh-btn:hover { transform: scale(1.05); }
    
    .video-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 20px;
    }
    
    .video-card {
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(10px);
      border-radius: 12px;
      overflow: hidden;
      cursor: pointer;
      transition: all 0.3s ease;
      border: 1px solid rgba(255,255,255,0.1);
    }
    
    .video-card:hover {
      transform: translateY(-5px);
      box-shadow: 0 15px 40px rgba(0,0,0,0.4);
    }
    
    .video-card.active {
      border-color: #ffd93d;
      box-shadow: 0 0 20px rgba(255,217,61,0.2);
    }
    
    .thumbnail {
      position: relative;
      padding-top: 56.25%;
      background: #1a1a3e;
      overflow: hidden;
    }
    
    .thumbnail img {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: transform 0.3s;
    }
    
    .video-card:hover .thumbnail img { transform: scale(1.05); }
    
    .play-overlay {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 60px;
      height: 60px;
      background: rgba(0,0,0,0.7);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      transition: all 0.3s;
    }
    
    .video-card:hover .play-overlay {
      background: #ff6b6b;
      transform: translate(-50%, -50%) scale(1.1);
    }
    
    .card-content { padding: 15px; }
    
    .card-content h3 {
      font-size: 1em;
      margin-bottom: 10px;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    
    .card-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.8em;
      color: #aaa;
      flex-wrap: wrap;
      gap: 5px;
    }
    
    .channel-badge {
      background: linear-gradient(45deg, #ff6b6b, #ffd93d);
      color: #000;
      padding: 3px 10px;
      border-radius: 15px;
      font-weight: bold;
      font-size: 0.75em;
    }
    
    .loading { text-align: center; padding: 60px 20px; }
    
    .spinner {
      width: 50px;
      height: 50px;
      border: 4px solid rgba(255,255,255,0.1);
      border-top: 4px solid #ffd93d;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 20px;
    }
    
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    
    .error { text-align: center; padding: 60px 20px; color: #ff6b6b; }
    
    @media (max-width: 768px) {
      .header h1 { font-size: 1.8em; }
      .video-grid { grid-template-columns: 1fr; }
      .container { padding: 10px; }
    }
    
    footer {
      text-align: center;
      padding: 40px 20px;
      color: #666;
      font-size: 0.9em;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>⚽ AJ Sports</h1>
    <p>جدیدترین ویدیوهای فوتبال | خلاصه بازی‌ها | گل‌ها | لحظات برتر</p>
  </div>
  
  <div class="container">
    <!-- Main Player -->
    <div class="main-player-section">
      <div class="video-wrapper">
        <iframe id="mainPlayer" 
                src="" 
                allow="autoplay; encrypted-media" 
                allowfullscreen>
        </iframe>
      </div>
      <div class="video-details">
        <h2 id="videoTitle">🎬 یک ویدیو انتخاب کنید</h2>
        <div class="meta-info">
          <span id="channelInfo">📺 کانال</span>
          <span id="dateInfo">📅 تاریخ</span>
        </div>
      </div>
    </div>
    
    <!-- Stats & Refresh -->
    <div class="stats-bar">
      <div class="count" id="videoCount">📊 در حال بارگذاری...</div>
      <button class="refresh-btn" onclick="loadVideos()">🔄 بروزرسانی</button>
    </div>
    
    <!-- Video Grid -->
    <div class="video-grid" id="videoGrid">
      <div class="loading">
        <div class="spinner"></div>
        <p>در حال بارگذاری ویدیوها...</p>
      </div>
    </div>
  </div>
  
  <footer>
    <p>© 2026 AJ Sports | تمامی حقوق محفوظ است</p>
  </footer>
  
  <script>
    const API_URL = '/api/videos';
    
    async function loadVideos() {
      const grid = document.getElementById('videoGrid');
      grid.innerHTML = '<div class="loading"><div class="spinner"></div><p>در حال بارگذاری...</p></div>';
      
      try {
        const response = await fetch(API_URL);
        if (!response.ok) throw new Error('Network error');
        
        const data = await response.json();
        
        if (!data.success || !data.videos.length) {
          grid.innerHTML = '<div class="error"><h3>⚠️ خطا</h3><p>ویدیویی یافت نشد</p></div>';
          return;
        }
        
        document.getElementById('videoCount').textContent = 
          \`📊 \${data.totalVideos} ویدیو از \${data.totalChannels} کانال\`;
        
        renderVideos(data.videos);
        
      } catch (error) {
        grid.innerHTML = '<div class="error"><h3>⚠️ خطا در بارگذاری</h3><p>لطفاً دوباره تلاش کنید</p></div>';
        console.error('Error:', error);
      }
    }
    
    function renderVideos(videos) {
      const grid = document.getElementById('videoGrid');
      grid.innerHTML = '';
      
      videos.forEach((video, index) => {
        const card = document.createElement('div');
        card.className = 'video-card';
        card.onclick = () => playVideo(video, card);
        
        const date = new Date(video.publishedAt).toLocaleDateString('fa-IR', {
          year: 'numeric', month: 'long', day: 'numeric'
        });
        
        card.innerHTML = \`
          <div class="thumbnail">
            <img src="\${video.thumbnail}" alt="\${video.title}" 
                 loading="lazy" 
                 onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22300%22 height=%22169%22><rect fill=%22%231a1a3e%22 width=%22300%22 height=%22169%22/><text fill=%22%23fff%22 x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22 font-size=%2220%22>🎬</text></svg>'">
            <div class="play-overlay">▶</div>
          </div>
          <div class="card-content">
            <h3>\${video.title}</h3>
            <div class="card-meta">
              <span>\${video.channelTitle}</span>
              <span class="channel-badge">\${getChannelNameFa(video.channelName)}</span>
              <span>\${date}</span>
            </div>
          </div>
        \`;
        
        grid.appendChild(card);
      });
      
      if (videos.length > 0) {
        const firstCard = grid.querySelector('.video-card');
        playVideo(videos[0], firstCard);
      }
    }
    
    function playVideo(video, cardElement) {
      const player = document.getElementById('mainPlayer');
      player.src = video.embedUrl;
      
      document.getElementById('videoTitle').textContent = video.title;
      document.getElementById('channelInfo').textContent = \`📺 \${video.channelTitle}\`;
      
      const date = new Date(video.publishedAt).toLocaleDateString('fa-IR', {
        year: 'numeric', month: 'long', day: 'numeric'
      });
      document.getElementById('dateInfo').textContent = \`📅 \${date}\`;
      
      document.querySelectorAll('.video-card').forEach(c => c.classList.remove('active'));
      if (cardElement) {
        cardElement.classList.add('active');
      }
    }
    
    function getChannelNameFa(channelName) {
      const names = {
        fifa: '🏆 فیفا',
        premierleague: '🏴 لیگ برتر',
        uefa: '⭐ لیگ قهرمانان',
        laliga: '🇪🇸 لالیگا',
        bundesliga: '🇩🇪 بوندسلیگا',
        afc: '🌏 لیگ قهرمانان آسیا',
        nbcsports: 'NBC',
        espnfc: 'ESPN',
        btsport: 'BT Sport',
        beinsports: 'beIN',
        skysports: 'Sky Sports',
        hayterstv: 'HaytersTV',
        efl: 'EFL',
        cbssports: 'CBS Sports',
        foxsoccer: 'FOX Soccer',
        tntsports: 'TNT Sports'
      };
      return names[channelName] || channelName;
    }
    
    loadVideos();
    setInterval(loadVideos, 1800000);
  </script>
</body>
</html>`;
      }
