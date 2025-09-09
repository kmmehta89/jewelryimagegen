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
      model: 'claude-sonnet-4-20250514', // Fixed: removed extra comma
      max_tokens: 1000,
      system: `You are a jewelry design consultant. For EVERY response about jewelry, you MUST always end with exactly this format:

GENERATE_IMAGE: [detailed description for jewelry photography]

Never skip this. Always include GENERATE_IMAGE: followed by a detailed description.`,
      messages: [
        ...conversationHistory.filter(msg => msg.role !== 'system'), // This filter is correct
        { role: 'user', content: message }
      ]
    });
    
    const claudeMessage = claudeResponse.content[0].text;
    console.log('Full Claude response:', claudeMessage);
    
    // Step 2: Check if Claude wants to generate an image
    let imageUrl = null;
    
    // TEMPORARY: Force image generation for debugging billing issue
    const forceImageGeneration = true;
    
    if (claudeMessage.includes('GENERATE_IMAGE:') || forceImageGeneration) {
      let imagePrompt;
      
      if (claudeMessage.includes('GENERATE_IMAGE:')) {
        imagePrompt = claudeMessage.split('GENERATE_IMAGE:')[1].trim();
      } else {
        // Use the user's message as the prompt for testing
        imagePrompt = message;
      }
      
      try {
        const imageResponse = await openai.images.generate({
          model: "dall-e-2", // Try DALL-E 2 instead
          prompt: `Professional jewelry photography: ${imagePrompt}. High quality, clean white background, studio lighting, detailed and realistic.`,
          size: "512x512", // DALL-E 2 uses different sizes
          n: 1,
        });
        
        imageUrl = imageResponse.data[0].url;
      } catch (imageError) {
        console.error('Image generation error:', imageError);
        console.error('Error details:', {
          message: imageError.message,
          status: imageError.status,
          code: imageError.code,
          type: imageError.type
        });
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
