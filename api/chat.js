// api/chat.js - Vercel serverless function
const { Anthropic } = require('@anthropic-ai/sdk');
const Replicate = require('replicate');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
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

The image description should be detailed and suitable for professional jewelry photography, including details about the jewelry type, materials, style, setting, and any specific design elements mentioned by the customer.`,
      messages: [
        ...conversationHistory.filter(msg => msg.role !== 'system'),
        { role: 'user', content: message }
      ]
    });
    
    const claudeMessage = claudeResponse.content[0].text;
    console.log('Full Claude response:', claudeMessage);
    
    // Step 2: Check if image generation is requested OR if it's a jewelry request
    let imageUrl = null;
    let downloadUrl = null;
    
    // Force image generation for jewelry-related requests
    const isJewelryRequest = (
      message.toLowerCase().includes('ring') ||
      message.toLowerCase().includes('jewelry') ||
      message.toLowerCase().includes('diamond') ||
      message.toLowerCase().includes('necklace') ||
      message.toLowerCase().includes('bracelet') ||
      message.toLowerCase().includes('earring') ||
      message.toLowerCase().includes('pendant') ||
      message.toLowerCase().includes('engagement') ||
      message.toLowerCase().includes('wedding') ||
      message.toLowerCase().includes('generate') ||
      message.toLowerCase().includes('create') ||
      message.toLowerCase().includes('image')
    );
    
    if (claudeMessage.includes('GENERATE_IMAGE:') || isJewelryRequest) {
      let imagePrompt;
      
      if (claudeMessage.includes('GENERATE_IMAGE:')) {
        imagePrompt = claudeMessage.split('GENERATE_IMAGE:')[1].trim();
      } else {
        // Create image prompt based on the user's original message
        imagePrompt = `${message.replace(/generate|create|image|of|an?/gi, '').trim()}, professional jewelry photography style`;
      }
      
      try {
        console.log('Generating image with prompt:', imagePrompt);
        
        // Use Google's Imagen 3 model via Replicate
        const output = await replicate.run(
          "google/imagen-3",
          {
            input: {
              prompt: `Professional jewelry photography: ${imagePrompt}. High quality, clean white background, studio lighting, detailed and realistic, commercial product photography style`,
              negative_prompt: "blurry, low quality, distorted, ugly, bad anatomy, watermark, text, signature, hands, fingers, people",
              aspect_ratio: "1:1",
              output_format: "png"
            }
          }
        );
        
        imageUrl = output; // Imagen returns a single URL
        downloadUrl = imageUrl; // For now, download URL is the same as display URL
        console.log('Image generated successfully with Google Imagen 3');
        
      } catch (imageError) {
        console.error('Image generation error:', imageError);
        
        // Fallback to Stable Diffusion if Imagen fails
        try {
          console.log('Falling back to Stable Diffusion');
          const fallbackOutput = await replicate.run(
            "stability-ai/stable-diffusion:27b93a2413e7f36cd83da926f3656280b2931564ff050bf9575f1fdf9bcd7478",
            {
              input: {
                prompt: `Professional jewelry photography: ${imagePrompt}. High quality, clean white background, studio lighting, detailed and realistic, commercial product photography`,
                negative_prompt: "blurry, low quality, distorted, ugly, bad anatomy, watermark, text, signature, hands, fingers, people",
                width: 768,
                height: 768,
                num_inference_steps: 25,
                guidance_scale: 7.5
              }
            }
          );
          
          imageUrl = fallbackOutput[0]; // Stable Diffusion returns an array
          downloadUrl = imageUrl; // For now, download URL is the same as display URL
          console.log('Image generated with Stable Diffusion fallback');
          
        } catch (sdError) {
          console.error('All image generation methods failed:', sdError);
        }
      }
    }
    
    // Remove the GENERATE_IMAGE instruction from the response to user
    const cleanMessage = claudeMessage.replace(/GENERATE_IMAGE:.*$/m, '').trim();
    
    res.status(200).json({
      message: cleanMessage,
      imageUrl,
      downloadUrl, // Provide separate download URL if needed
      conversationId: Date.now(),
      metadata: imageUrl ? {
        filename: `jewelry-design-${Date.now()}.png`,
        type: 'image/png',
        downloadable: true
      } : null
    });
    
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: 'API Error',
      message: error.message,
      details: {
        type: error.constructor.name,
        hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
        hasReplicateKey: !!process.env.REPLICATE_API_TOKEN,
        anthropicKeyPrefix: process.env.ANTHROPIC_API_KEY?.substring(0, 10) + '...',
        replicateKeyPrefix: process.env.REPLICATE_API_TOKEN?.substring(0, 10) + '...'
      }
    });
  }
};
