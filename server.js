require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
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

// AUTH ROUTES
app.get('/auth/login', (req, res) => {
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/analytics.readonly']
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

// API ROUTES
app.get('/api/overview', requireAuth, async (req, res) => {
  try {
    const client = getAnalyticsClient(req.session.tokens);
    const { current, previous } = getDateRanges();
    const [response] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [
        { startDate: current.startDate, endDate: current.endDate, name: 'current' },
        { startDate: previous.startDate, endDate: previous.endDate, name: 'previous' }
      ],
      metrics: [
        { name: 'sessions' }, { name: 'totalUsers' }, { name: 'bounceRate' },
        { name: 'averageSessionDuration' }, { name: 'screenPageViews' }, { name: 'engagementRate' }
      ]
    });

    const data = { current: {}, previous: {} };
    response.rows?.forEach(row => {
      const period = row.dimensionValues[0].value;
      data[period] = {
        sessions: parseInt(row.metricValues[0].value),
        users: parseInt(row.metricValues[1].value),
        bounceRate: parseFloat(row.metricValues[2].value) * 100,
        avgDuration: parseFloat(row.metricValues[3].value),
        pageViews: parseInt(row.metricValues[4].value),
        engagementRate: parseFloat(row.metricValues[5].value) * 100
      };
    });
    res.json({ success: true, data, dateRanges: { current, previous } });
  } catch (err) {
    console.error('Overview error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/organic', requireAuth, async (req, res) => {
  try {
    const client = getAnalyticsClient(req.session.tokens);
    const { current, previous } = getDateRanges();
    const [response] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [
        { startDate: current.startDate, endDate: current.endDate, name: 'current' },
        { startDate: previous.startDate, endDate: previous.endDate, name: 'previous' }
      ],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }, { name: 'dateRange' }],
      metrics: [{ name: 'sessions' }]
    });

    const channels = {};
    response.rows?.forEach(row => {
      const channel = row.dimensionValues[0].value;
      const period = row.dimensionValues[1].value;
      if (!channels[channel]) channels[channel] = { current: 0, previous: 0 };
      channels[channel][period] = parseInt(row.metricValues[0].value);
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
    const [response] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [
        { startDate: current.startDate, endDate: current.endDate, name: 'current' },
        { startDate: previous.startDate, endDate: previous.endDate, name: 'previous' }
      ],
      dimensions: [{ name: 'week' }, { name: 'dateRange' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      orderBys: [{ dimension: { dimensionName: 'week' } }]
    });

    const weeks = { current: [], previous: [] };
    response.rows?.forEach(row => {
      const period = row.dimensionValues[1].value;
      weeks[period].push({
        week: row.dimensionValues[0].value,
        sessions: parseInt(row.metricValues[0].value),
        users: parseInt(row.metricValues[1].value)
      });
    });
    res.json({ success: true, data: weeks });
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
    const [response] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [
        { startDate: current.startDate, endDate: current.endDate, name: 'current' },
        { startDate: previous.startDate, endDate: previous.endDate, name: 'previous' }
      ],
      dimensions: [{ name: 'pagePath' }, { name: 'dateRange' }],
      metrics: [{ name: 'screenPageViews' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 20
    });

    const pages = {};
    response.rows?.forEach(row => {
      const p = row.dimensionValues[0].value;
      const period = row.dimensionValues[1].value;
      if (!pages[p]) pages[p] = { current: 0, previous: 0 };
      pages[p][period] = parseInt(row.metricValues[0].value);
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
    const [response] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [
        { startDate: current.startDate, endDate: current.endDate, name: 'current' },
        { startDate: previous.startDate, endDate: previous.endDate, name: 'previous' }
      ],
      dimensions: [{ name: 'sessionSource' }, { name: 'dateRange' }],
      metrics: [{ name: 'sessions' }]
    });

    const currentMap = {}, previousMap = {};
    let totalCurrent = 0, totalPrevious = 0;

    response.rows?.forEach(row => {
      const source = row.dimensionValues[0].value.toLowerCase();
      const period = row.dimensionValues[1].value;
      const sessions = parseInt(row.metricValues[0].value);
      const isAI = AI_SOURCES.some(ai => source.includes(ai));
      if (isAI) {
        if (period === 'current') { currentMap[source] = (currentMap[source] || 0) + sessions; totalCurrent += sessions; }
        else { previousMap[source] = (previousMap[source] || 0) + sessions; totalPrevious += sessions; }
      }
    });

    res.json({
      success: true,
      data: {
        current: Object.entries(currentMap).map(([source, sessions]) => ({ source, sessions })).sort((a, b) => b.sessions - a.sessions),
        previous: Object.entries(previousMap).map(([source, sessions]) => ({ source, sessions })),
        totalCurrent, totalPrevious
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

let aiVisibilityLog = [];

app.get('/api/ai-visibility', (req, res) => res.json({ success: true, data: aiVisibilityLog }));

app.post('/api/ai-visibility', (req, res) => {
  const { platform, query, cited, notes, date } = req.body;
  const entry = { id: Date.now(), platform, query, cited: cited === true || cited === 'true', notes: notes || '', date: date || new Date().toISOString().split('T')[0] };
  aiVisibilityLog.unshift(entry);
  aiVisibilityLog = aiVisibilityLog.slice(0, 100);
  res.json({ success: true, data: entry });
});

app.delete('/api/ai-visibility/:id', (req, res) => {
  aiVisibilityLog = aiVisibilityLog.filter(e => e.id !== parseInt(req.params.id));
  res.json({ success: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Briskfil dashboard running on port ${PORT}`));
