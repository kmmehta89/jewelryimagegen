// api/chat.js - Updated with reference image functionality
const { Anthropic } = require('@anthropic-ai/sdk');
const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');
const { Storage } = require('@google-cloud/storage');
const multer = require('multer');
const sharp = require('sharp');

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

const bucketName = process.env.GOOGLE_STORAGE_BUCKET || 'jewelry-designs-bucket';

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

async function uploadImageToStorage(buffer, filename, contentType = 'image/png') {
  try {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(filename);
    
    await file.save(buffer, {
      metadata: {
        contentType: contentType,
      }
    });
    
    return `https://storage.googleapis.com/${bucketName}/${filename}`;
  } catch (error) {
    console.error('Error uploading to Google Storage:', error);
    throw error;
  }
}

async function processReferenceImage(imageBuffer) {
  try {
    // Resize and optimize the image for AI processing
    const processedBuffer = await sharp(imageBuffer)
      .resize(1024, 1024, { 
        fit: 'inside', 
        withoutEnlargement: true 
      })
      .jpeg({ quality: 85 })
      .toBuffer();
    
    // Convert to base64 for Claude
    const base64Image = processedBuffer.toString('base64');
    
    return {
      base64: base64Image,
      buffer: processedBuffer,
      mimeType: 'image/jpeg'
    };
  } catch (error) {
    console.error('Error processing reference image:', error);
    throw error;
  }
}

async function analyzeImageWithClaude(base64Image) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: `You are a jewelry expert. Analyze the provided image and describe the jewelry piece in detail, focusing on:
- Type of jewelry (ring, necklace, earrings, etc.)
- Materials visible (gold, silver, gemstones, etc.)
- Style and design elements
- Setting types
- Color scheme
- Overall aesthetic
Keep the description concise but detailed enough for jewelry photography generation.`,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: base64Image
            }
          },
          {
            type: 'text',
            content: 'Please analyze this jewelry image and provide a detailed description for jewelry photography purposes.'
          }
        ]
      }]
    });
    
    return response.content[0].text;
  } catch (error) {
    console.error('Error analyzing image with Claude:', error);
    return 'elegant jewelry piece with refined craftsmanship';
  }
}

async function generateImageWithVertex(prompt, referenceImageAnalysis = '') {
  try {
    const authClient = await auth.getClient();
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    const location = 'us-central1';

    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/imagen-3.0-generate-001:predict`;

    // Combine the original prompt with reference image analysis
    const enhancedPrompt = referenceImageAnalysis 
      ? `Professional jewelry photography inspired by this reference: ${referenceImageAnalysis}. ${prompt}. High quality, clean white background, studio lighting, detailed and realistic, commercial product photography style`
      : `Professional jewelry photography: ${prompt}. High quality, clean white background, studio lighting, detailed and realistic, commercial product photography style`;

    const requestBody = {
      instances: [{
        prompt: enhancedPrompt,
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
        const buffer = Buffer.from(prediction.bytesBase64Encoded, 'base64');
        
        // Upload to Google Cloud Storage and get public URL
        const filename = `jewelry-design-${Date.now()}.png`;
        const publicUrl = await uploadImageToStorage(buffer, filename, 'image/png');
        
        return {
          dataUrl: base64Data,
          publicUrl: publicUrl,
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

// Fallback to Replicate with reference image support
async function fallbackToStableDiffusion(prompt, referenceImageAnalysis = '') {
  const Replicate = require('replicate');
  const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
  });
  
  const enhancedPrompt = referenceImageAnalysis 
    ? `Professional jewelry photography inspired by: ${referenceImageAnalysis}. ${prompt}. High quality, clean white background, studio lighting, detailed and realistic, commercial product photography`
    : `Professional jewelry photography: ${prompt}. High quality, clean white background, studio lighting, detailed and realistic, commercial product photography`;
  
  const output = await replicate.run(
    "stability-ai/stable-diffusion:27b93a2413e7f36cd83da926f3656280b2931564ff050bf9575f1fdf9bcd7478",
    {
      input: {
        prompt: enhancedPrompt,
        negative_prompt: "blurry, low quality, distorted, ugly, bad anatomy, watermark, text, signature, hands, fingers, people",
        width: 768,
        height: 768,
        num_inference_steps: 25,
        guidance_scale: 7.5
      }
    }
  );
  
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
    // Handle multipart form data for image uploads
    const uploadMiddleware = upload.single('referenceImage');
    
    await new Promise((resolve, reject) => {
      uploadMiddleware(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const { message, conversationHistory = [] } = req.body;
    let referenceImageData = null;
    let referenceImageAnalysis = '';
    
    // Process reference image if provided
    if (req.file) {
      console.log('Processing reference image:', req.file.originalname);
      
      try {
        // Process and upload reference image
        const processedImage = await processReferenceImage(req.file.buffer);
        const referenceFilename = `reference-${Date.now()}.jpg`;
        const referencePublicUrl = await uploadImageToStorage(
          processedImage.buffer, 
          referenceFilename, 
          'image/jpeg'
        );
        
        // Analyze reference image with Claude
        referenceImageAnalysis = await analyzeImageWithClaude(processedImage.base64);
        console.log('Reference image analysis:', referenceImageAnalysis);
        
        referenceImageData = {
          publicUrl: referencePublicUrl,
          filename: referenceFilename,
          analysis: referenceImageAnalysis
        };
      } catch (imageError) {
        console.error('Error processing reference image:', imageError);
        return res.status(400).json({ 
          error: 'Failed to process reference image',
          message: imageError.message 
        });
      }
    }

    // Step 1: Claude consultation with reference context
    const systemPrompt = `You are a jewelry designer. A retailer is asking you to create an image of a piece of jewelry based on a request from a consumer. 

${referenceImageData ? `The user has provided a reference image that shows: ${referenceImageAnalysis}

Use this reference to inform your design recommendations and ensure the generated piece complements or is inspired by this reference.` : ''}

Always end your response with this format:
GENERATE_IMAGE: [detailed description for jewelry photography]

Only include the GENERATE_IMAGE instruction when you are discussing or recommending specific jewelry pieces that would benefit from a visual representation. For general questions about jewelry care, policies, or non-specific inquiries, do not include the image generation trigger and instead reply that your only capability is to create images of jewelry.

The image description should be detailed and suitable for professional jewelry photography, including details about the jewelry type, materials, style, setting, and any specific design elements mentioned by the customer.`;

    const claudeMessages = [
      ...conversationHistory.filter(msg => msg.role !== 'system'),
      { role: 'user', content: message }
    ];

    const claudeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: claudeMessages
    });
    
    const claudeMessage = claudeResponse.content[0].text;
    
    // Step 2: Image generation with reference context
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
      message.toLowerCase().includes('image') ||
      claudeMessage.includes('GENERATE_IMAGE:') ||
      referenceImageData // Always generate if reference image provided
    );
    
    if (isJewelryRequest) {
      let imagePrompt;
      
      if (claudeMessage.includes('GENERATE_IMAGE:')) {
        imagePrompt = claudeMessage.split('GENERATE_IMAGE:')[1].trim();
      } else {
        imagePrompt = `${message.replace(/generate|create|image|of|an?/gi, '').trim()}, professional jewelry photography style`;
      }
      
      try {
        console.log('Generating image with prompt:', imagePrompt);
        console.log('Reference analysis:', referenceImageAnalysis || 'None');
        
        imageResult = await generateImageWithVertex(imagePrompt, referenceImageAnalysis);
        console.log('Image generated successfully with Google Vertex AI');
        
      } catch (imageError) {
        console.error('Vertex AI image generation error:', imageError);
        
        try {
          console.log('Falling back to Stable Diffusion');
          imageResult = await fallbackToStableDiffusion(imagePrompt, referenceImageAnalysis);
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
      imageUrl: imageResult?.dataUrl || null,
      publicUrl: imageResult?.publicUrl || null,
      downloadUrl: imageResult?.dataUrl || null,
      conversationId: Date.now(),
      referenceImage: referenceImageData, // Include reference image data
      metadata: imageResult ? {
        filename: imageResult.filename,
        type: 'image/png',
        downloadable: true,
        publicUrl: imageResult.publicUrl,
        referenceImage: referenceImageData // Also include in metadata
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
