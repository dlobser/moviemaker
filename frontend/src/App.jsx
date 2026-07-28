import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  Film,
  Image as ImageIcon,
  Trash2,
  Settings,
  Plus,
  ChevronUp,
  ChevronDown,
  Download,
  Upload,
  Play,
  Check,
  FolderOpen,
  Edit2,
  Music,
  RefreshCw,
  MessageSquare,
  Save,
  X,
  FileJson,
  Eye,
  Maximize2,
  Minimize2,
  Sun,
  Moon,
  Clock,
  AlertTriangle,
  GripVertical,
  HelpCircle,
  Users,
  Layers,
  Copy,
  Zap,
  StopCircle
} from 'lucide-react';
import {
  IMAGE_MODELS,
  VIDEO_MODELS,
  IMAGE_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  LLM_PROVIDERS,
  PROVIDER_LABELS,
  getImageModel,
  getVideoModel,
  isKnownImageModel,
  isKnownVideoModel,
  priceLabel,
  groupedModelOptions,
  refImageCapacity
} from './catalog.js';
import {
  ASSET_TYPES,
  composeGenerationPrompt,
  defaultAssetPrompt,
  extractTags,
  findAssetByTag,
  normalizeTag
} from './promptTags.js';
import { buildLlmImportPrompt, normalizeImportedShotList } from './shotListImport.js';

const API_BASE = 'http://localhost:3001';

const DEFAULT_IMAGE_SYSTEM_PROMPT = "You are a professional cinematographic prompt engineer. Based on the user's details, write a single highly visual description optimized for AI generation (like Flux/Midjourney or Kling). Output ONLY the final visual prompt itself. Do not include titles, introductions, quotes, or conversational preamble.";
const DEFAULT_VIDEO_SYSTEM_PROMPT = "You are a professional cinematographic prompt engineer. Based on the user's details, write a single highly visual video description optimized for AI generation (like Kling, Runway, or Veo). Output ONLY the final visual prompt itself. Do not include titles, introductions, quotes, or conversational preamble.";

/** Render a model <select>'s options grouped by provider, with pricing inline. */
function ModelOptions({ models, unit }) {
  return groupedModelOptions(models).map(group => (
    <optgroup key={group.provider} label={PROVIDER_LABELS[group.provider] || group.provider}>
      {group.models.map(model => {
        const price = priceLabel(model, unit);
        return (
          <option key={model.id} value={model.id}>
            {model.label}{price ? ` — ${price}` : ''}
          </option>
        );
      })}
    </optgroup>
  ));
}

export default function App() {
  // --- CORE STATE ---
  const [scenes, setScenes] = useState([]);
  const [activeSceneId, setActiveSceneId] = useState(null);
  const shots = scenes.flatMap(s => s.shots || []);

  const [viewingPromptText, setViewingPromptText] = useState(null);
  const [promptSnippets, setPromptSnippets] = useState([
    { id: 's1', name: 'Establish', text: 'wide establishing shot, scale detail' },
    { id: 's2', name: 'Close Up', text: 'cinematic macro close up shot, shallow depth of field' },
    { id: 's3', name: 'Cyberpunk', text: 'neon cyberpunk aesthetic, volumetric haze, atmospheric reflections' },
    { id: 's4', name: 'Tracking', text: 'slow smooth tracking shot, camera moving forward' },
    { id: 's5', name: '8K Film', text: 'photorealistic 8k octane render, cinematic lighting, 35mm film grain' }
  ]);
  const [imageGallery, setImageGallery] = useState([]);
  const [videoGallery, setVideoGallery] = useState([]);
  const [referenceImages, setReferenceImages] = useState([]);
  const [apiKeys, setApiKeys] = useState({
    geminiKey: '',
    openaiKey: '',
    claudeKey: '',
    falKey: '',
    runwayKey: '',
    klingKey: '',
    klingSecret: '',
    higgsfieldKey: '',
    higgsfieldSecret: '',
    workingFolder: ''
  });

  // --- ASSET LIBRARY (characters / environments / props, referenced as <Tag>) ---
  const [assetLibrary, setAssetLibrary] = useState([]);
  const [assetEditor, setAssetEditor] = useState(null); // null | { id?, tag, type, name, description, images[], primaryImage }
  const [assetBatchDialog, setAssetBatchDialog] = useState(null); // { onlyMissing, useLlm, rewriteExisting }
  const assetUploadRef = useRef(null);

  // --- SETTINGS ---
  const [activeLlm, setActiveLlm] = useState('gemini');
  const [llmModel, setLlmModel] = useState('gemini-2.5-flash');
  const [llmModelsList, setLlmModelsList] = useState([]);
  
  const [activeImageGenerator, setActiveImageGenerator] = useState('fal-ai');
  const [imageModel, setImageModel] = useState('fal-ai/flux/schnell');
  const [imageResolution, setImageResolution] = useState('16:9');
  const [imageSystemPrompt, setImageSystemPrompt] = useState(DEFAULT_IMAGE_SYSTEM_PROMPT);

  const [activeVideoGenerator, setActiveVideoGenerator] = useState('fal-ai');
  const [videoResolution, setVideoResolution] = useState('1280x720');
  const [videoModel, setVideoModel] = useState('fal-ai/kling-video');
  const [videoDuration, setVideoDuration] = useState('5');
  const [videoSystemPrompt, setVideoSystemPrompt] = useState(DEFAULT_VIDEO_SYSTEM_PROMPT);

  // --- GLOBAL PRE/POST PROMPTS (wrapped around every generated prompt) ---
  const [prePrompt, setPrePrompt] = useState('');
  const [postPrompt, setPostPrompt] = useState('');
  const [videoPrePrompt, setVideoPrePrompt] = useState('');
  const [videoPostPrompt, setVideoPostPrompt] = useState('');

  // --- THEME STATE ---
  const [theme, setTheme] = useState('dark'); // 'dark' | 'light'

  // --- BATCH MANAGER STATE ---
  // { id, shotId, shotName, type, prompt, status: 'queued'|'running'|'completed'|'failed'|'cancelled', createdAt, error }
  const [batchJobs, setBatchJobs] = useState([]);
  const [batchRunner, setBatchRunner] = useState(null); // { total, done, type, label } while a batch sweep is live
  const cancelBatchRef = useRef(false);
  const [batchDialog, setBatchDialog] = useState(null); // { type: 'image'|'video', scope: 'scene'|'all' }
  const [batchOnlyMissing, setBatchOnlyMissing] = useState(true);
  const [batchConcurrency, setBatchConcurrency] = useState(3);

  // --- PROJECTS (one folder per project) ---
  const [project, setProject] = useState({ path: null, name: 'Loading…', workingFolder: '', isLegacy: true, recent: [] });
  const [newProjectDraft, setNewProjectDraft] = useState(null); // { directory, name }

  // --- SHOT LIST IMPORT ---
  const [importReport, setImportReport] = useState(null); // { added, warnings[] }
  const [llmPromptSource, setLlmPromptSource] = useState('');
  const shotListInputRef = useRef(null);

  // --- UI STATES ---
  const [activeShotId, setActiveShotId] = useState(null);
  const [collapsedShots, setCollapsedShots] = useState({}); // { [shotId]: boolean } (true = collapsed)
  const [activeOverlay, setActiveOverlay] = useState(null); // 'images', 'videos', 'reference', 'snippets', 'settings', 'batch'
  const [loadingStates, setLoadingStates] = useState({});
  const [toast, setToast] = useState(null);
  const [projectImagesSelector, setProjectImagesSelector] = useState(null); // null | { target: 'ref' }
  const [projectImagesList, setProjectImagesList] = useState([]);

  // --- MODALS FOR GENERATION PER SHOT ---
  const [generationModal, setGenerationModal] = useState(null); 
  // { type: 'image'|'video', shotId: string, existingPromptId: string|null }

  const [genModalPrompt, setGenModalPrompt] = useState('');
  const [genModalImageInput, setGenModalImageInput] = useState('');
  const [genModalInputImages, setGenModalInputImages] = useState([]);
  const [genModalDuration, setGenModalDuration] = useState('5');
  const [genModalModel, setGenModalModel] = useState('');
  const [genModalRes, setGenModalRes] = useState('');

  // --- DOUBLE CLICK PREVIEW WITH ZOOM & PAN ---
  const [zoomImage, setZoomImage] = useState(null); // { path: string, name: string }
  const [zoomScale, setZoomScale] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // --- CONCATENATED VIDEO PREVIEW ---
  const [concatenatedVideo, setConcatenatedVideo] = useState(null);

  // --- DRAG TO REORDER TIMELINE SHOTS ---
  const [isDraggable, setIsDraggable] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState(null);

  // --- PROMPT GROUP SELECTIONS PER SHOT ---
  const [activeShotImagePromptGroup, setActiveShotImagePromptGroup] = useState({});
  const [activeShotVideoPromptGroup, setActiveShotVideoPromptGroup] = useState({});

  // --- INTERACTIVE IMAGE CROPPER ---
  const [isCropping, setIsCropping] = useState(false);
  const [cropAspectWidth, setCropAspectWidth] = useState(16);
  const [cropAspectHeight, setCropAspectHeight] = useState(9);
  const [cropX, setCropX] = useState(10);
  const [cropY, setCropY] = useState(10);
  const [cropWidthPercent, setCropWidthPercent] = useState(50);
  const [imgNaturalSize, setImgNaturalSize] = useState({ width: 1, height: 1 });
  const [isDraggingCrop, setIsDraggingCrop] = useState(false);
  const [cropDragStart, setCropDragStart] = useState({ x: 0, y: 0, initialX: 0, initialY: 0 });
  const cropImgRef = useRef(null);

  // refs
  const audioInputRefs = useRef({});

  // Helper: Toast Alert
  const showToast = (message, type = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4500);
  };

  // On Load
  useEffect(() => {
    fetchConfig();
    fetchProject();
    fetchProjectState();
    
    // Load theme setting
    const savedTheme = localStorage.getItem('moviemaker-theme') || 'dark';
    setTheme(savedTheme);
    if (savedTheme === 'light') {
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.remove('light-theme');
    }
  }, []);

  const fetchLlmModels = async (provider) => {
    try {
      const res = await fetch(`${API_BASE}/api/llm/models?provider=${provider}`);
      if (res.ok) {
        const list = await res.json();
        setLlmModelsList(list);
        if (list.length > 0) {
          // If saved selection isn't in the newly fetched list, select first available
          const found = list.some(m => m.id === llmModel);
          if (!found) {
            setLlmModel(list[0].id);
          }
        }
      }
    } catch (e) {
      console.error('Error fetching models:', e);
    }
  };

  useEffect(() => {
    if (activeLlm) {
      fetchLlmModels(activeLlm);
    }
  }, [activeLlm, apiKeys]);

  const fetchConfig = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/config`);
      if (res.ok) {
        const config = await res.json();
        setApiKeys(config);
      }
    } catch (err) {
      console.error(err);
      showToast('Backend server not connected.', 'error');
    }
  };

  const fetchProjectState = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/state`);
      if (res.ok) applyLoadedState(await res.json());
    } catch (err) {
      console.error(err);
    }
  };

  /** Push a saved state blob into every piece of studio state. */
  const applyLoadedState = (state) => {
    // Migrate or load scenes
    let loadedScenes = state.scenes || [];
    if (loadedScenes.length === 0 && state.shots && state.shots.length > 0) {
      loadedScenes = [
        {
          id: 'scene_default_' + Date.now(),
          name: 'Scene 1',
          number: 1,
          shots: state.shots,
          sceneConcatenatedVideo: state.sceneConcatenatedVideo || null
        }
      ];
    } else if (loadedScenes.length === 0) {
      loadedScenes = [
        {
          id: 'scene_' + Date.now(),
          name: 'Scene 1',
          number: 1,
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
          sceneConcatenatedVideo: null
        }
      ];
    }
    setScenes(loadedScenes);

    setImageGallery(state.imageGallery || []);
    setVideoGallery(state.videoGallery || []);
    setReferenceImages(state.referenceImages || []);
    setAssetLibrary(state.assetLibrary || []);
    setPromptSnippets(state.promptSnippets || promptSnippets);
    setActiveLlm(state.activeLlm || 'gemini');
    setLlmModel(state.llmModel || 'gemini-2.5-flash');
    setActiveImageGenerator(state.activeImageGenerator || 'fal-ai');
    setImageModel(state.imageModel || 'fal-ai/flux/schnell');
    setImageResolution(state.imageResolution || '16:9');
    setActiveVideoGenerator(state.activeVideoGenerator || 'fal-ai');
    setVideoResolution(state.videoResolution || '1280x720');
    setVideoModel(state.videoModel || 'fal-ai/kling-video');
    setVideoDuration(state.videoDuration || '5');
    setPrePrompt(state.prePrompt || '');
    setPostPrompt(state.postPrompt || '');
    setVideoPrePrompt(state.videoPrePrompt || '');
    setVideoPostPrompt(state.videoPostPrompt || '');
    setImageSystemPrompt(state.imageSystemPrompt || DEFAULT_IMAGE_SYSTEM_PROMPT);
    setVideoSystemPrompt(state.videoSystemPrompt || DEFAULT_VIDEO_SYSTEM_PROMPT);
    setConcatenatedVideo(state.concatenatedVideo || null);

    // Find or set activeSceneId
    const firstSceneId = loadedScenes[0]?.id;
    setActiveSceneId(state.activeSceneId || firstSceneId);

    // Find and set activeShotId
    let foundShotId = null;
    if (state.activeShotId) {
      const allShots = loadedScenes.flatMap(s => s.shots || []);
      if (allShots.some(sh => sh.id === state.activeShotId)) {
        foundShotId = state.activeShotId;
      }
    }
    if (!foundShotId) {
      foundShotId = loadedScenes[0]?.shots[0]?.id || null;
    }
    setActiveShotId(foundShotId);
  };

  // The full serialisable studio state. Shared by autosave and Save As.
  const buildStatePayload = (updatedScenes = scenes, extra = {}) => {
    const flatShots = updatedScenes.flatMap(s => s.shots || []);
    return {
      scenes: updatedScenes,
      shots: flatShots,
      imageGallery,
      videoGallery,
      referenceImages,
      assetLibrary,
      promptSnippets,
      activeLlm,
      llmModel,
      activeImageGenerator,
      imageModel,
      imageResolution,
      activeVideoGenerator,
      videoResolution,
      videoModel,
      videoDuration,
      prePrompt,
      postPrompt,
      videoPrePrompt,
      videoPostPrompt,
      imageSystemPrompt,
      videoSystemPrompt,
      concatenatedVideo: extra.concatenatedVideo !== undefined ? extra.concatenatedVideo : concatenatedVideo,
      activeSceneId: extra.activeSceneId !== undefined ? extra.activeSceneId : activeSceneId,
      activeShotId: extra.activeShotId !== undefined ? extra.activeShotId : activeShotId,
      ...extra
    };
  };

  // Auto-Save Project State
  const saveProjectState = async (updatedScenes = scenes, extra = {}) => {
    try {
      await fetch(`${API_BASE}/api/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildStatePayload(updatedScenes, extra))
      });
    } catch (err) {
      console.error('Error saving state:', err);
    }
  };

  // Autosave is debounced: typing in a shot textarea used to fire one POST per
  // keystroke (and a second from the effect below), which made the timeline
  // stutter on long projects.
  const saveStateRef = useRef();
  saveStateRef.current = () => { saveProjectState(); };
  useEffect(() => {
    if (scenes.length === 0) return undefined;
    const timer = setTimeout(() => saveStateRef.current(), 600);
    return () => clearTimeout(timer);
  }, [scenes, imageGallery, videoGallery, referenceImages, assetLibrary, promptSnippets, activeLlm, llmModel, activeImageGenerator, imageModel, imageResolution, activeVideoGenerator, videoResolution, videoModel, videoDuration, prePrompt, postPrompt, videoPrePrompt, videoPostPrompt, imageSystemPrompt, videoSystemPrompt, concatenatedVideo]);

  // Save Credentials
  const saveConfig = async (newKeys) => {
    try {
      const res = await fetch(`${API_BASE}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newKeys)
      });
      if (res.ok) {
        setApiKeys(newKeys);
        showToast('API Credentials & Folder Path saved.', 'success');
        // Reload project state to fetch the project state from the new working folder path
        fetchProjectState();
      }
    } catch (err) {
      console.error(err);
      showToast('Failed to save config.', 'error');
    }
  };

  // --- THEME TOGGLE ---
  const handleToggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('moviemaker-theme', nextTheme);
    if (nextTheme === 'light') {
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.remove('light-theme');
    }
    showToast(`Switched to ${nextTheme} theme.`);
  };

  // --- COLLAPSE TOGGLES ---
  const toggleShotCollapse = (shotId, e) => {
    e.stopPropagation();
    setCollapsedShots(prev => ({
      ...prev,
      [shotId]: prev[shotId] === undefined ? false : !prev[shotId]
    }));
  };

  const isShotCollapsed = (shotId) => {
    return collapsedShots[shotId] !== false; // collapsed by default
  };

  // --- SCENE MANIPULATION ---
  const handleAddScene = () => {
    const newSceneNum = scenes.length + 1;
    const newSceneId = 'scene_' + Date.now();
    const newScene = {
      id: newSceneId,
      name: `Scene ${newSceneNum}`,
      number: newSceneNum,
      shots: [
        {
          id: 'shot_' + Date.now(),
          name: 'Shot 1',
          setup: '',
          description: '',
          dialogue: '',
          notes: '',
          selectedImage: null,
          selectedVideo: null,
          referenceImages: [],
          lipSyncAudio: null,
          imagePrompts: [],
          videoPrompts: [],
          draftImagePrompt: '',
          draftVideoPrompt: ''
        }
      ],
      sceneConcatenatedVideo: null
    };

    const updated = [...scenes, newScene];
    setScenes(updated);
    setActiveSceneId(newSceneId);
    setActiveShotId(newScene.shots[0].id);
    saveProjectState(updated, { activeSceneId: newSceneId, activeShotId: newScene.shots[0].id });
    showToast(`Scene ${newSceneNum} added.`, 'success');
  };

  const handleDeleteScene = (sceneId, e) => {
    if (e) e.stopPropagation();
    if (scenes.length <= 1) {
      showToast('Cannot delete the only scene.', 'warning');
      return;
    }
    const updated = scenes.filter(s => s.id !== sceneId);
    const reindexed = updated.map((s, idx) => ({ ...s, number: idx + 1 }));
    setScenes(reindexed);

    if (activeSceneId === sceneId) {
      const nextActiveScene = reindexed[0];
      setActiveSceneId(nextActiveScene.id);
      setActiveShotId(nextActiveScene.shots[0]?.id || null);
      saveProjectState(reindexed, { activeSceneId: nextActiveScene.id, activeShotId: nextActiveScene.shots[0]?.id || null });
    } else {
      saveProjectState(reindexed);
    }
    showToast('Scene deleted.', 'success');
  };

  const handleRenameScene = (sceneId, newName) => {
    const updated = scenes.map(s => {
      if (s.id === sceneId) {
        return { ...s, name: newName };
      }
      return s;
    });
    setScenes(updated);
    saveProjectState(updated);
  };

  // --- SHOT MANIPULATION ---
  const handleAddShot = () => {
    const activeScene = scenes.find(s => s.id === activeSceneId);
    if (!activeScene) return;

    const newId = 'shot_' + Date.now();
    const newShot = {
      id: newId,
      name: `Shot ${(activeScene.shots || []).length + 1}`,
      setup: '',
      description: '',
      dialogue: '',
      notes: '',
      selectedImage: null,
      selectedVideo: null,
      referenceImages: [],
      lipSyncAudio: null,
      imagePrompts: [], 
      videoPrompts: [],
      draftImagePrompt: '',
      draftVideoPrompt: ''
    };

    const newCollapseState = { ...collapsedShots };
    shots.forEach(s => {
      newCollapseState[s.id] = true;
    });
    newCollapseState[newId] = false;
    setCollapsedShots(newCollapseState);

    const updated = scenes.map(s => {
      if (s.id === activeSceneId) {
        return { ...s, shots: [...(s.shots || []), newShot] };
      }
      return s;
    });
    setScenes(updated);
    setActiveShotId(newId);
    saveProjectState(updated, { activeShotId: newId });
    showToast(`Added ${newShot.name}`);
  };

  const handleDeleteShot = (shotId, e) => {
    if (e) e.stopPropagation();
    const updated = scenes.map(s => {
      return {
        ...s,
        shots: (s.shots || []).filter(sh => sh.id !== shotId)
      };
    });
    setScenes(updated);

    const allRemainingShots = updated.flatMap(s => s.shots || []);
    if (activeShotId === shotId) {
      const nextId = allRemainingShots[0]?.id || null;
      setActiveShotId(nextId);
      saveProjectState(updated, { activeShotId: nextId });
    } else {
      saveProjectState(updated);
    }
    showToast('Shot deleted');
  };

  // No explicit save here — the debounced autosave effect picks the change up.
  const handleUpdateShotField = (shotId, field, value) => {
    setScenes(prev => prev.map(s => ({
      ...s,
      shots: (s.shots || []).map(shot => (
        shot.id === shotId ? { ...shot, [field]: value } : shot
      ))
    })));
  };

  const moveShot = (index, direction, e) => {
    if (e) e.stopPropagation();
    const activeScene = scenes.find(s => s.id === activeSceneId);
    if (!activeScene) return;

    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= (activeScene.shots || []).length) return;

    const newShots = [...activeScene.shots];
    const temp = newShots[index];
    newShots[index] = newShots[newIndex];
    newShots[newIndex] = temp;

    const updated = scenes.map(s => {
      if (s.id === activeSceneId) {
        return { ...s, shots: newShots };
      }
      return s;
    });
    setScenes(updated);
    saveProjectState(updated);
  };

  // --- OPEN GENERATION MODALS ---
  const openGenerationModal = (type, shotId, existingPromptId = null) => {
    const shot = shots.find(s => s.id === shotId);
    if (!shot) return;

    setGenerationModal({ type, shotId, existingPromptId });
    setGenModalPrompt('');
    setGenModalImageInput('');
    setGenModalInputImages((shot.referenceImages || [])
      .map(refId => referenceImages.find(ref => ref.id === refId)?.path)
      .filter(Boolean)
      .slice(0, 3));
    setGenModalDuration(videoDuration);

    // Per-shot overrides (set by shot list import) win over project defaults.
    if (type === 'image') {
      setGenModalModel(shot.imageModel || imageModel);
      setGenModalRes(shot.imageResolution || imageResolution);
    } else {
      setGenModalModel(shot.videoModel || videoModel);
      setGenModalRes(shot.videoResolution || videoResolution);
      setGenModalDuration(shot.videoDuration || videoDuration);
    }

    let initialPromptText = '';
    if (existingPromptId) {
      const promptList = type === 'image' ? shot.imagePrompts : shot.videoPrompts;
      const found = promptList.find(p => p.id === existingPromptId);
      if (found) initialPromptText = found.prompt;
    } else {
      const draftField = type === 'image' ? 'draftImagePrompt' : 'draftVideoPrompt';
      initialPromptText = shot[draftField] !== undefined && shot[draftField] !== null && shot[draftField] !== '' ? shot[draftField] : (shot.description || '');
    }

    setGenModalPrompt(initialPromptText);
    setGenModalImageInput(shot.selectedImage || '');
  };

  const updateDraftPrompt = (val) => {
    if (generationModal) {
      const { type, shotId, existingPromptId } = generationModal;
      if (shotId && !existingPromptId) {
        const field = type === 'image' ? 'draftImagePrompt' : 'draftVideoPrompt';
        handleUpdateShotField(shotId, field, val);
      }
    }
  };

  const appendSnippetToModalPrompt = (snippetText) => {
    setGenModalPrompt(prev => {
      const trimmed = prev.trim();
      const newVal = trimmed ? `${trimmed}, ${snippetText}` : snippetText;
      // Update draft synchronously
      if (generationModal) {
        const { type, shotId, existingPromptId } = generationModal;
        if (shotId && !existingPromptId) {
          const field = type === 'image' ? 'draftImagePrompt' : 'draftVideoPrompt';
          handleUpdateShotField(shotId, field, newVal);
        }
      }
      return newVal;
    });
  };

  // --- AUTO-GENERATE PROMPT FROM SHOT VIA LLM ---
  const handleAutoGeneratePromptInModal = async () => {
    const { shotId } = generationModal;
    const shot = shots.find(s => s.id === shotId);
    if (!shot || !shot.description) {
      showToast('Please add a visual description to the shot first.', 'warning');
      return;
    }

    setLoadingStates(prev => ({ ...prev, modal_llm: true }));
    const systemPrompt = generationModal.type === 'image' ? imageSystemPrompt : videoSystemPrompt;
    const promptPayload = `Write a visual prompt based on this scene description: "${shot.description}"\nCamera/Shot setup to apply: "${shot.setup}"\nAdditional Notes: "${shot.notes}"`;

    try {
      const res = await fetch(`${API_BASE}/api/llm/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: activeLlm,
          prompt: promptPayload,
          systemPrompt,
          model: llmModel
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed prompt generation');

      setGenModalPrompt(data.text);
      updateDraftPrompt(data.text);
      showToast('Prompt generated via LLM!', 'success');
    } catch (err) {
      console.error(err);
      showToast(`Prompt failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, modal_llm: false }));
    }
  };

  // --- PROMPT COMPOSITION ---
  // The single place where a raw shot prompt becomes the string a model sees:
  // global pre/post prompt + <Tag> substitution + reference image resolution.
  const buildPrompt = (type, rawPrompt, modelId, manualImagePaths = []) => composeGenerationPrompt({
    prompt: rawPrompt,
    prePrompt: type === 'image' ? prePrompt : videoPrePrompt,
    postPrompt: type === 'image' ? postPrompt : videoPostPrompt,
    assetLibrary,
    manualImagePaths,
    type,
    modelId
  });

  // --- BACKGROUND GENERATION SUBMISSION ---
  const handleTriggerGeneration = () => {
    const { type, shotId, existingPromptId } = generationModal;
    const shot = shots.find(s => s.id === shotId);
    const shotName = shot ? shot.name : 'Unknown Shot';

    setGenerationModal(null);
    showToast(`Background ${type} generation submitted for ${shotName}.`, 'info');

    submitGenerationJob({
      type,
      shotId,
      shotName,
      existingPromptId,
      rawPrompt: genModalPrompt,
      model: genModalModel,
      resolution: genModalRes,
      duration: genModalDuration,
      manualImagePaths: type === 'image'
        ? genModalInputImages
        : (genModalImageInput ? [genModalImageInput] : [])
    });
  };

  /**
   * Queue one generation. Used by the modal and by the batch runner alike, so
   * both go through identical prompt composition and identical result handling.
   * Resolves (never rejects) once the job settles.
   */
  const submitGenerationJob = async ({
    type, shotId, shotName, existingPromptId = null,
    rawPrompt, model, resolution, duration, manualImagePaths = []
  }) => {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const composed = buildPrompt(type, rawPrompt, model, manualImagePaths);

    setBatchJobs(prev => [{
      id: jobId,
      shotId,
      shotName,
      type,
      model,
      prompt: composed.prompt,
      taggedAssets: composed.taggedAssets.map(a => a.tag),
      status: 'running',
      createdAt: new Date().toISOString(),
      error: null
    }, ...prev]);

    if (composed.missingTags.length > 0) {
      showToast(`Unknown asset tag${composed.missingTags.length === 1 ? '' : 's'}: <${composed.missingTags.join('>, <')}> — sent as literal text.`, 'warning');
    }

    if (type === 'image') {
      return runAsyncImageJob(jobId, shotId, existingPromptId, composed.prompt, model, resolution, composed.inputImagePaths);
    }
    return runAsyncVideoJob(jobId, shotId, existingPromptId, composed.prompt, model, resolution, duration, composed.inputImagePaths[0] || '');
  };

  const runAsyncImageJob = async (jobId, shotId, existingPromptId, promptText, model, resOption, inputImagePaths = []) => {
    try {
      const res = await fetch(`${API_BASE}/api/image/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: model,
          providerFamily: getImageModel(model)?.provider || null,
          prompt: promptText,
          resolution: resOption,
          inputImagePaths
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Image API request failed');

      const newOutput = {
        id: 'out_img_' + Date.now(),
        path: data.filePath,
        name: `Iteration ${Date.now().toString().slice(-4)}`,
        createdAt: new Date().toISOString()
      };

      setScenes(prevScenes => prevScenes.map(scene => {
        const hasShot = (scene.shots || []).some(s => s.id === shotId);
        if (!hasShot) return scene;

        return {
          ...scene,
          shots: scene.shots.map(s => {
            if (s.id === shotId) {
              let updatedPrompts = [...(s.imagePrompts || [])];
              const existingGroup = existingPromptId ? updatedPrompts.find(p => p.id === existingPromptId) : null;
              
              // Verify if prompt AND settings match exactly
              const isMatch = existingGroup &&
                existingGroup.prompt === promptText &&
                existingGroup.model === model &&
                existingGroup.resolution === resOption &&
                JSON.stringify(existingGroup.inputImagePaths || []) === JSON.stringify(inputImagePaths || []);

              if (isMatch) {
                updatedPrompts = updatedPrompts.map(p => 
                  p.id === existingPromptId ? { ...p, outputs: [...(p.outputs || []), newOutput] } : p
                );
              } else {
                updatedPrompts.push({
                  id: 'prompt_img_' + Date.now(),
                  prompt: promptText,
                  model: model,
                  resolution: resOption,
                  inputImagePaths: inputImagePaths,
                  outputs: [newOutput]
                });
              }

              return { 
                ...s, 
                imagePrompts: updatedPrompts,
                selectedImage: s.selectedImage ? s.selectedImage : newOutput.path 
              };
            }
            return s;
          })
        };
      }));

      // Append to global gallery
      setImageGallery(prevGal => [{
        id: 'img_' + Date.now(),
        path: data.filePath,
        prompt: promptText,
        name: newOutput.name,
        createdAt: new Date().toISOString()
      }, ...prevGal]);

      // Update Job status
      setBatchJobs(prevJobs => prevJobs.map(j => j.id === jobId ? { ...j, status: 'completed', outputPath: data.filePath } : j));
      showToast(`Image iteration ready for ${shots.find(s => s.id === shotId)?.name || 'Shot'}!`, 'success');
      return { ok: true, path: data.filePath };

    } catch (err) {
      console.error(err);
      setBatchJobs(prevJobs => prevJobs.map(j => j.id === jobId ? { ...j, status: 'failed', error: err.message } : j));
      showToast(`Generation failed: ${err.message}`, 'error');
      return { ok: false, error: err.message };
    }
  };

  const runAsyncVideoJob = async (jobId, shotId, existingPromptId, promptText, model, resOption, duration, imageInput) => {
    try {
      const imageUrlsToSend = imageInput ? [imageInput] : [];
      const res = await fetch(`${API_BASE}/api/video/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: model,
          providerFamily: getVideoModel(model)?.provider || null,
          videoModel: model,
          prompt: promptText,
          imageUrls: imageUrlsToSend,
          resolution: resOption,
          duration: duration
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Video API request failed');

      const newOutput = {
        id: 'out_vid_' + Date.now(),
        path: data.filePath,
        name: `Iteration ${Date.now().toString().slice(-4)}`,
        createdAt: new Date().toISOString()
      };

      setScenes(prevScenes => prevScenes.map(scene => {
        const hasShot = (scene.shots || []).some(s => s.id === shotId);
        if (!hasShot) return scene;

        return {
          ...scene,
          shots: scene.shots.map(s => {
            if (s.id === shotId) {
              let updatedPrompts = [...(s.videoPrompts || [])];
              const existingGroup = existingPromptId ? updatedPrompts.find(p => p.id === existingPromptId) : null;
              
              // Verify if prompt and settings match exactly
              const isMatch = existingGroup &&
                existingGroup.prompt === promptText &&
                existingGroup.model === model &&
                existingGroup.resolution === resOption &&
                existingGroup.duration === duration &&
                existingGroup.imageInput === imageInput;

              if (isMatch) {
                updatedPrompts = updatedPrompts.map(p => 
                  p.id === existingPromptId ? { ...p, outputs: [...(p.outputs || []), newOutput] } : p
                );
              } else {
                updatedPrompts.push({
                  id: 'prompt_vid_' + Date.now(),
                  prompt: promptText,
                  model: model,
                  resolution: resOption,
                  duration: duration,
                  imageInput: imageInput,
                  outputs: [newOutput]
                });
              }

              return { 
                ...s, 
                videoPrompts: updatedPrompts,
                selectedVideo: s.selectedVideo ? s.selectedVideo : newOutput.path 
              };
            }
            return s;
          })
        };
      }));

      // Append to global video gallery
      setVideoGallery(prevGal => [{
        id: 'vid_' + Date.now(),
        path: data.filePath,
        prompt: promptText,
        name: newOutput.name,
        createdAt: new Date().toISOString()
      }, ...prevGal]);

      setBatchJobs(prevJobs => prevJobs.map(j => j.id === jobId ? { ...j, status: 'completed', outputPath: data.filePath } : j));
      showToast(`Video iteration ready for ${shots.find(s => s.id === shotId)?.name || 'Shot'}!`, 'success');
      return { ok: true, path: data.filePath };

    } catch (err) {
      console.error(err);
      setBatchJobs(prevJobs => prevJobs.map(j => j.id === jobId ? { ...j, status: 'failed', error: err.message } : j));
      showToast(`Video generation failed: ${err.message}`, 'error');
      return { ok: false, error: err.message };
    }
  };

  const handleClearBatchLog = () => {
    // Keep only active/running jobs
    setBatchJobs(batchJobs.filter(j => j.status === 'running'));
    showToast('Cleared completed and failed batch history.');
  };

  // --- BATCH GENERATION -----------------------------------------------------

  /** The prompt a batch run uses for a shot, before pre/post and tag expansion. */
  const resolveShotPrompt = (shot, type) => {
    if (type === 'image') {
      const lastGroup = (shot.imagePrompts || [])[(shot.imagePrompts || []).length - 1];
      return shot.draftImagePrompt || lastGroup?.prompt || shot.description || '';
    }
    const lastGroup = (shot.videoPrompts || [])[(shot.videoPrompts || []).length - 1];
    return shot.draftVideoPrompt || lastGroup?.prompt || shot.draftImagePrompt || shot.description || '';
  };

  const shotsForScope = (scope) => {
    if (scope === 'scene') {
      const scene = scenes.find(s => s.id === activeSceneId);
      return (scene?.shots || []).map(shot => ({ shot, sceneName: scene.name }));
    }
    return scenes.flatMap(scene => (scene.shots || []).map(shot => ({ shot, sceneName: scene.name })));
  };

  /** Shots a batch would actually act on, given the current dialog options. */
  const batchCandidates = (type, scope, onlyMissing) => shotsForScope(scope)
    .filter(({ shot }) => {
      if (!resolveShotPrompt(shot, type).trim()) return false;
      if (!onlyMissing) return true;
      // "Only shots without a result yet" — the point of a first full sweep.
      return type === 'image'
        ? !(shot.imagePrompts || []).some(p => (p.outputs || []).length > 0)
        : !(shot.videoPrompts || []).some(p => (p.outputs || []).length > 0);
    });

  const handleRunBatch = async () => {
    if (!batchDialog) return;
    const { type, scope } = batchDialog;
    const candidates = batchCandidates(type, scope, batchOnlyMissing);

    if (candidates.length === 0) {
      showToast('No shots match — every shot either has no prompt or already has output.', 'warning');
      return;
    }

    setBatchDialog(null);
    setActiveOverlay('batch');
    cancelBatchRef.current = false;

    const scopeLabel = scope === 'scene' ? `scene "${scenes.find(s => s.id === activeSceneId)?.name}"` : 'all scenes';
    setBatchRunner({ total: candidates.length, done: 0, type, label: `${type} × ${candidates.length} in ${scopeLabel}` });
    showToast(`Batch started: ${candidates.length} ${type} generation${candidates.length === 1 ? '' : 's'}.`, 'info');

    // Fixed-size worker pool so we do not slam the provider with N parallel
    // requests; each worker pulls the next shot off the shared cursor.
    let cursor = 0;
    let completed = 0;
    let failed = 0;
    const workerCount = Math.max(1, Math.min(batchConcurrency, candidates.length));

    const worker = async () => {
      while (true) {
        if (cancelBatchRef.current) return;
        const index = cursor;
        cursor += 1;
        if (index >= candidates.length) return;

        const { shot } = candidates[index];
        const isImage = type === 'image';
        const model = isImage ? (shot.imageModel || imageModel) : (shot.videoModel || videoModel);
        const resolution = isImage
          ? (shot.imageResolution || imageResolution)
          : (shot.videoResolution || videoResolution);

        // Video batches default to driving from the shot's selected still, which
        // is the usual storyboard-to-motion flow.
        const manualImagePaths = isImage
          ? (shot.referenceImages || []).map(refId => referenceImages.find(r => r.id === refId)?.path).filter(Boolean)
          : (shot.selectedImage ? [shot.selectedImage] : []);

        const result = await submitGenerationJob({
          type,
          shotId: shot.id,
          shotName: shot.name,
          rawPrompt: resolveShotPrompt(shot, type),
          model,
          resolution,
          duration: shot.videoDuration || videoDuration,
          manualImagePaths
        });

        if (result?.ok) completed += 1; else failed += 1;
        setBatchRunner(prev => (prev ? { ...prev, done: completed + failed } : prev));
      }
    };

    await Promise.all(Array.from({ length: workerCount }, worker));

    setBatchRunner(null);
    if (cancelBatchRef.current) {
      showToast(`Batch stopped. ${completed} finished, ${failed} failed, ${candidates.length - completed - failed} skipped.`, 'warning');
    } else if (failed > 0) {
      showToast(`Batch done: ${completed} succeeded, ${failed} failed. See the Batch Manager for errors.`, 'warning');
    } else {
      showToast(`Batch complete — ${completed} ${type}${completed === 1 ? '' : 's'} generated.`, 'success');
    }
    cancelBatchRef.current = false;
  };

  // Stops dispatching new jobs; requests already in flight are left to finish.
  const handleCancelBatch = () => {
    cancelBatchRef.current = true;
    showToast('Batch will stop after the in-flight generations finish.', 'warning');
  };

  // --- ASSET LIBRARY --------------------------------------------------------

  const openAssetEditor = (asset = null) => {
    setAssetEditor(asset
      ? { ...asset, images: [...(asset.images || [])] }
      : {
        tag: '', type: 'character', name: '', description: '',
        images: [], primaryImage: null,
        imagePrompt: '', imageModel: null, imageResolution: null,
        applyGlobalPrompts: false, useExistingAsReference: false
      });
  };

  /** The asset editor's prompt, falling back to one derived from the description. */
  const effectiveAssetPrompt = (draft) => (draft?.imagePrompt?.trim() ? draft.imagePrompt : defaultAssetPrompt(draft));

  /**
   * Compose an asset's generation prompt. Other assets' <Tag>s still resolve
   * (an environment can reference a character), but the asset being generated
   * is excluded from its own library so <Ralph> inside Ralph doesn't recurse.
   */
  const buildAssetPrompt = (draft) => {
    const others = assetLibrary.filter(a => a.id !== draft.id);
    const modelId = draft.imageModel || imageModel;
    const useRef = draft.useExistingAsReference && draft.primaryImage;
    return composeGenerationPrompt({
      prompt: effectiveAssetPrompt(draft),
      prePrompt: draft.applyGlobalPrompts ? prePrompt : '',
      postPrompt: draft.applyGlobalPrompts ? postPrompt : '',
      assetLibrary: others,
      manualImagePaths: useRef ? [draft.primaryImage] : [],
      type: 'image',
      modelId
    });
  };

  /** Attach a freshly generated image to an asset, in the library and the open editor. */
  const attachImageToAsset = (assetId, imagePath) => {
    setAssetLibrary(prev => prev.map(asset => {
      if (asset.id !== assetId) return asset;
      return {
        ...asset,
        images: [...(asset.images || []), imagePath],
        primaryImage: asset.primaryImage || imagePath
      };
    }));
    // Keep the editor in sync if it is still open on this asset.
    setAssetEditor(prev => {
      if (!prev || prev.id !== assetId) return prev;
      return {
        ...prev,
        images: [...(prev.images || []), imagePath],
        primaryImage: prev.primaryImage || imagePath
      };
    });
  };

  /** Generate one reference image for a saved asset. Resolves, never rejects. */
  const generateAssetImage = async (asset, promptOverride = null) => {
    const model = asset.imageModel || imageModel;
    const resolution = asset.imageResolution || imageResolution;
    const composed = promptOverride
      ? buildAssetPrompt({ ...asset, imagePrompt: promptOverride })
      : buildAssetPrompt(asset);

    if (!composed.prompt.trim()) {
      return { ok: false, error: 'No prompt or description to generate from.' };
    }

    const jobId = `job_asset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setBatchJobs(prev => [{
      id: jobId,
      shotId: null,
      assetId: asset.id,
      shotName: `Asset <${asset.tag}>`,
      type: 'image',
      model,
      prompt: composed.prompt,
      taggedAssets: composed.taggedAssets.map(a => a.tag),
      status: 'running',
      createdAt: new Date().toISOString(),
      error: null
    }, ...prev]);

    setLoadingStates(prev => ({ ...prev, [`asset_gen_${asset.id}`]: true }));
    try {
      const res = await fetch(`${API_BASE}/api/image/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: model,
          providerFamily: getImageModel(model)?.provider || null,
          prompt: composed.prompt,
          resolution,
          inputImagePaths: composed.inputImagePaths
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Image API request failed');

      attachImageToAsset(asset.id, data.filePath);
      setImageGallery(prev => [{
        id: `img_asset_${Date.now()}`,
        path: data.filePath,
        prompt: composed.prompt,
        name: `${asset.tag} reference`,
        createdAt: new Date().toISOString()
      }, ...prev]);

      setBatchJobs(prev => prev.map(j => (j.id === jobId ? { ...j, status: 'completed', outputPath: data.filePath } : j)));
      return { ok: true, path: data.filePath };
    } catch (err) {
      console.error(err);
      setBatchJobs(prev => prev.map(j => (j.id === jobId ? { ...j, status: 'failed', error: err.message } : j)));
      return { ok: false, error: err.message };
    } finally {
      setLoadingStates(prev => ({ ...prev, [`asset_gen_${asset.id}`]: false }));
    }
  };

  const handleGenerateAssetImage = async () => {
    if (!assetEditor) return;
    if (!effectiveAssetPrompt(assetEditor).trim()) {
      showToast('Add a description or a prompt before generating.', 'warning');
      return;
    }
    // The job outlives the editor, so the asset needs a committed id first.
    const saved = commitAssetDraft();
    if (!saved) return;

    const result = await generateAssetImage(saved);
    showToast(
      result.ok ? `New reference generated for <${saved.tag}>.` : `Asset generation failed: ${result.error}`,
      result.ok ? 'success' : 'error'
    );
  };

  /**
   * Everything the script says about an asset.
   *
   * Script-imported assets often carry a one-line description, but the shots
   * that reference them are full of usable detail. Feeding those lines to the
   * LLM is what lets it fill the gaps instead of padding with invention.
   */
  const gatherAssetContext = (asset) => {
    const tagKey = normalizeTag(asset.tag);
    const nameNeedle = (asset.name || '').trim().toLowerCase();
    const lines = [];

    scenes.forEach(scene => (scene.shots || []).forEach(shot => {
      const fields = [shot.setup, shot.description, shot.dialogue, shot.notes, shot.draftImagePrompt, shot.draftVideoPrompt];
      const blob = fields.filter(Boolean).join('\n');
      if (!blob) return;

      const taggedHere = extractTags(blob).some(t => normalizeTag(t) === tagKey);
      const namedHere = nameNeedle.length > 2 && blob.toLowerCase().includes(nameNeedle);
      if (!taggedHere && !namedHere) return;

      const detail = [shot.setup, shot.description, shot.notes].filter(Boolean).join(' ');
      if (detail) lines.push(`- [${scene.name} / ${shot.name}] ${detail}`);
    }));

    return lines.slice(0, 12); // enough signal without blowing the context
  };

  /**
   * Ask the LLM for a reference-image prompt (and a fuller description).
   * Prefers JSON, but a plain-text reply is treated as the prompt so a chatty
   * model still produces something usable.
   */
  const writeAssetPromptWithLlm = async (asset) => {
    const context = gatherAssetContext(asset);
    const styleHint = [prePrompt, postPrompt].filter(Boolean).join(' … ');

    const systemPrompt = `You write prompts for clean REFERENCE artwork used to keep a subject consistent across many shots of a film — not cinematic frames.

The image must isolate the subject: neutral pose, plain uncluttered background, even lighting, whole subject in frame, no motion blur, no dramatic grade, no other characters.

You are given a subject and the lines from the script where it appears. Infer concrete visual specifics that the script implies but never states — age, build, hair, wardrobe, materials, colour, wear and era. Be decisive and specific; do not hedge or offer alternatives. Never invent plot.

Reply with ONLY a JSON object, no markdown fence:
{"description":"<one dense sentence of physical description, reusable wherever this subject is named>","imagePrompt":"<the full reference image prompt>"}`;

    const userPrompt = [
      `Subject type: ${asset.type || 'character'}`,
      `Name: ${asset.name || asset.tag}`,
      `Existing description: ${asset.description?.trim() || '(none — infer it)'}`,
      context.length > 0
        ? `\nScript lines referencing this subject:\n${context.join('\n')}`
        : '\n(This subject is not referenced in any shot yet — work from the name and description alone.)',
      styleHint ? `\nProject look, for tone only — do NOT copy this into the reference prompt: ${styleHint}` : ''
    ].filter(Boolean).join('\n');

    const res = await fetch(`${API_BASE}/api/llm/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: activeLlm, model: llmModel, systemPrompt, prompt: userPrompt })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Prompt generation failed');

    const text = (data.text || '').trim();
    try {
      const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      if (parsed.imagePrompt) {
        return { description: parsed.description || '', imagePrompt: parsed.imagePrompt };
      }
    } catch {
      // Not JSON — fall through and use the raw reply.
    }
    return { description: '', imagePrompt: text };
  };

  const handleAutoWriteAssetPrompt = async () => {
    if (!assetEditor) return;
    setLoadingStates(prev => ({ ...prev, asset_llm: true }));
    try {
      const { description, imagePrompt } = await writeAssetPromptWithLlm(assetEditor);
      setAssetEditor(prev => (prev ? {
        ...prev,
        imagePrompt,
        // Only fill an empty description — never overwrite what you wrote.
        description: prev.description?.trim() ? prev.description : (description || prev.description)
      } : prev));
      const used = gatherAssetContext(assetEditor).length;
      showToast(`Reference prompt written${used ? ` from ${used} script reference${used === 1 ? '' : 's'}` : ''}.`, 'success');
    } catch (err) {
      console.error(err);
      showToast(`Prompt failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, asset_llm: false }));
    }
  };

  // --- BATCH ASSET GENERATION ------------------------------------------------
  // Runs strictly one asset at a time: write the prompt, generate, next. Each
  // asset's LLM pass can see assets generated before it, and serial execution
  // keeps both the LLM and image providers well inside rate limits.

  const assetBatchCandidates = (onlyMissing) => assetLibrary.filter(asset => (
    onlyMissing ? (asset.images || []).length === 0 : true
  ));

  const handleRunAssetBatch = async () => {
    if (!assetBatchDialog) return;
    const { onlyMissing, useLlm, rewriteExisting } = assetBatchDialog;
    const candidates = assetBatchCandidates(onlyMissing);

    if (candidates.length === 0) {
      showToast('No assets match — every asset already has an image.', 'warning');
      return;
    }

    setAssetBatchDialog(null);
    cancelBatchRef.current = false;
    setBatchRunner({ total: candidates.length, done: 0, type: 'image', label: `assets × ${candidates.length}` });
    showToast(`Generating ${candidates.length} asset reference${candidates.length === 1 ? '' : 's'}, one at a time.`, 'info');

    let completed = 0;
    let failed = 0;

    for (const candidate of candidates) {
      if (cancelBatchRef.current) break;

      // Re-read from the library so this asset sees edits made by earlier steps.
      let asset = assetLibrary.find(a => a.id === candidate.id) || candidate;
      let promptOverride = null;

      const needsPrompt = rewriteExisting || !asset.imagePrompt?.trim();
      if (useLlm && needsPrompt) {
        try {
          const { description, imagePrompt } = await writeAssetPromptWithLlm(asset);
          promptOverride = imagePrompt;
          const filledDescription = asset.description?.trim() ? asset.description : (description || asset.description);
          asset = { ...asset, imagePrompt, description: filledDescription };
          setAssetLibrary(prev => prev.map(a => (
            a.id === asset.id ? { ...a, imagePrompt, description: filledDescription } : a
          )));
        } catch (err) {
          console.error(err);
          showToast(`<${asset.tag}>: prompt failed (${err.message}) — using the auto-built one.`, 'warning');
        }
      }

      if (cancelBatchRef.current) break;

      const result = await generateAssetImage(asset, promptOverride);
      if (result.ok) completed += 1; else failed += 1;
      setBatchRunner(prev => (prev ? { ...prev, done: completed + failed } : prev));
    }

    setBatchRunner(null);
    if (cancelBatchRef.current) {
      showToast(`Stopped. ${completed} generated, ${failed} failed, ${candidates.length - completed - failed} skipped.`, 'warning');
    } else if (failed > 0) {
      showToast(`Done: ${completed} generated, ${failed} failed. See the Batch Manager.`, 'warning');
    } else {
      showToast(`All ${completed} asset reference${completed === 1 ? '' : 's'} generated.`, 'success');
    }
    cancelBatchRef.current = false;
  };

  /**
   * Validate the editor draft and write it into the library.
   * Returns the saved record (so callers have its id), or null if invalid.
   */
  const commitAssetDraft = () => {
    if (!assetEditor) return null;
    const tag = (assetEditor.tag || '').trim().replace(/^<|>$/g, '');
    if (!tag) {
      showToast('An asset needs a tag — that is what you type between < > in a prompt.', 'warning');
      return null;
    }
    if (/[^A-Za-z0-9 _-]/.test(tag)) {
      showToast('Tags may only contain letters, digits, spaces, hyphens and underscores.', 'warning');
      return null;
    }
    const clash = assetLibrary.find(a => normalizeTag(a.tag) === normalizeTag(tag) && a.id !== assetEditor.id);
    if (clash) {
      showToast(`Tag <${tag}> is already used by "${clash.name || clash.tag}".`, 'warning');
      return null;
    }

    const record = {
      id: assetEditor.id || `asset_${Date.now()}`,
      tag,
      type: assetEditor.type || 'character',
      name: (assetEditor.name || '').trim() || tag,
      description: (assetEditor.description || '').trim(),
      images: assetEditor.images || [],
      primaryImage: assetEditor.primaryImage || (assetEditor.images || [])[0] || null,
      imagePrompt: assetEditor.imagePrompt || '',
      imageModel: assetEditor.imageModel || null,
      imageResolution: assetEditor.imageResolution || null,
      applyGlobalPrompts: Boolean(assetEditor.applyGlobalPrompts),
      useExistingAsReference: Boolean(assetEditor.useExistingAsReference)
    };

    setAssetLibrary(prev => (
      prev.some(a => a.id === record.id) ? prev.map(a => (a.id === record.id ? record : a)) : [...prev, record]
    ));
    // Carry the id back so repeat generations update this asset instead of forking a new one.
    setAssetEditor(prev => (prev ? { ...prev, ...record } : prev));
    return record;
  };

  const handleSaveAsset = () => {
    const saved = commitAssetDraft();
    if (!saved) return;
    setAssetEditor(null);
    showToast(`Asset <${saved.tag}> saved.`, 'success');
  };

  const handleDeleteAssetEntry = (assetId) => {
    const asset = assetLibrary.find(a => a.id === assetId);
    setAssetLibrary(prev => prev.filter(a => a.id !== assetId));
    showToast(`Asset <${asset?.tag || '?'}> deleted. Prompts still referencing it will send the literal tag.`, 'warning');
  };

  const handleAssetImageUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length || !assetEditor) return;

    setLoadingStates(prev => ({ ...prev, asset_upload: true }));
    try {
      const paths = await Promise.all(files.map(async (file) => {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        return data.filePath;
      }));

      setAssetEditor(prev => ({
        ...prev,
        images: [...(prev.images || []), ...paths],
        primaryImage: prev.primaryImage || paths[0]
      }));
      showToast(`${paths.length} image${paths.length === 1 ? '' : 's'} added to asset.`, 'success');
    } catch (err) {
      console.error(err);
      showToast(`Upload failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, asset_upload: false }));
    }
  };

  /** Insert <Tag> at the end of the generation modal prompt. */
  const appendAssetTagToModalPrompt = (tag) => {
    setGenModalPrompt(prev => {
      const next = prev.trim() ? `${prev.trim()} <${tag}>` : `<${tag}>`;
      if (generationModal && !generationModal.existingPromptId) {
        const field = generationModal.type === 'image' ? 'draftImagePrompt' : 'draftVideoPrompt';
        handleUpdateShotField(generationModal.shotId, field, next);
      }
      return next;
    });
  };

  // --- PROJECTS -------------------------------------------------------------

  const fetchProject = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/project`);
      if (res.ok) setProject(await res.json());
    } catch (err) {
      console.error(err);
    }
  };

  /** Ask the backend to open a native Windows dialog. Returns a path or null. */
  const browseForPath = async (mode, defaultName = '') => {
    setLoadingStates(prev => ({ ...prev, browse: true }));
    try {
      const res = await fetch(`${API_BASE}/api/project/browse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, defaultName })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Picker failed');
      return data.path;
    } catch (err) {
      console.error(err);
      showToast(err.message, 'error');
      return null;
    } finally {
      setLoadingStates(prev => ({ ...prev, browse: false }));
    }
  };

  // Flush pending edits before switching away, so nothing typed in the last
  // half-second is lost to the debounce when the project file changes.
  const flushSave = async () => {
    await saveProjectState();
  };

  const handleOpenProject = async (explicitPath = null) => {
    const projectPath = explicitPath || await browseForPath('open');
    if (!projectPath) return;

    await flushSave();
    setLoadingStates(prev => ({ ...prev, project: true }));
    try {
      const res = await fetch(`${API_BASE}/api/project/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: projectPath })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not open project');

      applyLoadedState(data.state || {});
      await fetchProject();
      setActiveOverlay(null);
      showToast(`Opened "${data.name}".`, 'success');
      if (data.relocatedFrom) {
        showToast(`Project folder moved — media now resolves from ${data.workingFolder}.`, 'info');
      }
    } catch (err) {
      console.error(err);
      showToast(`Open failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, project: false }));
    }
  };

  const handleSaveProjectAs = async () => {
    const chosen = await browseForPath('saveAs', `${project.name || 'Untitled'}.mmproj.json`);
    if (!chosen) return;

    setLoadingStates(prev => ({ ...prev, project: true }));
    try {
      const res = await fetch(`${API_BASE}/api/project/save-as`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: chosen, state: buildStatePayload() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');

      await fetchProject();
      showToast(`Branched to "${data.name}" — ${data.copiedAssets} media file(s) copied. Autosave now writes here.`, 'success');
    } catch (err) {
      console.error(err);
      showToast(`Save As failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, project: false }));
    }
  };

  const handleCreateProject = async () => {
    if (!newProjectDraft?.directory || !newProjectDraft?.name?.trim()) {
      showToast('Pick a parent folder and give the project a name.', 'warning');
      return;
    }

    await flushSave();
    setLoadingStates(prev => ({ ...prev, project: true }));
    try {
      const res = await fetch(`${API_BASE}/api/project/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newProjectDraft)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create project');

      applyLoadedState({});
      await fetchProject();
      setNewProjectDraft(null);
      setActiveOverlay(null);
      showToast(`Created "${data.name}" in ${data.workingFolder}.`, 'success');
    } catch (err) {
      console.error(err);
      showToast(`Create failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, project: false }));
    }
  };

  const handleImportAssetsFromProject = async () => {
    const sourcePath = await browseForPath('open');
    if (!sourcePath) return;

    setLoadingStates(prev => ({ ...prev, project: true }));
    try {
      const res = await fetch(`${API_BASE}/api/project/import-assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: sourcePath })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');

      const incoming = data.assets || [];
      if (incoming.length === 0) {
        showToast(`"${data.sourceName}" has no assets to import.`, 'warning');
        return;
      }

      // Skip tags this project already defines rather than creating duplicates.
      let skipped = 0;
      setAssetLibrary(prev => {
        const additions = incoming.filter(asset => {
          const clash = prev.some(existing => normalizeTag(existing.tag) === normalizeTag(asset.tag));
          if (clash) skipped += 1;
          return !clash;
        });
        return [...prev, ...additions];
      });

      showToast(`Imported ${incoming.length - skipped} asset(s) from "${data.sourceName}"${skipped ? `, skipped ${skipped} duplicate tag(s)` : ''}.`, 'success');
    } catch (err) {
      console.error(err);
      showToast(`Asset import failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, project: false }));
    }
  };

  // --- SHOT LIST IMPORT / LLM PROMPT ---------------------------------------

  const handleCopyLlmPrompt = async () => {
    const text = buildLlmImportPrompt({ assetLibrary, sourceMaterial: llmPromptSource });
    try {
      await navigator.clipboard.writeText(text);
      showToast('LLM prompt copied. Paste it into any chat model with your script.', 'success');
    } catch (err) {
      console.error(err);
      showToast('Clipboard blocked by the browser — select the text and copy manually.', 'error');
    }
  };

  const handleImportShotList = (e, mode = 'replace') => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      let parsed;
      try {
        parsed = JSON.parse(evt.target.result);
      } catch (err) {
        showToast(`JSON parse error: ${err.message}`, 'error');
        return;
      }

      let normalized;
      try {
        normalized = normalizeImportedShotList(parsed);
      } catch (err) {
        showToast(`Import failed: ${err.message}`, 'error');
        return;
      }

      const { project, assets, promptSnippets: importedSnippets, scenes: importedScenes, warnings } = normalized;

      // Project-level settings
      if (project.prePrompt !== undefined) setPrePrompt(project.prePrompt);
      if (project.postPrompt !== undefined) setPostPrompt(project.postPrompt);
      if (project.videoPrePrompt !== undefined) setVideoPrePrompt(project.videoPrePrompt);
      if (project.videoPostPrompt !== undefined) setVideoPostPrompt(project.videoPostPrompt);
      if (project.imageSystemPrompt) setImageSystemPrompt(project.imageSystemPrompt);
      if (project.videoSystemPrompt) setVideoSystemPrompt(project.videoSystemPrompt);
      if (project.activeLlm) setActiveLlm(project.activeLlm);
      if (project.llmModel) setLlmModel(project.llmModel);
      if (project.imageModel) setImageModel(project.imageModel);
      if (project.imageResolution) setImageResolution(project.imageResolution);
      if (project.videoModel) setVideoModel(project.videoModel);
      if (project.videoResolution) setVideoResolution(project.videoResolution);
      if (project.videoDuration) setVideoDuration(project.videoDuration);

      // Assets merge by tag: an imported asset never clobbers reference images
      // you have already attached locally.
      if (assets.length > 0) {
        setAssetLibrary(prev => {
          const merged = [...prev];
          assets.forEach(incoming => {
            const existingIndex = merged.findIndex(a => normalizeTag(a.tag) === normalizeTag(incoming.tag));
            if (existingIndex >= 0) {
              const existing = merged[existingIndex];
              merged[existingIndex] = {
                ...existing,
                type: incoming.type || existing.type,
                name: incoming.name || existing.name,
                description: incoming.description || existing.description,
                images: existing.images?.length ? existing.images : incoming.images,
                primaryImage: existing.primaryImage || incoming.primaryImage
              };
            } else {
              merged.push(incoming);
            }
          });
          return merged;
        });
      }

      if (importedSnippets.length > 0) {
        setPromptSnippets(prev => [
          ...prev,
          ...importedSnippets.filter(s => !prev.some(p => p.name === s.name))
        ]);
      }

      const nextScenes = mode === 'append' ? [...scenes, ...importedScenes] : importedScenes;
      const renumbered = nextScenes.map((s, idx) => ({ ...s, number: idx + 1 }));
      setScenes(renumbered);
      setActiveSceneId(importedScenes[0]?.id || renumbered[0]?.id || null);
      setActiveShotId(importedScenes[0]?.shots?.[0]?.id || renumbered[0]?.shots?.[0]?.id || null);

      const shotCount = importedScenes.reduce((sum, s) => sum + s.shots.length, 0);
      const missingTagWarnings = collectMissingTagWarnings(importedScenes, assets);
      setImportReport({
        sceneCount: importedScenes.length,
        shotCount,
        assetCount: assets.length,
        mode,
        warnings: [...warnings, ...missingTagWarnings]
      });
      showToast(`Imported ${importedScenes.length} scene${importedScenes.length === 1 ? '' : 's'} / ${shotCount} shots.`, 'success');
    };
    reader.readAsText(file);
  };

  /** Flag <Tags> used in imported prompts that no asset defines. */
  const collectMissingTagWarnings = (importedScenes, importedAssets) => {
    const known = [...assetLibrary, ...importedAssets];
    const missing = new Set();
    importedScenes.forEach(scene => (scene.shots || []).forEach(shot => {
      [shot.draftImagePrompt, shot.draftVideoPrompt].forEach(text => {
        extractTags(text).forEach(tag => {
          if (!findAssetByTag(known, tag)) missing.add(tag);
        });
      });
    }));
    return missing.size > 0
      ? [`Prompts reference undefined asset tag(s): <${[...missing].join('>, <')}>. Add them in the Assets library or they will be sent as literal text.`]
      : [];
  };

  // Delete nested variation prompt output
  const handleDeleteNestedOutput = (shotId, type, promptId, outputId) => {
    const updated = scenes.map(scene => {
      const hasShot = (scene.shots || []).some(s => s.id === shotId);
      if (!hasShot) return scene;

      return {
        ...scene,
        shots: scene.shots.map(s => {
          if (s.id === shotId) {
            const promptList = type === 'image' ? (s.imagePrompts || []) : (s.videoPrompts || []);
            const updatedList = promptList.map(p => {
              if (p.id === promptId) {
                return { ...p, outputs: (p.outputs || []).filter(out => out.id !== outputId) };
              }
              return p;
            }).filter(p => p.outputs.length > 0);

            const stateUpdates = type === 'image' 
              ? { imagePrompts: updatedList }
              : { videoPrompts: updatedList };
            
            return { ...s, ...stateUpdates };
          }
          return s;
        })
      };
    });
    setScenes(updated);
    saveProjectState(updated);
    showToast('Iteration deleted');
  };

  // --- DOUBLE CLICK ZOOM SYSTEM ---
  const handleImageDoubleClick = (path, name) => {
    setZoomImage({ path, name });
    setZoomScale(1);
    setPanOffset({ x: 0, y: 0 });
  };

  const handleZoom = (direction) => {
    setZoomScale(prev => {
      const next = direction === 'in' ? prev + 0.25 : prev - 0.25;
      return Math.max(0.5, Math.min(4.0, next));
    });
  };

  const handleWheelZoom = (e) => {
    e.preventDefault();
    setZoomScale(prev => {
      const delta = e.deltaY < 0 ? 0.15 : -0.15;
      return Math.max(0.5, Math.min(4.0, prev + delta));
    });
  };

  // Pan dragging
  const handleDragStart = (e) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
  };

  const handleDragMove = (e) => {
    if (!isDragging) return;
    setPanOffset({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y
    });
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  // Reveal File on Disk
  const handleRevealInExplorer = async (filePath) => {
    try {
      const res = await fetch(`${API_BASE}/api/reveal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath })
      });
      if (res.ok) {
        showToast('Revealed file in Windows Explorer.');
      } else {
        const data = await res.json();
        showToast(`Failed reveal: ${data.error}`, 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Reveal failed.', 'error');
    }
  };

  // --- IMAGE CROPPING HANDLER ---
  const handleExecuteCrop = async () => {
    if (!cropImgRef.current || !zoomImage) return;

    // Calculate aspect bounds
    const imgAspect = imgNaturalSize.width / imgNaturalSize.height;
    const targetAspect = cropAspectWidth / cropAspectHeight;
    const maxCropWidthPercent = Math.min(100, 100 * (targetAspect / imgAspect));
    const activeCropW = Math.min(cropWidthPercent, maxCropWidthPercent);
    const activeCropH = activeCropW * (imgAspect / targetAspect);

    const maxCropX = 100 - activeCropW;
    const maxCropY = 100 - activeCropH;
    const constrainedX = Math.max(0, Math.min(cropX, maxCropX));
    const constrainedY = Math.max(0, Math.min(cropY, maxCropY));

    // Pixel coordinates
    const pixelX = (constrainedX / 100) * imgNaturalSize.width;
    const pixelY = (constrainedY / 100) * imgNaturalSize.height;
    const pixelW = (activeCropW / 100) * imgNaturalSize.width;
    const pixelH = (activeCropH / 100) * imgNaturalSize.height;

    try {
      showToast('Cropping image...', 'info');

      const canvas = document.createElement('canvas');
      canvas.width = pixelW;
      canvas.height = pixelH;
      const ctx = canvas.getContext('2d');

      const imgElement = new Image();
      imgElement.crossOrigin = 'anonymous';
      imgElement.src = `${API_BASE}/${zoomImage.path}`;

      imgElement.onload = async () => {
        try {
          ctx.drawImage(imgElement, pixelX, pixelY, pixelW, pixelH, 0, 0, pixelW, pixelH);
          const dataUrl = canvas.toDataURL('image/png');

          // Convert dataUrl to blob
          const blob = await (await fetch(dataUrl)).blob();
          const formData = new FormData();
          formData.append('file', blob, `crop_${Date.now()}.png`);

          const res = await fetch(`${API_BASE}/api/upload`, {
            method: 'POST',
            body: formData
          });
          const uploadData = await res.json();

          if (!res.ok) throw new Error(uploadData.error || 'Upload failed');

          // Save to image gallery
          const newCroppedImage = {
            id: `img_crop_${Date.now()}`,
            path: uploadData.filePath,
            prompt: `Crop of ${zoomImage.name}`,
            name: `crop_${zoomImage.name}`,
            createdAt: new Date().toISOString()
          };

          setImageGallery(prev => [newCroppedImage, ...prev]);
          saveProjectState();
          showToast('Image cropped and saved to master library!', 'success');
          setIsCropping(false);
          setZoomImage(null); // close zoom viewport
        } catch (err) {
          console.error(err);
          showToast(`Cropping failed: ${err.message}`, 'error');
        }
      };

      imgElement.onerror = () => {
        showToast('Failed to load image for cropping due to CORS or network error.', 'error');
      };

    } catch (err) {
      console.error(err);
      showToast(`Cropping failed: ${err.message}`, 'error');
    }
  };

  // --- FFMEG COMPILATION ---
  const handleStitchCompilation = async () => {
    const selects = scenes.flatMap(s => (s.shots || []).map(sh => sh.selectedVideo)).filter(Boolean);
    if (selects.length === 0) {
      showToast('No active selected videos found on timeline.', 'warning');
      return;
    }

    setLoadingStates(prev => ({ ...prev, compilation: true }));
    try {
      const res = await fetch(`${API_BASE}/api/concatenate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoPaths: selects })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'FFmpeg failed');

      window.open(`${API_BASE}/${data.filePath}`, '_blank');
      setConcatenatedVideo(data.filePath);
      saveProjectState(scenes, { concatenatedVideo: data.filePath });
      showToast('Compilation successful! Stitched output loaded and preview available.', 'success');
    } catch (err) {
      console.error(err);
      showToast(`Compilation failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, compilation: false }));
    }
  };

  const handleConcatenateScene = async (sceneId) => {
    const targetScene = scenes.find(s => s.id === sceneId);
    if (!targetScene) return;

    const selects = (targetScene.shots || []).map(s => s.selectedVideo).filter(Boolean);
    if (selects.length === 0) {
      showToast('No active selected videos found in this scene.', 'warning');
      return;
    }

    setLoadingStates(prev => ({ ...prev, compilation: true }));
    try {
      const res = await fetch(`${API_BASE}/api/concatenate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoPaths: selects })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'FFmpeg failed');

      window.open(`${API_BASE}/${data.filePath}`, '_blank');
      
      const updated = scenes.map(s => {
        if (s.id === sceneId) {
          return { ...s, sceneConcatenatedVideo: data.filePath };
        }
        return s;
      });
      setScenes(updated);
      saveProjectState(updated);
      showToast('Scene compiled successfully! Preview is active.', 'success');
    } catch (err) {
      console.error(err);
      showToast(`Scene compilation failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, compilation: false }));
    }
  };

  // --- AUDIO SYNCS & LIPSYNC ---
  const handleAudioUpload = async (shotId, e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    const key = `audio_${shotId}`;
    setLoadingStates(prev => ({ ...prev, [key]: true }));

    try {
      const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      handleUpdateShotField(shotId, 'lipSyncAudio', data.filePath);
      showToast('Audio uploaded to shot.');
    } catch (err) {
      console.error(err);
      showToast(`Upload failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, [key]: false }));
    }
  };

  const handleRunLipSync = async (shotId) => {
    const shot = shots.find(s => s.id === shotId);
    if (!shot || !shot.selectedVideo || !shot.lipSyncAudio) {
      showToast('Select a video and upload audio first.', 'warning');
      return;
    }

    const key = `sync_${shotId}`;
    setLoadingStates(prev => ({ ...prev, [key]: true }));

    try {
      const res = await fetch(`${API_BASE}/api/lipsync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoPath: shot.selectedVideo,
          audioPath: shot.lipSyncAudio
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed');

      const newOutput = {
        id: 'out_vid_' + Date.now(),
        path: data.filePath,
        name: `Lipsynced_${Date.now().toString().slice(-4)}`,
        createdAt: new Date().toISOString()
      };

      // `shots` is derived from `scenes`, so the update has to go through scenes.
      setScenes(prevScenes => prevScenes.map(scene => ({
        ...scene,
        shots: (scene.shots || []).map(s => {
          if (s.id !== shotId) return s;
          return {
            ...s,
            videoPrompts: [...(s.videoPrompts || []), {
              id: 'prompt_sync_' + Date.now(),
              prompt: `Lipsync synced with: ${pathBaseName(s.lipSyncAudio)}`,
              outputs: [newOutput]
            }],
            selectedVideo: newOutput.path
          };
        })
      })));

      setVideoGallery(prev => [{
        id: 'vid_' + Date.now(),
        path: data.filePath,
        prompt: `Lipsync output`,
        name: newOutput.name,
        createdAt: new Date().toISOString()
      }, ...prev]);

      showToast('Lip-sync complete! Output added and selected.', 'success');
    } catch (err) {
      console.error(err);
      showToast(`Lip sync failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, [key]: false }));
    }
  };

  const pathBaseName = (p) => {
    if (!p) return '';
    return p.split('/').pop().split('\\').pop();
  };

  // --- EXTERNAL FILE UPLOADS TO GALLERY OVERLAYS ---
  const handleGalleryImageUpload = async (e, dest = 'gallery') => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const key = dest === 'ref' ? 'ref_upload' : 'img_upload';
    setLoadingStates(prev => ({ ...prev, [key]: true }));

    try {
      const uploaded = await Promise.all(files.map(async (file, index) => {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        return { file, data, index };
      }));

      if (dest === 'ref') {
        const newRefs = uploaded.map(({ file, data, index }) => ({ id: `ref_${Date.now()}_${index}`, path: data.filePath, name: file.name }));
        setReferenceImages(prev => [...newRefs, ...prev]);
        if (generationModal?.type === 'image') {
          setGenModalInputImages(prev => [...prev, ...newRefs.map(ref => ref.path)].slice(0, 3));
        }
        showToast(`${newRefs.length} reference image${newRefs.length === 1 ? '' : 's'} added.`, 'success');
      } else {
        const newImages = uploaded.map(({ file, data, index }) => ({ id: `img_${Date.now()}_${index}`, path: data.filePath, prompt: 'Uploaded asset', name: file.name, createdAt: new Date().toISOString() }));
        setImageGallery(prev => [...newImages, ...prev]);
        showToast(`${newImages.length} image${newImages.length === 1 ? '' : 's'} added to gallery.`, 'success');
      }
    } catch (err) {
      console.error(err);
      showToast(`Upload failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, [key]: false }));
    }
  };

  const handleGalleryVideoUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    setLoadingStates(prev => ({ ...prev, vid_upload: true }));

    try {
      const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      const newVid = { id: 'vid_' + Date.now(), path: data.filePath, prompt: 'Uploaded asset', name: file.name, createdAt: new Date().toISOString() };
      setVideoGallery([newVid, ...videoGallery]);
      showToast('Video added to gallery.', 'success');
    } catch (err) {
      console.error(err);
      showToast(`Upload failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, vid_upload: false }));
    }
  };

  const openProjectImageSelector = async (target) => {
    setLoadingStates(prev => ({ ...prev, project_images: true }));
    try {
      const res = await fetch(`${API_BASE}/api/project-images`);
      if (res.ok) {
        const list = await res.json();
        setProjectImagesList(list);
        setProjectImagesSelector({ target });
      } else {
        showToast('Failed to load project images', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Error loading project images', 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, project_images: false }));
    }
  };

  const selectProjectImage = (image) => {
    if (projectImagesSelector.target === 'asset') {
      setAssetEditor(prev => {
        if (!prev) return prev;
        if ((prev.images || []).includes(image.path)) return prev;
        return {
          ...prev,
          images: [...(prev.images || []), image.path],
          primaryImage: prev.primaryImage || image.path
        };
      });
      setProjectImagesSelector(null);
      return;
    }
    if (projectImagesSelector.target === 'ref') {
      // Add to referenceImages
      if (referenceImages.some(r => r.path === image.path)) {
        showToast('This image is already in the reference imagery.', 'warning');
        setProjectImagesSelector(null);
        return;
      }
      const newRef = {
        id: `ref_${Date.now()}`,
        path: image.path,
        name: image.name
      };
      setReferenceImages(prev => [newRef, ...prev]);
      
      // If we are in the generation modal, also auto-select it as one of the active inputs
      if (generationModal?.type === 'image' || generationModal?.type === 'video') {
        setGenModalInputImages(prev => [...prev, image.path].slice(0, 3));
      }
      
      // If there is an active shot, also associate it with the active shot!
      if (activeShotId) {
        const activeShot = shots.find(s => s.id === activeShotId);
        if (activeShot) {
          const updatedRefs = [...(activeShot.referenceImages || []), newRef.id];
          handleUpdateShotField(activeShotId, 'referenceImages', updatedRefs);
        }
      }
      
      showToast(`Added ${image.name} to reference imagery.`, 'success');
    }
    setProjectImagesSelector(null);
  };

  const toggleRefImageMapping = (refId) => {
    if (!activeShotId) {
      showToast('Select a shot to assign reference imagery.', 'warning');
      return;
    }
    const activeShot = shots.find(s => s.id === activeShotId);
    if (!activeShot) return;

    let updatedRefs = [...activeShot.referenceImages];
    if (updatedRefs.includes(refId)) {
      updatedRefs = updatedRefs.filter(id => id !== refId);
      showToast('Reference image unassigned.');
    } else {
      updatedRefs.push(refId);
      showToast('Reference image assigned to active shot.');
    }
    handleUpdateShotField(activeShotId, 'referenceImages', updatedRefs);
  };

  const handleRenameAsset = (galleryType, id, newName) => {
    if (!newName.trim()) return;
    if (galleryType === 'images') {
      setImageGallery(imageGallery.map(i => i.id === id ? { ...i, name: newName } : i));
    } else if (galleryType === 'videos') {
      setVideoGallery(videoGallery.map(v => v.id === id ? { ...v, name: newName } : v));
    } else if (galleryType === 'reference') {
      setReferenceImages(referenceImages.map(r => r.id === id ? { ...r, name: newName } : r));
    }
    showToast('Asset renamed');
  };

  const handleDeleteAsset = (galleryType, id) => {
    if (galleryType === 'images') {
      // Shots store the asset *path*, not the gallery id — compare against the path.
      const removedPath = imageGallery.find(i => i.id === id)?.path;
      setImageGallery(imageGallery.filter(i => i.id !== id));
      const updated = scenes.map(sc => ({
        ...sc,
        shots: (sc.shots || []).map(s => s.selectedImage === removedPath ? { ...s, selectedImage: null } : s)
      }));
      setScenes(updated);
      saveProjectState(updated);
    } else if (galleryType === 'videos') {
      const removedPath = videoGallery.find(v => v.id === id)?.path;
      setVideoGallery(videoGallery.filter(v => v.id !== id));
      const updated = scenes.map(sc => ({
        ...sc,
        shots: (sc.shots || []).map(s => s.selectedVideo === removedPath ? { ...s, selectedVideo: null } : s)
      }));
      setScenes(updated);
      saveProjectState(updated);
    } else if (galleryType === 'reference') {
      setReferenceImages(referenceImages.filter(r => r.id !== id));
      const updated = scenes.map(sc => ({
        ...sc,
        shots: (sc.shots || []).map(s => ({
          ...s,
          referenceImages: (s.referenceImages || []).filter(refId => refId !== id)
        }))
      }));
      setScenes(updated);
      saveProjectState(updated);
    }
    showToast('Asset deleted');
  };

  const handleSetSelect = (galleryType, assetPath) => {
    if (!activeShotId) {
      showToast('Please select a shot first.', 'warning');
      return;
    }
    if (galleryType === 'images') {
      handleUpdateShotField(activeShotId, 'selectedImage', assetPath);
      showToast('Image set as active select');
      setActiveOverlay(null);
    } else if (galleryType === 'videos') {
      handleUpdateShotField(activeShotId, 'selectedVideo', assetPath);
      showToast('Video set as active select');
      setActiveOverlay(null);
    }
  };

  // --- STATE IMPORT/EXPORT ---
  const handleExportState = () => {
    const payload = {
      scenes, shots, imageGallery, videoGallery, referenceImages, assetLibrary, promptSnippets,
      activeLlm, llmModel, activeImageGenerator, imageModel, imageResolution,
      activeVideoGenerator, videoResolution, videoModel, videoDuration,
      prePrompt, postPrompt, videoPrePrompt, videoPostPrompt,
      imageSystemPrompt, videoSystemPrompt,
      activeSceneId, activeShotId, concatenatedVideo
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'project_state.json';
    link.click();
    URL.revokeObjectURL(url);
    showToast('Project State JSON exported.');
  };

  const handleImportState = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const parsed = JSON.parse(evt.target.result);
        
        let loadedScenes = parsed.scenes || [];
        if (loadedScenes.length === 0 && parsed.shots && parsed.shots.length > 0) {
          loadedScenes = [
            {
              id: 'scene_default_' + Date.now(),
              name: 'Scene 1',
              number: 1,
              shots: parsed.shots,
              sceneConcatenatedVideo: parsed.sceneConcatenatedVideo || null
            }
          ];
        } else if (loadedScenes.length === 0) {
          loadedScenes = [
            {
              id: 'scene_' + Date.now(),
              name: 'Scene 1',
              number: 1,
              shots: [
                {
                  id: 'shot_' + Date.now(),
                  name: 'Shot 1',
                  setup: '',
                  description: '',
                  dialogue: '',
                  notes: '',
                  selectedImage: null,
                  selectedVideo: null,
                  referenceImages: [],
                  lipSyncAudio: null
                }
              ],
              sceneConcatenatedVideo: null
            }
          ];
        }
        setScenes(loadedScenes);

        setImageGallery(parsed.imageGallery || []);
        setVideoGallery(parsed.videoGallery || []);
        setReferenceImages(parsed.referenceImages || []);
        setAssetLibrary(parsed.assetLibrary || []);
        setPromptSnippets(parsed.promptSnippets || promptSnippets);
        setActiveLlm(parsed.activeLlm || 'gemini');
        setLlmModel(parsed.llmModel || 'gemini-2.5-flash');
        setActiveImageGenerator(parsed.activeImageGenerator || 'fal-ai');
        setImageModel(parsed.imageModel || 'fal-ai/flux/schnell');
        setImageResolution(parsed.imageResolution || '16:9');
        setActiveVideoGenerator(parsed.activeVideoGenerator || 'fal-ai');
        setVideoResolution(parsed.videoResolution || '1280x720');
        setVideoModel(parsed.videoModel || 'fal-ai/kling-video');
        setVideoDuration(parsed.videoDuration || '5');
        setPrePrompt(parsed.prePrompt || '');
        setPostPrompt(parsed.postPrompt || '');
        setVideoPrePrompt(parsed.videoPrePrompt || '');
        setVideoPostPrompt(parsed.videoPostPrompt || '');
        setImageSystemPrompt(parsed.imageSystemPrompt || DEFAULT_IMAGE_SYSTEM_PROMPT);
        setVideoSystemPrompt(parsed.videoSystemPrompt || DEFAULT_VIDEO_SYSTEM_PROMPT);
        setConcatenatedVideo(parsed.concatenatedVideo || null);

        const firstSceneId = loadedScenes[0]?.id;
        setActiveSceneId(parsed.activeSceneId || firstSceneId);

        let foundShotId = null;
        if (parsed.activeShotId) {
          const allShots = loadedScenes.flatMap(s => s.shots || []);
          if (allShots.some(sh => sh.id === parsed.activeShotId)) {
            foundShotId = parsed.activeShotId;
          }
        }
        if (!foundShotId) {
          foundShotId = loadedScenes[0]?.shots[0]?.id || null;
        }
        setActiveShotId(foundShotId);

        await saveProjectState(loadedScenes, parsed);
        showToast('Project state imported.', 'success');
      } catch (err) {
        showToast('JSON Parse Error: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  };

  // Filter batch jobs active count
  const activeJobsCount = batchJobs.filter(j => j.status === 'running').length;

  const activeShotObj = shots.find(s => s.id === activeShotId);
  const activeScene = scenes.find(s => s.id === activeSceneId) || scenes[0];
  const activeSceneShots = activeScene ? (activeScene.shots || []) : [];

  return (
    <div className="app-container">
      {/* Toast Warning/Notifications */}
      {toast && (
        <div className="toast">
          <Sparkles size={16} />
          <span>{toast.message}</span>
        </div>
      )}

      {/* STICKY HEADER */}
      <header className="app-header">
        <div className="header-title-container">
          <div className="header-logo">MM</div>
          <div>
            <h1>MovieMaker Studio</h1>
            <button
              onClick={() => setActiveOverlay(activeOverlay === 'projects' ? null : 'projects')}
              title={project.path || 'No project file — using the loose project_state.json'}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.75rem', color: project.isLegacy ? 'var(--accent)' : 'var(--text-dim)', fontFamily: 'inherit' }}
            >
              <FolderOpen size={11} />
              <span style={{ maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {project.name}
              </span>
              <ChevronDown size={11} />
            </button>
          </div>
        </div>

        <div className="header-actions">
          {/* FFmpeg Video Concatenator Trigger */}
          <button
            className="btn btn-accent"
            onClick={handleStitchCompilation}
            disabled={loadingStates.compilation}
          >
            {loadingStates.compilation ? (
              <>
                <RefreshCw className="spinner" size={16} /> Compiling...
              </>
            ) : (
              <>
                <Film size={16} /> Concatenate Video
              </>
            )}
          </button>

          {/* Theme toggler */}
          <button className="btn btn-secondary" style={{ padding: '8px', borderRadius: '50%' }} onClick={handleToggleTheme} title="Toggle Theme (Dark/Light)">
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>

          {/* Batch Status indicator */}
          <div
            className={`batch-status-chip ${activeJobsCount > 0 ? 'active' : ''}`}
            onClick={() => setActiveOverlay(activeOverlay === 'batch' ? null : 'batch')}
            title="Open Batch Manager"
          >
            <Clock size={16} />
            <span>
              {batchRunner
                ? `Batch ${batchRunner.done}/${batchRunner.total}`
                : `${activeJobsCount} Generating`}
            </span>
          </div>

          {/* Overlays Toggles */}
          <button className={`btn btn-secondary ${activeOverlay === 'assets' ? 'active' : ''}`} onClick={() => setActiveOverlay(activeOverlay === 'assets' ? null : 'assets')} title="Character / environment library">
            <Users size={16} /> Assets
          </button>
          <button className={`btn btn-secondary ${activeOverlay === 'images' ? 'active' : ''}`} onClick={() => setActiveOverlay(activeOverlay === 'images' ? null : 'images')}>
            <ImageIcon size={16} /> Images
          </button>
          <button className={`btn btn-secondary ${activeOverlay === 'videos' ? 'active' : ''}`} onClick={() => setActiveOverlay(activeOverlay === 'videos' ? null : 'videos')}>
            <Film size={16} /> Videos
          </button>
          <button className={`btn btn-secondary ${activeOverlay === 'reference' ? 'active' : ''}`} onClick={() => setActiveOverlay(activeOverlay === 'reference' ? null : 'reference')}>
            <FolderOpen size={16} /> Reference
          </button>
          <button className={`btn btn-secondary ${activeOverlay === 'snippets' ? 'active' : ''}`} onClick={() => setActiveOverlay(activeOverlay === 'snippets' ? null : 'snippets')}>
            <MessageSquare size={16} /> Snippets
          </button>

          {/* Combined Settings Gear */}
          <button
            className={`btn btn-secondary ${activeOverlay === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveOverlay(activeOverlay === 'settings' ? null : 'settings')}
            title="Settings & Credentials"
          >
            <Settings size={18} />
          </button>

          <button
            className={`btn btn-secondary ${activeOverlay === 'help' ? 'active' : ''}`}
            onClick={() => setActiveOverlay(activeOverlay === 'help' ? null : 'help')}
            title="Help & LLM Import Guide"
          >
            <HelpCircle size={18} />
          </button>
        </div>
      </header>

      {/* SINGLE COLUMN TIMELINE */}
      <main className="main-grid">
        <section className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          {concatenatedVideo && (
            <div className="glass-panel" style={{ padding: '16px', background: 'rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', alignSelf: 'center', width: '100%', maxWidth: '50%', marginBottom: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: 'var(--accent)' }}>Global Compiled Video Preview</span>
                <button className="btn btn-secondary" style={{ padding: '2px 6px', fontSize: '0.7rem' }} onClick={() => setConcatenatedVideo(null)}>
                  Clear Preview
                </button>
              </div>
              <video src={`${API_BASE}/${concatenatedVideo}`} controls style={{ width: '100%', borderRadius: '6px', maxHeight: '250px', background: '#000' }} />
            </div>
          )}

          {/* Scene Tabs Row */}
          <div className="scene-tabs-container" style={{ display: 'flex', flexDirection: 'column', gap: '8px', borderBottom: '1px solid var(--border-light)', paddingBottom: '16px', marginBottom: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                {scenes.map((s, idx) => {
                  const isActive = s.id === activeSceneId;
                  return (
                    <div
                      key={s.id}
                      className={`scene-tab ${isActive ? 'active' : ''}`}
                      onClick={() => {
                        setActiveSceneId(s.id);
                        if (s.shots && s.shots.length > 0) {
                          setActiveShotId(s.shots[0].id);
                        }
                      }}
                      style={{
                        padding: '8px 16px',
                        background: isActive ? 'var(--primary)' : 'rgba(255,255,255,0.05)',
                        border: '1px solid ' + (isActive ? 'var(--primary-hover)' : 'var(--border-light)'),
                        borderRadius: '4px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '0.9rem',
                        fontWeight: isActive ? 'bold' : 'normal',
                        color: '#fff',
                        transition: 'all 0.2s ease'
                      }}
                    >
                      <span>Scene {idx + 1}: {s.name}</span>
                      {scenes.length > 1 && (
                        <button
                          style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '0.75rem', padding: '0 2px', display: 'flex', alignItems: 'center' }}
                          onClick={(e) => handleDeleteScene(s.id, e)}
                          title="Delete Scene"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  );
                })}
                <button
                  className="btn btn-secondary"
                  onClick={handleAddScene}
                  style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '8px 12px' }}
                >
                  <Plus size={14} /> Add Scene
                </button>
              </div>
            </div>

            {/* Rename Scene panel for active scene */}
            {activeScene && (
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', background: 'rgba(255,255,255,0.02)', padding: '8px 12px', borderRadius: '4px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Rename Scene:</label>
                  <input
                    type="text"
                    className="input-field"
                    style={{ maxWidth: '200px', padding: '4px 8px', fontSize: '0.85rem' }}
                    value={activeScene.name || ''}
                    onChange={(e) => handleRenameScene(activeScene.id, e.target.value)}
                  />
                </div>
                
                <button
                  className="btn btn-secondary"
                  onClick={() => handleConcatenateScene(activeScene.id)}
                  disabled={loadingStates.compilation}
                  style={{ fontSize: '0.8rem', padding: '6px 12px', marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '4px' }}
                >
                  <Film size={12} /> Compile Scene Video
                </button>
              </div>
            )}

            {/* Batch + shot list toolbar */}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', background: 'rgba(139, 92, 246, 0.06)', border: '1px solid var(--border-light)', padding: '8px 12px', borderRadius: '6px' }}>
              <Zap size={14} style={{ color: 'var(--primary)' }} />
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginRight: '4px' }}>Batch:</span>

              <button className="btn btn-primary" style={{ fontSize: '0.78rem', padding: '5px 10px' }} disabled={Boolean(batchRunner)} onClick={() => setBatchDialog({ type: 'image', scope: 'scene' })}>
                <ImageIcon size={12} /> Images — This Scene
              </button>
              <button className="btn btn-primary" style={{ fontSize: '0.78rem', padding: '5px 10px' }} disabled={Boolean(batchRunner)} onClick={() => setBatchDialog({ type: 'image', scope: 'all' })}>
                <ImageIcon size={12} /> Images — All Scenes
              </button>
              <button className="btn btn-accent" style={{ fontSize: '0.78rem', padding: '5px 10px' }} disabled={Boolean(batchRunner)} onClick={() => setBatchDialog({ type: 'video', scope: 'scene' })}>
                <Film size={12} /> Videos — This Scene
              </button>
              <button className="btn btn-accent" style={{ fontSize: '0.78rem', padding: '5px 10px' }} disabled={Boolean(batchRunner)} onClick={() => setBatchDialog({ type: 'video', scope: 'all' })}>
                <Film size={12} /> Videos — All Scenes
              </button>

              {batchRunner && (
                <button className="btn btn-danger" style={{ fontSize: '0.78rem', padding: '5px 10px' }} onClick={handleCancelBatch}>
                  <StopCircle size={12} /> Stop ({batchRunner.done}/{batchRunner.total})
                </button>
              )}

              <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input type="file" accept=".json" ref={shotListInputRef} onChange={(e) => handleImportShotList(e, shotListInputRef.current?.dataset.mode || 'replace')} style={{ display: 'none' }} />
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: '0.78rem', padding: '5px 10px' }}
                  onClick={handleCopyLlmPrompt}
                  title="Copy the full schema + model list to give an LLM"
                >
                  <Copy size={12} /> Copy LLM Prompt
                </button>
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: '0.78rem', padding: '5px 10px' }}
                  onClick={() => { shotListInputRef.current.dataset.mode = 'replace'; shotListInputRef.current.click(); }}
                >
                  <Upload size={12} /> Import Shot List
                </button>
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: '0.78rem', padding: '5px 10px' }}
                  onClick={() => { shotListInputRef.current.dataset.mode = 'append'; shotListInputRef.current.click(); }}
                  title="Add the imported scenes after the existing ones"
                >
                  <Plus size={12} /> Append
                </button>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-light)', paddingBottom: '12px' }}>
            <h2 className="section-title" style={{ border: 'none', padding: 0 }}><Film size={20} /> Scene {activeScene?.number || 1} Timeline ({activeSceneShots.length} shot{activeSceneShots.length === 1 ? '' : 's'})</h2>
            <button className="btn btn-primary" onClick={handleAddShot}>
              <Plus size={16} /> Append Shot
            </button>
          </div>

          {/* Scene Preview Video Player (Inside Scene) */}
          {activeScene && activeScene.sceneConcatenatedVideo && (
            <div className="glass-panel" style={{ padding: '12px', marginTop: '8px', background: 'rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', alignSelf: 'center', width: '100%', maxWidth: '40%', marginBottom: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 'bold', color: 'var(--accent)' }}>Scene Compiled Video Preview</span>
                <button className="btn btn-secondary" style={{ padding: '1px 4px', fontSize: '0.65rem' }} onClick={() => {
                  const updated = scenes.map(s => s.id === activeScene.id ? { ...s, sceneConcatenatedVideo: null } : s);
                  setScenes(updated);
                  saveProjectState(updated);
                }}>
                  Clear Preview
                </button>
              </div>
              <video src={`${API_BASE}/${activeScene.sceneConcatenatedVideo}`} controls style={{ width: '100%', borderRadius: '4px', maxHeight: '180px', background: '#000' }} />
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {activeSceneShots.map((shot, index) => {
              const isCollapsed = isShotCollapsed(shot.id);
              const isActive = shot.id === activeShotId;

              return (
                <div
                  key={shot.id}
                  className={`shot-card ${isActive ? 'active' : ''}`}
                  onClick={() => setActiveShotId(shot.id)}
                  draggable={isDraggable}
                  onDragStart={(e) => {
                    setDraggedIndex(index);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                  }}
                  onDragEnter={() => {
                    if (draggedIndex === null || draggedIndex === index) return;
                    const newShots = [...activeSceneShots];
                    const draggedItem = newShots[draggedIndex];
                    newShots.splice(draggedIndex, 1);
                    newShots.splice(index, 0, draggedItem);
                    setDraggedIndex(index);
                    
                    const updated = scenes.map(s => {
                      if (s.id === activeSceneId) {
                        return { ...s, shots: newShots };
                      }
                      return s;
                    });
                    setScenes(updated);
                  }}
                  onDragEnd={() => {
                    setDraggedIndex(null);
                    setIsDraggable(false);
                    saveProjectState(scenes);
                  }}
                >
                  {/* COLLAPSED ROW VIEW */}
                  <div
                    className="shot-row-collapsed"
                    onClick={(e) => toggleShotCollapse(shot.id, e)}
                  >
                    <div className="shot-collapsed-info" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div
                        style={{ cursor: 'grab', display: 'flex', alignItems: 'center', padding: '4px', color: 'var(--text-muted)' }}
                        onMouseEnter={() => setIsDraggable(true)}
                        onMouseLeave={() => setIsDraggable(false)}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <GripVertical size={16} />
                      </div>
                      <span className="shot-number">#{index + 1}</span>
                      <span className="shot-collapsed-title">{shot.name || `Shot ${index + 1}`}</span>
                      <span className="shot-collapsed-desc">{shot.description || '(No description)'}</span>
                    </div>

                    <div className="shot-collapsed-previews" onClick={(e) => e.stopPropagation()}>
                      <div
                        className="mini-preview"
                        title="Active Image Select"
                        onDoubleClick={() => shot.selectedImage && handleImageDoubleClick(shot.selectedImage, shot.name)}
                      >
                        {shot.selectedImage ? (
                          <img src={`${API_BASE}/${shot.selectedImage}`} alt="select visual" />
                        ) : (
                          'No Image'
                        )}
                      </div>

                      <div className="mini-preview" title="Active Video Select">
                        {shot.selectedVideo ? (
                          <video src={`${API_BASE}/${shot.selectedVideo}`} />
                        ) : (
                          'No Video'
                        )}
                      </div>

                      {shot.lipSyncAudio && (
                        <span style={{ fontSize: '0.65rem', background: 'rgba(16, 185, 129, 0.15)', color: 'var(--success)', padding: '2px 6px', borderRadius: '4px' }}>
                          Audio Sync
                        </span>
                      )}

                      <button className="btn btn-secondary" style={{ padding: '4px' }} onClick={(e) => moveShot(index, 'up', e)} disabled={index === 0}>
                        <ChevronUp size={12} />
                      </button>
                      <button className="btn btn-secondary" style={{ padding: '4px' }} onClick={(e) => moveShot(index, 'down', e)} disabled={index === activeSceneShots.length - 1}>
                        <ChevronDown size={12} />
                      </button>
                      <button className="btn btn-danger" style={{ padding: '4px' }} onClick={(e) => handleDeleteShot(shot.id, e)}>
                        <Trash2 size={12} />
                      </button>

                      <div style={{ color: 'var(--primary)', display: 'flex', alignItems: 'center', marginLeft: '6px' }}>
                        {isCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
                      </div>
                    </div>
                  </div>

                  {/* EXPANDED DETAIL VIEW */}
                  {!isCollapsed && (
                    <div className="shot-expanded-details" onClick={(e) => e.stopPropagation()}>
                      
                      <div className="shot-textareas">
                        <div className="form-group">
                          <label className="form-label">Visual / Camera Setup</label>
                          <textarea
                            className="input-field"
                            value={shot.setup || ''}
                            onChange={(e) => handleUpdateShotField(shot.id, 'setup', e.target.value)}
                            placeholder="low angle, pan right..."
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">Scene Action Description</label>
                          <textarea
                            className="input-field"
                            value={shot.description || ''}
                            onChange={(e) => handleUpdateShotField(shot.id, 'description', e.target.value)}
                            placeholder="What happens visually..."
                          />
                        </div>
                        <div className="form-group">
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                            <label className="form-label" style={{ margin: 0 }}>Spoken Dialogue</label>
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                              <input
                                type="file"
                                accept="audio/*"
                                ref={el => audioInputRefs.current[shot.id] = el}
                                onChange={(e) => handleAudioUpload(shot.id, e)}
                                style={{ display: 'none' }}
                              />
                              <button
                                className="btn btn-secondary"
                                style={{ padding: '2px 6px', fontSize: '0.65rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                                onClick={() => audioInputRefs.current[shot.id]?.click()}
                                disabled={loadingStates[`audio_${shot.id}`]}
                                title={shot.lipSyncAudio ? `Attached: ${pathBaseName(shot.lipSyncAudio)}` : 'Upload Dialogue Audio'}
                              >
                                <Music size={10} />
                                {shot.lipSyncAudio ? 'Replace Audio' : 'Upload Audio'}
                              </button>
                              {shot.lipSyncAudio && (
                                <button
                                  className="btn btn-primary"
                                  style={{ padding: '2px 6px', fontSize: '0.65rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                                  onClick={() => handleRunLipSync(shot.id)}
                                  disabled={!shot.selectedVideo || loadingStates[`sync_${shot.id}`]}
                                >
                                  {loadingStates[`sync_${shot.id}`] ? (
                                    <>
                                      <RefreshCw className="spinner" size={10} /> Syncing...
                                    </>
                                  ) : (
                                    <>
                                      <RefreshCw size={10} /> Sync Lips
                                    </>
                                  )}
                                </button>
                              )}
                            </div>
                          </div>
                          <textarea
                            className="input-field"
                            value={shot.dialogue || ''}
                            onChange={(e) => handleUpdateShotField(shot.id, 'dialogue', e.target.value)}
                            placeholder="Dialogue spoken by characters..."
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">Director Notes & Feedback</label>
                          <textarea
                            className="input-field"
                            value={shot.notes || ''}
                            onChange={(e) => handleUpdateShotField(shot.id, 'notes', e.target.value)}
                            placeholder="Director comments/notes..."
                          />
                        </div>
                      </div>

                      {/* Active Previews and Generate Actions Grid */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginTop: '12px', marginBottom: '12px' }}>
                        
                        {/* Image Column */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                          <div
                            className="preview-slot has-content"
                            style={{ minHeight: '130px', flex: 1 }}
                            onDoubleClick={() => shot.selectedImage && handleImageDoubleClick(shot.selectedImage, shot.name)}
                          >
                            <div className="slot-label">Active Image Select</div>
                            {shot.selectedImage ? (
                              <>
                                <img src={`${API_BASE}/${shot.selectedImage}`} alt="active visual" />
                                <button
                                  className="btn btn-danger"
                                  style={{ position: 'absolute', bottom: '6px', right: '6px', padding: '4px' }}
                                  onClick={() => handleUpdateShotField(shot.id, 'selectedImage', null)}
                                >
                                  <X size={12} />
                                </button>
                              </>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                                <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem', textAlign: 'center' }}>Double click iteration output to preview/set</span>
                                <button
                                  className="btn btn-secondary"
                                  style={{ fontSize: '0.75rem', padding: '4px 8px' }}
                                  onClick={() => {
                                    setActiveShotId(shot.id);
                                    setActiveOverlay('images');
                                  }}
                                >
                                  Choose from Library...
                                </button>
                              </div>
                            )}
                          </div>
                          <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => openGenerationModal('image', shot.id)}>
                            <ImageIcon size={14} /> Generate Image Variation
                          </button>
                        </div>

                        {/* Video Column */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                          <div
                            className="preview-slot has-content"
                            style={{ minHeight: '130px', flex: 1 }}
                          >
                            <div className="slot-label">Active Video Select</div>
                            {shot.selectedVideo ? (
                              <>
                                <video src={`${API_BASE}/${shot.selectedVideo}`} controls />
                                <button
                                  className="btn btn-danger"
                                  style={{ position: 'absolute', bottom: '6px', right: '6px', padding: '4px' }}
                                  onClick={() => handleUpdateShotField(shot.id, 'selectedVideo', null)}
                                >
                                  <X size={12} />
                                </button>
                              </>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                                <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem', textAlign: 'center' }}>Select a video iteration to make active</span>
                                <button
                                  className="btn btn-secondary"
                                  style={{ fontSize: '0.75rem', padding: '4px 8px' }}
                                  onClick={() => {
                                    setActiveShotId(shot.id);
                                    setActiveOverlay('videos');
                                  }}
                                >
                                  Choose from Library...
                                </button>
                              </div>
                            )}
                          </div>
                          <button className="btn btn-accent" style={{ width: '100%' }} onClick={() => openGenerationModal('video', shot.id)}>
                            <Film size={14} /> Generate Video Variation
                          </button>
                        </div>

                      </div>

                      {/* NESTED ITERATIONS GALLERIES */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginTop: '10px' }}>
                        
                        <div className="variation-section">
                          <h4 style={{ fontSize: '0.95rem', display: 'flex', justifySelf: 'start', gap: '6px', marginBottom: '8px' }}>
                            <ImageIcon size={16} /> Image Prompts & Iterations
                          </h4>
                          {shot.imagePrompts && shot.imagePrompts.length > 0 ? (() => {
                            const activeImagePromptGroupId = activeShotImagePromptGroup[shot.id] || shot.imagePrompts[0]?.id;
                            const activeImagePromptGroup = shot.imagePrompts.find(p => p.id === activeImagePromptGroupId) || shot.imagePrompts[0];

                            return (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                  <select
                                    className="select-field"
                                    value={activeImagePromptGroupId}
                                    onChange={(e) => setActiveShotImagePromptGroup(prev => ({ ...prev, [shot.id]: e.target.value }))}
                                    style={{ flex: 1, fontSize: '0.8rem', padding: '6px' }}
                                  >
                                    {shot.imagePrompts.map(pg => (
                                      <option key={pg.id} value={pg.id}>
                                        {pg.prompt.length > 35 ? pg.prompt.substring(0, 35) + '...' : pg.prompt}
                                      </option>
                                    ))}
                                  </select>
                                  {activeImagePromptGroup && (
                                    <button
                                      className="btn btn-secondary"
                                      style={{ padding: '6px 10px', fontSize: '0.75rem', whiteSpace: 'nowrap' }}
                                      onClick={() => setViewingPromptText({
                                        prompt: activeImagePromptGroup.prompt,
                                        type: 'Image',
                                        model: activeImagePromptGroup.model || 'Default',
                                        resolution: activeImagePromptGroup.resolution || 'Default'
                                      })}
                                    >
                                      View Prompt
                                    </button>
                                  )}
                                  <button
                                    className="btn btn-secondary"
                                    style={{ padding: '6px 10px', fontSize: '0.75rem', whiteSpace: 'nowrap' }}
                                    onClick={() => openGenerationModal('image', shot.id, activeImagePromptGroupId)}
                                  >
                                    + Add Iteration
                                  </button>
                                </div>

                                <div style={{ overflowY: 'auto', maxHeight: '250px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                  {activeImagePromptGroup && (
                                    <div className="iteration-grid">
                                      {activeImagePromptGroup.outputs.map(out => (
                                        <div
                                          key={out.id}
                                          className={`iteration-card ${shot.selectedImage === out.path ? 'active-select' : ''}`}
                                          onDoubleClick={() => handleImageDoubleClick(out.path, out.name)}
                                        >
                                          <img src={`${API_BASE}/${out.path}`} alt={out.name} />
                                          <div className="iteration-badge">{out.name}</div>
                                          <div className="iteration-hover-actions">
                                            <button
                                              className="btn btn-primary"
                                              style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                                              onClick={() => handleUpdateShotField(shot.id, 'selectedImage', out.path)}
                                            >
                                              Select
                                            </button>
                                            <button
                                              className="btn btn-danger"
                                              style={{ padding: '4px' }}
                                              onClick={() => handleDeleteNestedOutput(shot.id, 'image', activeImagePromptGroup.id, out.id)}
                                            >
                                              <Trash2 size={10} />
                                            </button>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })() : (
                            <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem', textAlign: 'center', padding: '16px' }}>No image iterations generated yet.</span>
                          )}
                        </div>

                        <div className="variation-section">
                          <h4 style={{ fontSize: '0.95rem', display: 'flex', justifySelf: 'start', gap: '6px', marginBottom: '8px' }}>
                            <Film size={16} /> Video Prompts & Iterations
                          </h4>
                          {shot.videoPrompts && shot.videoPrompts.length > 0 ? (() => {
                            const activeVideoPromptGroupId = activeShotVideoPromptGroup[shot.id] || shot.videoPrompts[0]?.id;
                            const activeVideoPromptGroup = shot.videoPrompts.find(p => p.id === activeVideoPromptGroupId) || shot.videoPrompts[0];

                            return (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                  <select
                                    className="select-field"
                                    value={activeVideoPromptGroupId}
                                    onChange={(e) => setActiveShotVideoPromptGroup(prev => ({ ...prev, [shot.id]: e.target.value }))}
                                    style={{ flex: 1, fontSize: '0.8rem', padding: '6px' }}
                                  >
                                    {shot.videoPrompts.map(pg => (
                                      <option key={pg.id} value={pg.id}>
                                        {pg.prompt.length > 35 ? pg.prompt.substring(0, 35) + '...' : pg.prompt}
                                      </option>
                                    ))}
                                  </select>
                                  {activeVideoPromptGroup && (
                                    <button
                                      className="btn btn-secondary"
                                      style={{ padding: '6px 10px', fontSize: '0.75rem', whiteSpace: 'nowrap' }}
                                      onClick={() => setViewingPromptText({
                                        prompt: activeVideoPromptGroup.prompt,
                                        type: 'Video',
                                        model: activeVideoPromptGroup.model || 'Default',
                                        resolution: activeVideoPromptGroup.resolution || 'Default'
                                      })}
                                    >
                                      View Prompt
                                    </button>
                                  )}
                                  <button
                                    className="btn btn-secondary"
                                    style={{ padding: '6px 10px', fontSize: '0.75rem', whiteSpace: 'nowrap' }}
                                    onClick={() => openGenerationModal('video', shot.id, activeVideoPromptGroupId)}
                                  >
                                    + Add Iteration
                                  </button>
                                </div>

                                <div style={{ overflowY: 'auto', maxHeight: '250px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                  {activeVideoPromptGroup && (
                                    <div className="iteration-grid">
                                      {activeVideoPromptGroup.outputs.map(out => (
                                        <div
                                          key={out.id}
                                          className={`iteration-card ${shot.selectedVideo === out.path ? 'active-select' : ''}`}
                                        >
                                          <video src={`${API_BASE}/${out.path}`} />
                                          <div className="iteration-badge">{out.name}</div>
                                          <div className="iteration-hover-actions">
                                            <button
                                              className="btn btn-primary"
                                              style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                                              onClick={() => handleUpdateShotField(shot.id, 'selectedVideo', out.path)}
                                            >
                                              Select
                                            </button>
                                            <button
                                              className="btn btn-danger"
                                              style={{ padding: '4px' }}
                                              onClick={() => handleDeleteNestedOutput(shot.id, 'video', activeVideoPromptGroup.id, out.id)}
                                            >
                                              <Trash2 size={10} />
                                            </button>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })() : (
                            <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem', textAlign: 'center', padding: '16px' }}>No video iterations generated yet.</span>
                          )}
                        </div>

                      </div>

                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </main>

      {/* --- A. GENERATION PROMPT MODAL (IMAGE / VIDEO) --- */}
      {generationModal && (
        <div className="modal-overlay">
          <div className="modal-window">
            <div className="modal-header">
              <h2 style={{ fontSize: '1.25rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                {generationModal.type === 'image' ? <ImageIcon size={20} /> : <Film size={20} />}
                Generate {generationModal.type === 'image' ? 'Image' : 'Video'} Variation for {shots.find(s => s.id === generationModal.shotId)?.name}
              </h2>
              <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setGenerationModal(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div style={{ alignSelf: 'flex-end' }}>
                <button
                  type="button"
                  className="btn btn-accent"
                  onClick={handleAutoGeneratePromptInModal}
                  disabled={loadingStates.modal_llm}
                >
                  {loadingStates.modal_llm ? <RefreshCw className="spinner" size={14} /> : <Sparkles size={14} />}
                  Auto-Prompt from Visual Description
                </button>
              </div>

              <div className="form-group">
                <label className="form-label">Visual Model Prompt</label>
                <textarea
                  className="input-field"
                  style={{ minHeight: '120px' }}
                  value={genModalPrompt}
                  onChange={(e) => {
                    setGenModalPrompt(e.target.value);
                    updateDraftPrompt(e.target.value);
                  }}
                  placeholder="Cinematic visual setup description..."
                />
              </div>

              {/* Asset tags — click to insert <Tag> into the prompt */}
              {assetLibrary.length > 0 && (
                <div className="form-group">
                  <label className="form-label">Insert Asset Tag (adds &lt;Tag&gt; + its reference image)</label>
                  <div className="snippet-chips-container">
                    {assetLibrary.map(asset => (
                      <button
                        key={asset.id}
                        type="button"
                        className="snippet-chip"
                        onClick={() => appendAssetTagToModalPrompt(asset.tag)}
                        title={asset.description || asset.name}
                      >
                        &lt;{asset.tag}&gt;
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Concatenate Prompt Snippets (Click to Add)</label>
                <div className="snippet-chips-container">
                  {promptSnippets.map(snip => (
                    <button
                      key={snip.id}
                      type="button"
                      className="snippet-chip"
                      onClick={() => appendSnippetToModalPrompt(snip.text)}
                    >
                      + {snip.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Exactly what the model will receive, after pre/post + tags */}
              {(() => {
                const preview = buildPrompt(
                  generationModal.type,
                  genModalPrompt,
                  genModalModel,
                  generationModal.type === 'image' ? genModalInputImages : (genModalImageInput ? [genModalImageInput] : [])
                );
                return (
                  <div className="form-group">
                    <label className="form-label">
                      Effective Prompt Sent to Model
                      <span style={{ marginLeft: '8px', fontWeight: 'normal', color: 'var(--text-dim)', fontSize: '0.75rem' }}>
                        {preview.prompt.length} chars · {preview.inputImagePaths.length}/{preview.capacity} reference image{preview.capacity === 1 ? '' : 's'}
                      </span>
                    </label>
                    <div style={{ background: 'rgba(0,0,0,0.28)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '10px', fontSize: '0.8rem', color: 'var(--text-muted)', whiteSpace: 'pre-wrap', maxHeight: '110px', overflowY: 'auto' }}>
                      {preview.prompt || <em style={{ color: 'var(--text-dim)' }}>Empty — nothing will be generated.</em>}
                    </div>

                    {preview.taggedAssets.length > 0 && (
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>Attaching:</span>
                        {preview.taggedAssets.map(asset => (
                          <span key={asset.id} style={{ fontSize: '0.72rem', background: 'rgba(16,185,129,0.15)', color: 'var(--success)', padding: '2px 8px', borderRadius: '10px' }}>
                            &lt;{asset.tag}&gt;{asset.primaryImage ? '' : ' (no image)'}
                          </span>
                        ))}
                      </div>
                    )}

                    {preview.missingTags.length > 0 && (
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px', alignItems: 'center' }}>
                        <AlertTriangle size={12} style={{ color: 'var(--accent)' }} />
                        <span style={{ fontSize: '0.72rem', color: 'var(--accent)' }}>
                          Undefined tag{preview.missingTags.length === 1 ? '' : 's'}: &lt;{preview.missingTags.join('&gt;, &lt;')}&gt; — add them in Assets or they go through as plain text.
                        </span>
                      </div>
                    )}

                    {preview.droppedImagePaths.length > 0 && (
                      <div style={{ fontSize: '0.72rem', color: 'var(--accent)', marginTop: '6px' }}>
                        {preview.droppedImagePaths.length} reference image{preview.droppedImagePaths.length === 1 ? '' : 's'} dropped — this model accepts at most {preview.capacity}.
                      </div>
                    )}
                  </div>
                );
              })()}

              <div className="control-grid">
                <div className="form-group">
                  <label className="form-label">Target Generation Model</label>
                  <select
                    className="select-field"
                    value={(generationModal.type === 'image' ? isKnownImageModel(genModalModel) : isKnownVideoModel(genModalModel)) ? genModalModel : 'custom'}
                    onChange={(e) => {
                      if (e.target.value === 'custom') {
                        setGenModalModel('');
                        return;
                      }
                      setGenModalModel(e.target.value);
                      if (generationModal.type === 'image') setImageModel(e.target.value);
                      else setVideoModel(e.target.value);
                    }}
                  >
                    <ModelOptions
                      models={generationModal.type === 'image' ? IMAGE_MODELS : VIDEO_MODELS}
                      unit={generationModal.type === 'image' ? 'img' : 'video'}
                    />
                    <option value="custom">Custom model path…</option>
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">{generationModal.type === 'image' ? 'Aspect Ratio' : 'Resolution / Sizing'}</label>
                  <select
                    className="select-field"
                    value={genModalRes}
                    onChange={(e) => setGenModalRes(e.target.value)}
                  >
                    {(generationModal.type === 'image' ? IMAGE_ASPECT_RATIOS : VIDEO_RESOLUTIONS).map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {!(generationModal.type === 'image' ? isKnownImageModel(genModalModel) : isKnownVideoModel(genModalModel)) && (
                <div className="form-group" style={{ marginTop: '10px' }}>
                  <label className="form-label">Custom Model Path</label>
                  <input
                    type="text"
                    className="input-field"
                    value={genModalModel}
                    onChange={(e) => {
                      setGenModalModel(e.target.value);
                      if (generationModal.type === 'image') setImageModel(e.target.value);
                      else setVideoModel(e.target.value);
                    }}
                    placeholder="e.g. fal-ai/flux-lora or higgsfield-ai/soul/standard"
                  />
                </div>
              )}

              {generationModal.type === 'image' && refImageCapacity('image', genModalModel) > 0 && (
                <div className="form-group">
                  <label className="form-label">Input Reference Images ({genModalInputImages.length}/{refImageCapacity('image', genModalModel)})</label>
                  <span className="input-help">Manually picked references. Images pulled in by &lt;Tag&gt;s are added automatically and take priority.</span>
                  <div className="generation-reference-grid">
                    {referenceImages.map(ref => {
                      const selected = genModalInputImages.includes(ref.path);
                      return (
                        <button
                          key={ref.id}
                          type="button"
                          className={`generation-reference-card ${selected ? 'selected' : ''}`}
                          onClick={() => setGenModalInputImages(prev => {
                            if (prev.includes(ref.path)) return prev.filter(path => path !== ref.path);
                            const capacity = refImageCapacity('image', genModalModel);
                            if (prev.length >= capacity) {
                              showToast(`This model accepts up to ${capacity} input image${capacity === 1 ? '' : 's'}.`, 'warning');
                              return prev;
                            }
                            return [...prev, ref.path];
                          })}
                          title={selected ? `Remove ${ref.name}` : `Add ${ref.name}`}
                        >
                          <img src={`${API_BASE}/${ref.path}`} alt={ref.name} />
                          {selected && <Check className="generation-reference-check" size={16} />}
                          <span>{ref.name}</span>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className="generation-reference-upload"
                      onClick={() => openProjectImageSelector('ref')}
                      style={{ border: '2px dashed var(--border-color)', background: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', color: 'var(--text-muted)' }}
                    >
                      <FolderOpen size={18} />
                      <span>Add from Project</span>
                    </button>
                  </div>
                </div>
              )}

              {generationModal.type === 'video' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '10px' }}>
                  <div className="form-group" style={{ maxWidth: '200px' }}>
                    <label className="form-label">Duration (seconds)</label>
                    <select
                      className="select-field"
                      value={genModalDuration}
                      onChange={(e) => setGenModalDuration(e.target.value)}
                    >
                      <option value="5">5 Seconds</option>
                      <option value="10">10 Seconds</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Input Context (Image-to-Video - Select Single)</label>
                    <span className="input-help" style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '8px' }}>
                      Choose an image to guide video generation, or click Add Reference to select a project asset. Leave unselected for Text-to-Video.
                    </span>
                    
                    <div className="generation-reference-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '8px', marginTop: '4px' }}>
                      {(() => {
                        const activeShot = shots.find(s => s.id === generationModal.shotId);
                        const shotVariations = [];
                        if (activeShot) {
                          (activeShot.imagePrompts || []).forEach(promptGroup => {
                            promptGroup.outputs.forEach(out => {
                              shotVariations.push({
                                id: out.id,
                                path: out.path,
                                name: out.name,
                                type: 'var'
                              });
                            });
                          });
                        }
                        
                        const allGridImages = [
                          ...referenceImages.map(r => ({ id: r.id, path: r.path, name: r.name, type: 'ref' })),
                          ...shotVariations
                        ];

                        return (
                          <>
                            {allGridImages.map(img => {
                              const isSelected = genModalImageInput === img.path;
                              return (
                                <button
                                  key={img.id}
                                  type="button"
                                  className={`generation-reference-card ${isSelected ? 'selected' : ''}`}
                                  onClick={() => setGenModalImageInput(isSelected ? '' : img.path)}
                                  style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--border-color)', borderRadius: '6px', overflow: 'hidden', padding: 0, height: '110px', background: 'rgba(255,255,255,0.02)' }}
                                  title={img.name}
                                >
                                  <div style={{ height: '70px', width: '100%', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                                    <img src={`${API_BASE}/${img.path}`} alt={img.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                                  </div>
                                  {isSelected && <Check className="generation-reference-check" size={14} style={{ position: 'absolute', top: '4px', right: '4px', background: 'var(--success)', color: '#fff', borderRadius: '50%', padding: '2px' }} />}
                                  <span style={{ fontSize: '0.65rem', padding: '4px', width: '90%', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', color: 'var(--text-muted)', textAlign: 'center' }}>
                                    <strong style={{ color: img.type === 'ref' ? 'var(--primary)' : 'var(--secondary)' }}>
                                      {img.type === 'ref' ? 'Ref' : 'Var'}
                                    </strong>: {img.name}
                                  </span>
                                </button>
                              );
                            })}
                          </>
                        );
                      })()}

                      <button
                        type="button"
                        className="generation-reference-upload"
                        onClick={() => openProjectImageSelector('ref')}
                        style={{ border: '2px dashed var(--border-color)', background: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', color: 'var(--text-muted)', height: '110px', borderRadius: '6px' }}
                      >
                        <FolderOpen size={16} />
                        <span style={{ fontSize: '0.65rem' }}>Add Reference</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setGenerationModal(null)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={handleTriggerGeneration}
              >
                <Sparkles size={16} /> Submit to Background Queue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- A1. FLOATING OVERLAY: PROJECTS --- */}
      {activeOverlay === 'projects' && (
        <div className="modal-overlay" onClick={() => setActiveOverlay(null)}>
          <div className="modal-window" style={{ maxWidth: '680px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><FolderOpen size={20} /> Projects</h2>
              <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setActiveOverlay(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="modal-body">
              {/* Current project */}
              <div className="glass-panel" style={{ padding: '16px', background: 'rgba(139,92,246,0.06)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Current Project</span>
                <strong style={{ fontSize: '1.15rem' }}>{project.name}</strong>
                <code style={{ fontSize: '0.75rem', color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                  {project.path || 'project_state.json (legacy loose file)'}
                </code>
                <span style={{ fontSize: '0.78rem', color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '5px', marginTop: '4px' }}>
                  <Check size={12} /> Autosaves continuously — no save button needed.
                </span>

                {project.isLegacy && (
                  <div style={{ fontSize: '0.78rem', color: 'var(--accent)', display: 'flex', alignItems: 'flex-start', gap: '5px', marginTop: '4px' }}>
                    <AlertTriangle size={12} style={{ marginTop: '3px', flexShrink: 0 }} />
                    <span>Not a real project file yet. Use <strong>Save As</strong> to turn this into a proper project folder you can reopen later.</span>
                  </div>
                )}

                {project.path && (
                  <button
                    className="btn btn-secondary"
                    style={{ alignSelf: 'flex-start', fontSize: '0.75rem', padding: '4px 10px', marginTop: '6px' }}
                    onClick={() => handleRevealInExplorer(project.path)}
                  >
                    <FolderOpen size={12} /> Show in Explorer
                  </button>
                )}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <button className="btn btn-primary" disabled={loadingStates.browse || loadingStates.project} onClick={() => setNewProjectDraft({ directory: '', name: '' })}>
                  <Plus size={14} /> New Project
                </button>
                <button className="btn btn-secondary" disabled={loadingStates.browse || loadingStates.project} onClick={() => handleOpenProject()}>
                  {loadingStates.browse ? <RefreshCw className="spinner" size={14} /> : <FolderOpen size={14} />} Open Project…
                </button>
                <button className="btn btn-secondary" disabled={loadingStates.browse || loadingStates.project} onClick={handleSaveProjectAs}>
                  <Save size={14} /> Save As…
                </button>
                <button className="btn btn-secondary" disabled={loadingStates.browse || loadingStates.project} onClick={handleImportAssetsFromProject}>
                  <Users size={14} /> Import Assets from Project…
                </button>
              </div>

              {/* New project inline form */}
              {newProjectDraft && (
                <div className="glass-panel" style={{ padding: '16px', background: 'rgba(128,128,128,0.04)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <h3 style={{ fontSize: '0.95rem' }}>New Project</h3>
                  <div className="form-group">
                    <label className="form-label">Parent Folder</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        type="text"
                        className="input-field"
                        style={{ flex: 1 }}
                        value={newProjectDraft.directory}
                        onChange={(e) => setNewProjectDraft({ ...newProjectDraft, directory: e.target.value })}
                        placeholder="C:\films"
                      />
                      <button
                        className="btn btn-secondary"
                        disabled={loadingStates.browse}
                        onClick={async () => {
                          const dir = await browseForPath('folder');
                          if (dir) setNewProjectDraft(prev => ({ ...prev, directory: dir }));
                        }}
                      >
                        {loadingStates.browse ? <RefreshCw className="spinner" size={14} /> : <FolderOpen size={14} />} Browse
                      </button>
                    </div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Project Name</label>
                    <input
                      type="text"
                      className="input-field"
                      value={newProjectDraft.name}
                      onChange={(e) => setNewProjectDraft({ ...newProjectDraft, name: e.target.value })}
                      placeholder="The Ash Lands"
                    />
                  </div>
                  {newProjectDraft.directory && newProjectDraft.name.trim() && (
                    <code style={{ fontSize: '0.75rem', color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                      Creates: {newProjectDraft.directory}\{newProjectDraft.name.trim()}\{newProjectDraft.name.trim()}.mmproj.json
                    </code>
                  )}
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                    <button className="btn btn-secondary" onClick={() => setNewProjectDraft(null)}>Cancel</button>
                    <button className="btn btn-primary" onClick={handleCreateProject} disabled={loadingStates.project}>
                      <Plus size={14} /> Create
                    </button>
                  </div>
                </div>
              )}

              {/* Recent */}
              <div className="glass-panel" style={{ padding: '16px', background: 'rgba(128,128,128,0.02)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <h3 style={{ fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '6px' }}><Clock size={16} /> Recent Projects</h3>
                {(project.recent || []).length === 0 ? (
                  <span style={{ fontSize: '0.82rem', color: 'var(--text-dim)' }}>Nothing yet. Create or open a project and it will show up here.</span>
                ) : (
                  project.recent.map(entry => {
                    const isActive = project.path && entry.path === project.path;
                    return (
                      <div
                        key={entry.path}
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-light)', background: isActive ? 'rgba(139,92,246,0.1)' : 'transparent' }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <strong style={{ fontSize: '0.88rem' }}>{entry.name}</strong>
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {entry.path}
                          </div>
                        </div>
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: '0.75rem', padding: '4px 10px', flexShrink: 0 }}
                          disabled={isActive || loadingStates.project}
                          onClick={() => handleOpenProject(entry.path)}
                        >
                          {isActive ? 'Open' : 'Switch'}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>

              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                A project is a folder: <code>MyFilm/MyFilm.mmproj.json</code> plus <code>MyFilm/assets/</code>.
                Zip it, move it, or drop it on a shared drive — the project re-anchors to wherever the file
                actually is, so media keeps resolving.
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setActiveOverlay(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* --- A2. FLOATING OVERLAY: ASSET LIBRARY (<Tag> targets) --- */}
      {activeOverlay === 'assets' && (
        <div className="modal-overlay" onClick={() => setActiveOverlay(null)}>
          <div className="modal-window gallery-modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Users size={20} /> Asset Library</h2>
              <div style={{ display: 'flex', gap: '12px' }}>
                {batchRunner ? (
                  <button className="btn btn-danger" onClick={handleCancelBatch}>
                    <StopCircle size={14} /> Stop ({batchRunner.done}/{batchRunner.total})
                  </button>
                ) : (
                  <button
                    className="btn btn-accent"
                    disabled={assetLibrary.length === 0}
                    onClick={() => setAssetBatchDialog({ onlyMissing: true, useLlm: true, rewriteExisting: false })}
                    title="Write prompts and generate references for every asset"
                  >
                    <Zap size={14} /> Batch Generate
                  </button>
                )}
                <button className="btn btn-primary" onClick={() => openAssetEditor()}>
                  <Plus size={14} /> New Asset
                </button>
                <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setActiveOverlay(null)}>
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="modal-body">
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '14px', lineHeight: 1.6 }}>
                Give a character, environment, prop or style a <strong>tag</strong>, then write that tag in angle
                brackets inside any prompt — e.g. <code style={{ color: 'var(--primary-hover)' }}>&lt;Ralph&gt; leans against the workbench</code>.
                At generation time the studio swaps in the asset's written description <em>and</em> uploads its
                reference image to any model that accepts image inputs, which is how a character stays consistent
                from shot to shot.
              </div>

              <div className="media-grid">
                {assetLibrary.map(asset => {
                  const usageCount = shots.filter(s => (
                    extractTags(s.draftImagePrompt).some(t => normalizeTag(t) === normalizeTag(asset.tag)) ||
                    extractTags(s.draftVideoPrompt).some(t => normalizeTag(t) === normalizeTag(asset.tag))
                  )).length;

                  return (
                    <div key={asset.id} className="media-card">
                      <div className="media-thumb-container" onDoubleClick={() => asset.primaryImage && handleImageDoubleClick(asset.primaryImage, asset.tag)}>
                        {loadingStates[`asset_gen_${asset.id}`] ? (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '8px', color: 'var(--primary-hover)', fontSize: '0.78rem' }}>
                            <RefreshCw className="spinner" size={20} />
                            Generating…
                          </div>
                        ) : asset.primaryImage ? (
                          <img src={`${API_BASE}/${asset.primaryImage}`} alt={asset.tag} />
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-dim)', fontSize: '0.78rem', textAlign: 'center', padding: '10px' }}>
                            No reference image — text substitution only
                          </div>
                        )}
                        <div className="media-badge">&lt;{asset.tag}&gt;</div>
                      </div>
                      <div className="media-info">
                        <strong style={{ fontSize: '0.88rem' }}>{asset.name}</strong>
                        <p className="media-prompt" title={asset.description}>
                          {ASSET_TYPES.find(t => t.id === asset.type)?.label || asset.type}
                          {asset.description ? ` — ${asset.description}` : ''}
                        </p>
                        <span style={{ fontSize: '0.7rem', color: (asset.images?.length || 0) === 0 ? 'var(--accent)' : 'var(--text-dim)' }}>
                          {(asset.images?.length || 0) === 0
                            ? 'No image yet — text only'
                            : `${asset.images.length} image${asset.images.length === 1 ? '' : 's'}`} · used in {usageCount} shot{usageCount === 1 ? '' : 's'}
                        </span>
                        <div className="media-actions" style={{ display: 'flex', gap: '6px', width: '100%', marginTop: '6px' }}>
                          <button className="btn btn-secondary" style={{ flex: 1, fontSize: '0.75rem', padding: '4px' }} onClick={() => openAssetEditor(asset)}>
                            <Edit2 size={12} /> Edit
                          </button>
                          <button className="btn btn-danger" style={{ padding: '4px 8px' }} onClick={() => handleDeleteAssetEntry(asset.id)}>
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {assetLibrary.length === 0 && (
                  <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: '40px 0', color: 'var(--text-dim)' }}>
                    No assets yet. Create one and tag it in your prompts.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- A2b. BATCH ASSET GENERATION DIALOG --- */}
      {assetBatchDialog && (() => {
        const candidates = assetBatchCandidates(assetBatchDialog.onlyMissing);
        const willWrite = assetBatchDialog.useLlm
          ? candidates.filter(a => assetBatchDialog.rewriteExisting || !a.imagePrompt?.trim()).length
          : 0;
        const withContext = candidates.filter(a => gatherAssetContext(a).length > 0).length;
        const model = getImageModel(imageModel);
        const unitPrice = model && typeof model.price === 'number' ? model.price : null;

        return (
          <div className="modal-overlay" onClick={() => setAssetBatchDialog(null)}>
            <div className="modal-window" style={{ maxWidth: '580px' }} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Zap size={20} /> Batch Generate Asset References</h2>
                <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setAssetBatchDialog(null)}>
                  <X size={16} />
                </button>
              </div>

              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">Which assets</label>
                  <select
                    className="select-field"
                    value={assetBatchDialog.onlyMissing ? 'missing' : 'all'}
                    onChange={(e) => setAssetBatchDialog({ ...assetBatchDialog, onlyMissing: e.target.value === 'missing' })}
                  >
                    <option value="missing">Only assets with no image yet ({assetBatchCandidates(true).length})</option>
                    <option value="all">Every asset ({assetLibrary.length}) — adds another variant to each</option>
                  </select>
                </div>

                <div className="form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.9rem' }}>
                    <input
                      type="checkbox"
                      checked={assetBatchDialog.useLlm}
                      onChange={(e) => setAssetBatchDialog({ ...assetBatchDialog, useLlm: e.target.checked })}
                    />
                    Write each prompt with the LLM first
                  </label>
                  <span className="input-help" style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                    Feeds the asset's description plus every script line that references it to {LLM_PROVIDERS.find(p => p.id === activeLlm)?.label || activeLlm},
                    which infers the visual specifics the script implies but never states. Off = use the auto-built template prompt.
                  </span>
                </div>

                {assetBatchDialog.useLlm && (
                  <div className="form-group" style={{ marginTop: '-6px', paddingLeft: '22px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                      <input
                        type="checkbox"
                        checked={assetBatchDialog.rewriteExisting}
                        onChange={(e) => setAssetBatchDialog({ ...assetBatchDialog, rewriteExisting: e.target.checked })}
                      />
                      Also rewrite prompts I've already written
                    </label>
                  </div>
                )}

                <div className="glass-panel" style={{ padding: '14px', background: 'rgba(139,92,246,0.06)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ fontSize: '0.95rem', fontWeight: 'bold' }}>
                    {candidates.length} asset{candidates.length === 1 ? '' : 's'}, one after the next
                  </div>
                  {assetBatchDialog.useLlm && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      {willWrite} LLM prompt{willWrite === 1 ? '' : 's'} to write · {withContext} of {candidates.length} have script references to draw on
                    </div>
                  )}
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Model: <strong>{model?.label || imageModel}</strong>
                    {model && priceLabel(model, 'img') ? ` — ${priceLabel(model, 'img')}` : ''}
                  </div>
                  {unitPrice !== null && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      Estimated image cost: <strong>${(unitPrice * candidates.length).toFixed(3)}</strong> plus LLM tokens
                    </div>
                  )}
                  {withContext < candidates.length && assetBatchDialog.useLlm && (
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)', display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
                      <AlertTriangle size={12} style={{ marginTop: '3px', flexShrink: 0 }} />
                      <span>{candidates.length - withContext} asset(s) aren't referenced by any shot — those get a thinner prompt from name and description alone.</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setAssetBatchDialog(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={handleRunAssetBatch} disabled={candidates.length === 0}>
                  <Zap size={14} /> Run ({candidates.length})
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* --- A3. ASSET EDITOR --- */}
      {assetEditor && (
        <div className="modal-overlay" onClick={() => setAssetEditor(null)}>
          <div className="modal-window" style={{ maxWidth: '620px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Users size={20} /> {assetEditor.id ? 'Edit Asset' : 'New Asset'}
              </h2>
              <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setAssetEditor(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div className="control-grid">
                <div className="form-group">
                  <label className="form-label">Tag (used as &lt;Tag&gt; in prompts)</label>
                  <input
                    type="text"
                    className="input-field"
                    value={assetEditor.tag}
                    onChange={(e) => setAssetEditor({ ...assetEditor, tag: e.target.value })}
                    placeholder="Ralph"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Type</label>
                  <select
                    className="select-field"
                    value={assetEditor.type}
                    onChange={(e) => setAssetEditor({ ...assetEditor, type: e.target.value })}
                  >
                    {ASSET_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Display Name</label>
                <input
                  type="text"
                  className="input-field"
                  value={assetEditor.name}
                  onChange={(e) => setAssetEditor({ ...assetEditor, name: e.target.value })}
                  placeholder="Ralph Mercer"
                />
              </div>

              <div className="form-group">
                <label className="form-label">Description (substituted into the prompt)</label>
                <textarea
                  className="input-field"
                  style={{ minHeight: '80px' }}
                  value={assetEditor.description}
                  onChange={(e) => setAssetEditor({ ...assetEditor, description: e.target.value })}
                  placeholder="grizzled mechanic in his 60s, oil-stained canvas overalls, close-cropped grey beard"
                />
                <span className="input-help" style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                  &lt;{assetEditor.tag || 'Tag'}&gt; becomes: "{[assetEditor.name, assetEditor.description].filter(Boolean).length ? `${assetEditor.name || assetEditor.tag}${assetEditor.description ? ` (${assetEditor.description})` : ''}` : '…'}"
                </span>
              </div>

              {/* Generate reference art — same iterate-and-pick loop as a shot */}
              {(() => {
                const modelId = assetEditor.imageModel || imageModel;
                const preview = buildAssetPrompt(assetEditor);
                const canUseRef = refImageCapacity('image', modelId) > 0 && Boolean(assetEditor.primaryImage);
                const busy = loadingStates[`asset_gen_${assetEditor.id}`];

                return (
                  <div className="glass-panel" style={{ padding: '16px', background: 'rgba(139,92,246,0.06)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <h3 style={{ fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <Sparkles size={16} /> Generate Reference Image
                      </h3>
                      <button
                        className="btn btn-accent"
                        style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                        onClick={handleAutoWriteAssetPrompt}
                        disabled={loadingStates.asset_llm}
                      >
                        {loadingStates.asset_llm ? <RefreshCw className="spinner" size={12} /> : <Sparkles size={12} />}
                        Write prompt with LLM
                      </button>
                    </div>

                    <div className="form-group">
                      <label className="form-label">Reference Prompt</label>
                      <textarea
                        className="input-field"
                        style={{ minHeight: '70px', fontSize: '0.85rem' }}
                        value={assetEditor.imagePrompt || ''}
                        onChange={(e) => setAssetEditor({ ...assetEditor, imagePrompt: e.target.value })}
                        placeholder={defaultAssetPrompt(assetEditor) || 'Describe the reference image to generate...'}
                      />
                      <span className="input-help" style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                        Leave blank to use the auto-built {assetEditor.type} reference prompt shown as placeholder.
                        You can tag other assets here, e.g. &lt;Garage&gt;.
                      </span>
                    </div>

                    <div className="control-grid">
                      <div className="form-group">
                        <label className="form-label">Model</label>
                        <select
                          className="select-field"
                          value={isKnownImageModel(modelId) ? modelId : 'custom'}
                          onChange={(e) => setAssetEditor({ ...assetEditor, imageModel: e.target.value === 'custom' ? '' : e.target.value })}
                        >
                          <ModelOptions models={IMAGE_MODELS} unit="img" />
                          <option value="custom">Custom model path…</option>
                        </select>
                      </div>
                      <div className="form-group">
                        <label className="form-label">Aspect Ratio</label>
                        <select
                          className="select-field"
                          value={assetEditor.imageResolution || imageResolution}
                          onChange={(e) => setAssetEditor({ ...assetEditor, imageResolution: e.target.value })}
                        >
                          {IMAGE_ASPECT_RATIOS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                        </select>
                      </div>
                    </div>

                    {!isKnownImageModel(modelId) && (
                      <div className="form-group">
                        <label className="form-label">Custom Model Path</label>
                        <input
                          type="text"
                          className="input-field"
                          value={assetEditor.imageModel || ''}
                          onChange={(e) => setAssetEditor({ ...assetEditor, imageModel: e.target.value })}
                          placeholder="e.g. higgsfield-ai/soul/standard"
                        />
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                        <input
                          type="checkbox"
                          checked={Boolean(assetEditor.applyGlobalPrompts)}
                          onChange={(e) => setAssetEditor({ ...assetEditor, applyGlobalPrompts: e.target.checked })}
                        />
                        Apply global pre/post prompt
                      </label>
                      {canUseRef && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                          <input
                            type="checkbox"
                            checked={Boolean(assetEditor.useExistingAsReference)}
                            onChange={(e) => setAssetEditor({ ...assetEditor, useExistingAsReference: e.target.checked })}
                          />
                          Use current image as reference (keep likeness)
                        </label>
                      )}
                    </div>

                    <div>
                      <label className="form-label" style={{ fontSize: '0.75rem' }}>
                        Effective Prompt
                        <span style={{ marginLeft: '8px', fontWeight: 'normal', color: 'var(--text-dim)' }}>
                          {preview.inputImagePaths.length}/{preview.capacity} reference image{preview.capacity === 1 ? '' : 's'}
                        </span>
                      </label>
                      <div style={{ background: 'rgba(0,0,0,0.28)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '9px', fontSize: '0.76rem', color: 'var(--text-muted)', whiteSpace: 'pre-wrap', maxHeight: '80px', overflowY: 'auto' }}>
                        {preview.prompt || <em style={{ color: 'var(--text-dim)' }}>Add a description or prompt above.</em>}
                      </div>
                      {preview.missingTags.length > 0 && (
                        <div style={{ fontSize: '0.72rem', color: 'var(--accent)', marginTop: '5px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <AlertTriangle size={11} /> Undefined tag(s): &lt;{preview.missingTags.join('&gt;, &lt;')}&gt;
                        </div>
                      )}
                    </div>

                    <button
                      className="btn btn-primary"
                      style={{ alignSelf: 'flex-start' }}
                      onClick={handleGenerateAssetImage}
                      disabled={busy || !preview.prompt}
                    >
                      {busy ? <><RefreshCw className="spinner" size={14} /> Generating…</> : <><Sparkles size={14} /> {(assetEditor.images || []).length > 0 ? 'Generate Another' : 'Generate'}</>}
                    </button>
                  </div>
                );
              })()}

              <div className="form-group">
                <label className="form-label">Reference Images ({(assetEditor.images || []).length})</label>
                <span className="input-help" style={{ fontSize: '0.75rem', color: 'var(--text-dim)', display: 'block', marginBottom: '8px' }}>
                  Click one to make it the primary — that's the image sent with &lt;{assetEditor.tag || 'Tag'}&gt;.
                  Models taking more than one input receive the rest in order. Double-click to view large.
                </span>
                <input type="file" accept="image/*" multiple ref={assetUploadRef} onChange={handleAssetImageUpload} style={{ display: 'none' }} />
                <div className="generation-reference-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '8px' }}>
                  {(assetEditor.images || []).map(imagePath => {
                    const isPrimary = assetEditor.primaryImage === imagePath;
                    return (
                      <div
                        key={imagePath}
                        className={`generation-reference-card ${isPrimary ? 'selected' : ''}`}
                        style={{ position: 'relative', height: '110px', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border-light)', cursor: 'pointer' }}
                        onClick={() => setAssetEditor({ ...assetEditor, primaryImage: imagePath })}
                        onDoubleClick={() => handleImageDoubleClick(imagePath, assetEditor.tag || 'asset')}
                        title={isPrimary ? 'Primary reference' : 'Click to make primary, double-click to enlarge'}
                      >
                        <img src={`${API_BASE}/${imagePath}`} alt="asset reference" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        {isPrimary && <Check size={14} style={{ position: 'absolute', top: '4px', left: '4px', background: 'var(--success)', color: '#fff', borderRadius: '50%', padding: '2px' }} />}
                        <button
                          className="btn btn-danger"
                          style={{ position: 'absolute', bottom: '4px', right: '4px', padding: '3px' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            const remaining = assetEditor.images.filter(p => p !== imagePath);
                            setAssetEditor({
                              ...assetEditor,
                              images: remaining,
                              primaryImage: isPrimary ? (remaining[0] || null) : assetEditor.primaryImage
                            });
                          }}
                        >
                          <X size={10} />
                        </button>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => assetUploadRef.current?.click()}
                    disabled={loadingStates.asset_upload}
                    style={{ border: '2px dashed var(--border-light)', background: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', color: 'var(--text-muted)', height: '110px', borderRadius: '6px' }}
                  >
                    {loadingStates.asset_upload ? <RefreshCw className="spinner" size={16} /> : <Upload size={16} />}
                    <span style={{ fontSize: '0.68rem' }}>Upload</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openProjectImageSelector('asset')}
                    style={{ border: '2px dashed var(--border-light)', background: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', color: 'var(--text-muted)', height: '110px', borderRadius: '6px' }}
                  >
                    <FolderOpen size={16} />
                    <span style={{ fontSize: '0.68rem' }}>From Project</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setAssetEditor(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveAsset}><Save size={14} /> Save Asset</button>
            </div>
          </div>
        </div>
      )}

      {/* --- A4. BATCH GENERATION DIALOG --- */}
      {batchDialog && (() => {
        const candidates = batchCandidates(batchDialog.type, batchDialog.scope, batchOnlyMissing);
        const allInScope = shotsForScope(batchDialog.scope);
        const noPrompt = allInScope.filter(({ shot }) => !resolveShotPrompt(shot, batchDialog.type).trim()).length;
        const model = batchDialog.type === 'image' ? getImageModel(imageModel) : getVideoModel(videoModel);
        const unitPrice = model && typeof model.price === 'number' ? model.price : null;

        return (
          <div className="modal-overlay" onClick={() => setBatchDialog(null)}>
            <div className="modal-window" style={{ maxWidth: '560px' }} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Zap size={20} /> Batch Generate {batchDialog.type === 'image' ? 'Images' : 'Videos'}
                </h2>
                <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setBatchDialog(null)}>
                  <X size={16} />
                </button>
              </div>

              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">Scope</label>
                  <select className="select-field" value={batchDialog.scope} onChange={(e) => setBatchDialog({ ...batchDialog, scope: e.target.value })}>
                    <option value="scene">Active scene — {scenes.find(s => s.id === activeSceneId)?.name}</option>
                    <option value="all">All scenes ({scenes.length})</option>
                  </select>
                </div>

                <div className="form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.9rem' }}>
                    <input type="checkbox" checked={batchOnlyMissing} onChange={(e) => setBatchOnlyMissing(e.target.checked)} />
                    Skip shots that already have output
                  </label>
                  <span className="input-help" style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                    Leave this on for the first sweep, turn it off to re-roll everything.
                  </span>
                </div>

                <div className="form-group" style={{ maxWidth: '220px' }}>
                  <label className="form-label">Parallel requests</label>
                  <select className="select-field" value={batchConcurrency} onChange={(e) => setBatchConcurrency(Number(e.target.value))}>
                    {[1, 2, 3, 5, 8].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <span className="input-help" style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                    Higher is faster but more likely to hit provider rate limits.
                  </span>
                </div>

                <div className="glass-panel" style={{ padding: '14px', background: 'rgba(139,92,246,0.06)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ fontSize: '0.95rem', fontWeight: 'bold' }}>
                    {candidates.length} shot{candidates.length === 1 ? '' : 's'} will be generated
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Model: <strong>{model?.label || (batchDialog.type === 'image' ? imageModel : videoModel)}</strong>
                    {model && priceLabel(model, batchDialog.type === 'image' ? 'img' : 'video') ? ` — ${priceLabel(model, batchDialog.type === 'image' ? 'img' : 'video')}` : ''}
                  </div>
                  {unitPrice !== null && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      Estimated cost: <strong>${(unitPrice * candidates.length).toFixed(3)}</strong> (before any per-shot model overrides)
                    </div>
                  )}
                  {noPrompt > 0 && (
                    <div style={{ fontSize: '0.78rem', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <AlertTriangle size={12} /> {noPrompt} shot{noPrompt === 1 ? '' : 's'} skipped — no prompt or description to work from.
                    </div>
                  )}
                  {batchDialog.type === 'video' && (
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                      Each video is driven by that shot's selected image when one is set, otherwise text-to-video.
                    </div>
                  )}
                </div>
              </div>

              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setBatchDialog(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={handleRunBatch} disabled={candidates.length === 0}>
                  <Zap size={14} /> Run Batch ({candidates.length})
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* --- A5. IMPORT REPORT --- */}
      {importReport && (
        <div className="modal-overlay" onClick={() => setImportReport(null)}>
          <div className="modal-window" style={{ maxWidth: '560px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><FileJson size={20} /> Shot List Imported</h2>
              <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setImportReport(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', marginBottom: '10px' }}>
                <div><strong style={{ fontSize: '1.4rem', color: 'var(--primary-hover)' }}>{importReport.sceneCount}</strong><div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>scenes</div></div>
                <div><strong style={{ fontSize: '1.4rem', color: 'var(--primary-hover)' }}>{importReport.shotCount}</strong><div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>shots</div></div>
                <div><strong style={{ fontSize: '1.4rem', color: 'var(--primary-hover)' }}>{importReport.assetCount}</strong><div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>assets</div></div>
                <div><strong style={{ fontSize: '1.4rem', color: 'var(--primary-hover)' }}>{importReport.mode}</strong><div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>mode</div></div>
              </div>

              {importReport.warnings.length > 0 ? (
                <div className="glass-panel" style={{ padding: '14px', background: 'rgba(244,63,94,0.07)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <strong style={{ fontSize: '0.9rem', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <AlertTriangle size={14} /> {importReport.warnings.length} warning{importReport.warnings.length === 1 ? '' : 's'}
                  </strong>
                  {importReport.warnings.map((warning, i) => (
                    <span key={i} style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>• {warning}</span>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: '0.88rem', color: 'var(--success)' }}>No warnings — everything resolved cleanly.</div>
              )}

              {importReport.assetCount > 0 && (
                <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '12px' }}>
                  Imported assets have descriptions but no images yet. Open <strong>Assets</strong> and upload a
                  reference image for each character so tagged prompts can carry it into generation.
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { setImportReport(null); setActiveOverlay('assets'); }}>Open Assets</button>
              <button className="btn btn-primary" onClick={() => setImportReport(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* --- B. FLOATING OVERLAY: IMAGES GALLERY --- */}
      {activeOverlay === 'images' && (() => {
        const activeShotForModal = shots.find(s => s.id === activeShotId);
        return (
          <div className="modal-overlay" onClick={() => setActiveOverlay(null)}>
            <div className="modal-window gallery-modal-window" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <ImageIcon size={20} /> Master Image Library Gallery {activeShotForModal ? `— Target: ${activeShotForModal.name}` : ''}
                </h2>
                <div style={{ display: 'flex', gap: '12px' }}>
                  <label className="btn btn-secondary" style={{ cursor: 'pointer', margin: 0 }}>
                    <Upload size={14} /> Upload Custom Image
                    <input type="file" accept="image/*" onChange={(e) => handleGalleryImageUpload(e, 'gallery')} style={{ display: 'none' }} />
                  </label>
                  <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setActiveOverlay(null)}>
                    <X size={16} />
                  </button>
                </div>
              </div>

              <div className="modal-body">
                <div className="media-grid">
                  {imageGallery.map((img) => (
                    <div key={img.id} className="media-card">
                      <div className="media-thumb-container" onDoubleClick={() => handleImageDoubleClick(img.path, img.name)}>
                        <img src={`${API_BASE}/${img.path}`} alt={img.name} />
                      </div>
                      <div className="media-info">
                        <input
                          type="text"
                          className="input-field"
                          style={{ padding: '2px 4px', fontSize: '0.8rem', background: 'none', border: 'none' }}
                          value={img.name}
                          onChange={(e) => handleRenameAsset('images', img.id, e.target.value)}
                        />
                        <p className="media-prompt" title={img.prompt}>{img.prompt}</p>
                        <div className="media-actions" style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%' }}>
                          <div style={{ display: 'flex', gap: '4px', width: '100%', alignItems: 'center' }}>
                            <select
                              className="select-field"
                              style={{ padding: '2px 4px', fontSize: '0.75rem', flex: 1, height: '24px' }}
                              defaultValue={activeShotId || (shots[0] && shots[0].id) || ''}
                              id={`apply-shot-image-${img.id}`}
                            >
                              {shots.map((s, idx) => (
                                <option key={s.id} value={s.id}>#{idx + 1} - {s.name || `Shot ${idx + 1}`}</option>
                              ))}
                            </select>
                            <button
                              className="btn btn-primary"
                              style={{ fontSize: '0.75rem', padding: '2px 8px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                              onClick={() => {
                                const targetShotId = document.getElementById(`apply-shot-image-${img.id}`).value;
                                if (targetShotId) {
                                  handleUpdateShotField(targetShotId, 'selectedImage', img.path);
                                  showToast(`Image applied to shot successfully.`, 'success');
                                  setActiveOverlay(null);
                                }
                              }}
                            >
                              Apply
                            </button>
                          </div>
                          <button
                            className="btn btn-danger"
                            style={{ padding: '4px', width: '100%', fontSize: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
                            onClick={() => handleDeleteAsset('images', img.id)}
                          >
                            <Trash2 size={12} /> Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                  {imageGallery.length === 0 && (
                    <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: '40px 0', color: 'var(--text-dim)' }}>No assets in library.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* --- C. FLOATING OVERLAY: VIDEOS GALLERY --- */}
      {activeOverlay === 'videos' && (() => {
        const activeShotForModal = shots.find(s => s.id === activeShotId);
        return (
          <div className="modal-overlay" onClick={() => setActiveOverlay(null)}>
            <div className="modal-window gallery-modal-window" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Film size={20} /> Master Video Library Gallery {activeShotForModal ? `— Target: ${activeShotForModal.name}` : ''}
                </h2>
                <div style={{ display: 'flex', gap: '12px' }}>
                  <label className="btn btn-secondary" style={{ cursor: 'pointer', margin: 0 }}>
                    <Upload size={14} /> Upload Custom Video
                    <input type="file" accept="video/*" onChange={handleGalleryVideoUpload} style={{ display: 'none' }} />
                  </label>
                  <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setActiveOverlay(null)}>
                    <X size={16} />
                  </button>
                </div>
              </div>

            <div className="modal-body">
              <div className="media-grid">
                {videoGallery.map((vid) => (
                  <div key={vid.id} className="media-card">
                    <div className="media-thumb-container">
                      <video src={`${API_BASE}/${vid.path}`} controls />
                    </div>
                    <div className="media-info">
                      <input
                        type="text"
                        className="input-field"
                        style={{ padding: '2px 4px', fontSize: '0.8rem', background: 'none', border: 'none' }}
                        value={vid.name}
                        onChange={(e) => handleRenameAsset('videos', vid.id, e.target.value)}
                      />
                      <p className="media-prompt" title={vid.prompt}>{vid.prompt}</p>
                      <div className="media-actions" style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%' }}>
                        <div style={{ display: 'flex', gap: '4px', width: '100%', alignItems: 'center' }}>
                          <select
                            className="select-field"
                            style={{ padding: '2px 4px', fontSize: '0.75rem', flex: 1, height: '24px' }}
                            defaultValue={activeShotId || (shots[0] && shots[0].id) || ''}
                            id={`apply-shot-video-${vid.id}`}
                          >
                            {shots.map((s, idx) => (
                              <option key={s.id} value={s.id}>#{idx + 1} - {s.name || `Shot ${idx + 1}`}</option>
                            ))}
                          </select>
                          <button
                            className="btn btn-primary"
                            style={{ fontSize: '0.75rem', padding: '2px 8px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            onClick={() => {
                              const targetShotId = document.getElementById(`apply-shot-video-${vid.id}`).value;
                              if (targetShotId) {
                                handleUpdateShotField(targetShotId, 'selectedVideo', vid.path);
                                showToast(`Video applied to shot successfully.`, 'success');
                                setActiveOverlay(null);
                              }
                            }}
                          >
                            Apply
                          </button>
                        </div>
                        <button
                          className="btn btn-danger"
                          style={{ padding: '4px', width: '100%', fontSize: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
                          onClick={() => handleDeleteAsset('videos', vid.id)}
                        >
                          <Trash2 size={12} /> Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                {videoGallery.length === 0 && (
                  <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: '40px 0', color: 'var(--text-dim)' }}>No assets in library.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      );
    })()}

      {/* --- D. FLOATING OVERLAY: REFERENCE IMAGERY --- */}
      {activeOverlay === 'reference' && (
        <div className="modal-overlay" onClick={() => setActiveOverlay(null)}>
          <div className="modal-window gallery-modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><FolderOpen size={20} /> Master Reference Imagery mood board</h2>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button
                  className="btn btn-secondary"
                  onClick={() => openProjectImageSelector('ref')}
                  disabled={loadingStates.project_images}
                >
                  <FolderOpen size={14} /> Add Reference from Project
                </button>
                <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setActiveOverlay(null)}>
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="modal-body">
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '10px' }}>
                {activeShotObj ? (
                  <span>Click reference cards below to associate/de-associate them with the active shot: <strong>{activeShotObj.name}</strong></span>
                ) : (
                  <span>Select a shot timeline row first to assign references.</span>
                )}
              </div>

              <div className="media-grid">
                {referenceImages.map((ref) => {
                  const isAssigned = activeShotObj?.referenceImages?.includes(ref.id);
                  return (
                    <div
                      key={ref.id}
                      className={`media-card ${isAssigned ? 'selected-select' : ''}`}
                      onClick={() => toggleRefImageMapping(ref.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <div className="media-thumb-container">
                        <img src={`${API_BASE}/${ref.path}`} alt={ref.name} />
                        {isAssigned && <div className="media-badge">Assigned</div>}
                      </div>
                      <div className="media-info">
                        <input
                          type="text"
                          className="input-field"
                          style={{ padding: '2px 4px', fontSize: '0.8rem', background: 'none', border: 'none' }}
                          value={ref.name}
                          onChange={(e) => handleRenameAsset('reference', ref.id, e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className="media-actions">
                          <button
                            className="btn btn-danger"
                            style={{ padding: '4px 8px', width: '100%' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteAsset('reference', ref.id);
                            }}
                          >
                            Delete Reference
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {projectImagesSelector && (
        <div className="modal-overlay" onClick={() => setProjectImagesSelector(null)}>
          <div className="modal-window" style={{ maxWidth: '600px', width: '90%', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><FolderOpen size={20} /> Select Image from Project Assets</h2>
              <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setProjectImagesSelector(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body" style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
                Select an image file from the project's <code>assets/</code> folder to associate as reference.
              </div>
              {projectImagesList.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
                  No images found in the <code>assets/</code> directory. Copy some image files there first.
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '12px' }}>
                  {projectImagesList.map((img) => (
                    <div
                      key={img.path}
                      className="media-card"
                      onClick={() => selectProjectImage(img)}
                      style={{ cursor: 'pointer', border: '1px solid var(--border-color)', borderRadius: '6px', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'rgba(255,255,255,0.02)' }}
                    >
                      <div className="media-thumb-container" style={{ height: '90px', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <img src={`${API_BASE}/${img.path}`} alt={img.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                      </div>
                      <div className="media-info" style={{ padding: '6px', fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }} title={img.name}>
                        {img.name}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* --- E. FLOATING OVERLAY: SNIPPETS MANAGER --- */}
      {activeOverlay === 'snippets' && (
        <div className="modal-overlay" onClick={() => setActiveOverlay(null)}>
          <div className="modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><MessageSquare size={20} /> Prompt Snippets Library</h2>
              <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setActiveOverlay(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div className="glass-panel" style={{ padding: '16px', background: 'rgba(128,128,128,0.05)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <h3 style={{ fontSize: '0.9rem' }}>Create Prompt Snippet Tag</h3>
                <div className="control-grid">
                  <div className="form-group">
                    <label className="form-label">Name Tag</label>
                    <input type="text" id="newSnipName" className="input-field" placeholder="e.g. Drone Pan" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Template Prompt Text</label>
                    <input type="text" id="newSnipText" className="input-field" placeholder="e.g. overhead cinematic drone camera panning left..." />
                  </div>
                </div>
                <button
                  className="btn btn-primary"
                  style={{ alignSelf: 'flex-end' }}
                  onClick={() => {
                    const name = document.getElementById('newSnipName').value;
                    const text = document.getElementById('newSnipText').value;
                    if (name && text) {
                      setPromptSnippets([...promptSnippets, { id: 'snip_' + Date.now(), name, text }]);
                      document.getElementById('newSnipName').value = '';
                      document.getElementById('newSnipText').value = '';
                      showToast('Snippet snippet added!');
                    }
                  }}
                >
                  Add Snippet Tag
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' }}>
                {promptSnippets.map(snip => (
                  <div key={snip.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(128,128,128,0.02)', padding: '10px 14px', borderRadius: '6px', border: '1px solid var(--border-light)' }}>
                    <div>
                      <strong style={{ color: 'var(--primary)' }}>[{snip.name}]</strong>
                      <span style={{ marginLeft: '10px', fontSize: '0.9rem', color: 'var(--text-muted)' }}>"{snip.text}"</span>
                    </div>
                    <button
                      className="btn btn-danger"
                      style={{ padding: '4px' }}
                      onClick={() => {
                        setPromptSnippets(promptSnippets.filter(s => s.id !== snip.id));
                        showToast('Snippet deleted.');
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- F. CONSOLIDATED SETTINGS & CREDENTIALS OVERLAY --- */}
      {activeOverlay === 'settings' && (
        <div className="modal-overlay" onClick={() => setActiveOverlay(null)}>
          <div className="modal-window" style={{ maxWidth: '600px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Settings size={20} /> System Studio Settings</h2>
              <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setActiveOverlay(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="modal-body">
              {/* API Credentials */}
              <div className="glass-panel" style={{ padding: '16px', background: 'rgba(128,128,128,0.02)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <h3 style={{ fontSize: '0.95rem', color: 'var(--primary-hover)', display: 'flex', alignItems: 'center', gap: '6px' }}><Settings size={16} /> API Key Setup</h3>
                
                <div className="form-group">
                  <label className="form-label">Google AI Studio Key (Gemini)</label>
                  <input
                    type="text"
                    className="input-field"
                    value={apiKeys.geminiKey || ''}
                    onChange={(e) => setApiKeys({ ...apiKeys, geminiKey: e.target.value })}
                    placeholder="AIzaSy..."
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">OpenAI API Key (ChatGPT / DALL-E)</label>
                  <input
                    type="text"
                    className="input-field"
                    value={apiKeys.openaiKey || ''}
                    onChange={(e) => setApiKeys({ ...apiKeys, openaiKey: e.target.value })}
                    placeholder="sk-proj-..."
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Anthropic API Key (Claude)</label>
                  <input
                    type="text"
                    className="input-field"
                    value={apiKeys.claudeKey || ''}
                    onChange={(e) => setApiKeys({ ...apiKeys, claudeKey: e.target.value })}
                    placeholder="sk-ant-..."
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Fal.ai API Key (Nano Banana / Wav2Lip)</label>
                  <input
                    type="text"
                    className="input-field"
                    value={apiKeys.falKey || ''}
                    onChange={(e) => setApiKeys({ ...apiKeys, falKey: e.target.value })}
                    placeholder="fal-key-..."
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Runway API Key (Gen-3)</label>
                  <input
                    type="text"
                    className="input-field"
                    value={apiKeys.runwayKey || ''}
                    onChange={(e) => setApiKeys({ ...apiKeys, runwayKey: e.target.value })}
                    placeholder="rwy-..."
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Kling AI API Key</label>
                  <input
                    type="text"
                    className="input-field"
                    value={apiKeys.klingKey || ''}
                    onChange={(e) => setApiKeys({ ...apiKeys, klingKey: e.target.value })}
                    placeholder="Kling Dev Key..."
                  />
                </div>

                <div className="control-grid">
                  <div className="form-group">
                    <label className="form-label">Higgsfield API Key</label>
                    <input
                      type="text"
                      className="input-field"
                      value={apiKeys.higgsfieldKey || ''}
                      onChange={(e) => setApiKeys({ ...apiKeys, higgsfieldKey: e.target.value })}
                      placeholder="from cloud.higgsfield.ai"
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Higgsfield API Secret</label>
                    <input
                      type="text"
                      className="input-field"
                      value={apiKeys.higgsfieldSecret || ''}
                      onChange={(e) => setApiKeys({ ...apiKeys, higgsfieldSecret: e.target.value })}
                      placeholder="paired secret"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Local Working Folder Path (Optional - Shared Drive)</label>
                  <input
                    type="text"
                    className="input-field"
                    value={apiKeys.workingFolder || ''}
                    onChange={(e) => setApiKeys({ ...apiKeys, workingFolder: e.target.value })}
                    placeholder="e.g. X:\SharedFolder or C:\SharedProjects"
                  />
                  <small style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginTop: '2px', display: 'block' }}>
                    If specified and exists, project assets and states will save to/load from this folder.
                  </small>
                </div>

                <button className="btn btn-primary" onClick={() => saveConfig(apiKeys)} style={{ alignSelf: 'flex-end', marginTop: '6px' }}>
                  <Save size={14} /> Save Credentials & Settings
                </button>
              </div>

              {/* JSON I/O Import/Export */}
              <div className="glass-panel" style={{ padding: '16px', background: 'rgba(128,128,128,0.02)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <h3 style={{ fontSize: '0.95rem', color: 'var(--secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}><FileJson size={16} /> Workspace File Sharing</h3>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Backup or share work relative to the project root directory.</span>
                <div style={{ display: 'flex', gap: '12px' }}>
                  <label className="btn btn-secondary" style={{ cursor: 'pointer', flex: 1 }}>
                    <FileJson size={14} /> Import State JSON
                    <input type="file" accept=".json" onChange={handleImportState} style={{ display: 'none' }} />
                  </label>
                  <button className="btn btn-secondary" style={{ flex: 1 }} onClick={handleExportState}>
                    <Download size={14} /> Export State JSON
                  </button>
                </div>
              </div>

              {/* System Defaults */}
              <div className="glass-panel" style={{ padding: '16px', background: 'rgba(128,128,128,0.02)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <h3 style={{ fontSize: '0.95rem', color: 'var(--primary-hover)' }}>Default Model Options</h3>
                <div className="control-grid">
                  <div className="form-group">
                    <label className="form-label">LLM Writer Engine</label>
                    <select className="select-field" value={activeLlm} onChange={(e) => setActiveLlm(e.target.value)}>
                      {LLM_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Specific LLM Model</label>
                    <select className="select-field" value={llmModel} onChange={(e) => setLlmModel(e.target.value)}>
                      {llmModelsList.map(m => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="control-grid" style={{ marginTop: '8px' }}>
                  <div className="form-group">
                    <label className="form-label">Default Image Model</label>
                    <select
                      className="select-field"
                      value={isKnownImageModel(imageModel) ? imageModel : 'custom'}
                      onChange={(e) => setImageModel(e.target.value === 'custom' ? '' : e.target.value)}
                    >
                      <ModelOptions models={IMAGE_MODELS} unit="img" />
                      <option value="custom">Custom model path…</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Default Image Aspect Ratio</label>
                    <select className="select-field" value={imageResolution} onChange={(e) => setImageResolution(e.target.value)}>
                      {IMAGE_ASPECT_RATIOS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                  </div>
                </div>
                {!isKnownImageModel(imageModel) && (
                  <div className="form-group" style={{ marginTop: '4px' }}>
                    <label className="form-label">Custom Default Image Model ID</label>
                    <input
                      type="text"
                      className="input-field"
                      value={imageModel}
                      onChange={(e) => setImageModel(e.target.value)}
                      placeholder="e.g. fal-ai/flux-lora"
                    />
                  </div>
                )}

                <div className="control-grid" style={{ marginTop: '8px' }}>
                  <div className="form-group">
                    <label className="form-label">Default Video Model</label>
                    <select
                      className="select-field"
                      value={isKnownVideoModel(videoModel) ? videoModel : 'custom'}
                      onChange={(e) => setVideoModel(e.target.value === 'custom' ? '' : e.target.value)}
                    >
                      <ModelOptions models={VIDEO_MODELS} unit="video" />
                      <option value="custom">Custom model path…</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Default Video Resolution</label>
                    <select className="select-field" value={videoResolution} onChange={(e) => setVideoResolution(e.target.value)}>
                      {VIDEO_RESOLUTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                  </div>
                </div>
                {!isKnownVideoModel(videoModel) && (
                  <div className="form-group" style={{ marginTop: '4px' }}>
                    <label className="form-label">Custom Default Video Model ID</label>
                    <input
                      type="text"
                      className="input-field"
                      value={videoModel}
                      onChange={(e) => setVideoModel(e.target.value)}
                      placeholder="e.g. higgsfield-ai/dop/standard"
                    />
                  </div>
                )}

                <div className="form-group" style={{ maxWidth: '220px', marginTop: '8px' }}>
                  <label className="form-label">Default Video Duration</label>
                  <select className="select-field" value={videoDuration} onChange={(e) => setVideoDuration(e.target.value)}>
                    <option value="5">5 Seconds</option>
                    <option value="10">10 Seconds</option>
                  </select>
                </div>
              </div>

              {/* Global Pre/Post Prompts */}
              <div className="glass-panel" style={{ padding: '16px', background: 'rgba(128,128,128,0.02)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <h3 style={{ fontSize: '0.95rem', color: 'var(--primary-hover)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Layers size={16} /> Global Pre / Post Prompts
                </h3>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  Wrapped around every prompt at generation time — put film stock, lens and grade language here
                  instead of repeating it in each shot. The generation modal shows the combined result before you submit.
                </span>

                <div className="control-grid">
                  <div className="form-group">
                    <label className="form-label">Image Pre-Prompt</label>
                    <textarea
                      className="input-field"
                      style={{ minHeight: '60px', fontSize: '0.85rem' }}
                      value={prePrompt}
                      onChange={(e) => setPrePrompt(e.target.value)}
                      placeholder="cinematic film still, shot on 35mm anamorphic,"
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Image Post-Prompt</label>
                    <textarea
                      className="input-field"
                      style={{ minHeight: '60px', fontSize: '0.85rem' }}
                      value={postPrompt}
                      onChange={(e) => setPostPrompt(e.target.value)}
                      placeholder=", volumetric lighting, ultra detailed, 8k"
                    />
                  </div>
                </div>

                <div className="control-grid">
                  <div className="form-group">
                    <label className="form-label">Video Pre-Prompt</label>
                    <textarea
                      className="input-field"
                      style={{ minHeight: '60px', fontSize: '0.85rem' }}
                      value={videoPrePrompt}
                      onChange={(e) => setVideoPrePrompt(e.target.value)}
                      placeholder="Leave blank to reuse nothing"
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Video Post-Prompt</label>
                    <textarea
                      className="input-field"
                      style={{ minHeight: '60px', fontSize: '0.85rem' }}
                      value={videoPostPrompt}
                      onChange={(e) => setVideoPostPrompt(e.target.value)}
                      placeholder=", smooth cinematic camera motion"
                    />
                  </div>
                </div>
              </div>

              {/* LLM Prompts Config */}
              <div className="glass-panel" style={{ padding: '16px', background: 'rgba(128,128,128,0.02)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <h3 style={{ fontSize: '0.95rem', color: 'var(--secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}><MessageSquare size={16} /> LLM Prompt Engineering Settings</h3>
                
                <div className="form-group">
                  <label className="form-label">LLM Image Prompt Generator (System Instruction)</label>
                  <textarea
                    className="input-field"
                    style={{ minHeight: '80px', fontSize: '0.85rem' }}
                    value={imageSystemPrompt}
                    onChange={(e) => setImageSystemPrompt(e.target.value)}
                    placeholder="System prompt instructions..."
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">LLM Video Prompt Generator (System Instruction)</label>
                  <textarea
                    className="input-field"
                    style={{ minHeight: '80px', fontSize: '0.85rem' }}
                    value={videoSystemPrompt}
                    onChange={(e) => setVideoSystemPrompt(e.target.value)}
                    placeholder="System prompt instructions..."
                  />
                </div>
              </div>
            </div>
            
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setActiveOverlay(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* --- I. HELP & LLM IMPORT GUIDE OVERLAY --- */}
      {activeOverlay === 'help' && (
        <div className="modal-overlay" onClick={() => setActiveOverlay(null)}>
          <div className="modal-window" style={{ maxWidth: '750px', width: '90%' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><HelpCircle size={20} /> Help & Import Guide</h2>
              <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setActiveOverlay(null)}>
                <X size={16} />
              </button>
            </div>
            
            <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div className="glass-panel" style={{ padding: '16px', background: 'rgba(255, 255, 255, 0.02)' }}>
                <h3 style={{ color: 'var(--primary-hover)', marginBottom: '8px', fontSize: '1rem' }}>General Guide</h3>
                <ul style={{ listStyle: 'disc', paddingLeft: '20px', fontSize: '0.88rem', lineHeight: '1.5', display: 'flex', flexDirection: 'column', gap: '8px', color: 'var(--text-muted)' }}>
                  <li><strong>Scenes & Shots:</strong> Organize your screenplay timeline by scenes. Click "Add Scene" to create tab groups, rename them directly, and append shots inside scenes.</li>
                  <li><strong>Concatenation:</strong> Use "Compile Scene Video" to merge shots within the active scene, or click "Concatenate Video" in the header to stitch all scenes and shots chronologically.</li>
                  <li><strong>Generation Dropdowns:</strong> Click "+ Add Iteration" inside a shot's image or video library section. If you modify settings (resolution, prompts, duration), a new dropdown entry will be created.</li>
                  <li><strong>Image Cropper:</strong> Double-click any image iteration output card to view the overlay. Check "Crop Image" to crop with custom aspect ratio float values, and save to output new crops.</li>
                </ul>
              </div>

              <div className="glass-panel" style={{ padding: '16px', background: 'rgba(255, 255, 255, 0.02)' }}>
                <h3 style={{ color: 'var(--accent)', marginBottom: '8px', fontSize: '1rem' }}>Asset Tags</h3>
                <ul style={{ listStyle: 'disc', paddingLeft: '20px', fontSize: '0.88rem', lineHeight: '1.6', display: 'flex', flexDirection: 'column', gap: '8px', color: 'var(--text-muted)' }}>
                  <li>Open <strong>Assets</strong> and create a character, environment, prop or style with a short tag such as <code style={{ color: 'var(--primary-hover)' }}>Ralph</code>.</li>
                  <li>Write <code style={{ color: 'var(--primary-hover)' }}>&lt;Ralph&gt;</code> anywhere in an image or video prompt.</li>
                  <li>On generation the tag is replaced by the asset's name and description, and its reference image is uploaded with the request for any model that accepts image inputs — the generation modal shows exactly what will be sent.</li>
                  <li>Models differ in how many inputs they take; extra reference images are dropped and the modal tells you when that happens.</li>
                </ul>
              </div>

              <div className="glass-panel" style={{ padding: '16px', background: 'rgba(255, 255, 255, 0.02)' }}>
                <h3 style={{ color: 'var(--accent)', marginBottom: '8px', fontSize: '1rem' }}>Shot List Import via LLM</h3>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: 1.6 }}>
                  Paste your script or treatment below, hit <strong>Copy LLM Prompt</strong>, and give the result to
                  any chat model. It returns a JSON document covering scenes, shots, prompts, assets, global
                  pre/post prompts, system prompts and model choices — import it with <strong>Import Shot List</strong>.
                  The prompt is generated from this project's live model catalog and existing asset tags.
                </p>

                <div className="form-group" style={{ marginBottom: '12px' }}>
                  <label className="form-label">Source material (optional — embedded into the prompt)</label>
                  <textarea
                    className="input-field"
                    style={{ minHeight: '120px', fontSize: '0.82rem' }}
                    value={llmPromptSource}
                    onChange={(e) => setLlmPromptSource(e.target.value)}
                    placeholder="Paste your screenplay, treatment or rough shot list here..."
                  />
                </div>

                <textarea
                  readOnly
                  className="input-field"
                  style={{ fontFamily: 'monospace', fontSize: '0.72rem', minHeight: '220px', width: '100%', background: 'rgba(0,0,0,0.3)', color: '#a8ffb2' }}
                  value={buildLlmImportPrompt({ assetLibrary, sourceMaterial: llmPromptSource })}
                />

                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '10px' }}>
                  <button className="btn btn-primary" onClick={handleCopyLlmPrompt}>
                    <Copy size={14} /> Copy LLM Prompt
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => { shotListInputRef.current.dataset.mode = 'replace'; shotListInputRef.current.click(); }}
                  >
                    <Upload size={14} /> Import Shot List
                  </button>
                </div>
              </div>

              <div className="glass-panel" style={{ padding: '16px', background: 'rgba(255, 255, 255, 0.02)' }}>
                <h3 style={{ color: 'var(--accent)', marginBottom: '8px', fontSize: '1rem' }}>Batch Generation</h3>
                <ul style={{ listStyle: 'disc', paddingLeft: '20px', fontSize: '0.88rem', lineHeight: '1.6', display: 'flex', flexDirection: 'column', gap: '8px', color: 'var(--text-muted)' }}>
                  <li>The batch bar above the timeline runs images or videos across the active scene or every scene.</li>
                  <li>Each shot uses its own prompt draft, falling back to its last generated prompt, then to its scene action description.</li>
                  <li><strong>Skip shots that already have output</strong> is on by default, so you can sweep everything, hand-regenerate the misses, and sweep again without paying twice.</li>
                  <li>Batch videos are driven by each shot's selected image where one exists, otherwise text-to-video.</li>
                  <li>Watch progress in the Batch Manager; <strong>Stop</strong> halts new dispatches and lets in-flight jobs land.</li>
                </ul>
              </div>
            </div>
            
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setActiveOverlay(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* --- J. VIEW PROMPT TEXT OVERLAY MODAL --- */}
      {viewingPromptText && (
        <div className="modal-overlay" onClick={() => setViewingPromptText(null)}>
          <div className="modal-window" style={{ maxWidth: '600px', width: '95%' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>View {viewingPromptText.type} Generation Prompt</h2>
              <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setViewingPromptText(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label className="form-label" style={{ fontWeight: 'bold' }}>Prompt Text</label>
                <div style={{ background: 'rgba(0,0,0,0.3)', padding: '12px', borderRadius: '6px', fontSize: '0.9rem', color: '#fff', border: '1px solid var(--border-light)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '200px', overflowY: 'auto', userSelect: 'text' }}>
                  {viewingPromptText.prompt}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label className="form-label" style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Model / Provider</label>
                  <div style={{ fontSize: '0.85rem', color: '#fff' }}>{viewingPromptText.model}</div>
                </div>
                <div>
                  <label className="form-label" style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Resolution</label>
                  <div style={{ fontSize: '0.85rem', color: '#fff' }}>{viewingPromptText.resolution}</div>
                </div>
              </div>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                className="btn btn-primary"
                onClick={() => {
                  navigator.clipboard.writeText(viewingPromptText.prompt);
                  showToast('Prompt copied to clipboard!', 'success');
                }}
              >
                Copy Prompt
              </button>
              <button className="btn btn-secondary" onClick={() => setViewingPromptText(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- G. FLOATING OVERLAY: BATCH MANAGER QUEUE --- */}
      {activeOverlay === 'batch' && (
        <div className="modal-overlay" onClick={() => setActiveOverlay(null)}>
          <div className="modal-window" style={{ maxWidth: '700px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Clock size={20} /> Background Batch Job Manager</h2>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button className="btn btn-secondary" onClick={handleClearBatchLog}>Clear Finished History</button>
                <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setActiveOverlay(null)}>
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="modal-body">
              <div className="batch-list-container">
                {batchJobs.map(job => (
                  <div key={job.id} className="batch-job-card">
                    <div className="batch-job-info">
                      <div className="batch-job-header">
                        <span style={{ fontWeight: 'bold' }}>{job.shotName}</span>
                        <span className={`batch-job-badge ${job.status}`}>
                          {job.status === 'running' ? 'In Progress' : job.status}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                          {job.type === 'image' ? 'Image Prompt' : 'Video Prompt'}
                        </span>
                      </div>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', display: 'block', maxWidth: '450px', whiteSpace: 'nowrap', overflow: 'hidden', textSlice: 'ellipsis' }}>
                        "{job.prompt}"
                      </span>
                      {job.error && (
                        <span style={{ fontSize: '0.75rem', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <AlertTriangle size={12} /> {job.error}
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      {job.status === 'running' && <RefreshCw className="spinner" size={16} style={{ color: 'var(--primary)' }} />}
                      {job.status === 'completed' && <Check size={20} style={{ color: 'var(--success)' }} />}
                      {job.status === 'failed' && <X size={20} style={{ color: 'var(--accent)' }} />}
                    </div>
                  </div>
                ))}
                {batchJobs.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-dim)' }}>
                    No background batch jobs submitted yet.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- H. DOUBLE-CLICK PREVIEW LARGE ZOOM OVERLAY --- */}
      {zoomImage && (() => {
        const imgAspect = imgNaturalSize.width / imgNaturalSize.height;
        const targetAspect = cropAspectWidth / cropAspectHeight;
        const maxCropWidthPercent = Math.min(100, 100 * (targetAspect / imgAspect));
        const activeCropW = Math.min(cropWidthPercent, maxCropWidthPercent);
        const activeCropH = activeCropW * (imgAspect / targetAspect);

        const maxCropX = 100 - activeCropW;
        const maxCropY = 100 - activeCropH;
        const constrainedX = Math.max(0, Math.min(cropX, maxCropX));
        const constrainedY = Math.max(0, Math.min(cropY, maxCropY));

        return (
          <div className="zoom-modal" onWheel={isCropping ? undefined : handleWheelZoom}>
            <div className="zoom-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
              <span style={{ fontWeight: 'bold' }}>
                {isCropping ? `Cropping: ${zoomImage.name}` : `Zooming Viewport: ${zoomImage.name}`}
              </span>
              
              {isCropping ? (
                <div className="zoom-controls" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  {/* Presets */}
                  <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '0.8rem' }} onClick={() => { setCropAspectWidth(16); setCropAspectHeight(9); }}>
                    16:9 Preset
                  </button>
                  <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '0.8rem' }} onClick={() => { setCropAspectWidth(9); setCropAspectHeight(16); }}>
                    9:16 Preset
                  </button>
                  
                  {/* Aspect Float Inputs */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(255,255,255,0.05)', padding: '4px 8px', borderRadius: '4px' }}>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Aspect:</span>
                    <input
                      type="number"
                      step="any"
                      value={cropAspectWidth}
                      onChange={(e) => setCropAspectWidth(parseFloat(e.target.value) || 1)}
                      style={{ width: '55px', padding: '2px 4px', fontSize: '0.8rem', background: '#000', border: '1px solid var(--border-light)', color: '#fff', borderRadius: '4px', textAlign: 'center' }}
                    />
                    <span style={{ color: 'var(--text-dim)' }}>:</span>
                    <input
                      type="number"
                      step="any"
                      value={cropAspectHeight}
                      onChange={(e) => setCropAspectHeight(parseFloat(e.target.value) || 1)}
                      style={{ width: '55px', padding: '2px 4px', fontSize: '0.8rem', background: '#000', border: '1px solid var(--border-light)', color: '#fff', borderRadius: '4px', textAlign: 'center' }}
                    />
                  </div>

                  {/* Size Slider */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(255,255,255,0.05)', padding: '4px 8px', borderRadius: '4px' }}>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Crop Scale:</span>
                    <input
                      type="range"
                      min="10"
                      max="100"
                      value={cropWidthPercent}
                      onChange={(e) => setCropWidthPercent(parseInt(e.target.value) || 50)}
                      style={{ width: '90px', cursor: 'pointer' }}
                    />
                    <span style={{ fontSize: '0.78rem', color: '#fff', minWidth: '32px', textAlign: 'right' }}>{cropWidthPercent}%</span>
                  </div>

                  <button className="btn btn-primary" style={{ padding: '6px 12px' }} onClick={handleExecuteCrop}>
                    Save Crop
                  </button>
                  <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={() => setIsCropping(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="zoom-controls">
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      setIsCropping(true);
                      setCropX(15);
                      setCropY(15);
                      setCropWidthPercent(70);
                    }}
                  >
                    Crop Image...
                  </button>
                  <button className="btn btn-secondary" style={{ padding: '6px' }} onClick={() => handleZoom('in')}>
                    <Maximize2 size={16} /> Zoom In
                  </button>
                  <button className="btn btn-secondary" style={{ padding: '6px' }} onClick={() => handleZoom('out')}>
                    <Minimize2 size={16} /> Zoom Out
                  </button>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '0 8px' }}>
                    {Math.round(zoomScale * 100)}%
                  </span>
                  <button className="btn btn-accent" onClick={() => handleRevealInExplorer(zoomImage.path)}>
                    <FolderOpen size={14} /> Show in File Explorer
                  </button>
                  <button className="btn btn-danger" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => {
                    setZoomImage(null);
                    setIsCropping(false);
                  }}>
                    <X size={16} />
                  </button>
                </div>
              )}
            </div>

            {isCropping ? (
              <div
                className="zoom-viewport"
                style={{ cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseMove={(e) => {
                  if (!isDraggingCrop) return;
                  const rect = cropImgRef.current.getBoundingClientRect();
                  const deltaXPercent = (e.clientX - cropDragStart.x) / rect.width * 100;
                  const deltaYPercent = (e.clientY - cropDragStart.y) / rect.height * 100;
                  setCropX(cropDragStart.initialX + deltaXPercent);
                  setCropY(cropDragStart.initialY + deltaYPercent);
                }}
                onMouseUp={() => setIsDraggingCrop(false)}
                onMouseLeave={() => setIsDraggingCrop(false)}
              >
                <div
                  className="crop-container"
                  style={{
                    position: 'relative',
                    display: 'inline-block',
                    maxWidth: '90%',
                    maxHeight: '75vh',
                    background: '#111',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
                    border: '1px solid var(--border-light)'
                  }}
                >
                  <img
                    ref={cropImgRef}
                    src={`${API_BASE}/${zoomImage.path}`}
                    alt="to crop"
                    onLoad={(e) => {
                      setImgNaturalSize({ width: e.target.naturalWidth, height: e.target.naturalHeight });
                    }}
                    style={{
                      display: 'block',
                      maxWidth: '100%',
                      maxHeight: '75vh',
                      pointerEvents: 'none',
                      userSelect: 'none'
                    }}
                  />
                  
                  {/* Highlighted Crop Area Box */}
                  <div
                    style={{
                      position: 'absolute',
                      top: `${constrainedY}%`,
                      left: `${constrainedX}%`,
                      width: `${activeCropW}%`,
                      height: `${activeCropH}%`,
                      border: '2px dashed var(--primary)',
                      boxShadow: '0 0 0 9999px rgba(0,0,0,0.65)',
                      cursor: 'move',
                      boxSizing: 'border-box'
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setIsDraggingCrop(true);
                      setCropDragStart({
                        x: e.clientX,
                        y: e.clientY,
                        initialX: constrainedX,
                        initialY: constrainedY
                      });
                    }}
                  />
                </div>
              </div>
            ) : (
              <div
                className="zoom-viewport"
                onMouseDown={handleDragStart}
                onMouseMove={handleDragMove}
                onMouseUp={handleDragEnd}
                onMouseLeave={handleDragEnd}
              >
                <img
                  src={`${API_BASE}/${zoomImage.path}`}
                  className="zoom-image"
                  style={{
                    transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomScale})`
                  }}
                  alt={zoomImage.name}
                  draggable="false"
                />
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
