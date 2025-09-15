// api/chat.js - Vercel serverless function with direct Google Vertex AI
const { Anthropic } = require('@anthropic-ai/sdk');
const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Initialize Google Auth using service account key from environment variable
const auth = new GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

async function generateImageWithVertex(prompt) {
  try {
    const authClient = await auth.getClient();
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    const location = 'us-central1'; // or your preferred location
    
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/imagen-3.0-generate-001:predict`;
    
    const requestBody = {
      instances: [{
        prompt: `Professional jewelry photography: ${prompt}. High quality, clean white background, studio lighting, detailed and realistic, commercial product photography style`,
        negative_prompt: "blurry, low quality, distorted, ugly, bad anatomy, watermark, text, signature, hands, fingers, people",
        parameters: {
          aspectRatio: "1:1",
          outputMimeType: "image/png",
          safetyFilterLevel: "block_some", // or "block_few", "block_most"
          personGeneration: "dont_allow" // Since it's jewelry
        }
      }],
      parameters: {
        sampleCount: 1
      }
    };
    
    const accessToken = await authClient.getAccessToken();
    
    const response = await axios.post(url, requestBody, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000 // 60 second timeout for image generation
    });
    
    if (response.data.predictions && response.data.predictions[0]) {
      const prediction = response.data.predictions[0];
      
      // The response contains base64 encoded image data
      if (prediction.bytesBase64Encoded) {
        // Convert base64 to a data URL
        return `data:image/png;base64,${prediction.bytesBase64Encoded}`;
      }
      
      // Some responses might have a generated image URL
      if (prediction.mimeType && prediction.bytesBase64Encoded) {
        return `data:${prediction.mimeType};base64,${prediction.bytesBase64Encoded}`;
      }
    }
    
    throw new Error('No image generated in response');
    
  } catch (error) {
    console.error('Vertex AI error:', error.response?.data || error.message);
    throw error;
  }
}

// Fallback to Replicate Stable Diffusion (keeping your existing fallback)
async function fallbackToStableDiffusion(prompt) {
  const Replicate = require('replicate');
  const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
  });
  
  const output = await replicate.run(
    "stability-ai/stable-diffusion:27b93a2413e7f36cd83da926f3656280b2931564ff050bf9575f1fdf9bcd7478",
    {
      input: {
        prompt: `Professional jewelry photography: ${prompt}. High quality, clean white background, studio lighting, detailed and realistic, commercial product photography`,
        negative_prompt: "blurry, low quality, distorted, ugly, bad anatomy, watermark, text, signature, hands, fingers, people",
        width: 768,
        height: 768,
        num_inference_steps: 25,
        guidance_scale: 7.5
      }
    }
  );
  
  return output[0];
}

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
        
        // Use Google's Vertex AI directly
        imageUrl = await generateImageWithVertex(imagePrompt);
        downloadUrl = imageUrl; // For data URLs, same as display URL
        console.log('Image generated successfully with Google Vertex AI');
        
      } catch (imageError) {
        console.error('Vertex AI image generation error:', imageError);
        
        // Fallback to Stable Diffusion if Vertex AI fails
        try {
          console.log('Falling back to Stable Diffusion');
          imageUrl = await fallbackToStableDiffusion(imagePrompt);
          downloadUrl = imageUrl;
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
      downloadUrl,
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
        hasGoogleCredentials: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
        hasGoogleProjectId: !!process.env.GOOGLE_CLOUD_PROJECT_ID,
        anthropicKeyPrefix: process.env.ANTHROPIC_API_KEY?.substring(0, 10) + '...'
      }
    });
  }
};
