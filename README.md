# AJ Sports — Unified Edge Worker

یک ورکر مشترک برای هر دو فرانت (تب پیش‌بینی + تب پروفایل)، بدون نیاز به تغییر
حتی یک خط از کد فرانت‌اند فعلی. هر دو قرارداد API دقیقاً همان‌طور که در دو
فایل HTML شما پیاده‌سازی شده، پشتیبانی می‌شوند.

## 1) قبل از دیپلوی — مراحل الزامی

### الف) ساخت KV Namespace
```bash
wrangler kv namespace create KV_STORE
wrangler kv namespace create KV_STORE --preview
```
دو تا `id` که برمی‌گردونه رو داخل `wrangler.toml` جای `REPLACE_WITH_...` بذار.
**بدون این مرحله دیپلوی fail می‌شه.**

### ب) ست کردن Secretها (نه در wrangler.toml — امن‌تره)
```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY
wrangler secret put SUPABASE_JWT_SECRET       # توضیح پایین‌تر، خیلی مهم برای سرعت
wrangler secret put SUPABASE_SERVICE_ROLE_KEY # اختیاری، برای sync لیدربورد
wrangler secret put JWT_SECRET                # یک رشته رندوم بلند، خودت بساز
wrangler secret put API_FOOTBALL_KEY
wrangler secret put CLOUDINARY_CLOUD_NAME
wrangler secret put CLOUDINARY_UPLOAD_PRESET
wrangler secret put ADMIN_TOKEN               # برای /admin/cache/clear
```

اگه با GitHub / Cloudflare Dashboard دیپلوی می‌کنی، همین متغیرها رو از
Settings → Variables and Secrets داخل داشبورد ورکر اضافه کن؛ دیپلوی به این
مقادیر در زمان build نیازی نداره (فقط در runtime لازمن)، پس نبودشون باعث
خطای دیپلوی نمی‌شه.

### چرا `SUPABASE_JWT_SECRET` مهمه؟
پروفایل توکن Supabase واقعی (access_token) رو مستقیم به عنوان Bearer
می‌فرسته. اگه این secret رو بدی، ورکر امضای JWT رو **کاملاً لوکال** (بدون
تماس شبکه‌ای) verify می‌کنه — یعنی زیر میلیون‌ها درخواست هم هیچ فشاری روی
Supabase نمیاد. این مقدار رو از Supabase Dashboard → Settings → API →
"JWT Secret" (یا در پروژه‌های جدیدتر JWKS) کپی کن. اگه ندیش، ورکر خودش
fallback می‌زنه به یک تماس شبکه‌ای که نتیجه‌اش رو ۵ دقیقه در KV کش می‌کنه —
کار می‌کنه ولی کندتره.

## 2) دیپلوی
```bash
npm install
wrangler deploy
```
یا از طریق Cloudflare Dashboard → Workers → Connect to Git (همین ریپو رو
وصل کن، `main` را به عنوان build command پیش‌فرض می‌شناسه چون `wrangler.toml`
و `package.json` هر دو موجودن).

## 3) دو فرانت رو کجا وصل کنم؟
یک آدرس ورکر واحد می‌گیری (مثلاً `https://ajsports-unified-worker.<you>.workers.dev`).
- در `deepseek_html_...` (تب پیش‌بینی): `WORKER_URL` رو به این آدرس تغییر بده.
- در `index.html` (تب پروفایل): `API_BASE` رو به همین آدرس تغییر بده.
هیچ تغییر دیگه‌ای در فرانت لازم نیست — همه مسیرها (با/بدون `/api`) توسط همین
یک ورکر پاسخ داده می‌شن.

## 4) قراردادهای API (دقیقاً مطابق فرانت فعلی، verify شده)

### تب پیش‌بینی (بدون پیشوند)
| Route | Method | ورودی | خروجی |
|---|---|---|---|
| /auth/send-otp | POST | {email} | {success} |
| /auth/verify-otp | POST | {email, token} | {token, user} — `token` = worker JWT، `user` = پروفایل flat |
| /auth/google | POST | {access_token} | {token} |
| /auth/logout | POST | – | {success} |
| /profile | GET | – | پروفایل flat (بدون wrap) |
| /profile | PUT | {username?, sports?, settings?} | {success, profile} |
| /profile/avatar | POST (multipart) | file | {success, avatar_url, profile} |
| /profile/history | GET | – | {history:[...]} |
| /matches | GET | ?date= | {matches, userPredictions} |
| /predictions | POST | {matchId, matchDate/date, homeTeam, awayTeam, homePred, awayPred} | {success, prediction, total} |
| /predictions/settle | POST | – | {success, settled, total_pending} |
| /leaderboard | GET | – | {leaderboard} |
| /missions | GET | – | {claimed, eligibility} |
| /missions/claim | POST | {missionId} | {success, reward, diamonds} |
| /wheel/spin | POST | – | {success, segmentIndex, prize, diamonds} |

### تب پروفایل (پیشوند `/api`)
| Route | Method | ورودی | خروجی |
|---|---|---|---|
| /api/auth/otp/send | POST | {email} | {success} |
| /api/auth/otp/verify | POST | {email, token} | {access_token, refresh_token} (توکن واقعی Supabase) |
| /api/auth/refresh | POST | {refresh_token} | {access_token, refresh_token} |
| /api/profile | GET | – | {profile} |
| /api/profile | PUT | {username?, sports?, settings?} | {success, profile} |
| /api/avatar | POST (multipart) | file | {success, avatar_url, profile} |
| /api/account | DELETE | – | {success} |

هر دو دسته روی **یک رکورد پروفایل مشترک در KV** (کلید `profile:{userId}`)
کار می‌کنن، پس تغییر یوزرنیم/آواتار/زبان از هرکدوم فوراً در اون یکی هم دیده
می‌شه.

## 5) سوییچ زبان سمت سرور
با `PUT /profile` یا `PUT /api/profile` و بدنه‌ی `{ settings: { lang: "en" } }`
مقدار `profile.settings.lang` در KV آپدیت می‌شه — این تنها منبع حقیقت زبانه
و هر دو تب همون رکورد رو می‌خونن. از این به بعد، **هر پیام خطا/موفقیتی که
خودِ ورکر تولید می‌کنه** (نه دیتای خام فوتبال) طبق همین زبان فارسی/انگلیسی
برگردونده می‌شه (`tr(lang, key)` در کد). نام تیم‌ها/لیگ‌ها که از API فوتبال
میاد رو **ترجمه نکردیم** — این‌ها متن خام ارائه‌دهنده‌ی API هستن و ترجمه
خودکارشون بدون یک سرویس ترجمه یا دیکشنری تیم/لیگ اختصاصی، غیرقابل‌اعتماده؛
اگه لازمشون داری بگو تا یک لایه‌ی نگاشت اسم اضافه کنم.

## 6) کش لبه — چطور میلیون‌ها درخواست رو تحمل می‌کنه
مسیر `/matches` دو لایه کش داره:
1. **Cloudflare Cache API** (`caches.default`) — سریع‌ترین لایه، حتی KV هم
   خونده نمی‌شه اگه همون PoP قبلاً همون تاریخ رو کش کرده باشه.
2. **KV** با TTL 60 ثانیه‌ی «تازه» + 300 ثانیه‌ی سخت، به‌همراه
   **stale-while-revalidate**: اگه کش قدیمی شده، بلافاصله همون داده‌ی قدیمی
   serve می‌شه و رفرش در پس‌زمینه (`ctx.waitUntil`) انجام می‌شه — کاربر هرگز
   منتظر API فوتبال نمی‌مونه.
نتیجه: API رایگان فوتبال تقریباً یک‌بار در هر پنجره‌ی زمانی **در کل دنیا**
صدا زده می‌شه، نه یک‌بار به ازای هر کاربر.

مسیر `/predictions/settle` هم نتیجه‌ی هر مسابقه رو ۳۰ ثانیه در KV کش می‌کنه
(`matchresult:{matchId}`) تا وقتی همزمان هزاران کاربر settle می‌زنن، فقط
یک تماس واقعی به API فوتبال برای هر مسابقه بره.

لیدربورد هم همین الگو رو داره (Cache API + KV 60 ثانیه) و از یک جدول
`profiles` در Supabase می‌خونه (نه اسکن KV که برای مقیاس میلیونی کند و
گرونه).

## 7) نکات مهندسی/باگ‌هایی که در نمونه‌ی قبلی اصلاح شدن
- **باگ امنیتی**: نمونه‌ی قبلی برای sync پروفایل به Supabase یک
  `PATCH /rest/v1/profiles` بدون فیلتر `id=eq.` می‌زد — این می‌تونست
  یوزرنیم **همه‌ی کاربران** رو با آخرین مقدار عوض کنه. اینجا با
  `POST ...?on_conflict=id` + هدر `Prefer: resolution=merge-duplicates`
  (upsert واقعی) جایگزین شده.
- **گردونه‌ی شانس**: فرانت انتظار `segmentIndex` (۰ تا ۷، چون چرخ ۸ خونه‌س:
  `360/45=8`) داره که در نمونه‌ی قبلی اصلاً برنمی‌گشت. اضافه شده، بدون اینکه
  احتمال جوایز (۵۰٪/۳۰٪/۱۵٪/۵٪) تغییر کنه — فقط این‌که کدوم خونه از چرخ
  انتخاب بشه تصادفیه.
- **ماموریت‌ها**: قرارداد واقعی فرانت `{claimed, eligibility}` هست، نه
  ساختار تودرتوی نمونه‌ی قبلی — اصلاح شد.
- **امتیاز مساوی**: فرانت یک وضعیت جدا برای «مساوی درست حدس زده‌شده»
  (`draw`, رنگ زرد) داره که نمونه‌ی قبلی نداشت. فرض شده `exact=5،
  winner=3، draw=2` — اگه عدد واقعی متفاوته، فقط ثابت‌های `POINTS` در
  بالای فایل رو عوض کن، جای دیگه‌ای نیاز به تغییر نداره.

## 8) چیزهایی که همچنان باید خودت چک/تنظیم کنی
- جدول `profiles` در Supabase باید ستون‌های `id (uuid, PK) / username /
  avatar_url / diamonds` رو داشته باشه تا sync لیدربورد کار کنه (اختیاریه؛
  اگه `SUPABASE_SERVICE_ROLE_KEY` رو ندی، این بخش صرفاً skip می‌شه و بقیه‌ی
  سیستم عادی کار می‌کنه).
- `API_FOOTBALL_KEY` که فرستادی مربوط به apifootball.com هست؛ اگه سرویس
  دیگه‌ای استفاده می‌کنی (API-Football/RapidAPI، football-data.org و...)
  بگو تا تابع `fetchMatchesFromUpstream` رو با فرمت درخواست/پاسخ همون
  سرویس تطبیق بدم.
