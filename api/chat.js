// api/chat.js - Updated with image upload functionality
const { Anthropic } = require('@anthropic-ai/sdk');
const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');
const { Storage } = require('@google-cloud/storage');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Initialize Google Auth
const keyJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
keyJson.private_key = keyJson.private_key.replace(/\\n/g, "\n");

const auth = new GoogleAuth({
  credentials: keyJson,
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

// Initialize Google Cloud Storage
const storage = new Storage({
  credentials: keyJson,
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
});

const bucketName = process.env.GOOGLE_STORAGE_BUCKET || 'jewelry-designs-bucket'; // You'll need to create this bucket

async function uploadImageToStorage(base64Data, filename) {
  try {
    // Extract base64 data without the data:image/png;base64, prefix
    const base64Image = base64Data.replace(/^data:image\/[a-z]+;base64,/, '');
    const buffer = Buffer.from(base64Image, 'base64');
    
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(filename);
    
    // Upload the file (will be automatically public if bucket allows public access)
    await file.save(buffer, {
      metadata: {
        contentType: 'image/png',
      }
    });
    
    // Return public URL
    return `https://storage.googleapis.com/${bucketName}/${filename}`;
  } catch (error) {
    console.error('Error uploading to Google Storage:', error);
    throw error;
  }
}

async function generateImageWithVertex(prompt) {
  try {
    const authClient = await auth.getClient();
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    const location = 'us-central1';

    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/imagen-3.0-generate-001:predict`;

    const requestBody = {
      instances: [{
        prompt: `Professional jewelry photography: ${prompt}. High quality, clean white background, studio lighting, detailed and realistic, commercial product photography style`,
        negative_prompt: "blurry, low quality, distorted, ugly, bad anatomy, watermark, text, signature, hands, fingers, people",
        parameters: {
          aspectRatio: "1:1",
          outputMimeType: "image/png",
          safetyFilterLevel: "block_some",
          personGeneration: "dont_allow"
        }
      }],
      parameters: { sampleCount: 1 }
    };

    const { token: accessToken } = await authClient.getAccessToken();

    const response = await axios.post(url, requestBody, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });

    if (response.data.predictions && response.data.predictions[0]) {
      const prediction = response.data.predictions[0];

      if (prediction.bytesBase64Encoded) {
        const base64Data = `data:image/png;base64,${prediction.bytesBase64Encoded}`;
        
        // Upload to Google Cloud Storage and get public URL
        const filename = `jewelry-design-${Date.now()}.png`;
        const publicUrl = await uploadImageToStorage(base64Data, filename);
        
        return {
          dataUrl: base64Data, // For immediate display
          publicUrl: publicUrl, // For sharing/email
          filename: filename
        };
      }
    }

    throw new Error('No image generated in response');

  } catch (error) {
    console.error('Vertex AI error:', error.response?.data || error.message);
    throw error;
  }
}

// Fallback to Replicate (keeping existing logic)
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
  
  // Replicate returns direct URLs, so we can use them as-is
  return {
    dataUrl: output[0],
    publicUrl: output[0],
    filename: `jewelry-design-${Date.now()}.png`
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
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
    
    // Step 1: Claude consultation
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
    
    // Step 2: Image generation
    let imageResult = null;
    
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
        imagePrompt = `${message.replace(/generate|create|image|of|an?/gi, '').trim()}, professional jewelry photography style`;
      }
      
      try {
        console.log('Generating image with prompt:', imagePrompt);
        imageResult = await generateImageWithVertex(imagePrompt);
        console.log('Image generated successfully with Google Vertex AI');
        
      } catch (imageError) {
        console.error('Vertex AI image generation error:', imageError);
        
        try {
          console.log('Falling back to Stable Diffusion');
          imageResult = await fallbackToStableDiffusion(imagePrompt);
          console.log('Image generated with Stable Diffusion fallback');
          
        } catch (sdError) {
          console.error('All image generation methods failed:', sdError);
        }
      }
    }
    
    // Clean response
    const cleanMessage = claudeMessage.replace(/GENERATE_IMAGE:.*$/m, '').trim();
    
    res.status(200).json({
      message: cleanMessage,
      imageUrl: imageResult?.dataUrl || null, // For immediate display
      publicUrl: imageResult?.publicUrl || null, // For sharing/email
      downloadUrl: imageResult?.dataUrl || null, // For download
      conversationId: Date.now(),
      metadata: imageResult ? {
        filename: imageResult.filename,
        type: 'image/png',
        downloadable: true,
        publicUrl: imageResult.publicUrl // Include public URL in metadata
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
        hasStorageBucket: !!process.env.GOOGLE_STORAGE_BUCKET,
        anthropicKeyPrefix: process.env.ANTHROPIC_API_KEY?.substring(0, 10) + '...'
      }
    });
  }
};
