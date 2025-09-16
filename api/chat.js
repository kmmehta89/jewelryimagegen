// api/chat.js - Enhanced with multi-angle image generation and video support
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

// GJS Logo watermark function
async function addWatermark(imageBuffer) {
  try {
    // You'll need to download and store the GJS logo
    // For now, we'll create a simple text watermark
    const watermarkedBuffer = await sharp(imageBuffer)
      .composite([{
        input: {
          text: {
            text: 'GJS',
            fontfile: 'Arial', // You can specify a font file path
            fontSize: 24,
            rgba: true,
          },
          create: {
            width: 80,
            height: 30,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 0.8 }
          }
        },
        top: 20,
        left: 20,
        blend: 'over'
      }])
      .toBuffer();
    
    return watermarkedBuffer;
  } catch (error) {
    console.error('Error adding watermark:', error);
    return imageBuffer; // Return original if watermarking fails
  }
}

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

// Enhanced multi-angle image generation
async function generateMultiAngleImages(prompt, referenceImageAnalysis = '') {
  try {
    const authClient = await auth.getClient();
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    const location = 'us-central1';

    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/imagen-3.0-generate-001:predict`;

    // Define different angles and their specific prompts
    const angles = [
      {
        name: 'front',
        description: 'straight front view, centered, face-on perspective'
      },
      {
        name: 'three-quarter',
        description: '3/4 angle view, showing dimension and depth, slightly turned'
      },
      {
        name: 'side',
        description: 'perfect side profile view, showcasing thickness and profile'
      },
      {
        name: 'top',
        description: 'top-down bird\'s eye view, showing surface details and shape'
      }
    ];

    const basePrompt = referenceImageAnalysis 
      ? `Professional ecommerce jewelry photography inspired by: ${referenceImageAnalysis}. ${prompt}`
      : `Professional ecommerce jewelry photography: ${prompt}`;

    const images = [];

    // Generate images for each angle
    for (const angle of angles) {
      const enhancedPrompt = `${basePrompt}, ${angle.description}, pure white background, studio lighting, high-end commercial product photography, metallic finish with reflective highlights, professional jewelry photography, clean and minimalist, high resolution, detailed craftsmanship, luxury presentation, no shadows on background`;

      const requestBody = {
        instances: [{
          prompt: enhancedPrompt,
          negative_prompt: "blurry, low quality, distorted, ugly, bad anatomy, watermark, text, signature, hands, fingers, people, colored background, shadows on background, cluttered, busy background, poor lighting, amateur photography",
          parameters: {
            aspectRatio: "1:1",
            outputMimeType: "image/png",
            safetyFilterLevel: "block_some",
            personGeneration: "dont_allow"
          }
        }],
        parameters: { sampleCount: 1 }
      };

      try {
        const { token: accessToken } = await authClient.getAccessToken();

        const response = await axios.post(url, requestBody, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 90000 // Increased timeout for multiple images
        });

        if (response.data.predictions && response.data.predictions[0]) {
          const prediction = response.data.predictions[0];

          if (prediction.bytesBase64Encoded) {
            let imageBuffer = Buffer.from(prediction.bytesBase64Encoded, 'base64');
            
            // Add GJS watermark
            imageBuffer = await addWatermark(imageBuffer);
            
            const filename = `jewelry-design-${angle.name}-${Date.now()}.png`;
            const publicUrl = await uploadImageToStorage(imageBuffer, filename, 'image/png');
            const base64Data = `data:image/png;base64,${imageBuffer.toString('base64')}`;
            
            images.push({
              angle: angle.name,
              dataUrl: base64Data,
              publicUrl: publicUrl,
              filename: filename
            });
          }
        }
      } catch (angleError) {
        console.error(`Error generating ${angle.name} view:`, angleError);
        // Continue with other angles even if one fails
      }
    }

    if (images.length === 0) {
      throw new Error('No images generated successfully');
    }

    return images;

  } catch (error) {
    console.error('Multi-angle image generation error:', error);
    throw error;
  }
}

// Video generation with Veo
async function generateVideoWithVeo(prompt, referenceImageAnalysis = '') {
  try {
    const authClient = await auth.getClient();
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    const location = 'us-central1';

    // Veo model endpoint
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/veo:predict`;

    const enhancedPrompt = referenceImageAnalysis 
      ? `Professional jewelry video showcasing: ${referenceImageAnalysis}. ${prompt}. Smooth 360-degree rotation, white background, studio lighting, metallic reflections, luxury presentation, high-end commercial jewelry video, detailed close-ups`
      : `Professional jewelry video: ${prompt}. Smooth 360-degree rotation, white background, studio lighting, metallic reflections, luxury presentation, high-end commercial jewelry video, detailed close-ups`;

    const requestBody = {
      instances: [{
        prompt: enhancedPrompt,
        negative_prompt: "shaky camera, poor quality, blurry, hands, fingers, people, colored background, amateur video",
        parameters: {
          duration: "5s", // 5-second video
          aspectRatio: "16:9",
          outputMimeType: "video/mp4",
          motionBucket: 3, // Controls motion intensity
          safetyFilterLevel: "block_some"
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
      timeout: 180000 // 3 minutes timeout for video generation
    });

    if (response.data.predictions && response.data.predictions[0]) {
      const prediction = response.data.predictions[0];

      if (prediction.bytesBase64Encoded) {
        const videoBuffer = Buffer.from(prediction.bytesBase64Encoded, 'base64');
        const filename = `jewelry-video-${Date.now()}.mp4`;
        const publicUrl = await uploadImageToStorage(videoBuffer, filename, 'video/mp4');
        const base64Data = `data:video/mp4;base64,${prediction.bytesBase64Encoded}`;
        
        return {
          dataUrl: base64Data,
          publicUrl: publicUrl,
          filename: filename,
          type: 'video'
        };
      }
    }

    throw new Error('No video generated in response');

  } catch (error) {
    console.error('Veo video generation error:', error);
    throw error;
  }
}

// Fallback to Replicate for images
async function fallbackToStableDiffusion(prompt, referenceImageAnalysis = '') {
  const Replicate = require('replicate');
  const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
  });
  
  const enhancedPrompt = referenceImageAnalysis 
    ? `Professional ecommerce jewelry photography inspired by: ${referenceImageAnalysis}. ${prompt}. Pure white background, studio lighting, metallic finish, high-end commercial product photography`
    : `Professional ecommerce jewelry photography: ${prompt}. Pure white background, studio lighting, metallic finish, high-end commercial product photography`;
  
  const output = await replicate.run(
    "stability-ai/stable-diffusion:27b93a2413e7f36cd83da926f3656280b2931564ff050bf9575f1fdf9bcd7478",
    {
      input: {
        prompt: enhancedPrompt,
        negative_prompt: "blurry, low quality, distorted, ugly, bad anatomy, watermark, text, signature, hands, fingers, people, colored background",
        width: 768,
        height: 768,
        num_inference_steps: 25,
        guidance_scale: 7.5
      }
    }
  );
  
  return [{
    angle: 'single',
    dataUrl: output[0],
    publicUrl: output[0],
    filename: `jewelry-design-${Date.now()}.png`
  }];
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
    
    // Parse conversationHistory if it's a string (from FormData)
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

    // Check if user wants video
    const wantsVideo = message.toLowerCase().includes('video') || 
                      message.toLowerCase().includes('animation') || 
                      message.toLowerCase().includes('rotate') ||
                      message.toLowerCase().includes('360');

    // Step 1: Claude consultation with enhanced prompting
    const systemPrompt = `You are a jewelry designer assistant. Keep responses brief and focused (2-3 sentences max). A retailer is asking you to create ${wantsVideo ? 'a video' : 'images'} of jewelry based on a consumer request.

${referenceImageData ? `The user provided a reference image showing: ${referenceImageAnalysis}

Create a design inspired by this reference.` : ''}

IMPORTANT FORMATTING:
- Keep responses concise and professional
- Use **bold** for emphasis on key details
- Always end with: ${wantsVideo ? 'GENERATE_VIDEO:' : 'GENERATE_IMAGES:'} [detailed technical description for AI generation]

For non-jewelry questions, simply say "I can only create jewelry ${wantsVideo ? 'videos' : 'images'}. What piece would you like me to design?"

The description should be detailed and technical for ${wantsVideo ? 'video' : 'photography'}: jewelry type, materials, style, setting, stones, finish, lighting setup.`;

    const claudeMessages = [
      ...parsedHistory.filter(msg => msg.role !== 'system'),
      { role: 'user', content: message || `Please create jewelry ${wantsVideo ? 'video' : 'images'} inspired by this reference` }
    ];

    const claudeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: claudeMessages
    });
    
    const claudeMessage = claudeResponse.content[0].text;
    
    // Step 2: Generate content based on request type
    let contentResult = null;
    
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
      message.toLowerCase().includes('video') ||
      claudeMessage.includes('GENERATE_IMAGES:') ||
      claudeMessage.includes('GENERATE_VIDEO:') ||
      referenceImageData
    );
    
    if (isJewelryRequest) {
      let contentPrompt;
      
      if (wantsVideo && claudeMessage.includes('GENERATE_VIDEO:')) {
        contentPrompt = claudeMessage.split('GENERATE_VIDEO:')[1].trim();
      } else if (claudeMessage.includes('GENERATE_IMAGES:')) {
        contentPrompt = claudeMessage.split('GENERATE_IMAGES:')[1].trim();
      } else {
        contentPrompt = `${message.replace(/generate|create|image|video|of|an?/gi, '').trim()}, professional jewelry photography style`;
      }
      
      try {
        if (wantsVideo) {
          console.log('Generating video with prompt:', contentPrompt);
          contentResult = await generateVideoWithVeo(contentPrompt, referenceImageAnalysis);
          console.log('Video generated successfully with Google Veo');
        } else {
          console.log('Generating multi-angle images with prompt:', contentPrompt);
          const images = await generateMultiAngleImages(contentPrompt, referenceImageAnalysis);
          contentResult = { images, type: 'images' };
          console.log(`Generated ${images.length} images successfully with Google Vertex AI`);
        }
        
      } catch (generationError) {
        console.error('Primary generation error:', generationError);
        
        if (!wantsVideo) {
          // Fallback only available for images
          try {
            console.log('Falling back to Stable Diffusion');
            const images = await fallbackToStableDiffusion(contentPrompt, referenceImageAnalysis);
            contentResult = { images, type: 'images' };
            console.log('Images generated with Stable Diffusion fallback');
            
          } catch (sdError) {
            console.error('All image generation methods failed:', sdError);
          }
        } else {
          console.error('Video generation failed and no fallback available');
        }
      }
    }
    
    // Clean response
    const cleanMessage = claudeMessage.replace(/(GENERATE_IMAGES:|GENERATE_VIDEO:).*$/m, '').trim();
    
    // Prepare response based on content type
    let responseData = {
      message: cleanMessage,
      conversationId: Date.now(),
      referenceImage: referenceImageData,
    };

    if (contentResult?.type === 'video') {
      responseData = {
        ...responseData,
        videoUrl: contentResult.dataUrl,
        publicUrl: contentResult.publicUrl,
        downloadUrl: contentResult.dataUrl,
        metadata: {
          filename: contentResult.filename,
          type: 'video/mp4',
          downloadable: true,
          publicUrl: contentResult.publicUrl,
          referenceImage: referenceImageData
        }
      };
    } else if (contentResult?.images) {
      // For multiple images, return the first as primary with all as metadata
      const primaryImage = contentResult.images[0];
      responseData = {
        ...responseData,
        imageUrl: primaryImage?.dataUrl || null,
        publicUrl: primaryImage?.publicUrl || null,
        downloadUrl: primaryImage?.dataUrl || null,
        images: contentResult.images, // All angles
        metadata: primaryImage ? {
          filename: primaryImage.filename,
          type: 'image/png',
          downloadable: true,
          publicUrl: primaryImage.publicUrl,
          referenceImage: referenceImageData,
          allImages: contentResult.images
        } : null
      };
    }
    
    res.status(200).json(responseData);
    
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
