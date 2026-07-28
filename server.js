const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Config & State file paths
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Helper to read JSON safely
function readJsonFile(filePath, defaultVal = {}) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error);
  }
  return defaultVal;
}

// --- PROJECTS ---------------------------------------------------------------
// A project is a folder. It holds one `<name>.mmproj.json` alongside an
// `assets/` directory, so the folder can be zipped, moved or dropped on a
// shared drive and still open. The project file records its own workingFolder,
// but the file's actual location always wins — that is what makes a moved or
// copied project folder just work.

const PROJECT_EXT = '.mmproj.json';

function projectNameFromPath(projectPath) {
  return path.basename(projectPath).replace(/\.mmproj\.json$/i, '');
}

/** The active project file, or null when running on the legacy loose state file. */
function getActiveProjectPath() {
  const config = readJsonFile(CONFIG_FILE);
  const active = config.activeProjectPath;
  if (active && fs.existsSync(active)) return active;
  return null;
}

// Helper to get current project working root from config
function getWorkingRoot() {
  // Folder-per-project: the project file's own directory is the working root.
  const active = getActiveProjectPath();
  if (active) return path.dirname(active);

  const config = readJsonFile(CONFIG_FILE);
  if (config.workingFolder && fs.existsSync(config.workingFolder)) {
    return config.workingFolder;
  }
  return __dirname;
}

function readProjectFile(projectPath) {
  const raw = readJsonFile(projectPath, null);
  if (!raw) throw new Error(`Could not read project file: ${projectPath}`);
  // Accept both the wrapped format and a bare legacy state blob.
  return raw.state && typeof raw.state === 'object' ? raw : { state: raw };
}

function writeProjectFile(projectPath, state, name) {
  const dir = path.dirname(projectPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const payload = {
    format: 'moviemaker-project',
    formatVersion: 1,
    name: name || projectNameFromPath(projectPath),
    workingFolder: dir,
    savedAt: new Date().toISOString(),
    state: state || {}
  };
  if (!writeJsonFile(projectPath, payload)) {
    throw new Error(`Failed to write project file: ${projectPath}`);
  }
  // Every project owns its media directory.
  const assetsDir = path.join(dir, 'assets');
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
  return payload;
}

/** Remember this project at the top of the recent list and make it active. */
function setActiveProject(projectPath) {
  const config = readJsonFile(CONFIG_FILE);
  const recent = (config.recentProjects || []).filter(entry => (
    entry && entry.path && path.resolve(entry.path) !== path.resolve(projectPath)
  ));
  recent.unshift({
    path: projectPath,
    name: projectNameFromPath(projectPath),
    lastOpened: new Date().toISOString()
  });
  config.activeProjectPath = projectPath;
  config.recentProjects = recent.slice(0, 12);
  writeJsonFile(CONFIG_FILE, config);
  return config;
}

// Helper to get dynamic assets directory path
function getAssetsDir() {
  const dir = path.join(getWorkingRoot(), 'assets');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Helper to get dynamic project state file path
function getStateFilePath() {
  return getActiveProjectPath() || path.join(getWorkingRoot(), 'project_state.json');
}

// Serve assets statically (wrapped dynamically to support runtime config updates)
app.use('/assets', (req, res, next) => {
  express.static(getAssetsDir())(req, res, next);
});

// Helper to write JSON safely
function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error(`Error writing ${filePath}:`, error);
    return false;
  }
}

// Helper to download a file from a URL to assets
async function downloadFile(url, prefix, ext) {
  // If it's a data URL, handle base64
  if (url.startsWith('data:')) {
    const matches = url.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      throw new Error('Invalid data URL');
    }
    const buffer = Buffer.from(matches[2], 'base64');
    const filename = `${prefix}_${Date.now()}${ext}`;
    const filePath = path.join(getAssetsDir(), filename);
    fs.writeFileSync(filePath, buffer);
    return `assets/${filename}`;
  }

  // Handle standard HTTP/HTTPS URLs
  const filename = `${prefix}_${Date.now()}${ext}`;
  const filePath = path.join(getAssetsDir(), filename);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch remote asset: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(filePath, buffer);
  return `assets/${filename}`;
}

// Multer Storage Configuration for user uploads (audio, reference images)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, getAssetsDir());
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const prefix = file.fieldname === 'audio' ? 'audio' : 'ref';
    cb(null, `${prefix}_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

// --- CONFIG API ENDPOINTS ---
app.get('/api/config', (req, res) => {
  const config = readJsonFile(CONFIG_FILE, {
    geminiKey: '',
    openaiKey: '',
    claudeKey: '',
    falKey: '',
    runwayKey: '',
    klingKey: '',
    klingSecret: '',
    higgsfieldKey: '',
    higgsfieldSecret: ''
  });
  res.json(config);
});

app.post('/api/config', (req, res) => {
  const success = writeJsonFile(CONFIG_FILE, req.body);
  if (success) {
    res.json({ message: 'Configuration saved successfully' });
  } else {
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// --- PROJECT STATE API ENDPOINTS ---
app.get('/api/state', (req, res) => {
  const defaultState = {
    shots: [
      {
        id: 'shot_' + Date.now(),
        name: 'Shot 1',
        setup: 'Wide establishing shot of a futuristic cyberpunk city skyline, neon lights reflecting in the rain.',
        description: 'A glowing hover-car slowly flies between towering skyscrapers. Rain streaks the camera lens.',
        dialogue: 'A voiceover says: "Welcome to New Eden, where dreams are manufactured."',
        notes: 'Needs to feel atmospheric and slow.',
        selectedImage: null,
        selectedVideo: null,
        referenceImages: [],
        lipSyncAudio: null
      }
    ],
    imagePrompts: [],
    videoPrompts: [],
    referenceImages: [],
    prePrompt: 'Create a cinematic, photorealistic visual description for a high-budget sci-fi film of the following scene: ',
    postPrompt: ', ultra realistic, highly detailed, octane render, 8k, volumetric lighting',
    activeLlm: 'gemini',
    activeImageGenerator: 'fal-ai',
    imageResolution: '1344x768',
    activeVideoGenerator: 'fal-ai',
    videoResolution: '1280x720',
    videoModel: 'fal-ai/kling-video' // fallback / flexible model selection
  };
  const activePath = getActiveProjectPath();
  if (activePath) {
    try {
      const project = readProjectFile(activePath);
      return res.json(Object.keys(project.state || {}).length > 0 ? project.state : defaultState);
    } catch (error) {
      console.error('Failed to read active project:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  const state = readJsonFile(getStateFilePath(), defaultState);
  res.json(state);
});

// Autosave channel. Writes into the active project file when one is open,
// otherwise the legacy loose project_state.json.
app.post('/api/state', (req, res) => {
  const activePath = getActiveProjectPath();
  try {
    if (activePath) {
      writeProjectFile(activePath, req.body);
    } else if (!writeJsonFile(getStateFilePath(), req.body)) {
      throw new Error('Failed to save project state');
    }
    res.json({ message: 'Project state saved successfully' });
  } catch (error) {
    console.error('Save error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- PROJECT MANAGEMENT ENDPOINTS ---

app.get('/api/project', (req, res) => {
  const config = readJsonFile(CONFIG_FILE);
  const activePath = getActiveProjectPath();
  res.json({
    path: activePath,
    name: activePath ? projectNameFromPath(activePath) : 'Untitled (loose state file)',
    workingFolder: getWorkingRoot(),
    isLegacy: !activePath,
    recent: (config.recentProjects || []).filter(entry => entry && fs.existsSync(entry.path))
  });
});

app.post('/api/project/new', (req, res) => {
  const { directory, name } = req.body;
  if (!directory || !name) {
    return res.status(400).json({ error: 'directory and name are required' });
  }
  try {
    const safeName = String(name).replace(/[<>:"/\\|?*]/g, '_').trim();
    if (!safeName) throw new Error('Project name is empty after removing illegal characters.');

    // Each project gets its own folder named after it.
    const projectDir = path.join(directory, safeName);
    const projectPath = path.join(projectDir, `${safeName}${PROJECT_EXT}`);
    if (fs.existsSync(projectPath)) {
      return res.status(409).json({ error: `A project already exists at ${projectPath}` });
    }

    writeProjectFile(projectPath, {}, safeName);
    setActiveProject(projectPath);
    res.json({ path: projectPath, name: safeName, workingFolder: projectDir });
  } catch (error) {
    console.error('New project error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/project/open', (req, res) => {
  const { path: projectPath } = req.body;
  if (!projectPath) return res.status(400).json({ error: 'path is required' });
  if (!fs.existsSync(projectPath)) {
    return res.status(404).json({ error: `Project file not found: ${projectPath}` });
  }
  try {
    const project = readProjectFile(projectPath);
    setActiveProject(projectPath);

    const actualDir = path.dirname(projectPath);
    const moved = project.workingFolder && path.resolve(project.workingFolder) !== path.resolve(actualDir);
    if (moved) {
      // The folder was moved or copied — re-anchor to where the file actually is.
      writeProjectFile(projectPath, project.state, project.name);
    }

    res.json({
      path: projectPath,
      name: projectNameFromPath(projectPath),
      workingFolder: actualDir,
      relocatedFrom: moved ? project.workingFolder : null,
      state: project.state
    });
  } catch (error) {
    console.error('Open project error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save As branches the whole project: it always creates its own folder (so the
// one-folder-per-project rule holds) and copies the current media across, or
// every thumbnail in the new copy would be dead.
app.post('/api/project/save-as', (req, res) => {
  const { path: rawPath, state } = req.body;
  if (!rawPath) return res.status(400).json({ error: 'path is required' });

  try {
    const chosen = rawPath.replace(/\.mmproj\.json$/i, '').replace(/\.json$/i, '');
    const name = path.basename(chosen);
    if (!name) throw new Error('Could not derive a project name from that path.');

    const projectDir = path.join(path.dirname(chosen), name);
    const projectPath = path.join(projectDir, `${name}${PROJECT_EXT}`);
    if (fs.existsSync(projectPath)) {
      return res.status(409).json({ error: `A project already exists at ${projectPath}` });
    }

    const sourceAssets = getAssetsDir();
    writeProjectFile(projectPath, state || {}, name);

    // Copy media forward so the branch is immediately usable.
    let copied = 0;
    const targetAssets = path.join(projectDir, 'assets');
    if (fs.existsSync(sourceAssets) && path.resolve(sourceAssets) !== path.resolve(targetAssets)) {
      for (const entry of fs.readdirSync(sourceAssets, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        fs.copyFileSync(path.join(sourceAssets, entry.name), path.join(targetAssets, entry.name));
        copied++;
      }
    }

    setActiveProject(projectPath);
    res.json({ path: projectPath, name, workingFolder: projectDir, copiedAssets: copied });
  } catch (error) {
    console.error('Save-as error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Pull the asset library out of another project, copying its reference images
// into this project so the result stays self-contained.
app.post('/api/project/import-assets', (req, res) => {
  const { path: sourcePath } = req.body;
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return res.status(404).json({ error: 'Source project not found' });
  }
  try {
    const source = readProjectFile(sourcePath);
    const sourceDir = path.dirname(sourcePath);
    const targetAssets = getAssetsDir();
    const assets = source.state?.assetLibrary || [];

    const copyInto = (relativePath) => {
      if (!relativePath) return null;
      const from = path.resolve(sourceDir, relativePath);
      if (!fs.existsSync(from)) return null;
      const filename = `ref_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${path.extname(from)}`;
      fs.copyFileSync(from, path.join(targetAssets, filename));
      return `assets/${filename}`;
    };

    const imported = assets.map(asset => {
      const remap = new Map();
      (asset.images || []).forEach(imagePath => {
        const copied = copyInto(imagePath);
        if (copied) remap.set(imagePath, copied);
      });
      const images = (asset.images || []).map(p => remap.get(p)).filter(Boolean);
      return {
        ...asset,
        id: `asset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        images,
        primaryImage: remap.get(asset.primaryImage) || images[0] || null
      };
    });

    res.json({ assets: imported, sourceName: projectNameFromPath(sourcePath) });
  } catch (error) {
    console.error('Import assets error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- FILE UPLOAD ENDPOINT ---
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  res.json({
    filePath: `assets/${req.file.filename}`,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype
  });
});

// --- PROJECT IMAGES ENUMERATION ENDPOINT ---
app.get('/api/project-images', (req, res) => {
  try {
    if (!fs.existsSync(getAssetsDir())) {
      return res.json([]);
    }
    const files = fs.readdirSync(getAssetsDir());
    const images = files
      .filter(file => {
        const ext = path.extname(file).toLowerCase();
        return ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext);
      })
      .map(file => {
        return {
          name: file,
          path: `assets/${file}`
        };
      });
    res.json(images);
  } catch (err) {
    console.error('Error reading assets directory:', err);
    res.status(500).json({ error: 'Failed to read assets directory' });
  }
});

// --- LLM PROXY ENDPOINTS ---
app.post('/api/llm/generate', async (req, res) => {
  const { provider, prompt, systemPrompt, model } = req.body;
  const config = readJsonFile(CONFIG_FILE);

  try {
    let responseText = '';

    if (provider === 'gemini') {
      const apiKey = config.geminiKey;
      if (!apiKey) throw new Error('Gemini API key is not configured.');

      const targetModel = model || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\nUser text: ${prompt}` }] }]
        })
      });

      const data = await response.json();
      if (data.error) throw new Error(data.error.message || 'Gemini API Error');
      responseText = data.candidates[0].content.parts[0].text;

    } else if (provider === 'chatgpt') {
      const apiKey = config.openaiKey;
      if (!apiKey) throw new Error('OpenAI API key is not configured.');

      const url = 'https://api.openai.com/v1/chat/completions';
      const targetModel = model || 'gpt-4o-mini';
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: targetModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt }
          ]
        })
      });

      const data = await response.json();
      if (data.error) throw new Error(data.error.message || 'OpenAI API Error');
      responseText = data.choices[0].message.content;

    } else if (provider === 'claude') {
      const apiKey = config.claudeKey;
      if (!apiKey) throw new Error('Claude API key is not configured.');

      const url = 'https://api.anthropic.com/v1/messages';
      const targetModel = model || 'claude-3-5-sonnet-latest';
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'dangerously-allow-html': 'true'
        },
        body: JSON.stringify({
          model: targetModel,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      const data = await response.json();
      if (data.error) throw new Error(data.error.message || 'Claude API Error');
      responseText = data.content[0].text;
    } else {
      throw new Error(`Unsupported LLM provider: ${provider}`);
    }

    res.json({ text: responseText.trim() });
  } catch (error) {
    console.error('LLM Generation Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET list of models from providers
app.get('/api/llm/models', async (req, res) => {
  const { provider } = req.query;
  const config = readJsonFile(CONFIG_FILE);

  try {
    let models = [];

    if (provider === 'gemini') {
      const apiKey = config.geminiKey;
      if (apiKey) {
        try {
          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
          if (response.ok) {
            const data = await response.json();
            models = data.models
              .filter(m => m.supportedGenerationMethods.includes('generateContent'))
              .map(m => ({ id: m.name.replace('models/', ''), name: m.displayName }));
          }
        } catch (e) {
          console.error('Failed to fetch Gemini models from API:', e);
        }
      }
      if (models.length === 0) {
        models = [
          { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (Recommended)' },
          { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
          { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
          { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' }
        ];
      }

    } else if (provider === 'chatgpt') {
      const apiKey = config.openaiKey;
      if (apiKey) {
        try {
          const response = await fetch('https://api.openai.com/v1/models', {
            headers: { 'Authorization': `Bearer ${apiKey}` }
          });
          if (response.ok) {
            const data = await response.json();
            models = data.data
              .filter(m => m.id.startsWith('gpt') || m.id.startsWith('o1'))
              .map(m => ({ id: m.id, name: m.id }));
          }
        } catch (e) {
          console.error('Failed to fetch OpenAI models from API:', e);
        }
      }
      if (models.length === 0) {
        models = [
          { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Recommended)' },
          { id: 'gpt-4o', name: 'GPT-4o' },
          { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'o1-mini', name: 'o1 Mini' }
        ];
      }

    } else if (provider === 'claude') {
      const apiKey = config.claudeKey;
      if (apiKey) {
        try {
          const response = await fetch('https://api.anthropic.com/v1/models', {
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01'
            }
          });
          if (response.ok) {
            const data = await response.json();
            models = data.data.map(m => ({ id: m.id, name: m.display_name || m.id }));
          }
        } catch (e) {
          console.error('Failed to fetch Claude models from API:', e);
        }
      }
      if (models.length === 0) {
        models = [
          { id: 'claude-3-5-sonnet-latest', name: 'Claude 3.5 Sonnet (Latest)' },
          { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet (2024-10-22)' },
          { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku (Latest)' },
          { id: 'claude-3-opus-latest', name: 'Claude 3 Opus (Latest)' }
        ];
      }
    } else {
      return res.status(400).json({ error: 'Invalid provider' });
    }

    res.json(models);
  } catch (error) {
    console.error('Error fetching models:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- HELPER FOR FAL.AI QUEUE POLLING ---
async function callFalModel(modelId, input, apiKey) {
  const submitUrl = `https://queue.fal.run/${modelId}`;
  console.log(`[FAL] Submitting to queue: ${submitUrl}`);
  
  // Submit task
  const submitResponse = await fetch(submitUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Key ${apiKey}`
    },
    body: JSON.stringify(input)
  });

  if (!submitResponse.ok) {
    const errText = await submitResponse.text();
    console.error(`[FAL] Task submission failed status: ${submitResponse.status}, body: ${errText}`);
    throw new Error(`Fal.ai Task Submission Failed (${submitResponse.status}): ${errText}`);
  }

  const submitData = await submitResponse.json();
  console.log('[FAL] Queue submission response payload:', submitData);
  const request_id = submitData.request_id || submitData.gateway_request_id;
  
  const statusUrl = submitData.status_url || `https://queue.fal.run/${encodeURIComponent(modelId)}/requests/${request_id}/status`;
  const checkUrl = submitData.response_url || `https://queue.fal.run/${encodeURIComponent(modelId)}/requests/${request_id}`;

  console.log(`[FAL] Polling statusUrl: ${statusUrl}, checkUrl: ${checkUrl}`);

  // Poll for completion
  let attempts = 0;
  const maxAttempts = 60; // 5 minutes max
  while (attempts < maxAttempts) {
    const statusResponse = await fetch(statusUrl, {
      headers: { 'Authorization': `Key ${apiKey}` }
    });
    
    if (!statusResponse.ok) {
      throw new Error(`Failed to check Fal.ai task status: ${statusResponse.statusText}`);
    }

    const statusData = await statusResponse.json();
    if (statusData.status === 'COMPLETED') {
      const resultResponse = await fetch(checkUrl, {
        headers: { 'Authorization': `Key ${apiKey}` }
      });
      if (!resultResponse.ok) {
        const errBody = await resultResponse.text();
        console.error(`[FAL] Result retrieval failed status: ${resultResponse.status}, body: ${errBody}`);
        throw new Error(`Fal.ai failed to retrieve completed task details (${resultResponse.status}): ${errBody}`);
      }
      return await resultResponse.json();
    } else if (statusData.status === 'FAILED') {
      throw new Error(`Fal.ai task failed: ${statusData.error || 'Unknown error'}`);
    }

    // Wait 5 seconds
    await new Promise(resolve => setTimeout(resolve, 5000));
    attempts++;
  }

  throw new Error('Fal.ai task timed out.');
}

// --- HELPER FOR HIGGSFIELD QUEUE POLLING ---
// Higgsfield's platform API mirrors Fal's submit-then-poll shape:
//   POST https://platform.higgsfield.ai/{model_id}   -> { request_id, status_url }
//   GET  https://platform.higgsfield.ai/requests/{id}/status
// Auth is a combined "Key {key}:{secret}" bearer.
const HIGGSFIELD_BASE = 'https://platform.higgsfield.ai';

// Model ids routed through Higgsfield. The frontend also sends an explicit
// providerFamily, but keep the prefix check so older saved projects still work.
const HIGGSFIELD_PREFIXES = [
  'higgsfield-ai/', 'reve/', 'google/', 'openai/', 'bytedance/',
  'kling-video/', 'kling/', 'minimax/', 'alibaba/', 'black-forest-labs/'
];

function isHiggsfieldModel(modelId) {
  return typeof modelId === 'string' && HIGGSFIELD_PREFIXES.some(prefix => modelId.startsWith(prefix));
}

function higgsfieldAuthHeader(config) {
  const key = config.higgsfieldKey;
  if (!key) throw new Error('Higgsfield API key is not configured. Add it in Settings first.');
  const secret = config.higgsfieldSecret;
  return `Key ${secret ? `${key}:${secret}` : key}`;
}

async function callHiggsfieldModel(modelId, input, config) {
  const auth = higgsfieldAuthHeader(config);
  const submitUrl = `${HIGGSFIELD_BASE}/${modelId}`;
  console.log(`[HIGGSFIELD] Submitting: ${submitUrl}`);

  const submitResponse = await fetch(submitUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify(input)
  });

  if (!submitResponse.ok) {
    const errText = await submitResponse.text();
    throw new Error(`Higgsfield submission failed (${submitResponse.status}): ${errText}`);
  }

  const submitData = await submitResponse.json();
  const requestId = submitData.request_id || submitData.id;
  const statusUrl = submitData.status_url || `${HIGGSFIELD_BASE}/requests/${requestId}/status`;

  // Some models return inline on the first response.
  if (submitData.status === 'completed') return submitData;

  let attempts = 0;
  const maxAttempts = 120; // 10 minutes at 5s intervals
  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const statusResponse = await fetch(statusUrl, { headers: { Authorization: auth } });
    if (!statusResponse.ok) {
      throw new Error(`Higgsfield status check failed (${statusResponse.status}): ${await statusResponse.text()}`);
    }
    const statusData = await statusResponse.json();

    if (statusData.status === 'completed') return statusData;
    if (statusData.status === 'failed') {
      throw new Error(`Higgsfield generation failed: ${statusData.error || statusData.message || 'unknown error'}`);
    }
    if (statusData.status === 'nsfw') {
      throw new Error('Higgsfield rejected the generation as NSFW.');
    }
    if (statusData.status === 'cancelled') {
      throw new Error('Higgsfield generation was cancelled.');
    }
    attempts++;
  }

  throw new Error('Higgsfield generation timed out.');
}

// Read a project asset into a data URL so it can be shipped inline to providers
// that accept base64 image inputs.
function assetToDataUrl(inputPath) {
  const normalizedPath = String(inputPath).replace(/\\/g, '/');
  const assetPath = path.resolve(getWorkingRoot(), normalizedPath);
  if (!fs.existsSync(assetPath)) {
    throw new Error(`Input image was not found: ${normalizedPath}`);
  }
  const ext = path.extname(assetPath).toLowerCase();
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif'
    : 'image/png';
  return `data:${mimeType};base64,${fs.readFileSync(assetPath).toString('base64')}`;
}

// --- IMAGE GENERATION PROXY ---
app.post('/api/image/generate', async (req, res) => {
  const { provider, prompt, resolution, inputImagePaths = [] } = req.body;
  const config = readJsonFile(CONFIG_FILE);

  try {
    let localPath = '';

    if (provider === 'higgsfield' || isHiggsfieldModel(provider)) {
      const modelId = provider === 'higgsfield' ? 'higgsfield-ai/soul/standard' : provider;

      const input = { prompt };
      if (resolution && resolution.includes(':')) {
        input.aspect_ratio = resolution;
      } else if (resolution) {
        input.resolution = resolution;
      }

      if (inputImagePaths && inputImagePaths.length > 0) {
        const dataUrls = inputImagePaths.map(assetToDataUrl);
        // Higgsfield accepts a single `image_url` on edit endpoints and a list
        // of `reference_images` on identity-preserving ones. Send both shapes so
        // whichever the chosen model reads is populated.
        input.image_url = dataUrls[0];
        input.reference_images = dataUrls;
      }

      const result = await callHiggsfieldModel(modelId, input, config);
      const remoteUrl = result.images?.[0]?.url || result.image?.url;
      if (!remoteUrl) throw new Error('No image returned from Higgsfield.');
      localPath = await downloadFile(remoteUrl, 'img', '.png');

    } else if (provider === 'fal-ai' || provider.startsWith('fal-ai')) {
      const apiKey = config.falKey;
      if (!apiKey) throw new Error('Fal.ai API key is not configured.');

      const modelId = provider === 'fal-ai' ? 'fal-ai/flux/schnell' : provider;
      
      let imageSize = 'landscape_16_9';
      if (resolution === '16:9') imageSize = 'landscape_16_9';
      else if (resolution === '9:16') imageSize = 'portrait_16_9';
      else if (resolution === '1:1') imageSize = 'square_hd';
      else if (resolution === '4:3') imageSize = 'landscape_4_3';
      else if (resolution === '3:2') imageSize = { width: 1200, height: 800 };
      else if (resolution === '21:9') imageSize = { width: 1536, height: 640 };
      else if (resolution && resolution.includes('x')) {
        imageSize = resolution;
      }

      const input = {
        prompt: prompt,
        image_size: imageSize,
        num_inference_steps: 4
      };

      const isRedux = modelId.includes('redux');

      if (inputImagePaths && inputImagePaths.length > 0) {
        const normalizedPath = String(inputImagePaths[0]).replace(/\\/g, '/');
        const assetPath = path.resolve(getWorkingRoot(), normalizedPath);
        if (fs.existsSync(assetPath)) {
          const fileBuffer = fs.readFileSync(assetPath);
          const mimeType = path.extname(assetPath) === '.png' ? 'image/png' : 'image/jpeg';
          const base64Data = fileBuffer.toString('base64');
          input.image_url = `data:${mimeType};base64,${base64Data}`;
        }
      } else if (isRedux) {
        throw new Error('Flux Redux requires at least one input reference image. Please add a reference image to this shot first.');
      }

      const result = await callFalModel(modelId, input, apiKey);
      if (!result.images || result.images.length === 0) {
        throw new Error('No images returned from Fal.ai');
      }
      const remoteUrl = result.images[0].url;
      localPath = await downloadFile(remoteUrl, 'img', '.png');

    } else if (provider === 'google-gemini-image') {
      const apiKey = config.geminiKey;
      if (!apiKey) throw new Error('Google AI Studio key is not configured. Add it in Settings first.');

      // Gemini 2.5 Flash Image supports up to three image inputs.  Read the
      // locally managed reference assets and send each as an inline image part.
      if (!Array.isArray(inputImagePaths)) throw new Error('Input images must be an array.');
      if (inputImagePaths.length > 3) {
        throw new Error('Google Gemini Image supports up to 3 input images per generation.');
      }

      const imageParts = inputImagePaths.map((inputPath) => {
        const normalizedPath = String(inputPath).replace(/\\/g, '/');
        if (!normalizedPath.startsWith('assets/')) {
          throw new Error('Input images must be assets uploaded to MovieMaker.');
        }
        const assetPath = path.resolve(getWorkingRoot(), normalizedPath);
        if (!assetPath.startsWith(`${getAssetsDir()}${path.sep}`) || !fs.existsSync(assetPath)) {
          throw new Error(`Input image was not found: ${normalizedPath}`);
        }
        const ext = path.extname(assetPath).toLowerCase();
        const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
          : ext === '.webp' ? 'image/webp'
          : ext === '.gif' ? 'image/gif'
          : 'image/png';
        return { inlineData: { mimeType, data: fs.readFileSync(assetPath).toString('base64') } };
      });

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }, ...imageParts] }],
            generationConfig: {
              responseModalities: ['IMAGE']
            }
          })
        }
      );
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error?.message || 'Google Gemini Image API error');

      const imagePart = data.candidates?.flatMap(candidate => candidate.content?.parts || [])
        .find(part => part.inlineData?.data);
      if (!imagePart) throw new Error('Google Gemini Image returned no image output.');

      const mimeType = imagePart.inlineData.mimeType || 'image/png';
      const ext = mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png';
      const filename = `img_${Date.now()}${ext}`;
      fs.writeFileSync(path.join(getAssetsDir(), filename), Buffer.from(imagePart.inlineData.data, 'base64'));
      localPath = `assets/${filename}`;

    } else if (provider === 'chatgpt') {
      // OpenAI DALL-E 3
      const apiKey = config.openaiKey;
      if (!apiKey) throw new Error('OpenAI API key is not configured.');

      const url = 'https://api.openai.com/v1/images/generations';
      
      // Map resolutions/ratios to DALL-E formats: 1024x1024, 1792x1024, or 1024x1792
      let size = '1024x1024';
      if (resolution && (resolution.includes('16:9') || resolution.includes('1344') || resolution.includes('1792') || resolution === '21:9' || resolution === '3:2')) {
        size = '1792x1024';
      } else if (resolution && (resolution.includes('9:16') || resolution.includes('768'))) {
        size = '1024x1792';
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'dall-e-3',
          prompt: prompt,
          n: 1,
          size: size,
          quality: 'standard'
        })
      });

      const data = await response.json();
      if (data.error) throw new Error(data.error.message || 'DALL-E 3 API Error');
      const remoteUrl = data.data[0].url;
      localPath = await downloadFile(remoteUrl, 'img', '.png');
    } else {
      throw new Error(`Unsupported image provider: ${provider}`);
    }

    res.json({ filePath: localPath });
  } catch (error) {
    console.error('Image Generation Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- VIDEO GENERATION PROXY ---
app.post('/api/video/generate', async (req, res) => {
  const { provider, prompt, imageUrls, resolution, duration, videoModel } = req.body;
  const config = readJsonFile(CONFIG_FILE);

  try {
    let localPath = '';
    const hasImage = imageUrls && imageUrls.length > 0;
    
    const routesToHiggsfield = provider === 'higgsfield' || isHiggsfieldModel(provider);

    // Convert relative asset paths to something the remote API can read.
    // Higgsfield takes inline data URLs; the others need a publicly reachable
    // URL, so the asset gets pushed to Fal's storage first.
    let publicImageUrls = [];
    if (hasImage) {
      for (const imgPath of imageUrls) {
        const absolutePath = path.join(getWorkingRoot(), imgPath);
        if (!fs.existsSync(absolutePath)) continue;

        if (routesToHiggsfield) {
          publicImageUrls.push(assetToDataUrl(imgPath));
        } else if (config.falKey) {
          publicImageUrls.push(await uploadToFalMedia(absolutePath, config.falKey));
        } else {
          throw new Error('Image-to-Video requires a Fal.ai key to upload the image asset to cloud-accessible storage.');
        }
      }
    }

    if (routesToHiggsfield) {
      const modelId = provider === 'higgsfield' ? 'higgsfield-ai/dop/preview' : provider;

      const input = {
        prompt: prompt,
        aspect_ratio: resolution === '720x1280' ? '9:16' : '16:9',
        duration: Number(duration) || 5
      };
      if (publicImageUrls.length > 0) {
        input.image_url = publicImageUrls[0];
        input.input_images = publicImageUrls;
      }

      const result = await callHiggsfieldModel(modelId, input, config);
      const remoteUrl = result.video?.url || result.videos?.[0]?.url;
      if (!remoteUrl) throw new Error('No video returned from Higgsfield.');
      localPath = await downloadFile(remoteUrl, 'vid', '.mp4');

    } else if (provider === 'fal-ai' || provider.startsWith('fal-ai')) {
      const apiKey = config.falKey;
      if (!apiKey) throw new Error('Fal.ai API key is not configured.');

      let baseModel = provider === 'fal-ai' ? (videoModel || 'fal-ai/kling-video') : provider;
      
      // Determine the specific endpoint depending on if we have input images
      let modelId = baseModel;
      if (hasImage) {
        if (modelId === 'fal-ai/kling-video') {
          modelId = 'fal-ai/kling-video/v2.1/standard/image-to-video';
        } else if (modelId === 'fal-ai/luma-dream-machine') {
          modelId = 'fal-ai/luma-dream-machine/image-to-video';
        }
      } else {
        if (modelId === 'fal-ai/kling-video') {
          modelId = 'fal-ai/kling-video/v3/standard/text-to-video';
        } else if (modelId === 'fal-ai/luma-dream-machine') {
          modelId = 'fal-ai/luma-dream-machine/text-to-video';
        }
      }

      let durationValue = duration || '5';
      if (modelId.startsWith('fal-ai/veo')) {
        // Veo expects string values like '5s' or '8s' (max 8s)
        durationValue = durationValue === '10' ? '8s' : '5s';
      }

      let input = {
        prompt: prompt,
        duration: durationValue,
        aspect_ratio: resolution === '720x1280' ? '9:16' : '16:9'
      };

      if (hasImage) {
        input.image_url = publicImageUrls[0];
      }

      const result = await callFalModel(modelId, input, apiKey);
      const remoteUrl = result.video ? result.video.url : (result.videos && result.videos[0].url);
      if (!remoteUrl) throw new Error('No video URL returned from Fal.ai Kling/Veo');
      localPath = await downloadFile(remoteUrl, 'vid', '.mp4');

    } else if (provider === 'runway') {
      const apiKey = config.runwayKey;
      if (!apiKey) throw new Error('Runway API key is not configured.');

      // Standard Runway REST API call
      // Submit runway task
      const url = 'https://api.dev.runwayml.com/v1/image_to_video'; // or text_to_video
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'X-Runway-Version': '2024-11-06'
      };
      
      const payload = {
        model: 'gen3a_turbo',
        promptText: prompt,
        ratio: resolution === '720x1280' ? '720:1280' : '1280:720'
      };
      if (hasImage) {
        payload.imageUrl = publicImageUrls[0];
      }

      const submitRes = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
      if (!submitRes.ok) {
        throw new Error(`Runway task submission failed: ${await submitRes.text()}`);
      }
      
      const { id } = await submitRes.json();
      
      // Poll Runway task
      let completedUrl = null;
      let attempts = 0;
      while (attempts < 60) {
        const pollRes = await fetch(`https://api.dev.runwayml.com/v1/tasks/${id}`, { headers });
        const task = await pollRes.json();
        if (task.status === 'SUCCEEDED') {
          completedUrl = task.output[0];
          break;
        } else if (task.status === 'FAILED') {
          throw new Error(`Runway task failed: ${task.failureReason || 'unknown error'}`);
        }
        await new Promise(r => setTimeout(r, 5000));
        attempts++;
      }
      if (!completedUrl) throw new Error('Runway task timed out.');
      localPath = await downloadFile(completedUrl, 'vid', '.mp4');

    } else if (provider === 'kling') {
      const apiKey = config.klingKey;
      if (!apiKey) throw new Error('Kling API key is not configured.');

      // Standard Kling API call
      const baseUrl = 'https://api-singapore.klingai.com';
      const endpoint = hasImage ? '/v1/videos/image2video' : '/v1/videos/text2video';
      
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      };

      const payload = {
        model: 'kling-v1-5',
        prompt: prompt,
        cfg_scale: 0.5,
        duration: duration || '5',
        aspect_ratio: resolution === '720x1280' ? '9:16' : '16:9'
      };
      if (hasImage) {
        payload.image = publicImageUrls[0];
      }

      const submitRes = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      const submitData = await submitRes.json();
      if (submitData.code !== 0) {
        throw new Error(`Kling Task failed to submit: ${submitData.message}`);
      }

      const taskId = submitData.data.task_id;
      let completedUrl = null;
      let attempts = 0;
      while (attempts < 60) {
        const pollRes = await fetch(`${baseUrl}/v1/videos/status?task_id=${taskId}`, { headers });
        const pollData = await pollRes.json();
        if (pollData.code === 0 && pollData.data.task_status === 'SUCCESS') {
          completedUrl = pollData.data.task_result.videos[0].url;
          break;
        } else if (pollData.code !== 0 || pollData.data.task_status === 'FAILED') {
          throw new Error(`Kling Task failed: ${pollData.message || 'generation failed'}`);
        }
        await new Promise(r => setTimeout(r, 5000));
        attempts++;
      }
      if (!completedUrl) throw new Error('Kling task timed out.');
      localPath = await downloadFile(completedUrl, 'vid', '.mp4');

    } else {
      throw new Error(`Unsupported video provider: ${provider}`);
    }

    res.json({ filePath: localPath });
  } catch (error) {
    console.error('Video Generation Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper: Upload file to Fal.media so external models can access it
async function uploadToFalMedia(filePath, falKey) {
  const fileBuffer = fs.readFileSync(filePath);
  const mimeType = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  // Ask Fal.ai for an upload URL
  const initRes = await fetch('https://rest.fal.ai/storage/upload/initiate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Key ${falKey}`
    },
    body: JSON.stringify({
      file_name: path.basename(filePath),
      content_type: mimeType
    })
  });

  if (!initRes.ok) {
    throw new Error(`Failed to initiate Fal media upload: ${await initRes.text()}`);
  }

  const { upload_url, file_url } = await initRes.json();

  // Upload actual file binary
  const uploadRes = await fetch(upload_url, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType
    },
    body: fileBuffer
  });

  if (!uploadRes.ok) {
    throw new Error(`Failed to upload file content to Fal media storage: ${await uploadRes.text()}`);
  }

  return file_url;
}

// --- LIP SYNC PROXY (FAL.AI WAV2LIP/SYNC-LIPSYNC) ---
app.post('/api/lipsync', async (req, res) => {
  const { videoPath, audioPath } = req.body;
  const config = readJsonFile(CONFIG_FILE);
  const apiKey = config.falKey;

  if (!apiKey) {
    return res.status(400).json({ error: 'Fal.ai API key is required for Lip-Sync.' });
  }
  if (!videoPath || !audioPath) {
    return res.status(400).json({ error: 'Both videoPath and audioPath are required.' });
  }

  try {
    const absVideoPath = path.join(getWorkingRoot(), videoPath);
    const absAudioPath = path.join(getWorkingRoot(), audioPath);

    if (!fs.existsSync(absVideoPath) || !fs.existsSync(absAudioPath)) {
      throw new Error('Local video or audio file does not exist.');
    }

    // Upload both files to Fal media
    console.log('Uploading video and audio to Fal media...');
    const publicVideoUrl = await uploadToFalMedia(absVideoPath, apiKey);
    const publicAudioUrl = await uploadToFalMedia(absAudioPath, apiKey);

    // Run Fal Wav2Lip or Sync Lipsync model
    // Sync Lipsync is newer and has better quality. Let's use fal-ai/sync-lipsync
    console.log('Submitting Lip Sync job to Fal...');
    const result = await callFalModel('fal-ai/sync-lipsync', {
      video_url: publicVideoUrl,
      audio_url: publicAudioUrl,
      lipsync_mode: 'cut_off' // cuts video or repeats depending on model
    }, apiKey);

    const remoteUrl = result.video ? result.video.url : result.url;
    if (!remoteUrl) throw new Error('No synced video returned from Lip-Sync API');

    console.log('Downloading synced video...');
    const localPath = await downloadFile(remoteUrl, 'sync', '.mp4');
    res.json({ filePath: localPath });
  } catch (error) {
    console.error('Lip Sync API Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- FFMEG VIDEO CONCATENATION ENDPOINT ---
app.post('/api/concatenate', async (req, res) => {
  const { videoPaths } = req.body; // Array of relative paths e.g. ["assets/vid1.mp4", "assets/vid2.mp4"]
  
  if (!videoPaths || !Array.isArray(videoPaths) || videoPaths.length === 0) {
    return res.status(400).json({ error: 'No video files provided for concatenation.' });
  }

  try {
    // Generate absolute paths and verify files exist
    const validPaths = videoPaths.map(p => path.join(getWorkingRoot(), p)).filter(p => fs.existsSync(p));
    
    if (validPaths.length === 0) {
      throw new Error('None of the selected video files exist on the server.');
    }

    // Create file list for ffmpeg concat demuxer
    const listFilePath = path.join(getWorkingRoot(), 'concat_list.txt');
    const listContent = validPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(listFilePath, listContent, 'utf8');

    const outputFilename = `master_${Date.now()}.mp4`;
    const outputFilePath = path.join(getAssetsDir(), outputFilename);

    // Run FFmpeg command
    // Using -safe 0 because we pass absolute paths, and -c copy to quickly stitch them without re-encoding
    const ffmpegCmd = `ffmpeg -y -f concat -safe 0 -i "${listFilePath}" -c copy "${outputFilePath}"`;
    
    console.log('Running FFmpeg Command:', ffmpegCmd);
    exec(ffmpegCmd, (error, stdout, stderr) => {
      // Clean up temporary list file
      try { fs.unlinkSync(listFilePath); } catch (e) {}

      if (error) {
        console.error('FFmpeg Concatenation Error:', error);
        console.error('stderr:', stderr);
        return res.status(500).json({ error: 'FFmpeg processing failed. Make sure all select videos have the same resolution/codec, and FFmpeg is installed.', details: stderr });
      }

      console.log('FFmpeg finished successfully');
      res.json({ filePath: `assets/${outputFilename}` });
    });

  } catch (error) {
    console.error('Concatenation endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- NATIVE WINDOWS FILE / FOLDER PICKER ---
// Runs a WinForms dialog through PowerShell. Needs -STA (the dialogs require a
// single-threaded apartment) and a TopMost owner form, otherwise the dialog can
// open behind the browser and look like a hang. The script goes to a temp file
// so we avoid nested-quote escaping through cmd.
app.post('/api/project/browse', (req, res) => {
  const { mode = 'open', defaultName = '' } = req.body;

  if (process.platform !== 'win32') {
    return res.status(501).json({ error: 'The native picker is Windows-only. Paste a path instead.' });
  }

  const scripts = {
    open: `
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Open MovieMaker Project'
$dialog.Filter = 'MovieMaker Project (*.mmproj.json)|*.mmproj.json|JSON (*.json)|*.json'
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.FileName }`,
    saveAs: `
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = 'Save MovieMaker Project As'
$dialog.Filter = 'MovieMaker Project (*.mmproj.json)|*.mmproj.json'
$dialog.FileName = '${String(defaultName).replace(/'/g, "''")}'
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.FileName }`,
    folder: `
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose the folder to create the project in'
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }`
  };

  const body = scripts[mode];
  if (!body) return res.status(400).json({ error: `Unknown browse mode: ${mode}` });

  const script = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
${body}
$owner.Dispose()
`;

  const scriptPath = path.join(os.tmpdir(), `mm_browse_${Date.now()}.ps1`);
  try {
    fs.writeFileSync(scriptPath, script, 'utf8');
  } catch (error) {
    return res.status(500).json({ error: `Could not stage picker script: ${error.message}` });
  }

  exec(
    `powershell -NoProfile -ExecutionPolicy Bypass -STA -File "${scriptPath}"`,
    { timeout: 5 * 60 * 1000 },
    (error, stdout, stderr) => {
      try { fs.unlinkSync(scriptPath); } catch { /* best effort */ }

      if (error && error.killed) {
        return res.status(504).json({ error: 'The file dialog timed out.' });
      }
      if (error) {
        console.error('Picker error:', stderr || error);
        return res.status(500).json({ error: 'Could not open the file dialog. Paste a path instead.' });
      }

      const selected = String(stdout).trim();
      // Empty output means the user pressed Cancel — not an error.
      res.json({ path: selected || null, cancelled: !selected });
    }
  );
});

// --- EXPOSE FILE IN WINDOWS EXPLORER ---
app.post('/api/reveal', (req, res) => {
  const { filePath } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath is required' });
  }

  try {
    const currentWorkingRoot = getWorkingRoot();
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(path.join(currentWorkingRoot, filePath));

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'File does not exist on disk' });
    }

    // Use child_process.exec to reliably launch explorer.exe in active user session
    const { exec } = require('child_process');
    const windowsPath = absolutePath.replace(/\//g, '\\');
    console.log(`Running reveal: explorer.exe /select,"${windowsPath}"`);
    
    exec(`explorer.exe /select,"${windowsPath}"`, (err) => {
      // Ignore exit code errors from explorer.exe since it returns non-zero even on success
      if (err) {
        console.log('Explorer reveal completed.');
      }
    });

    res.json({ message: 'Exposed file in Explorer' });
  } catch (error) {
    console.error('Error revealing file:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`MovieMaker backend running at http://localhost:${PORT}`);
});
