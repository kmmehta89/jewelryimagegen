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
    console.log('Request body:', req.body);
    
    const { email, sessionData, conversationHistory, conversionTrigger } = req.body;
    
    console.log('Processing contact for email:', email);
    console.log('Session data:', sessionData);
    
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

    console.log('Contact properties to send:', contactProperties);

    const response = await hubspotClient.crm.contacts.basicApi.create({
      properties: contactProperties,
      associations: []
    });

    console.log('HubSpot create response:', response);

    res.status(200).json({ 
      success: true, 
      contactId: response.id 
    });

  } catch (error) {
    console.error('HubSpot API Error:', error);
    console.error('Error message:', error.message);
    console.error('Error response data:', error.response?.data);
    
    if (error.message.includes('Contact already exists')) {
      console.log('Contact exists, attempting update...');
      try {
        const updateResponse = await hubspotClient.crm.contacts.basicApi.update(
          email,
          { properties: contactProperties },
          undefined,
          'email'
        );
        console.log('Update successful:', updateResponse);
        res.status(200).json({ 
          success: true, 
          contactId: updateResponse.id 
        });
      } catch (updateError) {
        console.error('Update error:', updateError);
        console.error('Update error response:', updateError.response?.data);
        res.status(500).json({ error: updateError.message });
      }
    } else {
      res.status(500).json({ 
        error: error.message,
        details: error.response?.data || 'No additional details'
      });
    }
  }
};
