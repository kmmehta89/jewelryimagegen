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
      system: `You are a jewelry designer. A retailer is asking you to create an image of a piece of jewelry based on a request from a consumer. Always end your response with this format:

GENERATE_IMAGE: [detailed description for jewelry photography]

Only include the GENERATE_IMAGE instruction when you are discussing or recommending specific jewelry pieces that would benefit from a visual representation. For general questions about jewelry care, policies, or non-specific inquiries, do not include the image generation trigger and instead reply that your only capability is to create images of jewelry.

The image description should be detailed and suitable for professional jewelry photography.`,
      messages: [
        ...conversationHistory.filter(msg => msg.role !== 'system'),
        { role: 'user', content: message }
      ]
    });
    
    const claudeMessage = claudeResponse.content[0].text;
    console.log('Full Claude response:', claudeMessage);
    
    // Step 2: Check if image generation is requested
    let imageUrl = null;
    
    if (claudeMessage.includes('GENERATE_IMAGE:')) {
      const imagePrompt = claudeMessage.split('GENERATE_IMAGE:')[1].trim();
      
      try {
        console.log('Generating image with prompt:', imagePrompt);
        
        // Use DALL-E 3 for better quality (falls back to DALL-E 2 if not available)
        const imageResponse = await openai.images.generate({
          model: "dall-e-3",
          prompt: `Professional jewelry photography: ${imagePrompt}. High quality, clean white background, studio lighting, detailed and realistic, commercial product photography style.`,
          size: "1024x1024",
          quality: "standard",
          n: 1,
        });
        
        imageUrl = imageResponse.data[0].url;
        console.log('Image generated successfully');
        
      } catch (imageError) {
        console.error('Image generation error:', imageError);
        
        // Fallback to DALL-E 2 if DALL-E 3 fails
        if (imageError.code === 'model_not_found' || imageError.message.includes('dall-e-3')) {
          try {
            console.log('Falling back to DALL-E 2');
            const fallbackResponse = await openai.images.generate({
              model: "dall-e-2",
              prompt: `Professional jewelry photography: ${imagePrompt}. High quality, clean white background, studio lighting.`,
              size: "512x512",
              n: 1,
            });
            
            imageUrl = fallbackResponse.data[0].url;
            console.log('Image generated with DALL-E 2 fallback');
            
          } catch (fallbackError) {
            console.error('DALL-E 2 fallback also failed:', fallbackError);
          }
        }
      }
    }
    
    // Remove the GENERATE_IMAGE instruction from the response to user
    const cleanMessage = claudeMessage.replace(/GENERATE_IMAGE:.*$/m, '').trim();
    
    res.status(200).json({
      message: cleanMessage,
      imageUrl,
      conversationId: Date.now()
    });
    
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: 'API Error',
      message: error.message,
      details: {
        type: error.constructor.name,
        hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
        hasOpenAIKey: !!process.env.OPENAI_API_KEY,
        anthropicKeyPrefix: process.env.ANTHROPIC_API_KEY?.substring(0, 10) + '...',
        openaiKeyPrefix: process.env.OPENAI_API_KEY?.substring(0, 10) + '...'
      }
    });
  }
};
