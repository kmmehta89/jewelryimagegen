// api/analytics.js - Track global usage metrics
const { Storage } = require('@google-cloud/storage');

const keyJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
keyJson.private_key = keyJson.private_key.replace(/\\n/g, "\n");

const storage = new Storage({
  credentials: keyJson,
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
});

const bucketName = process.env.GOOGLE_STORAGE_BUCKET || 'jewelry-designs-bucket';
const ANALYTICS_FILE = 'analytics/global-stats.json';

// Initialize with existing data
const INITIAL_STATS = {
  totalImagesGenerated: 750, // Starting count
  totalSessions: 0,
  totalDownloads: 0,
  totalShares: 0,
  totalRefinements: 0,
  lastUpdated: new Date().toISOString(),
  dailyStats: {},
  brandStats: {}
};

async function getAnalytics() {
  try {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(ANALYTICS_FILE);
    
    const [exists] = await file.exists();
    if (!exists) {
      await file.save(JSON.stringify(INITIAL_STATS, null, 2), {
        contentType: 'application/json'
      });
      return INITIAL_STATS;
    }
    
    const [contents] = await file.download();
    return JSON.parse(contents.toString());
  } catch (error) {
    console.error('Error reading analytics:', error);
    return INITIAL_STATS;
  }
}

async function updateAnalytics(analytics) {
  try {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(ANALYTICS_FILE);
    
    analytics.lastUpdated = new Date().toISOString();
    
    await file.save(JSON.stringify(analytics, null, 2), {
      contentType: 'application/json'
    });
    
    return analytics;
  } catch (error) {
    console.error('Error updating analytics:', error);
    throw error;
  }
}

function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

async function trackEvent(eventType, data = {}) {
  const analytics = await getAnalytics();
  const today = getTodayKey();
  const brand = data.brand || 'default';
  
  // Initialize daily stats if needed
  if (!analytics.dailyStats[today]) {
    analytics.dailyStats[today] = {
      imagesGenerated: 0,
      sessions: 0,
      downloads: 0,
      shares: 0,
      refinements: 0,
      brands: {}
    };
  }
  
  // Initialize brand stats if needed
  if (!analytics.brandStats[brand]) {
    analytics.brandStats[brand] = {
      totalImages: 0,
      totalSessions: 0,
      totalDownloads: 0,
      totalShares: 0,
      totalRefinements: 0,
      firstUsed: new Date().toISOString(),
      lastUsed: new Date().toISOString()
    };
  }
  
  if (!analytics.dailyStats[today].brands[brand]) {
    analytics.dailyStats[today].brands[brand] = {
      images: 0,
      sessions: 0,
      downloads: 0,
      shares: 0,
      refinements: 0
    };
  }
  
  // Update counters based on event type
  switch (eventType) {
    case 'image_generated':
      analytics.totalImagesGenerated++;
      analytics.dailyStats[today].imagesGenerated++;
      analytics.brandStats[brand].totalImages++;
      analytics.dailyStats[today].brands[brand].images++;
      break;
      
    case 'session_start':
      analytics.totalSessions++;
      analytics.dailyStats[today].sessions++;
      analytics.brandStats[brand].totalSessions++;
      analytics.dailyStats[today].brands[brand].sessions++;
      break;
      
    case 'download':
      analytics.totalDownloads++;
      analytics.dailyStats[today].downloads++;
      analytics.brandStats[brand].totalDownloads++;
      analytics.dailyStats[today].brands[brand].downloads++;
      break;
      
    case 'share':
      analytics.totalShares++;
      analytics.dailyStats[today].shares++;
      analytics.brandStats[brand].totalShares++;
      analytics.dailyStats[today].brands[brand].shares++;
      break;
      
    case 'refinement':
      analytics.totalRefinements++;
      analytics.dailyStats[today].refinements++;
      analytics.brandStats[brand].totalRefinements++;
      analytics.dailyStats[today].brands[brand].refinements++;
      break;
  }
  
  analytics.brandStats[brand].lastUsed = new Date().toISOString();
  
  // Clean up old daily stats (keep last 90 days)
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const cutoffDate = ninetyDaysAgo.toISOString().split('T')[0];
  
  Object.keys(analytics.dailyStats).forEach(date => {
    if (date < cutoffDate) {
      delete analytics.dailyStats[date];
    }
  });
  
  await updateAnalytics(analytics);
  return analytics;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    if (req.method === 'GET') {
      // Get analytics data
      const analytics = await getAnalytics();
      const today = getTodayKey();
      
      res.status(200).json({
        success: true,
        global: {
          totalImagesGenerated: analytics.totalImagesGenerated,
          totalSessions: analytics.totalSessions,
          totalDownloads: analytics.totalDownloads,
          totalShares: analytics.totalShares,
          totalRefinements: analytics.totalRefinements
        },
        today: analytics.dailyStats[today] || {
          imagesGenerated: 0,
          sessions: 0,
          downloads: 0,
          shares: 0,
          refinements: 0,
          brands: {}
        },
        brands: analytics.brandStats,
        lastUpdated: analytics.lastUpdated
      });
      
    } else if (req.method === 'POST') {
      // Track an event
      const { eventType, data } = req.body;
      
      if (!eventType) {
        return res.status(400).json({ error: 'eventType is required' });
      }
      
      const analytics = await trackEvent(eventType, data);
      
      res.status(200).json({
        success: true,
        totalImagesGenerated: analytics.totalImagesGenerated
      });
      
    } else {
      res.status(405).json({ error: 'Method not allowed' });
    }
    
  } catch (error) {
    console.error('Analytics API Error:', error);
    res.status(500).json({ 
      error: 'Analytics tracking failed',
      message: error.message
    });
  }
};

module.exports.trackEvent = trackEvent;
module.exports.getAnalytics = getAnalytics;
