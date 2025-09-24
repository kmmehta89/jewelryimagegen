const hubspot = require('@hubspot/api-client');
const hubspotClient = new hubspot.Client({
  accessToken: process.env.HUBSPOT_ACCESS_TOKEN
});

module.exports = async function handler(req, res) {
  // CORS headers
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
    console.log('Testing HubSpot token...');
    console.log('Token starts with:', process.env.HUBSPOT_ACCESS_TOKEN?.substring(0, 10));
    
    // Simple test call
    const testResponse = await hubspotClient.crm.contacts.basicApi.getPage();
    console.log('Token test successful');
    console.log('Request body:', req.body);
    
    const { 
      email, 
      sessionData, 
      conversationHistory, 
      conversionTrigger, 
      imageUrl, 
      actionDetails 
    } = req.body;
    
    console.log('Processing contact for email:', email);
    console.log('Session data:', sessionData);
    console.log('Action details:', actionDetails);
    console.log('Image URL:', imageUrl);
    
    // First, try to find existing contact to get current image history
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
          'downloaded_images_history', // New field for image history
          'shared_images_history',     // New field for shared images
          'generated_images_history'   // New field for all generated images
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

    // Build image history arrays
    const imageHistories = buildImageHistories(existingContact, imageUrl, actionDetails, conversionTrigger);
    
    // Calculate cumulative values
    const cumulativeData = calculateCumulativeData(existingContact, sessionData, conversionTrigger);
    
    const contactProperties = {
      email: email,
      chatbot_sessions_count: cumulativeData.sessionsCount,
      images_generated_count: cumulativeData.imagesGenerated,
      refinements_made_count: cumulativeData.refinementsMade,
      downloads_count: cumulativeData.downloadsCount,
      designs_shared_count: cumulativeData.sharesCount,
      first_jewelry_interest: sessionData.firstJewelryType || existingContact?.properties?.first_jewelry_interest,
      last_chat_date: new Date().toISOString().split('T')[0],
      conversion_trigger: conversionTrigger,
      // Add image history fields
      downloaded_images_history: imageHistories.downloaded,
      shared_images_history: imageHistories.shared,
      generated_images_history: imageHistories.generated
    };
    
    console.log('Contact properties to send:', contactProperties);
    
    let response;
    
    if (contactId) {
      // Update existing contact
      console.log('Updating existing contact...');
      response = await hubspotClient.crm.contacts.basicApi.update(contactId, {
        properties: contactProperties
      });
      console.log('HubSpot update response:', response);
    } else {
      // Create new contact
      console.log('Creating new contact...');
      response = await hubspotClient.crm.contacts.basicApi.create({
        properties: contactProperties,
        associations: []
      });
      console.log('HubSpot create response:', response);
      contactId = response.id;
    }
    
    // Create a note/activity for this specific action with image URL
    if (contactId && imageUrl) {
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
  const timestamp = new Date().toISOString();
  const imageEntry = `${timestamp}|${imageUrl}|${actionDetails?.filename || 'unknown'}`;
  
  // Get existing histories or initialize empty arrays
  const existingDownloaded = existingContact?.properties?.downloaded_images_history || '';
  const existingShared = existingContact?.properties?.shared_images_history || '';
  const existingGenerated = existingContact?.properties?.generated_images_history || '';
  
  let downloadedHistory = existingDownloaded;
  let sharedHistory = existingShared;
  let generatedHistory = existingGenerated;
  
  // Add to appropriate history based on action type
  if (conversionTrigger === 'download' && imageUrl) {
    downloadedHistory = addToImageHistory(existingDownloaded, imageEntry);
  }
  
  if (conversionTrigger === 'share' && imageUrl) {
    sharedHistory = addToImageHistory(existingShared, imageEntry);
  }
  
  if (conversionTrigger === 'image_generated' && imageUrl) {
    generatedHistory = addToImageHistory(existingGenerated, imageEntry);
  }
  
  // Also add downloads and shares to generated history for complete tracking
  if ((conversionTrigger === 'download' || conversionTrigger === 'share') && imageUrl) {
    generatedHistory = addToImageHistory(existingGenerated, imageEntry);
  }
  
  return {
    downloaded: downloadedHistory,
    shared: sharedHistory,
    generated: generatedHistory
  };
}

function addToImageHistory(existingHistory, newEntry) {
  // Parse existing entries
  const entries = existingHistory ? existingHistory.split(';;') : [];
  
  // Add new entry
  entries.push(newEntry);
  
  // Keep only last 50 entries to avoid field size limits
  const limitedEntries = entries.slice(-50);
  
  // Join back with delimiter
  return limitedEntries.join(';;');
}

// FIXED: Removed double counting - session data already includes current action counts
function calculateCumulativeData(existingContact, sessionData, conversionTrigger) {
  const existing = existingContact?.properties || {};
  
  return {
    sessionsCount: (parseInt(existing.chatbot_sessions_count) || 0) + 1,
    imagesGenerated: (parseInt(existing.images_generated_count) || 0) + (sessionData.imagesGenerated || 0),
    refinementsMade: (parseInt(existing.refinements_made_count) || 0) + (sessionData.refinementsMade || 0),
    // FIXED: Removed the extra increment - sessionData already includes current action
    downloadsCount: (parseInt(existing.downloads_count) || 0) + (sessionData.downloadsCount || 0),
    sharesCount: (parseInt(existing.designs_shared_count) || 0) + (sessionData.sharesCount || 0)
  };
}

async function createImageActionNote(contactId, actionType, imageUrl, actionDetails) {
  try {
    const noteContent = formatImageActionNote(actionType, imageUrl, actionDetails);
    
    const noteProperties = {
      hs_timestamp: Date.now(),
      hs_note_body: noteContent,
      hubspot_owner_id: null // You can set a default owner if needed
    };
    
    await hubspotClient.crm.objects.notes.basicApi.create({
      properties: noteProperties,
      associations: [
        {
          to: { id: contactId },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 202 // Note to Contact association
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
    'refinement_made': '✨ Design Refined'
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
  
  return note;
}
