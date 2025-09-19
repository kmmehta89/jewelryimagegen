// api/share.js - Share conversation endpoint
const { Storage } = require('@google-cloud/storage');

// Initialize Google Cloud Storage (reuse your existing config from chat.js)
const keyJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
keyJson.private_key = keyJson.private_key.replace(/\\n/g, "\n");

const storage = new Storage({
  credentials: keyJson,
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
});

const bucketName = process.env.GOOGLE_STORAGE_BUCKET || 'jewelry-designs-bucket';

// Generate a unique share ID
function generateShareId() {
  return 'share_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Save conversation to Google Cloud Storage
async function saveSharedConversation(shareId, conversationData) {
  try {
    const bucket = storage.bucket(bucketName);
    const fileName = `shared-conversations/${shareId}.json`;
    const file = bucket.file(fileName);
    
    const conversationJson = JSON.stringify(conversationData, null, 2);
    
    await file.save(conversationJson, {
      metadata: {
        contentType: 'application/json',
      }
    });
    
    return fileName;
  } catch (error) {
    console.error('Error saving shared conversation:', error);
    throw error;
  }
}

// Retrieve shared conversation from Google Cloud Storage
async function getSharedConversation(shareId) {
  try {
    const bucket = storage.bucket(bucketName);
    const fileName = `shared-conversations/${shareId}.json`;
    const file = bucket.file(fileName);
    
    const [exists] = await file.exists();
    if (!exists) {
      return null;
    }
    
    const [contents] = await file.download();
    return JSON.parse(contents.toString());
  } catch (error) {
    console.error('Error retrieving shared conversation:', error);
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    if (req.method === 'POST') {
      // Create shared conversation
      const { conversationHistory, title } = req.body;
      
      if (!conversationHistory || !Array.isArray(conversationHistory)) {
        return res.status(400).json({ error: 'Invalid conversation history' });
      }
      
      // Filter out system messages and format for sharing
      const shareableHistory = conversationHistory.map(msg => ({
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp || new Date().toISOString(),
        imageUrl: msg.imageUrl || null,
        metadata: msg.metadata || null
      }));
      
      const shareId = generateShareId();
      const conversationData = {
        id: shareId,
        title: title || 'Jewelry Design Conversation',
        messages: shareableHistory,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
      };
      
      await saveSharedConversation(shareId, conversationData);
      
      const shareUrl = `https://www.gjsusa.com/home?share=${shareId}`;
      
      res.status(200).json({
        success: true,
        shareId,
        shareUrl,
        expiresAt: conversationData.expiresAt
      });
      
    } else if (req.method === 'GET') {
      // Retrieve shared conversation
      const { shareId } = req.query;
      
      if (!shareId) {
        return res.status(400).json({ error: 'Share ID required' });
      }
      
      const conversationData = await getSharedConversation(shareId);
      
      if (!conversationData) {
        return res.status(404).json({ error: 'Shared conversation not found or expired' });
      }
      
      // Check if conversation has expired
      if (new Date() > new Date(conversationData.expiresAt)) {
        return res.status(410).json({ error: 'Shared conversation has expired' });
      }
      
      res.status(200).json({
        success: true,
        conversation: conversationData
      });
      
    } else {
      res.status(405).json({ error: 'Method not allowed' });
    }
    
  } catch (error) {
    console.error('Share API Error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message,
      details: {
        hasGoogleCredentials: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
        hasGoogleProjectId: !!process.env.GOOGLE_CLOUD_PROJECT_ID,
        hasStorageBucket: !!process.env.GOOGLE_STORAGE_BUCKET
      }
    });
  }
};
