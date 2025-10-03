// api/create-hubspot-contact.js - Fixed to prevent double counting
const hubspot = require('@hubspot/api-client');
const hubspotClient = new hubspot.Client({
  accessToken: process.env.HUBSPOT_ACCESS_TOKEN
});

function validateSessionData(sessionData, conversionTrigger) {
  console.log('Validating session data for trigger:', conversionTrigger);
  
  const maxReasonableCount = 50;
  
  if (sessionData.imagesGenerated > maxReasonableCount) {
    console.warn('Unusually high image count:', sessionData.imagesGenerated);
  }
  
  if (sessionData.downloadsCount > sessionData.imagesGenerated) {
    console.warn('Downloads exceed images generated - possible double counting');
  }
  
  return sessionData;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.gjsusa.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { 
      email, 
      sessionData: rawSessionData, 
      conversationHistory, 
      conversionTrigger, 
      imageUrl, 
      actionDetails 
    } = req.body;
    
    const sessionData = validateSessionData(rawSessionData, conversionTrigger);
    
    console.log('Processing contact for email:', email);
    console.log('Conversion trigger:', conversionTrigger);
    console.log('Session data:', sessionData);
    
    let existingContact = null;
    let contactId = null;
    
    try {
      const searchResults = await hubspotClient.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator: 'EQ',
            value: email
          }]
        }],
        properties: [
          'email',
          'chatbot_sessions_count',
          'images_generated_count',
          'refinements_made_count',
          'downloads_count',
          'designs_shared_count',
          'first_jewelry_interest',
          'last_chat_date',
          'conversion_trigger',
          'downloaded_images_history',
          'shared_images_history',
          'generated_images_history',
          'brand_usage' // NEW: Track which brands user has used
        ]
      });
      
      if (searchResults.results && searchResults.results.length > 0) {
        existingContact = searchResults.results[0];
        contactId = existingContact.id;
        console.log('Found existing contact:', contactId);
      }
    } catch (searchError) {
      console.log('Contact search failed, will create new contact:', searchError.message);
    }

    // Build image history arrays (fixed to avoid duplication)
    const imageHistories = buildImageHistories(existingContact, imageUrl, actionDetails, conversionTrigger);
    
    // Calculate cumulative values (fixed to only count real actions)
    const cumulativeData = calculateCumulativeData(existingContact, sessionData, conversionTrigger);
    
    // Update brand usage
    const brandUsage = updateBrandUsage(existingContact, actionDetails?.brand);
    
    const contactProperties = {
      email: email,
      chatbot_sessions_count: cumulativeData.sessionsCount,
      images_generated_count: cumulativeData.imagesGenerated,
      refinements_made_count: cumulativeData.refinementsMade,
      downloads_count: cumulativeData.downloadsCount,
      designs_shared_count: cumulativeData.sharesCount,
      first_jewelry_interest: sessionData.firstJewelryType || existingContact?.properties?.first_jewelry_interest || 'not specified',
      last_chat_date: new Date().toISOString().split('T')[0],
      conversion_trigger: conversionTrigger,
      downloaded_images_history: imageHistories.downloaded,
      shared_images_history: imageHistories.shared,
      generated_images_history: imageHistories.generated,
      brand_usage: brandUsage
    };
    
    console.log('Contact properties to send:', contactProperties);
    
    let response;
    
    if (contactId) {
      console.log('Updating existing contact...');
      response = await hubspotClient.crm.contacts.basicApi.update(contactId, {
        properties: contactProperties
      });
      console.log('HubSpot update response received');
    } else {
      console.log('Creating new contact...');
      response = await hubspotClient.crm.contacts.basicApi.create({
        properties: contactProperties,
        associations: []
      });
      console.log('HubSpot create response received');
      contactId = response.id;
    }
    
    // Create a note/activity for this specific action with image URL
    if (contactId && (imageUrl || conversionTrigger === 'email_captured')) {
      await createImageActionNote(contactId, conversionTrigger, imageUrl, actionDetails);
    }
    
    res.status(200).json({ 
      success: true, 
      contactId: contactId,
      action: contactId === response.id ? 'created' : 'updated'
    });
    
  } catch (error) {
    console.error('HubSpot API Error:', error);
    console.error('Error message:', error.message);
    console.error('Error response data:', error.response?.data);
    
    res.status(500).json({ 
      error: error.message,
      details: error.response?.data || 'No additional details'
    });
  }
};

function buildImageHistories(existingContact, imageUrl, actionDetails, conversionTrigger) {
  if (!imageUrl) {
    return {
      downloaded: existingContact?.properties?.downloaded_images_history || '',
      shared: existingContact?.properties?.shared_images_history || '',
      generated: existingContact?.properties?.generated_images_history || ''
    };
  }
  
  const timestamp = new Date().toISOString();
  const imageEntry = `${timestamp}|${imageUrl}|${actionDetails?.filename || 'unknown'}`;
  
  const existingDownloaded = existingContact?.properties?.downloaded_images_history || '';
  const existingShared = existingContact?.properties?.shared_images_history || '';
  const existingGenerated = existingContact?.properties?.generated_images_history || '';
  
  let downloadedHistory = existingDownloaded;
  let sharedHistory = existingShared;
  let generatedHistory = existingGenerated;
  
  // FIXED: Only add to the specific history that matches the trigger
  if (conversionTrigger === 'download') {
    downloadedHistory = addToImageHistory(existingDownloaded, imageEntry);
  } else if (conversionTrigger === 'share') {
    sharedHistory = addToImageHistory(existingShared, imageEntry);
  } else if (conversionTrigger === 'image_generated') {
    generatedHistory = addToImageHistory(existingGenerated, imageEntry);
  }
  
  return {
    downloaded: downloadedHistory,
    shared: sharedHistory,
    generated: generatedHistory
  };
}

function addToImageHistory(existingHistory, newEntry) {
  const entries = existingHistory ? existingHistory.split(';;') : [];
  
  // Check if this exact entry already exists to prevent duplicates
  if (entries.includes(newEntry)) {
    console.log('Duplicate entry detected, skipping:', newEntry);
    return existingHistory;
  }
  
  entries.push(newEntry);
  
  // Keep only last 50 entries
  const limitedEntries = entries.slice(-50);
  
  return limitedEntries.join(';;');
}

// FIXED: Only increment counters based on actual conversion triggers
function calculateCumulativeData(existingContact, sessionData, conversionTrigger) {
  const existing = existingContact?.properties || {};
  
  // Start with existing values
  let result = {
    sessionsCount: parseInt(existing.chatbot_sessions_count) || 0,
    imagesGenerated: parseInt(existing.images_generated_count) || 0,
    refinementsMade: parseInt(existing.refinements_made_count) || 0,
    downloadsCount: parseInt(existing.downloads_count) || 0,
    sharesCount: parseInt(existing.designs_shared_count) || 0
  };
  
  // FIXED: Only increment specific counters based on the exact trigger
  // Don't add bulk session data anymore - only increment on specific actions
  switch(conversionTrigger) {
    case 'download':
      result.downloadsCount += 1;
      break;
    case 'share':
      result.sharesCount += 1;
      break;
    case 'image_generated':
      result.imagesGenerated += 1;
      break;
    case 'refinement_made':
      result.refinementsMade += 1;
      break;
    case 'email_captured':
      // First time email captured - add their current session totals
      result.imagesGenerated += sessionData.imagesGenerated || 0;
      result.refinementsMade += sessionData.refinementsMade || 0;
      result.downloadsCount += sessionData.downloadsCount || 0;
      result.sharesCount += sessionData.sharesCount || 0;
      result.sessionsCount += 1;
      break;
    case 'session_end':
      result.sessionsCount += 1;
      break;
  }
  
  return result;
}

function updateBrandUsage(existingContact, newBrand) {
  if (!newBrand) return existingContact?.properties?.brand_usage || 'default';
  
  const existing = existingContact?.properties?.brand_usage || '';
  const brands = existing ? existing.split(',').map(b => b.trim()) : [];
  
  if (!brands.includes(newBrand)) {
    brands.push(newBrand);
  }
  
  return brands.join(', ');
}

async function createImageActionNote(contactId, actionType, imageUrl, actionDetails) {
  try {
    const noteContent = formatImageActionNote(actionType, imageUrl, actionDetails);
    
    const noteProperties = {
      hs_timestamp: Date.now(),
      hs_note_body: noteContent,
      hubspot_owner_id: null
    };
    
    await hubspotClient.crm.objects.notes.basicApi.create({
      properties: noteProperties,
      associations: [
        {
          to: { id: contactId },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 202
            }
          ]
        }
      ]
    });
    
    console.log(`Created note for ${actionType} action on contact ${contactId}`);
  } catch (noteError) {
    console.error('Failed to create note:', noteError);
  }
}

function formatImageActionNote(actionType, imageUrl, actionDetails) {
  const timestamp = new Date().toLocaleString();
  
  const actionTitles = {
    'download': '📥 Image Downloaded',
    'share': '📤 Design Shared', 
    'project_inquiry': '🚀 Project Inquiry',
    'image_generated': '🎨 Image Generated',
    'refinement_made': '✨ Design Refined',
    'session_end': '📊 Session Completed',
    'email_captured': '📧 Email Captured'
  };
  
  let note = `${actionTitles[actionType] || 'Action Taken'} - ${timestamp}\n\n`;
  
  if (imageUrl) {
    note += `Image URL: ${imageUrl}\n`;
  }
  
  if (actionDetails?.filename) {
    note += `Filename: ${actionDetails.filename}\n`;
  }
  
  if (actionDetails?.jewelryType) {
    note += `Jewelry Type: ${actionDetails.jewelryType}\n`;
  }
  
  if (actionDetails?.brand) {
    note += `Brand: ${actionDetails.brand}\n`;
  }
  
  if (actionDetails?.shareUrl) {
    note += `Share URL: ${actionDetails.shareUrl}\n`;
  }
  
  if (actionType === 'project_inquiry') {
    note += `\n⭐ HIGH VALUE LEAD ⭐\n`;
    note += `Customer expressed interest in custom jewelry project.\n`;
    note += `Source: ${actionDetails?.source || 'Cleo AI Chat'}\n`;
    
    if (actionDetails?.isShared) {
      note += `Originated from shared conversation.\n`;
    }
  }
  
  if (actionType === 'session_end') {
    note += `\nSession Summary:\n`;
    note += `- Images Generated: ${actionDetails?.imagesGenerated || 0}\n`;
    note += `- Downloads: ${actionDetails?.downloadsCount || 0}\n`;
    note += `- Refinements: ${actionDetails?.refinementsMade || 0}\n`;
  }
  
  if (actionType === 'email_captured') {
    note += `\n🎯 First Contact Made\n`;
    note += `User provided email for the first time.\n`;
    note += `Session activity before email capture:\n`;
    note += `- Images Generated: ${actionDetails?.imagesGenerated || 0}\n`;
    note += `- Downloads: ${actionDetails?.downloadsCount || 0}\n`;
    note += `- Refinements: ${actionDetails?.refinementsMade || 0}\n`;
  }
  
  return note;
}
