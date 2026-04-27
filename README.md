# Briskfil Analytics Dashboard
### Built by NXRD — nx-rd.com

Live GA4 analytics dashboard for Briskfil with NXRD branding.

---

## Deploy to Railway (5 minutes)

### Step 1 — Upload to GitHub
1. Create a free account at github.com if you don't have one
2. Create a new repository called `briskfil-dashboard`
3. Upload all these files to the repository
4. Make sure the `.gitignore` is included — it prevents your credentials being exposed

### Step 2 — Deploy on Railway
1. Go to railway.app and sign up (free tier available)
2. Click **New Project > Deploy from GitHub repo**
3. Select your `briskfil-dashboard` repository
4. Railway will detect the Node.js app automatically

### Step 3 — Add environment variables (IMPORTANT — do this before the app goes live)
In Railway, go to your project > **Variables** tab and add:

| Variable | Value |
|---|---|
| `GA4_PROPERTY_ID` | `307311147` |
| `GOOGLE_CREDENTIALS` | Paste the ENTIRE contents of your service account JSON file here |
| `PORT` | `3000` |

For `GOOGLE_CREDENTIALS`, open your JSON file in a text editor, select all, copy, and paste the whole thing as the variable value.

### Step 4 — Get your URL
1. Go to the **Settings** tab in Railway
2. Under **Domains**, click **Generate Domain**
3. You will get a URL like `briskfil-dashboard.up.railway.app`
4. Share this link with your client

---

## What the dashboard shows
- Sessions, users, pageviews, bounce rate, engagement rate, avg session duration
- Month-on-month comparison for every metric
- Traffic channel breakdown (organic, direct, referral, social, email)
- Week-by-week trend chart
- Top pages with change indicators
- Geographic traffic breakdown by country
- AI platform referrals (traffic from ChatGPT, Perplexity, Claude, Gemini etc)
- Manual AI citation tracker — log when Briskfil appears in AI responses

---

## Support
Contact NXRD at nx-rd.com
