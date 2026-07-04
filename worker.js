const YOUTUBE_API_KEY = 'AIzaSyCKBbpYov7TL3DzxhzuAzGq1ujkp77dHtU';

const CHANNELS = {
  fifa: 'UCpcTrCXblq78GZrTUTLWeBw',
  premierleague: 'UCD4EOyXKjfDUhBI6k-5QJ_g',
  uefa: 'UC8xmq5k3ZxL4MUjaxdXbTcA',
  laliga: 'UCT9dx7j32tq4V2YQq4QoFkA',
  bundesliga: 'UCGAjv7E8ahcHDKr7aJ7_8RQ',
  afc: 'UCjIVZgJdBYZ4FXyH7JwXGKA',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    };

    // API: لیست ویدیوها
    if (path === '/api/videos') {
      try {
        const allVideos = [];
        
        for (const [name, id] of Object.entries(CHANNELS)) {
          const videos = await fetchChannelVideos(id, name);
          allVideos.push(...videos);
        }
        
        allVideos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
        
        return new Response(JSON.stringify({
          success: true,
          videos: allVideos.slice(0, 30)
        }), { headers: corsHeaders });
        
      } catch(e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { 
          status: 500, headers: corsHeaders 
        });
      }
    }

    // API: گرفتن لینک مستقیم ویدیو
    if (path.startsWith('/video/')) {
      const videoId = path.split('/video/')[1];
      
      try {
        const videoUrl = await getDirectVideoUrl(videoId);
        
        if (videoUrl) {
          // ریدایرکت به لینک مستقیم googlevideo.com
          return Response.redirect(videoUrl, 302);
        } else {
          // اگر نشد، ریدایرکت به یوتیوب
          return Response.redirect(`https://www.youtube.com/watch?v=${videoId}`, 302);
        }
        
      } catch(e) {
        return Response.redirect(`https://www.youtube.com/watch?v=${videoId}`, 302);
      }
    }

    // صفحه اصلی
    if (path === '/' || path === '/index.html') {
      return new Response(HTML_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};

async function fetchChannelVideos(channelId, channelName) {
  const channelUrl = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&id=${channelId}&key=${YOUTUBE_API_KEY}`;
  
  const channelResponse = await fetch(channelUrl);
  if (!channelResponse.ok) return [];
  
  const channelData = await channelResponse.json();
  if (!channelData.items?.length) return [];
  
  const channel = channelData.items[0];
  const uploadsPlaylistId = channel.contentDetails.relatedPlaylists.uploads;
  const channelTitle = channel.snippet.title;
  
  const videosUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=10&playlistId=${uploadsPlaylistId}&key=${YOUTUBE_API_KEY}`;
  
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
               item.snippet.thumbnails?.medium?.url,
    channelName: channelName,
    channelTitle: channelTitle,
    publishedAt: item.snippet.publishedAt,
    directUrl: `/video/${item.snippet.resourceId.videoId}`
  }));
}

async function getDirectVideoUrl(videoId) {
  try {
    const response = await fetch('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: videoId,
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '19.09.37',
            androidSdkVersion: 30
          }
        }
      })
    });
    
    const data = await response.json();
    const formats = data?.streamingData?.formats || data?.streamingData?.adaptiveFormats || [];
    
    // کیفیت 360p یا 720p
    const format = formats.find(f => f.height === 360 && f.mimeType?.includes('video/mp4')) ||
                   formats.find(f => f.height === 720 && f.mimeType?.includes('video/mp4')) ||
                   formats[0];
    
    return format?.url || null;
    
  } catch(e) {
    return null;
  }
}

const HTML_PAGE = `<!DOCTYPE html>
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
    
    .player-section {
      background: #000;
      border-radius: 16px;
      overflow: hidden;
      margin-bottom: 30px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    }
    
    .player-wrapper {
      position: relative;
      padding-top: 56.25%;
      background: #000;
    }
    
    .player-wrapper video {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      outline: none;
    }
    
    .player-placeholder {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #1a1a3e;
      text-align: center;
    }
    
    .video-info {
      padding: 20px;
      background: rgba(255,255,255,0.05);
    }
    
    .video-info h2 { font-size: 1.5em; margin-bottom: 10px; }
    
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
    }
    
    .thumbnail {
      position: relative;
      padding-top: 56.25%;
      background: #1a1a3e;
    }
    
    .thumbnail img {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    
    .play-overlay {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 60px;
      height: 60px;
      background: rgba(255,0,0,0.8);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
    }
    
    .card-content { padding: 15px; }
    
    .card-content h3 {
      font-size: 1em;
      margin-bottom: 10px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    
    .card-meta {
      display: flex;
      justify-content: space-between;
      font-size: 0.8em;
      color: #aaa;
    }
    
    .btn {
      background: #ff0000;
      color: white;
      border: none;
      padding: 12px 30px;
      border-radius: 30px;
      cursor: pointer;
      font-size: 1.1em;
      margin-top: 10px;
      display: inline-block;
    }
    
    .btn:hover { background: #cc0000; }
    
    .loading { text-align: center; padding: 60px; }
    
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
    
    @media (max-width: 768px) {
      .header h1 { font-size: 1.8em; }
      .video-grid { grid-template-columns: 1fr; }
    }
    
    footer {
      text-align: center;
      padding: 40px;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>⚽ AJ Sports</h1>
    <p>جدیدترین ویدیوهای فوتبال | خلاصه بازی‌ها | گل‌ها | لحظات برتر</p>
  </div>
  
  <div class="container">
    <!-- Player -->
    <div class="player-section">
      <div class="player-wrapper" id="playerContainer">
        <div class="player-placeholder">
          <div>
            <div style="font-size:4em;">🎬</div>
            <p style="margin-top:10px;">یک ویدیو انتخاب کنید</p>
          </div>
        </div>
      </div>
      <div class="video-info">
        <h2 id="videoTitle">🎬 یک ویدیو انتخاب کنید</h2>
        <div class="meta-info">
          <span id="channelInfo">📺 کانال</span>
          <span id="dateInfo">📅 تاریخ</span>
        </div>
        <button class="btn" id="playBtn" style="display:none;" onclick="playSelectedVideo()">
          ▶️ پخش ویدیو
        </button>
      </div>
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
    <p>© 2026 AJ Sports</p>
  </footer>
  
  <script>
    let selectedVideo = null;
    
    async function loadVideos() {
      try {
        const res = await fetch('/api/videos');
        const data = await res.json();
        
        if (!data.success || !data.videos.length) {
          document.getElementById('videoGrid').innerHTML = '<div class="loading"><p>ویدیویی یافت نشد</p></div>';
          return;
        }
        
        renderVideos(data.videos);
        
      } catch(e) {
        document.getElementById('videoGrid').innerHTML = '<div class="loading"><p>خطا در بارگذاری</p></div>';
      }
    }
    
    function renderVideos(videos) {
      const grid = document.getElementById('videoGrid');
      grid.innerHTML = '';
      
      videos.forEach(video => {
        const card = document.createElement('div');
        card.className = 'video-card';
        card.onclick = () => selectVideo(video, card);
        
        const date = new Date(video.publishedAt).toLocaleDateString('fa-IR');
        
        card.innerHTML = \`
          <div class="thumbnail">
            <img src="\${video.thumbnail}" alt="\${video.title}" loading="lazy">
            <div class="play-overlay">▶</div>
          </div>
          <div class="card-content">
            <h3>\${video.title}</h3>
            <div class="card-meta">
              <span>\${video.channelTitle}</span>
              <span>\${date}</span>
            </div>
          </div>
        \`;
        
        grid.appendChild(card);
      });
    }
    
    function selectVideo(video, card) {
      selectedVideo = video;
      
      document.getElementById('videoTitle').textContent = video.title;
      document.getElementById('channelInfo').textContent = '📺 ' + video.channelTitle;
      document.getElementById('dateInfo').textContent = '📅 ' + new Date(video.publishedAt).toLocaleDateString('fa-IR');
      document.getElementById('playBtn').style.display = 'inline-block';
      
      document.querySelectorAll('.video-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      
      // Show thumbnail
      document.getElementById('playerContainer').innerHTML = \`
        <img src="\${video.thumbnail}" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;">
        <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);">
          <div style="width:80px;height:80px;background:rgba(255,0,0,0.8);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:30px;">▶</div>
        </div>
      \`;
    }
    
    async function playSelectedVideo() {
      if (!selectedVideo) return;
      
      const container = document.getElementById('playerContainer');
      container.innerHTML = '<div class="player-placeholder"><div class="spinner"></div><p>در حال دریافت ویدیو...</p></div>';
      
      try {
        // First try to get direct URL
        const urlRes = await fetch('/video/' + selectedVideo.id, { redirect: 'manual' });
        
        if (urlRes.status === 302 || urlRes.status === 301) {
          const directUrl = urlRes.headers.get('Location');
          
          container.innerHTML = \`
            <video controls autoplay playsinline 
                   style="position:absolute;top:0;left:0;width:100%;height:100%;">
              <source src="\${directUrl}" type="video/mp4">
              مرورگر شما از پخش ویدیو پشتیبانی نمی‌کند
            </video>
          \`;
        } else {
          // Fallback: open YouTube
          window.open('https://www.youtube.com/watch?v=' + selectedVideo.id, '_blank');
          container.innerHTML = \`
            <div class="player-placeholder">
              <div>
                <p>ویدیو در یوتیوب باز شد</p>
                <button class="btn" onclick="window.open('https://www.youtube.com/watch?v=\${selectedVideo.id}', '_blank')">
                  🔄 تلاش مجدد
                </button>
              </div>
            </div>
          \`;
        }
        
      } catch(e) {
        container.innerHTML = '<div class="player-placeholder"><p>⚠️ خطا در پخش ویدیو</p></div>';
      }
    }
    
    loadVideos();
  </script>
</body>
</html>`;
