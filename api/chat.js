const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const { Storage } = require('@google-cloud/storage');
const { VertexAI } = require('@google-cloud/vertexai');
const Replicate = require('replicate');
const sharp = require('sharp');

// Enhanced system prompt for Claude updated
const systemPrompt = `You are Cleo, an expert jewelry design consultant and AI image generator for GJS (a high-end jewelry manufacturer). You create detailed, professional jewelry designs and generate catalog-quality images.

CORE RESPONSIBILITIES:
- Analyze jewelry requests and reference images with technical precision
- Create detailed jewelry designs with specifications
- Generate professional catalog-style jewelry photographs

JEWELRY EXPERTISE:
- Diamond cuts, clarity, color grades (GIA standards)
- Precious metals: platinum, 14k/18k gold (white, yellow, rose)
- Gemstone types, cuts, and settings
- Ring settings: prong, bezel, pave, channel, halo
- Jewelry construction techniques and proportions

VISUAL ANALYSIS (for reference images):
When analyzing reference images, identify:
- Metal type and finish
- Stone shapes, sizes, and arrangements  
- Setting styles and construction details
- Design proportions and aesthetic elements
- Manufacturing techniques required

DESIGN PROCESS:
1. Understand the request (style, budget tier, occasion)
2. Specify technical details (metal, stones, dimensions)
3. Create detailed description for manufacturing
4. Generate professional catalog photograph

RESPONSE FORMAT:
**Design Concept:** [Brief description]
**Technical Specifications:**
- Metal: [type, karat, finish]
- Main Stone: [type, cut, size, quality]
- Accent Stones: [details if applicable]
- Setting Style: [prong, bezel, etc.]
- Dimensions: [approximate sizes]

**Manufacturing Notes:** [Key construction details]

**Visual Description:** [Detailed appearance for customer]

GENERATE_IMAGE: [Detailed technical photography prompt - see guidelines below]

IMAGE GENERATION GUIDELINES:
Always use this exact format for GENERATE_IMAGE prompts:

"Professional jewelry catalog photography, [JEWELRY TYPE] in [METAL TYPE], featuring [STONE DETAILS], photographed at 3/4 angle profile view on pure white seamless background, studio lighting with key light at 45 degrees creating dramatic shadows and highlights, fill light to reduce contrast, rim lighting to enhance metal edges and create separation, macro lens with shallow depth of field focusing on center stone, high-end commercial photography style, sparkling diamonds with internal fire and brilliance, lustrous metal surface with subtle reflections, catalog quality image, 8K resolution, professional color grading, no distracting elements"

SPECIFIC LIGHTING REQUIREMENTS:
- Pure white seamless background (RGB 255,255,255)
- 3/4 angle view (45-degree rotation from front)
- Key light at 45 degrees above and to the side
- Fill light opposite key light to soften shadows
- Rim/edge lighting to separate jewelry from background
- Highlight reflectors to enhance sparkle

METAL RENDERING:
- Platinum: Cool, bright white reflections
- White gold: Slightly warmer than platinum, rhodium-plated appearance
- Yellow gold: Warm golden reflections and highlights
- Rose gold: Subtle pink undertones in highlights

DIAMOND/GEMSTONE RENDERING:
- Internal fire and brilliance visible
- Crisp facet definition
- Rainbow light dispersion in diamonds
- Color stones: saturated hues with transparency
- Proper proportions for cut quality

CONSISTENCY REQUIREMENTS:
- Always 3/4 angle profile view
- Consistent lighting setup
- White background with subtle drop shadow
- Sharp focus on main stone/design element
- Commercial catalog photography aesthetic

For non-jewelry requests, respond: "I specialize in jewelry design and image generation. What type of jewelry piece would you like me to create?"

Remember: Your images represent GJS's premium brand quality. Every generated image should look like it belongs in a high-end jewelry catalog or luxury e-commerce site.`;

// Enhanced reference image analysis prompt
const referenceAnalysisPrompt = `Analyze this jewelry reference image with technical precision for recreating similar designs. Identify:

DESIGN ELEMENTS:
- Jewelry type and style category
- Overall design aesthetic and era
- Proportions and scale relationships

MATERIALS AND CONSTRUCTION:
- Metal type (estimate: platinum, white/yellow/rose gold)
- Surface finish (polished, matte, textured)
- Construction techniques visible

STONE DETAILS:
- Types of stones present
- Cut styles and shapes
- Setting techniques (prong, bezel, pave, etc.)
- Stone arrangements and patterns

TECHNICAL SPECIFICATIONS:
- Approximate dimensions and proportions
- Manufacturing complexity level
- Quality indicators visible

PHOTOGRAPHIC ANALYSIS:
- Lighting setup and angle
- Background and composition
- What makes this image effective for jewelry display

Provide a detailed technical description focusing on specific, measurable details for design recreation.`;

// Enhanced image prompt creation function
function createEnhancedImagePrompt(originalPrompt, referenceAnalysis) {
  // Base catalog photography settings
  const baseSettings = `Professional luxury jewelry catalog photography, macro lens with 100mm focal length, pure white seamless background (RGB 255,255,255), 3/4 angle profile view at 45-degree rotation`;
  
  // Advanced lighting specifications
  const lightingSpecs = `studio lighting setup: key light with 60x90cm softbox positioned 45 degrees above and to the right, fill light with umbrella reflector opposite side at 50% power, rim light behind subject for edge separation, two reflector cards positioned to enhance diamond sparkle, subtle graduated backdrop lighting`;
  
  // Quality and technical specs
  const technicalSpecs = `shot with Canon EOS R5, 100mm macro lens, f/8 aperture, ISO 100, focus stacking for maximum sharpness, 8K resolution, professional color grading with slight contrast enhancement, catalog quality commercial product photography`;
  
  // Material rendering instructions
  const materialRendering = `sparkling diamonds showing internal fire with rainbow light dispersion, brilliant cut facets with razor-sharp definition, lustrous precious metal surfaces with controlled reflections, gemstones displaying proper transparency and vibrant color saturation, no overexposure or harsh reflections`;
  
  // Extract jewelry details from prompt
  const jewelryType = extractJewelryType(originalPrompt);
  const metalType = extractMetalType(originalPrompt);
  const stoneDetails = extractStoneDetails(originalPrompt);
  
  // Reference image context
  let referenceContext = '';
  if (referenceAnalysis) {
    referenceContext = `incorporating design elements from reference: ${referenceAnalysis.slice(0, 150)}`;
  }
  
  // Professional finishing touches
  const finishingDetails = `subtle drop shadow beneath jewelry piece, perfect white balance, no color casts, luxury brand presentation quality, suitable for high-end e-commerce catalog, museum-quality lighting, jeweler's loupe level detail`;
  
  // Combine everything into enhanced prompt
  const enhancedPrompt = `${baseSettings}, ${jewelryType} in ${metalType}, ${stoneDetails}, ${referenceContext}, ${lightingSpecs}, ${materialRendering}, ${technicalSpecs}, ${finishingDetails}, absolutely no distracting elements or imperfections`;
  
  console.log('Enhanced image prompt:', enhancedPrompt);
  return enhancedPrompt;
}

// Jewelry type extraction with more specific categories
function extractJewelryType(prompt) {
  const types = {
    'engagement ring': 'elegant solitaire engagement ring',
    'wedding band': 'classic wedding band',
    'eternity ring': 'diamond eternity band',
    'tennis bracelet': 'diamond tennis bracelet',
    'pendant': 'pendant necklace with chain',
    'stud earrings': 'diamond stud earrings',
    'hoop earrings': 'diamond hoop earrings',
    'drop earrings': 'elegant drop earrings',
    'cocktail ring': 'statement cocktail ring',
    'signet ring': 'men\'s signet ring',
    'ring': 'luxury designer ring',
    'necklace': 'elegant necklace',
    'bracelet': 'luxury bracelet',
    'earrings': 'designer earrings',
    'brooch': 'vintage-inspired brooch',
    'cufflinks': 'men\'s luxury cufflinks'
  };
  
  const prompt_lower = prompt.toLowerCase();
  for (const [key, value] of Object.entries(types)) {
    if (prompt_lower.includes(key)) {
      return value;
    }
  }
  return 'luxury jewelry piece';
}

// Enhanced metal type detection
function extractMetalType(prompt) {
  const metals = {
    'platinum': 'solid platinum with mirror-bright finish',
    'white gold': '18k white gold with rhodium plating and bright white finish',
    'yellow gold': '18k yellow gold with polished warm golden finish',
    'rose gold': '18k rose gold with warm pink undertones and polished finish',
    'two tone': '18k two-tone gold combining white and yellow gold',
    'gold': '18k yellow gold with polished finish'
  };
  
  const prompt_lower = prompt.toLowerCase();
  for (const [key, value] of Object.entries(metals)) {
    if (prompt_lower.includes(key)) {
      return value;
    }
  }
  return '18k white gold with rhodium plating';
}

// Enhanced stone details extraction
function extractStoneDetails(prompt) {
  const prompt_lower = prompt.toLowerCase();
  let stoneDetails = [];
  
  // Diamond details with specific cuts
  if (prompt_lower.includes('diamond')) {
    if (prompt_lower.includes('round brilliant') || prompt_lower.includes('round')) {
      stoneDetails.push('round brilliant cut diamond center stone with 57 facets');
    } else if (prompt_lower.includes('princess')) {
      stoneDetails.push('princess cut diamond center stone with square shape');
    } else if (prompt_lower.includes('emerald cut')) {
      stoneDetails.push('emerald cut diamond with rectangular step-cut faceting');
    } else if (prompt_lower.includes('cushion')) {
      stoneDetails.push('cushion cut diamond with rounded square shape');
    } else if (prompt_lower.includes('oval')) {
      stoneDetails.push('oval brilliant cut diamond center stone');
    } else if (prompt_lower.includes('pear')) {
      stoneDetails.push('pear-shaped diamond with teardrop silhouette');
    } else {
      stoneDetails.push('brilliant cut diamond center stone with exceptional fire');
    }
    
    // Setting styles
    if (prompt_lower.includes('halo')) {
      stoneDetails.push('surrounded by micro-pave diamond halo');
    }
    if (prompt_lower.includes('pave')) {
      stoneDetails.push('with precision-set pave diamond accents');
    }
    if (prompt_lower.includes('channel')) {
      stoneDetails.push('with channel-set diamond band');
    }
    if (prompt_lower.includes('prong')) {
      stoneDetails.push('held by four-prong setting');
    } else if (prompt_lower.includes('bezel')) {
      stoneDetails.push('in sleek bezel setting');
    }
  }
  
  // Colored stones with specific descriptions
  const coloredStones = {
    'sapphire': 'vivid blue sapphire with excellent transparency',
    'ruby': 'rich red ruby with exceptional color saturation',
    'emerald': 'deep green emerald with natural inclusions',
    'amethyst': 'royal purple amethyst with brilliant clarity',
    'topaz': 'bright blue topaz with perfect clarity',
    'aquamarine': 'pale blue aquamarine with icy transparency',
    'garnet': 'deep red garnet with warm undertones'
  };
  
  Object.entries(coloredStones).forEach(([stone, description]) => {
    if (prompt_lower.includes(stone)) {
      stoneDetails.push(`featuring ${description}`);
    }
  });
  
  return stoneDetails.length > 0 
    ? stoneDetails.join(', ')
    : 'featuring premium gemstones with exceptional clarity and brilliance';
}

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Initialize Google Cloud Storage
let bucket;
if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY && process.env.GOOGLE_STORAGE_BUCKET) {
  try {
    const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const storage = new Storage({
      credentials: serviceAccountKey,
      projectId: serviceAccountKey.project_id,
    });
    bucket = storage.bucket(process.env.GOOGLE_STORAGE_BUCKET);
    console.log('Google Cloud Storage initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Google Cloud Storage:', error);
  }
}

// Upload image to Google Cloud Storage
async function uploadToCloudStorage(imageBuffer, filename) {
  if (!bucket) {
    throw new Error('Google Cloud Storage not configured');
  }

  const file = bucket.file(`jewelry-images/${filename}`);
  const stream = file.createWriteStream({
    metadata: {
      contentType: 'image/png',
    },
    public: true,
  });

  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('finish', () => {
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${file.name}`;
      resolve(publicUrl);
    });
    stream.end(imageBuffer);
  });
}

// Enhanced Vertex AI image generation with fixed authentication
async function generateImageWithVertex(prompt, referenceAnalysis) {
  const enhancedPrompt = createEnhancedImagePrompt(prompt, referenceAnalysis);
  
  try {
    // Parse and validate service account key
    let serviceAccountKey;
    try {
      serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    } catch (parseError) {
      console.error('Invalid GOOGLE_SERVICE_ACCOUNT_KEY JSON format:', parseError);
      throw new Error('Invalid Google service account key format');
    }
    
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    
    if (!projectId) {
      throw new Error('GOOGLE_CLOUD_PROJECT_ID not configured');
    }

    // Fix private key formatting issues that cause OpenSSL errors
    if (serviceAccountKey.private_key) {
      // Replace escaped newlines with actual newlines
      let privateKey = serviceAccountKey.private_key.replace(/\\n/g, '\n');
      
      // Remove any extra whitespace or newlines that might cause issues
      privateKey = privateKey.trim();
      
      // Ensure proper PEM format
      if (!privateKey.startsWith('-----BEGIN PRIVATE KEY-----')) {
        throw new Error('Invalid private key format - missing header');
      }
      if (!privateKey.endsWith('-----END PRIVATE KEY-----')) {
        throw new Error('Invalid private key format - missing footer');
      }
      
      // Update the key in the service account object
      serviceAccountKey.private_key = privateKey;
    }
    
    // Initialize Vertex AI with proper authentication
    const vertex_ai = new VertexAI({
      project: projectId,
      location: 'us-central1',
      googleAuthOptions: {
        credentials: serviceAccountKey,
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
      },
    });

    // Use the correct model for image generation
    const model = 'imagegeneration@006';
    const generativeModel = vertex_ai.preview.getGenerativeModel({
      model: model,
    });

    // Create the request with enhanced prompt
    const request = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: enhancedPrompt
            }
          ]
        }
      ],
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.3,
        topP: 0.8,
        topK: 32,
      },
    };

    console.log('Attempting Vertex AI generation with enhanced prompt...');
    const streamingResp = await generativeModel.generateContentStream(request);
    const contentResponse = await streamingResp.response;
    
    if (contentResponse.candidates && contentResponse.candidates[0]) {
      const candidate = contentResponse.candidates[0];
      if (candidate.content && candidate.content.parts) {
        for (const part of candidate.content.parts) {
          if (part.inlineData && part.inlineData.data) {
            const imageBuffer = Buffer.from(part.inlineData.data, 'base64');
            const optimizedBuffer = await sharp(imageBuffer)
              .png({ quality: 95 })
              .resize(1024, 1024, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
              .toBuffer();
            
            const timestamp = Date.now();
            const filename = `vertex-jewelry-${timestamp}.png`;
            
            const dataUrl = `data:image/png;base64,${optimizedBuffer.toString('base64')}`;
            
            let publicUrl = null;
            try {
              publicUrl = await uploadToCloudStorage(optimizedBuffer, filename);
            } catch (uploadError) {
              console.error('Cloud storage upload failed:', uploadError);
            }
            
            return {
              dataUrl: dataUrl,
              publicUrl: publicUrl,
              filename: filename
            };
          }
        }
      }
    }
    
    throw new Error('No image data received from Vertex AI');
    
  } catch (error) {
    console.error('Vertex AI generation error:', error);
    // Re-throw with more context
    if (error.message.includes('authentication') || error.message.includes('DECODER')) {
      throw new Error(`Authentication failed: Check your GOOGLE_SERVICE_ACCOUNT_KEY format. Original error: ${error.message}`);
    }
    throw error;
  }
}

// Enhanced Stable Diffusion fallback
async function fallbackToStableDiffusion(prompt, referenceAnalysis) {
  const enhancedPrompt = createEnhancedImagePrompt(prompt, referenceAnalysis);
  
  const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
  });

  const model = "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b";
  
  try {
    const output = await replicate.run(model, {
      input: {
        prompt: enhancedPrompt,
        negative_prompt: "blurry, low quality, distorted, amateur, poor lighting, colored background, multiple objects, hands, people, text, watermarks, overexposed, underexposed, noise, grain, cluttered, busy background, distracting elements",
        width: 1024,
        height: 1024,
        num_inference_steps: 50,
        guidance_scale: 7.5,
        scheduler: "DPMSolverMultistep",
        num_outputs: 1,
        apply_watermark: false
      }
    });

    if (output && output[0]) {
      const response = await fetch(output[0]);
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      const optimizedBuffer = await sharp(buffer)
        .png({ quality: 95 })
        .resize(1024, 1024, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .toBuffer();
      
      const timestamp = Date.now();
      const filename = `sd-jewelry-${timestamp}.png`;
      
      const dataUrl = `data:image/png;base64,${optimizedBuffer.toString('base64')}`;
      
      let publicUrl = null;
      try {
        publicUrl = await uploadToCloudStorage(optimizedBuffer, filename);
      } catch (uploadError) {
        console.error('Cloud storage upload failed:', uploadError);
        publicUrl = output[0]; // Use original URL as fallback
      }
      
      return {
        dataUrl: dataUrl,
        publicUrl: publicUrl,
        filename: filename
      };
    }
    
    throw new Error('No image generated');
    
  } catch (error) {
    console.error('Stable Diffusion error:', error);
    throw error;
  }
}

// Main API handler
module.exports = async (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Handle multipart form data
  const uploadMiddleware = upload.single('referenceImage');
  
  await new Promise((resolve, reject) => {
    uploadMiddleware(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  try {
    const { message, conversationHistory } = req.body;
    const parsedHistory = conversationHistory ? JSON.parse(conversationHistory) : [];
    
    // Handle reference image if provided
    let referenceImageData = null;
    if (req.file) {
      const optimizedBuffer = await sharp(req.file.buffer)
        .jpeg({ quality: 85 })
        .resize(800, 600, { fit: 'inside', withoutEnlargement: true })
        .toBuffer();
      
      const base64Data = optimizedBuffer.toString('base64');
      const timestamp = Date.now();
      const filename = `reference-${timestamp}.jpg`;
      
      let publicUrl = null;
      try {
        publicUrl = await uploadToCloudStorage(optimizedBuffer, filename);
      } catch (uploadError) {
        console.error('Reference image upload failed:', uploadError);
      }
      
      referenceImageData = {
        data: base64Data,
        filename: filename,
        publicUrl: publicUrl
      };
    }

    console.log('Processing request:', {
      message: message?.slice(0, 100) + '...',
      hasReferenceImage: !!referenceImageData,
      historyLength: parsedHistory.length
    });

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    // Reference image analysis (if provided)
    let referenceImageAnalysis = null;
    if (referenceImageData) {
      try {
        const analysisResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: referenceAnalysisPrompt
              },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: referenceImageData.data
                }
              }
            ]
          }]
        });
        
        referenceImageAnalysis = analysisResponse.content[0].text;
        console.log('Reference image analyzed:', referenceImageAnalysis.slice(0, 200) + '...');
      } catch (analysisError) {
        console.error('Reference image analysis failed:', analysisError);
      }
    }

    // Main Claude conversation
    const claudeMessages = [
      ...parsedHistory.filter(msg => msg.role !== 'system'),
      { role: 'user', content: message || 'Please create jewelry inspired by this reference image' }
    ];

    const claudeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: claudeMessages
    });
    
    const claudeMessage = claudeResponse.content[0].text;
    
    // Image generation with reference context
    let imageResult = null;
    
    const isJewelryRequest = (
      message?.toLowerCase().includes('ring') ||
      message?.toLowerCase().includes('jewelry') ||
      message?.toLowerCase().includes('diamond') ||
      message?.toLowerCase().includes('necklace') ||
      message?.toLowerCase().includes('bracelet') ||
      message?.toLowerCase().includes('earring') ||
      message?.toLowerCase().includes('pendant') ||
      message?.toLowerCase().includes('engagement') ||
      message?.toLowerCase().includes('wedding') ||
      message?.toLowerCase().includes('generate') ||
      message?.toLowerCase().includes('create') ||
      message?.toLowerCase().includes('image') ||
      claudeMessage.includes('GENERATE_IMAGE:') ||
      referenceImageData
    );
    
    if (isJewelryRequest) {
      let imagePrompt;
      
      if (claudeMessage.includes('GENERATE_IMAGE:')) {
        imagePrompt = claudeMessage.split('GENERATE_IMAGE:')[1].trim();
      } else {
        imagePrompt = `${message?.replace(/generate|create|image|of|an?/gi, '').trim() || 'luxury jewelry piece'}, professional jewelry photography style`;
      }
      
      try {
        console.log('Generating image with enhanced prompt');
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
      referenceImage: referenceImageData,
      metadata: imageResult ? {
        filename: imageResult.filename,
        type: 'image/png',
        downloadable: true,
        publicUrl: imageResult.publicUrl,
        referenceImage: referenceImageData
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
