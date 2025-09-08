// api/chat.js - Vercel serverless function
const { Anthropic } = require('@anthropic-ai/sdk');
const { OpenAI } = require('openai');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

module.exports = async function handler(req, res) {
  // Enable CORS for your HubSpot domain (update this later with your actual domain)
  res.setHeader('Access-Control-Allow-Origin', '*'); // Change this to your HubSpot domain later
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { message, conversationHistory = [] } = req.body;
    
    // Step 1: Send to Claude for jewelry consultation
    const claudeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: `You are a jewelry design consultant. Help customers describe their ideal piece of jewelry. Ask clarifying questions about:
- Type of jewelry (ring, necklace, earrings, bracelet)
- Metal preference (gold, silver, platinum, rose gold)  
- Gemstones or diamonds
- Style (vintage, modern, minimalist, ornate)
- Occasion/purpose

IMPORTANT: Once you have enough details OR when the customer explicitly asks for an image, you MUST end your response with "GENERATE_IMAGE:" followed by a detailed image prompt for DALL-E. Do not ask more questions after you have the basic details.`,
      messages: [
        ...conversationHistory.filter(msg => msg.role !== 'system'), // This filter is correct
        { role: 'user', content: message }
      ]
    });
    
    const claudeMessage = claudeResponse.content[0].text;
    
    // Step 2: Check if Claude wants to generate an image
    let imageUrl = null;
    if (claudeMessage.includes('GENERATE_IMAGE:')) {
      const imagePrompt = claudeMessage.split('GENERATE_IMAGE:')[1].trim();
      
      try {
        const imageResponse = await openai.images.generate({
          model: "dall-e-3",
          prompt: `Professional jewelry photography: ${imagePrompt}. High quality, clean white background, studio lighting, detailed and realistic.`,
          size: "1024x1024",
          quality: "standard",
          n: 1,
        });
        
        imageUrl = imageResponse.data[0].url;
      } catch (imageError) {
        console.error('Image generation error:', imageError);
      }
    }
    
    res.status(200).json({
      message: claudeMessage.replace(/GENERATE_IMAGE:.*/, '').trim(),
      imageUrl,
      conversationId: Date.now() // Simple conversation tracking
    });
    
  } catch (error) {
    console.error('Full error details:', error);
    res.status(500).json({ 
      error: 'API Error',
      message: error.message,
      type: error.constructor.name,
      hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
      hasOpenAIKey: !!process.env.OPENAI_API_KEY
    });
  }
};
