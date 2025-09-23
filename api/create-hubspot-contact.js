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
    const { email, sessionData, conversationHistory, conversionTrigger } = req.body;
    
    const contactProperties = {
      email: email,
      chatbot_sessions_count: sessionData.sessionsCount || 1,
      images_generated_count: sessionData.imagesGenerated,
      refinements_made_count: sessionData.refinementsMade,
      downloads_count: sessionData.downloadsCount,
      designs_shared_count: sessionData.sharesCount,
      first_jewelry_interest: sessionData.firstJewelryType,
      last_chat_date: new Date().toISOString(),
      conversion_trigger: conversionTrigger
    };

    const response = await hubspotClient.crm.contacts.basicApi.create({
      properties: contactProperties,
      associations: []
    });

    res.status(200).json({ 
      success: true, 
      contactId: response.id 
    });

  } catch (error) {
    if (error.message.includes('Contact already exists')) {
      // Update existing contact
      try {
        const updateResponse = await hubspotClient.crm.contacts.basicApi.update(
          email,
          { properties: contactProperties },
          undefined,
          'email'
        );
        res.status(200).json({ 
          success: true, 
          contactId: updateResponse.id 
        });
      } catch (updateError) {
        res.status(500).json({ error: updateError.message });
      }
    } else {
      res.status(500).json({ error: error.message });
    }
  }
};
