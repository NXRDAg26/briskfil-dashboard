require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { google } = require('googleapis');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const path = require('path');
const { pool, initSchema, CLIENT } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Sessions live in the same Postgres database as the rest of the dashboard.
// Removes the MemoryStore production warning and means Google sign-in
// survives Render restarts and redeploys.
app.use(session({
  store: new pgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'nxrd-briskfil-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const PROPERTY_ID = process.env.GA4_PROPERTY_ID || '307311147';
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://briskfil-dashboard.onrender.com/auth/callback';

function getOAuthClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.tokens) return next();
  if (req.path.startsWith('/api/ai-visibility')) return next();
  res.status(401).json({ success: false, error: 'Not authenticated', needsAuth: true });
}

function getAnalyticsClient(tokens) {
  const auth = getOAuthClient();
  auth.setCredentials(tokens);
  return new BetaAnalyticsDataClient({ authClient: auth });
}

function getDateRanges() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const firstThisMonth = new Date(y, m, 1);
  const firstLastMonth = new Date(y, m - 1, 1);
  const lastLastMonth = new Date(y, m, 0);
  const fmt = d => d.toISOString().split('T')[0];
  return {
    current: { startDate: fmt(firstThisMonth), endDate: 'today' },
    previous: { startDate: fmt(firstLastMonth), endDate: fmt(lastLastMonth) }
  };
}

const AI_SOURCES = ['chatgpt', 'openai', 'perplexity', 'claude', 'gemini', 'copilot', 'you.com', 'phind', 'bard'];

// ── AUTH ──────────────────────────────────────────────────────────────────────

app.get('/auth/login', (req, res) => {
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/analytics.readonly',
      'https://www.googleapis.com/auth/webmasters.readonly'
    ]
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    res.redirect('/');
  } catch (err) {
    console.error('Auth callback error:', err);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/status', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.tokens) });
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ── ANALYTICS API ─────────────────────────────────────────────────────────────

app.get('/api/overview', requireAuth, async (req, res) => {
  try {
    const client = getAnalyticsClient(req.session.tokens);
    const { current, previous } = getDateRanges();

    const fetchPeriod = async (startDate, endDate) => {
      const [r] = await client.runReport({
        property: `properties/${PROPERTY_ID}`,
        dateRanges: [{ startDate, endDate }],
        metrics: [
          { name: 'sessions' }, { name: 'totalUsers' }, { name: 'bounceRate' },
          { name: 'averageSessionDuration' }, { name: 'screenPageViews' }, { name: 'engagementRate' }
        ]
      });
      const row = r.rows?.[0];
      if (!row) return {};
      return {
        sessions: parseInt(row.metricValues[0].value),
        users: parseInt(row.metricValues[1].value),
        bounceRate: parseFloat(row.metricValues[2].value) * 100,
        avgDuration: parseFloat(row.metricValues[3].value),
        pageViews: parseInt(row.metricValues[4].value),
        engagementRate: parseFloat(row.metricValues[5].value) * 100
      };
    };

    const [curr, prev] = await Promise.all([
      fetchPeriod(current.startDate, current.endDate),
      fetchPeriod(previous.startDate, previous.endDate)
    ]);

    res.json({ success: true, data: { current: curr, previous: prev }, dateRanges: { current, previous } });
  } catch (err) {
    console.error('Overview error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/organic', requireAuth, async (req, res) => {
  try {
    const client = getAnalyticsClient(req.session.tokens);
    const { current, previous } = getDateRanges();

    const fetchPeriod = async (startDate, endDate) => {
      const [r] = await client.runReport({
        property: `properties/${PROPERTY_ID}`,
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }]
      });
      const result = {};
      r.rows?.forEach(row => { result[row.dimensionValues[0].value] = parseInt(row.metricValues[0].value); });
      return result;
    };

    const [curr, prev] = await Promise.all([
      fetchPeriod(current.startDate, current.endDate),
      fetchPeriod(previous.startDate, previous.endDate)
    ]);

    const channels = {};
    [...new Set([...Object.keys(curr), ...Object.keys(prev)])].forEach(k => {
      channels[k] = { current: curr[k] || 0, previous: prev[k] || 0 };
    });
    res.json({ success: true, data: channels });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/traffic-trend', requireAuth, async (req, res) => {
  try {
    const client = getAnalyticsClient(req.session.tokens);
    const { current, previous } = getDateRanges();

    const fetchPeriod = async (startDate, endDate) => {
      const [r] = await client.runReport({
        property: `properties/${PROPERTY_ID}`,
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'week' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
        orderBys: [{ dimension: { dimensionName: 'week' } }]
      });
      return r.rows?.map(row => ({
        week: row.dimensionValues[0].value,
        sessions: parseInt(row.metricValues[0].value),
        users: parseInt(row.metricValues[1].value)
      })) || [];
    };

    const [curr, prev] = await Promise.all([
      fetchPeriod(current.startDate, current.endDate),
      fetchPeriod(previous.startDate, previous.endDate)
    ]);

    res.json({ success: true, data: { current: curr, previous: prev } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/geo', requireAuth, async (req, res) => {
  try {
    const client = getAnalyticsClient(req.session.tokens);
    const { current } = getDateRanges();
    const [response] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [{ startDate: current.startDate, endDate: current.endDate }],
      dimensions: [{ name: 'country' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 15
    });

    const countries = response.rows?.map(row => ({
      country: row.dimensionValues[0].value,
      sessions: parseInt(row.metricValues[0].value),
      users: parseInt(row.metricValues[1].value)
    })) || [];
    res.json({ success: true, data: countries });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/top-pages', requireAuth, async (req, res) => {
  try {
    const client = getAnalyticsClient(req.session.tokens);
    const { current, previous } = getDateRanges();

    const fetchPeriod = async (startDate, endDate) => {
      const [r] = await client.runReport({
        property: `properties/${PROPERTY_ID}`,
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 10
      });
      const result = {};
      r.rows?.forEach(row => { result[row.dimensionValues[0].value] = parseInt(row.metricValues[0].value); });
      return result;
    };

    const [curr, prev] = await Promise.all([
      fetchPeriod(current.startDate, current.endDate),
      fetchPeriod(previous.startDate, previous.endDate)
    ]);

    const pages = {};
    [...new Set([...Object.keys(curr), ...Object.keys(prev)])].forEach(k => {
      pages[k] = { current: curr[k] || 0, previous: prev[k] || 0 };
    });
    res.json({ success: true, data: pages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/ai-referrals', requireAuth, async (req, res) => {
  try {
    const client = getAnalyticsClient(req.session.tokens);
    const { current, previous } = getDateRanges();

    const fetchPeriod = async (startDate, endDate) => {
      const [r] = await client.runReport({
        property: `properties/${PROPERTY_ID}`,
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'sessionSource' }],
        metrics: [{ name: 'sessions' }]
      });
      const result = {};
      r.rows?.forEach(row => {
        const source = row.dimensionValues[0].value.toLowerCase();
        const sessions = parseInt(row.metricValues[0].value);
        if (AI_SOURCES.some(ai => source.includes(ai))) {
          result[source] = (result[source] || 0) + sessions;
        }
      });
      return result;
    };

    const [currMap, prevMap] = await Promise.all([
      fetchPeriod(current.startDate, current.endDate),
      fetchPeriod(previous.startDate, previous.endDate)
    ]);

    res.json({
      success: true,
      data: {
        current: Object.entries(currMap).map(([source, sessions]) => ({ source, sessions })).sort((a, b) => b.sessions - a.sessions),
        previous: Object.entries(prevMap).map(([source, sessions]) => ({ source, sessions })),
        totalCurrent: Object.values(currMap).reduce((s, v) => s + v, 0),
        totalPrevious: Object.values(prevMap).reduce((s, v) => s + v, 0)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── AI VISIBILITY TRACKER ─────────────────────────────────────────────────────

app.get('/api/ai-visibility', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, platform, query, cited, notes, date FROM ai_visibility WHERE client = $1 ORDER BY id DESC LIMIT 100',
      [CLIENT]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('AI visibility GET error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/ai-visibility', async (req, res) => {
  try {
    const { platform, query, cited, notes, date } = req.body;
    const id = Date.now();
    const citedBool = cited === true || cited === 'true';
    const dateStr = date || new Date().toISOString().split('T')[0];
    const r = await pool.query(
      `INSERT INTO ai_visibility (id, client, platform, query, cited, notes, date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, platform, query, cited, notes, date`,
      [id, CLIENT, platform, query, citedBool, notes || '', dateStr]
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error('AI visibility POST error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/ai-visibility/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM ai_visibility WHERE id = $1 AND client = $2', [parseInt(req.params.id), CLIENT]);
    res.json({ success: true });
  } catch (err) {
    console.error('AI visibility DELETE error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── LINKEDIN TRACKER ──────────────────────────────────────────────────────────

app.get('/api/linkedin', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, type, topic, impressions, engagement, followers, date FROM linkedin_log WHERE client = $1 ORDER BY id DESC LIMIT 200',
      [CLIENT]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('LinkedIn GET error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/linkedin', async (req, res) => {
  try {
    const { type, topic, impressions, engagement, followers, date } = req.body;
    const id = Date.now();
    await pool.query(
      `INSERT INTO linkedin_log (id, client, type, topic, impressions, engagement, followers, date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, CLIENT, type || 'post', topic, parseInt(impressions) || 0, parseFloat(engagement) || 0, parseInt(followers) || 0, date || new Date().toISOString().split('T')[0]]
    );
    const all = await pool.query(
      'SELECT id, type, topic, impressions, engagement, followers, date FROM linkedin_log WHERE client = $1 ORDER BY id DESC LIMIT 200',
      [CLIENT]
    );
    res.json({ success: true, data: all.rows });
  } catch (err) {
    console.error('LinkedIn POST error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/linkedin/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM linkedin_log WHERE id = $1 AND client = $2', [parseInt(req.params.id), CLIENT]);
    const all = await pool.query(
      'SELECT id, type, topic, impressions, engagement, followers, date FROM linkedin_log WHERE client = $1 ORDER BY id DESC LIMIT 200',
      [CLIENT]
    );
    res.json({ success: true, data: all.rows });
  } catch (err) {
    console.error('LinkedIn DELETE error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST SCHEDULER ────────────────────────────────────────────────────────────

app.get('/api/posts', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, title, copy, format, status, date, time, hashtags, link, notes,
              to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
       FROM posts WHERE client = $1 ORDER BY date NULLS LAST, time NULLS LAST`,
      [CLIENT]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('Posts GET error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/posts', async (req, res) => {
  try {
    const p = req.body || {};
    const id = p.id || 'post_' + Date.now();
    await pool.query(
      `INSERT INTO posts (id, client, title, copy, format, status, date, time, hashtags, link, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         copy = EXCLUDED.copy,
         format = EXCLUDED.format,
         status = EXCLUDED.status,
         date = EXCLUDED.date,
         time = EXCLUDED.time,
         hashtags = EXCLUDED.hashtags,
         link = EXCLUDED.link,
         notes = EXCLUDED.notes,
         updated_at = NOW()`,
      [id, CLIENT, p.title || '', p.copy || '', p.format || 'text', p.status || 'draft',
       p.date || '', p.time || '', p.hashtags || '', p.link || '', p.notes || '']
    );
    res.json({ success: true, id });
  } catch (err) {
    console.error('Posts POST error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/posts/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM posts WHERE id = $1 AND client = $2', [req.params.id, CLIENT]);
    res.json({ success: true });
  } catch (err) {
    console.error('Posts DELETE error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── TECH SEO CHECKLIST ────────────────────────────────────────────────────────

app.get('/api/tech-checklist', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT item_id, checked FROM tech_checklist WHERE client = $1',
      [CLIENT]
    );
    const map = {};
    r.rows.forEach(row => { map[row.item_id] = row.checked; });
    res.json({ success: true, data: map });
  } catch (err) {
    console.error('Tech checklist GET error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/tech-checklist', async (req, res) => {
  try {
    const { item_id, checked } = req.body;
    if (!item_id) return res.status(400).json({ success: false, error: 'item_id required' });
    await pool.query(
      `INSERT INTO tech_checklist (client, item_id, checked, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (client, item_id) DO UPDATE SET checked = EXCLUDED.checked, updated_at = NOW()`,
      [CLIENT, item_id, !!checked]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Tech checklist POST error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── TOP 5 ACTIONS CHECKLIST ───────────────────────────────────────────────────

app.get('/api/bf-actions', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT action_id, checked FROM bf_actions WHERE client = $1',
      [CLIENT]
    );
    const map = {};
    r.rows.forEach(row => { map[row.action_id] = row.checked; });
    res.json({ success: true, data: map });
  } catch (err) {
    console.error('BF actions GET error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/bf-actions', async (req, res) => {
  try {
    const { action_id, checked } = req.body;
    if (!action_id) return res.status(400).json({ success: false, error: 'action_id required' });
    await pool.query(
      `INSERT INTO bf_actions (client, action_id, checked, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (client, action_id) DO UPDATE SET checked = EXCLUDED.checked, updated_at = NOW()`,
      [CLIENT, action_id, !!checked]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('BF actions POST error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/bf-actions', async (req, res) => {
  try {
    await pool.query('DELETE FROM bf_actions WHERE client = $1', [CLIENT]);
    res.json({ success: true });
  } catch (err) {
    console.error('BF actions DELETE error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── COPYWRITER CLIENTS ────────────────────────────────────────────────────────

app.get('/api/copy-clients', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, name, sector, description AS desc, audience, proof FROM copy_clients WHERE client = $1 ORDER BY created_at ASC',
      [CLIENT]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('Copy clients GET error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/copy-clients', async (req, res) => {
  try {
    const c = req.body || {};
    const id = c.id || 'custom_' + Date.now();
    await pool.query(
      `INSERT INTO copy_clients (id, client, name, sector, description, audience, proof)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         sector = EXCLUDED.sector,
         description = EXCLUDED.description,
         audience = EXCLUDED.audience,
         proof = EXCLUDED.proof`,
      [id, CLIENT, c.name || '', c.sector || '', c.desc || c.description || '', c.audience || '', c.proof || '']
    );
    res.json({ success: true, id });
  } catch (err) {
    console.error('Copy clients POST error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/copy-clients/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM copy_clients WHERE id = $1 AND client = $2', [req.params.id, CLIENT]);
    res.json({ success: true });
  } catch (err) {
    console.error('Copy clients DELETE error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── COPYWRITER HISTORY ────────────────────────────────────────────────────────

app.get('/api/copy-history', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, copy_client_name AS client, format, topic, lang, en, pt, date
       FROM copy_history WHERE client = $1 ORDER BY created_at DESC LIMIT 30`,
      [CLIENT]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('Copy history GET error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/copy-history', async (req, res) => {
  try {
    const h = req.body || {};
    const id = h.id || 'copy_' + Date.now();
    await pool.query(
      `INSERT INTO copy_history (id, client, copy_client_name, format, topic, lang, en, pt, date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [id, CLIENT, h.client || h.copy_client_name || '', h.format || '', h.topic || '', h.lang || 'en', h.en || '', h.pt || '', h.date || '']
    );
    // Keep only the most recent 30 entries for this client
    await pool.query(
      `DELETE FROM copy_history WHERE client = $1 AND id NOT IN (
        SELECT id FROM copy_history WHERE client = $1 ORDER BY created_at DESC LIMIT 30
      )`,
      [CLIENT]
    );
    res.json({ success: true, id });
  } catch (err) {
    console.error('Copy history POST error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/copy-history', async (req, res) => {
  try {
    await pool.query('DELETE FROM copy_history WHERE client = $1', [CLIENT]);
    res.json({ success: true });
  } catch (err) {
    console.error('Copy history DELETE error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── CITATION TOOL ─────────────────────────────────────────────────────────────

app.get('/citation', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'citation.html'));
});

// ── LINKEDIN GROWTH TOOL ──────────────────────────────────────────────────────

app.get('/linkedin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'linkedin-growth-tool.html'));
});

// ── AI GENERATE PROXY ─────────────────────────────────────────────────────────
// Routes all Claude API calls through the server so the API key is never
// exposed in the browser and iframe CSP restrictions are avoided.

const CLAUDE_MODEL = 'claude-sonnet-4-5';

app.post('/api/generate', async (req, res) => {
  const { system, prompt, max_tokens } = req.body;
  if (!prompt) return res.status(400).json({ success: false, error: 'prompt is required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured on server' });

  try {
    const body = {
      model: CLAUDE_MODEL,
      max_tokens: max_tokens || 1000,
      messages: [{ role: 'user', content: prompt }]
    };
    if (system) body.system = system;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ success: false, error: data.error?.message || 'Anthropic API error' });

    const text = (data.content || []).map(b => b.text || '').join('');
    res.json({ success: true, text });
  } catch (err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Vision endpoint — accepts a base64 image alongside the prompt
app.post('/api/generate-vision', async (req, res) => {
  const { system, prompt, imageBase64, max_tokens } = req.body;
  if (!prompt || !imageBase64) return res.status(400).json({ success: false, error: 'prompt and imageBase64 are required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured on server' });

  try {
    const body = {
      model: CLAUDE_MODEL,
      max_tokens: max_tokens || 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: prompt }
        ]
      }]
    };
    if (system) body.system = system;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ success: false, error: data.error?.message || 'Anthropic API error' });

    const text = (data.content || []).map(b => b.text || '').join('');
    res.json({ success: true, text });
  } catch (err) {
    console.error('Vision error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GOOGLE SEARCH CONSOLE ────────────────────────────────────────────────────

const GSC_SITE = process.env.GSC_SITE_URL || 'sc-domain:briskfil.com';

function getGscClient(tokens) {
  const auth = getOAuthClient();
  auth.setCredentials(tokens);
  return google.searchconsole({ version: 'v1', auth });
}

function gscRange(days) {
  const end = new Date();
  end.setDate(end.getDate() - 3);
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  const fmt = d => d.toISOString().split('T')[0];
  return { startDate: fmt(start), endDate: fmt(end) };
}

// Top queries — what people search to find briskfil.com
app.get('/api/gsc/queries', requireAuth, async (req, res) => {
  try {
    const gsc = getGscClient(req.session.tokens);
    const { startDate, endDate } = gscRange(90);
    const result = await gsc.searchanalytics.query({
      siteUrl: GSC_SITE,
      requestBody: {
        startDate, endDate,
        dimensions: ['query'],
        rowLimit: 50,
        orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }]
      }
    });
    res.json({ success: true, rows: result.data.rows || [], period: { startDate, endDate } });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Overview metrics
app.get('/api/gsc/overview', requireAuth, async (req, res) => {
  try {
    const gsc = getGscClient(req.session.tokens);
    const curr = gscRange(28);
    const prevEnd = new Date(curr.startDate);
    prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd);
    prevStart.setDate(prevStart.getDate() - 28);
    const fmt = d => d.toISOString().split('T')[0];
    const prev = { startDate: fmt(prevStart), endDate: fmt(prevEnd) };

    const query = (range) => gsc.searchanalytics.query({
      siteUrl: GSC_SITE,
      requestBody: { startDate: range.startDate, endDate: range.endDate, dimensions: [], rowLimit: 1 }
    });
    const [currRes, prevRes] = await Promise.all([query(curr), query(prev)]);
    res.json({
      success: true,
      current: currRes.data.rows?.[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 },
      previous: prevRes.data.rows?.[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 },
      period: curr
    });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Top pages
app.get('/api/gsc/pages', requireAuth, async (req, res) => {
  try {
    const gsc = getGscClient(req.session.tokens);
    const { startDate, endDate } = gscRange(90);
    const result = await gsc.searchanalytics.query({
      siteUrl: GSC_SITE,
      requestBody: {
        startDate, endDate,
        dimensions: ['page'],
        rowLimit: 15,
        orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }]
      }
    });
    res.json({ success: true, rows: result.data.rows || [] });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── CATCH-ALL (keep this last) ────────────────────────────────────────────────

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await initSchema();
  } catch (err) {
    console.error('Failed to initialise database schema. Server starting anyway.');
  }
  app.listen(PORT, () => console.log(`Briskfil dashboard running on port ${PORT}`));
})();
