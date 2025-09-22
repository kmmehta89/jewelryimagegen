// api/chat.js - Complete backend with video support and image refinement
const { Anthropic } = require('@anthropic-ai/sdk');
const { GoogleAuth } = require('google-auth-library');
const { VertexAI } = require('@google-cloud/vertexai');
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

// Initialize Vertex AI
const vertexAI = new VertexAI({
  project: process.env.GOOGLE_CLOUD_PROJECT_ID,
  location: 'us-central1',
  googleAuthOptions: {
    credentials: keyJson,
  }
});

const bucketName = process.env.GOOGLE_STORAGE_BUCKET || 'jewelry-designs-bucket';

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit for files
    fieldSize: 5 * 1024 * 1024,  // 5MB limit for form fields (increased for base64 image data)
    fields: 20,                   // Allow up to 20 form fields
    fieldNameSize: 100           // Maximum field name size
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// Enhanced video generation manager with rate limiting
class VideoGenerationManager {
  constructor() {
    this.requestQueue = [];
    this.processing = false;
    this.lastRequestTime = 0;
    this.minRequestInterval = 600; // 600ms = 100 requests/minute (your approved quota)
    this.maxRetries = 3;
    this.requestCount = 0;
    this.windowStart = Date.now();
    this.maxRequestsPerMinute = 100; // Your approved quota limit
  }

  async generateVideo(prompt, referenceImageAnalysis = '') {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ prompt, referenceImageAnalysis, resolve, reject, timestamp: Date.now() });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.processing || this.requestQueue.length === 0) return;
    
    this.processing = true;
    console.log(`Processing video queue: ${this.requestQueue.length} requests pending`);
    
    while (this.requestQueue.length > 0) {
      const { prompt, referenceImageAnalysis, resolve, reject, timestamp } = this.requestQueue.shift();
      
      try {
        // Check if request is too old (5 minutes timeout)
        if (Date.now() - timestamp > 300000) {
          reject(new Error('Request timed out in queue'));
          continue;
        }

        // Rate limiting: ensure minimum interval between requests
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.minRequestInterval) {
          const waitTime = this.minRequestInterval - timeSinceLastRequest;
          console.log(`Rate limiting: waiting ${waitTime}ms before next video request`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        // Check quota availability before making request
        if (!this.checkQuotaAvailability()) {
          const resetTime = 60000 - (Date.now() - this.windowStart);
          console.log(`Quota exhausted, waiting ${resetTime}ms for reset`);
          await new Promise(resolve => setTimeout(resolve, resetTime));
          this.resetQuotaWindow();
        }
        
        const result = await this.generateVideoWithRetry(prompt, referenceImageAnalysis);
        this.lastRequestTime = Date.now();
        this.incrementRequestCount();
        resolve(result);
        
        // Small additional delay to be conservative
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.error('Video generation failed:', error);
        reject(error);
      }
    }
    
    this.processing = false;
    console.log('Video queue processing completed');
  }

  checkQuotaAvailability() {
    const now = Date.now();
    const windowDuration = 60000; // 1 minute
    
    // Reset counter if window has passed
    if (now - this.windowStart > windowDuration) {
      this.resetQuotaWindow();
    }
    
    return this.requestCount < this.maxRequestsPerMinute;
  }

  resetQuotaWindow() {
    this.requestCount = 0;
    this.windowStart = Date.now();
    console.log('Quota window reset');
  }

  incrementRequestCount() {
    this.requestCount++;
    console.log(`Quota usage: ${this.requestCount}/${this.maxRequestsPerMinute} requests this minute`);
  }

  async generateVideoWithRetry(prompt, referenceImageAnalysis = '') {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        console.log(`Video generation attempt ${attempt + 1}/${this.maxRetries}`);
        return await this.generateSingleVideo(prompt, referenceImageAnalysis);
      } catch (error) {
        console.error(`Video generation attempt ${attempt + 1} failed:`, error);
        
        if (error.message && (error.message.includes('429') || error.message.includes('Quota exceeded'))) {
          if (attempt < this.maxRetries - 1) {
            // Exponential backoff for quota errors, starting at 10 seconds
            const backoffTime = Math.pow(2, attempt) * 10000; // 10s, 20s, 40s
            console.log(`Quota exceeded, backing off for ${backoffTime}ms`);
            await new Promise(resolve => setTimeout(resolve, backoffTime));
            continue;
          }
          
          // If all retries failed due to quota, throw specific error
          throw new Error('Video generation quota exceeded despite rate limiting. Please try again later or contact support.');
        }
        
        // For non-quota errors, try fallbacks on last attempt
        if (attempt === this.maxRetries - 1) {
          throw error;
        }
        
        // Small delay before retry for non-quota errors
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  async generateSingleVideo(prompt, referenceImageAnalysis = '') {
    const videoPrompt = referenceImageAnalysis 
      ? `jewelry product video: ${prompt}, inspired by: ${referenceImageAnalysis}. MUST BE: pure white background, rotating three-quarter view showcase, professional studio lighting, sparkling reflections, smooth rotation, 360-degree turn, luxury presentation`
      : `jewelry product video: ${prompt}. MUST BE: pure white background, rotating three-quarter view showcase, professional studio lighting, sparkling reflections, smooth rotation, 360-degree turn, luxury presentation`;

    console.log('Generating video with Veo 3 Fast...');

    const request = {
      contents: [{
        role: 'user',
        parts: [{
          text: videoPrompt
        }]
      }],
      generationConfig: {
        maxOutputTokens: 1024,
        temperature: 0.2,
      },
      safetySettings: [
        {
          category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE'
        }
      ]
    };

    try {
      // Try Veo 3 Fast first
      const model = vertexAI.getGenerativeModel({
        model: 'veo-3.0-fast-generate-001',
      });

      const response = await model.generateContent(request);
      return this.processVideoResponse(response, 'veo-3.0-fast');
      
    } catch (error) {
      console.error('Veo 3 Fast failed, trying standard Veo 3:', error);
      
      // Fallback to standard Veo 3
      try {
        const fallbackModel = vertexAI.getGenerativeModel({
          model: 'veo-3.0-generate-001',
        });
        
        const response = await fallbackModel.generateContent(request);
        return this.processVideoResponse(response, 'veo-3.0');
        
      } catch (fallbackError) {
        console.error('Standard Veo 3 also failed, trying Veo 2:', fallbackError);
        
        // Final fallback to Veo 2
        const veo2Model = vertexAI.getGenerativeModel({
          model: 'veo-2.0-generate-001',
        });
        
        const response = await veo2Model.generateContent(request);
        return this.processVideoResponse(response, 'veo-2.0');
      }
    }
  }

  async processVideoResponse(response, modelUsed = 'unknown') {
    if (response.response && response.response.candidates && response.response.candidates[0]) {
      const candidate = response.response.candidates[0];
      
      if (candidate.content && candidate.content.parts && candidate.content.parts[0]) {
        const videoPart = candidate.content.parts[0];
        
        if (videoPart.inlineData && videoPart.inlineData.data) {
          const videoBuffer = Buffer.from(videoPart.inlineData.data, 'base64');
          const filename = `jewelry-video-${modelUsed}-${Date.now()}.mp4`;
          const publicUrl = await uploadImageToStorage(videoBuffer, filename, 'video/mp4');
          
          console.log(`Video generated successfully using ${modelUsed}`);
          
          return {
            dataUrl: `data:video/mp4;base64,${videoPart.inlineData.data}`,
            publicUrl: publicUrl,
            filename: filename,
            type: 'video',
            modelUsed: modelUsed
          };
        }
      }
    }
    
    throw new Error('No video generated in response');
  }
}

// Create singleton instance
const videoManager = new VideoGenerationManager();

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
            text: 'Please analyze this jewelry image and provide a detailed description for jewelry photography purposes.'
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

async function generateImageWithVertex(prompt, referenceImageAnalysis = '', isRefinement = false, baseImageDescription = '') {
  try {
    const authClient = await auth.getClient();
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    const location = 'us-central1';

    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/imagen-3.0-generate-001:predict`;

    // Enhanced catalog-style prompt with refinement context
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

    if (response.data.predictions && response.data.predictions[0]) {
      const prediction = response.data.predictions[0];

      if (prediction.bytesBase64Encoded) {
        const base64Data = `data:image/png;base64,${prediction.bytesBase64Encoded}`;
        const buffer = Buffer.from(prediction.bytesBase64Encoded, 'base64');
        
        // Upload to Google Cloud Storage and get public URL
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
    }

    throw new Error('No image generated in response');

  } catch (error) {
    console.error('Vertex AI error:', error.response?.data || error.message);
    throw error;
  }
}

// Updated generateVideoWithVertex function using the manager
async function generateVideoWithVertex(prompt, referenceImageAnalysis = '') {
  console.log('Video generation request received:', { prompt: prompt.substring(0, 50) + '...', hasReference: !!referenceImageAnalysis });
  
  try {
    const result = await videoManager.generateVideo(prompt, referenceImageAnalysis);
    console.log('Video generation completed successfully');
    return result;
  } catch (error) {
    console.error('Vertex AI video generation error:', error);
    throw error;
  }
}

// Enhanced fallback with refinement support
async function fallbackToStableDiffusion(prompt, referenceImageAnalysis = '', isRefinement = false, baseImageDescription = '') {
  const Replicate = require('replicate');
  const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
  });
  
  // Enhanced catalog prompt with refinement context
  let catalogPrompt;
  
  if (isRefinement && baseImageDescription) {
    catalogPrompt = `jewelry product photography refinement: Starting with ${baseImageDescription}, now ${prompt}. MUST BE: pure white background, three-quarter view angle, professional studio lighting, sparkling`;
  } else if (referenceImageAnalysis) {
    catalogPrompt = `jewelry product photography: ${prompt}, inspired by: ${referenceImageAnalysis}. MUST BE: pure white background, three-quarter view angle, professional studio lighting, sparkling`;
  } else {
    catalogPrompt = `jewelry product photography: ${prompt}. MUST BE: pure white background, three-quarter view angle, professional studio lighting, sparkling`;
  }
  
  const output = await replicate.run(
    "stability-ai/stable-diffusion:27b93a2413e7f36cd83da926f3656280b2931564ff050bf9575f1fdf9bcd7478",
    {
      input: {
        prompt: catalogPrompt,
        negative_prompt: "colored background, dark background, gray background, black background, textured background, front view, side view, back view, top view, multiple angles, blurry, low quality, hands, people, multiple items, text, shadows on background",
        width: 768,
        height: 768,
        num_inference_steps: 20,
        guidance_scale: 7.5
      }
    }
  );
  
  return {
    dataUrl: output[0],
    publicUrl: output[0],
    filename: isRefinement 
      ? `jewelry-refined-${Date.now()}.png`
      : `jewelry-catalog-${Date.now()}.png`
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

    const { message, conversationHistory = [], isRefinement = 'false', baseImageData, refinementCount = '0' } = req.body;
    
    // Parse data from FormData
    let parsedHistory = [];
    if (typeof conversationHistory === 'string') {
      try {
        parsedHistory = JSON.parse(conversationHistory);
      } catch (e) {
        console.log('Could not parse conversationHistory, using empty array');
        parsedHistory = [];
      }
    } else if (Array.isArray(conversationHistory)) {
      parsedHistory = conversationHistory;
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
      message: message?.substring(0, 50) + '...'
    });
    
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

    // Step 1: Claude consultation with refinement context
    let systemPrompt = `You are a jewelry designer assistant. Keep responses brief and focused (2-3 sentences max). A retailer is asking you to create a catalog image of jewelry based on a consumer request.

${referenceImageData ? `Reference image shows: ${referenceImageAnalysis}

Create a design inspired by this reference.` : ''}`;

    // Add refinement context to system prompt
    if (isRefinementRequest && baseImageInfo) {
      systemPrompt += `

REFINEMENT MODE: You are refining an existing jewelry design. The user wants to modify the current design.
Previous design: The user is working with an existing jewelry piece and wants modifications.
This is refinement #${refinementCount}.

Focus on the specific changes requested while maintaining the overall jewelry aesthetic.`;
    }

    systemPrompt += `

IMPORTANT FORMATTING:
- Keep responses concise and professional
- Use **bold** for emphasis on key details
- Always end with: GENERATE_IMAGE: [jewelry type and key details only]

For non-jewelry questions, simply say "I can only create jewelry images. What piece would you like me to design?"

The GENERATE_IMAGE description should be brief: just the jewelry type, main materials, and key visual features (e.g., "diamond solitaire engagement ring, platinum band, round brilliant cut").

For video requests, end with: GENERATE_VIDEO: [same brief description for rotating jewelry showcase]`;

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
    
    // Step 2: Image/Video generation with refinement context
    let imageResult = null;
    let videoResult = null;
    
    const isVideoRequest = (
      message.toLowerCase().includes('video') ||
      message.toLowerCase().includes('rotating') ||
      message.toLowerCase().includes('360') ||
      message.toLowerCase().includes('rotate') ||
      message.toLowerCase().includes('spin') ||
      message.toLowerCase().includes('animation') ||
      message.toLowerCase().includes('moving') ||
      claudeMessage.toLowerCase().includes('video') ||
      claudeMessage.includes('GENERATE_VIDEO:')
    );
    
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
      referenceImageData || // Always generate if reference image provided
      isRefinementRequest // Always generate for refinements
    );
    
    if (isJewelryRequest) {
      let prompt;
      
      if (claudeMessage.includes('GENERATE_IMAGE:')) {
        prompt = claudeMessage.split('GENERATE_IMAGE:')[1].trim();
      } else if (claudeMessage.includes('GENERATE_VIDEO:')) {
        prompt = claudeMessage.split('GENERATE_VIDEO:')[1].trim();
      } else {
        prompt = `${message.replace(/generate|create|image|video|of|an?/gi, '').trim()}, professional jewelry photography style`;
      }
      
      // Create base image description for refinements
      let baseImageDescription = '';
      if (isRefinementRequest && baseImageInfo && baseImageInfo.metadata) {
        baseImageDescription = `elegant jewelry piece (previous design)`;
      }
      
      if (isVideoRequest) {
        // Generate video with rate limiting
        try {
          console.log('Generating video with prompt:', prompt);
          console.log('Reference analysis:', referenceImageAnalysis || 'None');
          
          videoResult = await generateVideoWithVertex(prompt, referenceImageAnalysis);
          console.log('Video generated successfully with Google Vertex AI');
          
        } catch (videoError) {
          console.error('Vertex AI video generation error:', videoError);
          // No fallback for video - just log the error
        }
      } else {
        // Generate image with refinement support
        try {
          console.log('Generating image with prompt:', prompt);
          console.log('Reference analysis:', referenceImageAnalysis || 'None');
          console.log('Is refinement:', isRefinementRequest);
          console.log('Base image description:', baseImageDescription || 'None');
          
          imageResult = await generateImageWithVertex(
            prompt, 
            referenceImageAnalysis, 
            isRefinementRequest, 
            baseImageDescription
          );
          console.log('Image generated successfully with Google Vertex AI');
          
        } catch (imageError) {
          console.error('Vertex AI image generation error:', imageError);
          
          try {
            console.log('Falling back to Stable Diffusion');
            imageResult = await fallbackToStableDiffusion(
              prompt, 
              referenceImageAnalysis, 
              isRefinementRequest, 
              baseImageDescription
            );
            console.log('Image generated with Stable Diffusion fallback');
            
          } catch (sdError) {
            console.error('All image generation methods failed:', sdError);
          }
        }
      }
    }
    
    // Clean response
    const cleanMessage = claudeMessage.replace(/GENERATE_IMAGE:.*$/m, '').trim();
    
    res.status(200).json({
      message: cleanMessage,
      imageUrl: imageResult?.dataUrl || null,
      videoUrl: videoResult?.dataUrl || null,
      publicUrl: imageResult?.publicUrl || videoResult?.publicUrl || null,
      downloadUrl: imageResult?.dataUrl || videoResult?.dataUrl || null,
      conversationId: Date.now(),
      referenceImage: referenceImageData,
      contentType: videoResult ? 'video' : 'image',
      isRefinement: isRefinementRequest,
      refinementCount: parseInt(refinementCount) + (isRefinementRequest ? 1 : 0),
      metadata: (imageResult || videoResult) ? {
        filename: imageResult?.filename || videoResult?.filename,
        type: videoResult ? 'video/mp4' : 'image/png',
        downloadable: true,
        publicUrl: imageResult?.publicUrl || videoResult?.publicUrl,
        referenceImage: referenceImageData,
        isVideo: !!videoResult,
        isRefinement: isRefinementRequest,
        refinementCount: parseInt(refinementCount) + (isRefinementRequest ? 1 : 0),
        modelUsed: videoResult?.modelUsed || 'imagen-3.0' // Track which model was used
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
