require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PROPERTY_ID = process.env.GA4_PROPERTY_ID || '307311147';

function getAnalyticsClient() {
  const credsEnv = process.env.GOOGLE_CREDENTIALS;
  if (!credsEnv) throw new Error('GOOGLE_CREDENTIALS environment variable not set');
  const credentials = JSON.parse(credsEnv);
  return new BetaAnalyticsDataClient({ credentials });
}

function getDateRanges() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const firstThisMonth = new Date(y, m, 1);
  const firstLastMonth = new Date(y, m - 1, 1);
  const lastLastMonth = new Date(y, m, 0);
  const fmt = d => d.toISOString().split('T')[0];
  return {
    current: { startDate: fmt(firstThisMonth), endDate: 'today' },
    previous: { startDate: fmt(firstLastMonth), endDate: fmt(lastLastMonth) }
  };
}

const AI_SOURCES = [
  'chatgpt.com', 'chat.openai.com', 'perplexity.ai', 'claude.ai',
  'gemini.google.com', 'copilot.microsoft.com', 'you.com',
  'phind.com', 'bing.com', 'bard.google.com'
];

app.get('/api/overview', async (req, res) => {
  try {
    const client = getAnalyticsClient();
    const { current, previous } = getDateRanges();

    const [response] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [
        { startDate: current.startDate, endDate: current.endDate, name: 'current' },
        { startDate: previous.startDate, endDate: previous.endDate, name: 'previous' }
      ],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'bounceRate' },
        { name: 'averageSessionDuration' },
        { name: 'screenPageViews' },
        { name: 'engagementRate' }
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

app.get('/api/organic', async (req, res) => {
  try {
    const client = getAnalyticsClient();
    const { current, previous } = getDateRanges();

    const [response] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [
        { startDate: current.startDate, endDate: current.endDate, name: 'current' },
        { startDate: previous.startDate, endDate: previous.endDate, name: 'previous' }
      ],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'bounceRate' }]
    });

    const channels = {};
    response.rows?.forEach(row => {
      const period = row.dimensionValues[1]?.value || 'current';
      const channel = row.dimensionValues[0].value;
      if (!channels[channel]) channels[channel] = { current: 0, previous: 0 };
      channels[channel][period] = parseInt(row.metricValues[0].value);
    });

    res.json({ success: true, data: channels });
  } catch (err) {
    console.error('Organic error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/traffic-trend', async (req, res) => {
  try {
    const client = getAnalyticsClient();
    const { current, previous } = getDateRanges();

    const [response] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [
        { startDate: current.startDate, endDate: current.endDate, name: 'current' },
        { startDate: previous.startDate, endDate: previous.endDate, name: 'previous' }
      ],
      dimensions: [{ name: 'week' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      orderBys: [{ dimension: { dimensionName: 'week' } }]
    });

    const weeks = { current: [], previous: [] };
    response.rows?.forEach(row => {
      const period = row.dimensionValues[1]?.value || 'current';
      weeks[period].push({
        week: row.dimensionValues[0].value,
        sessions: parseInt(row.metricValues[0].value),
        users: parseInt(row.metricValues[1].value)
      });
    });

    res.json({ success: true, data: weeks });
  } catch (err) {
    console.error('Traffic trend error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/geo', async (req, res) => {
  try {
    const client = getAnalyticsClient();
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
    console.error('Geo error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/top-pages', async (req, res) => {
  try {
    const client = getAnalyticsClient();
    const { current, previous } = getDateRanges();

    const [response] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [
        { startDate: current.startDate, endDate: current.endDate, name: 'current' },
        { startDate: previous.startDate, endDate: previous.endDate, name: 'previous' }
      ],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'averageSessionDuration' }, { name: 'bounceRate' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 10
    });

    const pages = {};
    response.rows?.forEach(row => {
      const period = row.dimensionValues[1]?.value || 'current';
      const path = row.dimensionValues[0].value;
      if (!pages[path]) pages[path] = { current: 0, previous: 0 };
      pages[path][period] = parseInt(row.metricValues[0].value);
    });

    res.json({ success: true, data: pages });
  } catch (err) {
    console.error('Top pages error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/ai-referrals', async (req, res) => {
  try {
    const client = getAnalyticsClient();
    const { current, previous } = getDateRanges();

    const [response] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [
        { startDate: current.startDate, endDate: current.endDate, name: 'current' },
        { startDate: previous.startDate, endDate: previous.endDate, name: 'previous' }
      ],
      dimensions: [{ name: 'sessionSource' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }]
    });

    const aiReferrals = { current: [], previous: [], totalCurrent: 0, totalPrevious: 0 };

    const currentMap = {};
    const previousMap = {};

    response.rows?.forEach(row => {
      const period = row.dimensionValues[1]?.value || 'current';
      const source = row.dimensionValues[0].value.toLowerCase();
      const sessions = parseInt(row.metricValues[0].value);

      const isAI = AI_SOURCES.some(ai => source.includes(ai.split('.')[0]));
      if (isAI) {
        if (period === 'current') {
          currentMap[source] = (currentMap[source] || 0) + sessions;
          aiReferrals.totalCurrent += sessions;
        } else {
          previousMap[source] = (previousMap[source] || 0) + sessions;
          aiReferrals.totalPrevious += sessions;
        }
      }
    });

    aiReferrals.current = Object.entries(currentMap).map(([source, sessions]) => ({ source, sessions })).sort((a, b) => b.sessions - a.sessions);
    aiReferrals.previous = Object.entries(previousMap).map(([source, sessions]) => ({ source, sessions }));

    res.json({ success: true, data: aiReferrals });
  } catch (err) {
    console.error('AI referrals error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// AI Visibility manual tracker - stored in memory (use a DB for persistence in production)
let aiVisibilityLog = [];

app.get('/api/ai-visibility', (req, res) => {
  res.json({ success: true, data: aiVisibilityLog });
});

app.post('/api/ai-visibility', (req, res) => {
  const { platform, query, cited, notes, date } = req.body;
  const entry = {
    id: Date.now(),
    platform,
    query,
    cited: cited === true || cited === 'true',
    notes: notes || '',
    date: date || new Date().toISOString().split('T')[0],
    addedAt: new Date().toISOString()
  };
  aiVisibilityLog.unshift(entry);
  aiVisibilityLog = aiVisibilityLog.slice(0, 100);
  res.json({ success: true, data: entry });
});

app.delete('/api/ai-visibility/:id', (req, res) => {
  aiVisibilityLog = aiVisibilityLog.filter(e => e.id !== parseInt(req.params.id));
  res.json({ success: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Briskfil dashboard running on port ${PORT}`));
