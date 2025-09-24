// api/chat.js - Optimized backend for jewelry image generation
const { Anthropic } = require('@anthropic-ai/sdk');
const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');
const { Storage } = require('@google-cloud/storage');
const multer = require('multer');
const sharp = require('sharp');

// Initialize services
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const keyJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
keyJson.private_key = keyJson.private_key.replace(/\\n/g, "\n");

const auth = new GoogleAuth({
  credentials: keyJson,
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

const storage = new Storage({
  credentials: keyJson,
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
});

const bucketName = process.env.GOOGLE_STORAGE_BUCKET || 'jewelry-designs-bucket';

// Optimized multer configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    fieldSize: 5 * 1024 * 1024,  // 5MB for form fields
    fields: 20,
    fieldNameSize: 100
  },
  fileFilter: (req, file, cb) => {
    cb(file.mimetype.startsWith('image/') ? null : new Error('Only image files allowed'), 
       file.mimetype.startsWith('image/'));
  }
});

// Utility functions
async function uploadImageToStorage(buffer, filename, contentType = 'image/png') {
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(filename);
  
  await file.save(buffer, {
    metadata: { contentType }
  });
  
  return `https://storage.googleapis.com/${bucketName}/${filename}`;
}

async function processReferenceImage(imageBuffer) {
  const processedBuffer = await sharp(imageBuffer)
    .resize(1024, 1024, { 
      fit: 'inside', 
      withoutEnlargement: true 
    })
    .jpeg({ quality: 85 })
    .toBuffer();
  
  return {
    base64: processedBuffer.toString('base64'),
    buffer: processedBuffer,
    mimeType: 'image/jpeg'
  };
}

async function analyzeImageWithClaude(base64Image) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: `Analyze jewelry images focusing on: type, materials, style, setting types, color scheme, and aesthetic. Keep descriptions concise but detailed for photography generation.`,
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
            text: 'Analyze this jewelry image for photography generation purposes.'
          }
        ]
      }]
    });
    
    return response.content[0].text;
  } catch (error) {
    console.error('Claude analysis error:', error);
    return 'elegant jewelry piece with refined craftsmanship';
  }
}

async function generateImageWithVertex(prompt, referenceImageAnalysis = '', isRefinement = false, baseImageDescription = '') {
  const authClient = await auth.getClient();
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const location = 'us-central1';

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/imagen-3.0-generate-001:predict`;

  // Build catalog prompt based on context
  let catalogPrompt;
  if (isRefinement && baseImageDescription) {
    catalogPrompt = `jewelry product photography refinement: Starting with ${baseImageDescription}, now ${prompt}. MUST BE: pure white background, three-quarter view angle, professional studio lighting, sparkling reflections`;
  } else if (referenceImageAnalysis) {
    catalogPrompt = `jewelry product photography: ${prompt}, inspired by: ${referenceImageAnalysis}. MUST BE: pure white background, three-quarter view angle, professional studio lighting, sparkling reflections`;
  } else {
    catalogPrompt = `jewelry product photography: ${prompt}. MUST BE: pure white background, three-quarter view angle, professional studio lighting, sparkling reflections`;
  }

  const requestBody = {
    instances: [{
      prompt: catalogPrompt,
      negative_prompt: "colored background, dark background, gray background, black background, textured background, pattern background, front view, side view, back view, top view, multiple angles, blurry, low quality, hands, people, multiple items, text, watermark, shadows on background",
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

  if (response.data.predictions?.[0]?.bytesBase64Encoded) {
    const prediction = response.data.predictions[0];
    const base64Data = `data:image/png;base64,${prediction.bytesBase64Encoded}`;
    const buffer = Buffer.from(prediction.bytesBase64Encoded, 'base64');
    
    const filename = isRefinement 
      ? `jewelry-refined-${Date.now()}.png`
      : `jewelry-catalog-${Date.now()}.png`;
    const publicUrl = await uploadImageToStorage(buffer, filename, 'image/png');
    
    return {
      dataUrl: base64Data,
      publicUrl: publicUrl,
      filename: filename
    };
  }

  throw new Error('No image generated in response');
}



module.exports = async function handler(req, res) {
  // CORS headers
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
    // Handle multipart form data
    await new Promise((resolve, reject) => {
      upload.single('referenceImage')(req, res, (err) => {
        err ? reject(err) : resolve();
      });
    });

    const { message, conversationHistory = [], isRefinement = 'false', baseImageData, refinementCount = '0' } = req.body;
    
    // Parse conversation history
    let parsedHistory = [];
    try {
      parsedHistory = typeof conversationHistory === 'string' 
        ? JSON.parse(conversationHistory) 
        : Array.isArray(conversationHistory) ? conversationHistory : [];
    } catch (e) {
      console.log('Using empty conversation history due to parse error');
    }

    // Parse refinement data
    const isRefinementRequest = isRefinement === 'true';
    let baseImageInfo = null;
    if (isRefinementRequest && baseImageData) {
      try {
        baseImageInfo = JSON.parse(baseImageData);
      } catch (e) {
        console.error('Could not parse base image data:', e);
      }
    }

    console.log('Processing request:', {
      isRefinement: isRefinementRequest,
      hasBaseImage: !!baseImageInfo,
      refinementCount,
      messageLength: message?.length || 0
    });
    
    let referenceImageData = null;
    let referenceImageAnalysis = '';
    
    // Process reference image if provided
    if (req.file) {
      console.log('Processing reference image:', req.file.originalname);
      
      try {
        const processedImage = await processReferenceImage(req.file.buffer);
        const referenceFilename = `reference-${Date.now()}.jpg`;
        const referencePublicUrl = await uploadImageToStorage(
          processedImage.buffer, 
          referenceFilename, 
          'image/jpeg'
        );
        
        referenceImageAnalysis = await analyzeImageWithClaude(processedImage.base64);
        console.log('Reference image analyzed');
        
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

    // Claude consultation with refinement context
    let systemPrompt = `You are a jewelry designer assistant. Keep responses brief and focused (2-3 sentences max). A retailer is asking you to create a catalog image of jewelry based on a consumer request.

${referenceImageData ? `Reference image shows: ${referenceImageAnalysis}\n\nCreate a design inspired by this reference.` : ''}`;

    if (isRefinementRequest && baseImageInfo) {
      systemPrompt += `\n\nREFINEMENT MODE: You are refining an existing jewelry design. The user wants to modify the current design.
Previous design: The user is working with an existing jewelry piece and wants modifications.
This is refinement #${refinementCount}.

Focus on the specific changes requested while maintaining the overall jewelry aesthetic.`;
    }

    systemPrompt += `\n\nIMPORTANT FORMATTING:
- Keep responses concise and professional
- Use **bold** for emphasis on key details
- Always end with: GENERATE_IMAGE: [jewelry type and key details only]

For non-jewelry questions, simply say "I can only create jewelry images. What piece would you like me to design?"

The GENERATE_IMAGE description should be brief: just the jewelry type, main materials, and key visual features (e.g., "diamond solitaire engagement ring, platinum band, round brilliant cut").`;

    const claudeMessages = [
      ...parsedHistory.filter(msg => msg.role !== 'system'),
      { 
        role: 'user', 
        content: isRefinementRequest 
          ? `Please refine the current design: ${message}` 
          : (message || 'Please create jewelry inspired by this reference image')
      }
    ];

    const claudeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: claudeMessages
    });
    
    const claudeMessage = claudeResponse.content[0].text;
    
    // Image generation with refinement support
    let imageResult = null;
    
    const isJewelryRequest = (
      /\b(ring|jewelry|diamond|necklace|bracelet|earring|pendant|engagement|wedding|generate|create|image)\b/i.test(message) ||
      claudeMessage.includes('GENERATE_IMAGE:') ||
      referenceImageData || 
      isRefinementRequest
    );
    
    if (isJewelryRequest) {
      let prompt;
      
      if (claudeMessage.includes('GENERATE_IMAGE:')) {
        prompt = claudeMessage.split('GENERATE_IMAGE:')[1].trim();
      } else {
        prompt = `${message.replace(/generate|create|image|of|an?/gi, '').trim()}, professional jewelry photography style`;
      }
      
      const baseImageDescription = isRefinementRequest && baseImageInfo?.metadata 
        ? 'elegant jewelry piece (previous design)' 
        : '';
      
      try {
        console.log('Generating image with Vertex AI');
        imageResult = await generateImageWithVertex(
          prompt, 
          referenceImageAnalysis, 
          isRefinementRequest, 
          baseImageDescription
        );
        console.log('Image generated successfully');
        
      } catch (imageError) {
        console.error('Vertex AI image generation failed:', imageError);
        // No fallback - let the error bubble up so users see the actual issue
        throw imageError;
      }
    }
    
    // Clean response and send result
    const cleanMessage = claudeMessage.replace(/GENERATE_IMAGE:.*$/m, '').trim();
    const newRefinementCount = parseInt(refinementCount) + (isRefinementRequest ? 1 : 0);
    
    res.status(200).json({
      message: cleanMessage,
      imageUrl: imageResult?.dataUrl || null,
      publicUrl: imageResult?.publicUrl || null,
      downloadUrl: imageResult?.dataUrl || null,
      conversationId: Date.now(),
      referenceImage: referenceImageData,
      contentType: 'image',
      isRefinement: isRefinementRequest,
      refinementCount: newRefinementCount,
      metadata: imageResult ? {
        filename: imageResult.filename,
        type: 'image/png',
        downloadable: true,
        publicUrl: imageResult.publicUrl,
        referenceImage: referenceImageData,
        isVideo: false,
        isRefinement: isRefinementRequest,
        refinementCount: newRefinementCount
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
        hasStorageBucket: !!process.env.GOOGLE_STORAGE_BUCKET
      }
    });
  }
};
