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
  Upload,
  Check,
  FolderOpen,
  Edit2,
  Music,
  RefreshCw,
  MessageSquare,
  Save,
  X,
  FileJson,
  Maximize2,
  Minimize2,
  Clock,
  AlertTriangle,
  GripVertical,
  HelpCircle,
  Users,
  Layers,
  Copy,
  Zap,
  StopCircle,
  LayoutGrid,
  Scissors,
  RotateCcw
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
  assetInputImages,
  composeGenerationPrompt,
  defaultAssetPrompt,
  extractTags,
  findAssetByTag,
  normalizeTag
} from './promptTags.js';
import { buildLlmImportPrompt, normalizeImportedShotList } from './shotListImport.js';
import { apiFetch, resolveAssetUrl, detectMode, isStatic } from './client.js';
import { createEmptyEdit, migrateEdit } from './edit/model.js';
import EditView from './edit/EditView.jsx';
import { AssetImage, AssetVideo, useAssetUrl } from './AssetMedia.jsx';
import * as projectFs from './static/fileSystem.js';
import {
  compactPromptSettings,
  fillTemplate,
  migratePromptSettings,
  promptNumber,
  promptText
} from './prompts.js';
import {
  REFERENCE_SCHEMA_VERSION,
  assignReferences,
  enabledReferencePaths,
  migrateReferenceState,
  normalizeReference,
  pruneAssignments,
  resolveSceneReferences,
  resolveShotReferences,
  setEdgeEnabled,
  unassignReferences
} from './references.js';
import ReferencePanel, { ReferenceStrip } from './ReferencePanel.jsx';
import SettingsPanel from './SettingsPanel.jsx';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from './MenuBar.jsx';
import './reference.css';
import './menu.css';
import './settings.css';

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
  const [frameCaptureChoice, setFrameCaptureChoice] = useState(null); // { imagePath, imageName, shotId }
  const [promptSnippets, setPromptSnippets] = useState([
    { id: 's1', name: 'Establish', text: 'wide establishing shot, scale detail' },
    { id: 's2', name: 'Close Up', text: 'cinematic macro close up shot, shallow depth of field' },
    { id: 's3', name: 'Cyberpunk', text: 'neon cyberpunk aesthetic, volumetric haze, atmospheric reflections' },
    { id: 's4', name: 'Tracking', text: 'slow smooth tracking shot, camera moving forward' },
    { id: 's5', name: '8K Film', text: 'photorealistic 8k octane render, cinematic lighting, 35mm film grain' }
  ]);
  const [imageGallery, setImageGallery] = useState([]);
  const [videoGallery, setVideoGallery] = useState([]);
  // The reference board. `referenceImages` are the records; `refAssignments` is
  // the edge list saying which of them apply to the project, a scene or a shot.
  // Keeping assignment out of the shot is what makes assigning a dozen images to
  // three shots one operation instead of a nested rewrite of every scene.
  const [referenceImages, setReferenceImages] = useState([]);
  const [refAssignments, setRefAssignments] = useState([]);
  const [referencePanelOpen, setReferencePanelOpen] = useState(false);
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
  const [assetEditor, setAssetEditor] = useState(null); // null | { id?, tag, type, name, description, images[], primaryImage, inputImages[] }
  const [assetBatchDialog, setAssetBatchDialog] = useState(null); // { onlyMissing, useLlm, rewriteExisting }
  const [refBoardPicker, setRefBoardPicker] = useState(null); // null | { selected: string[] } — pulling from the master board into an asset
  const assetUploadRef = useRef(null);

  // --- SETTINGS ---
  const [activeLlm, setActiveLlm] = useState('gemini');
  const [llmModel, setLlmModel] = useState('gemini-2.5-flash');
  const [llmModelsList, setLlmModelsList] = useState([]);
  
  const [activeImageGenerator, setActiveImageGenerator] = useState('fal-ai');
  const [imageModel, setImageModel] = useState('fal-ai/flux/schnell');
  const [imageResolution, setImageResolution] = useState('16:9');

  const [activeVideoGenerator, setActiveVideoGenerator] = useState('fal-ai');
  const [videoResolution, setVideoResolution] = useState('1280x720');
  const [videoModel, setVideoModel] = useState('fal-ai/kling-video');
  const [videoDuration, setVideoDuration] = useState('5');

  // --- REFERENCE IMAGE ATTACHMENT DEFAULTS ---
  // Images want the tagged character/environment art for consistency. Video is
  // driven by the shot's own still, and most i2v models take a single input —
  // attaching a character portrait there silently replaces the frame you meant
  // to animate, so it is off unless explicitly asked for.
  const [attachTagsForImages, setAttachTagsForImages] = useState(true);
  const [attachTagsForVideos, setAttachTagsForVideos] = useState(false);
  const [genModalAttachTags, setGenModalAttachTags] = useState(true);

  // --- PROMPTS ---
  // Every editable prompt in one bag, keyed by the slot ids in prompts.js. A
  // slot the project has never touched simply isn't present, so a later change
  // to a shipped default still reaches it.
  const [promptSettings, setPromptSettings] = useState({});

  const imageSystemPrompt = promptText(promptSettings, 'imageSystemPrompt');
  const videoSystemPrompt = promptText(promptSettings, 'videoSystemPrompt');
  const prePrompt = promptText(promptSettings, 'prePrompt');
  const postPrompt = promptText(promptSettings, 'postPrompt');
  const videoPrePrompt = promptText(promptSettings, 'videoPrePrompt');
  const videoPostPrompt = promptText(promptSettings, 'videoPostPrompt');
  const assetPrePrompt = promptText(promptSettings, 'assetPrePrompt');
  const assetPostPrompt = promptText(promptSettings, 'assetPostPrompt');

  const setPromptSetting = (slotId, value) => setPromptSettings(prev => ({ ...prev, [slotId]: value }));
  const resetPromptSetting = (slotId) => setPromptSettings(prev => {
    const next = { ...prev };
    delete next[slotId];
    return next;
  });

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
  const [runtimeMode, setRuntimeMode] = useState(null); // 'server' | 'static'
  const [needsFolderPermission, setNeedsFolderPermission] = useState(false);

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
  const [genModalExcludedImages, setGenModalExcludedImages] = useState([]);

  // --- DOUBLE CLICK PREVIEW WITH ZOOM & PAN ---
  const [zoomImage, setZoomImage] = useState(null); // { path: string, name: string }
  const zoomImageUrl = useAssetUrl(zoomImage?.path);
  const [zoomScale, setZoomScale] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // --- CONCATENATED VIDEO PREVIEW ---
  const [concatenatedVideo, setConcatenatedVideo] = useState(null);
  const [checkpoints, setCheckpoints] = useState([]);
  const [checkpointName, setCheckpointName] = useState('');
  // The edit document. Owned here so it autosaves and travels with the project
  // file; every operation on it lives in ./edit/.
  const [edit, setEdit] = useState(createEmptyEdit);
  // 'create' | 'edit'. The editor replaces the whole window rather than sharing
  // it, so nothing about cutting has to fit around the generation UI. ?view=edit
  // also lets it be opened on its own in a second browser tab.
  const [view, setView] = useState(() => (
    new URLSearchParams(window.location.search).get('view') === 'edit' ? 'edit' : 'create'
  ));

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
    (async () => {
      const detected = await detectMode();
      setRuntimeMode(detected);

      if (detected === 'static') {
        // Re-adopt last session's folder. The handle survives in IndexedDB but
        // the browser may still want a click before granting access again.
        const restored = await projectFs.restoreActiveProject();
        if (restored?.needsPermission) {
          setNeedsFolderPermission(true);
          await fetchConfig();
          return;
        }
      }

      await fetchConfig();
      await fetchProject();
      await fetchProjectState();
    })();
    
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
      const res = await apiFetch(`/api/llm/models?provider=${provider}`);
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
      const res = await apiFetch(`/api/config`);
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
      const res = await apiFetch(`/api/state`);
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
    // Reference migration has to see the scenes, because pre-v2 projects kept
    // assignments inside each shot. It hands back scenes with those legacy
    // arrays cleared, so this must run before the scenes reach state.
    const migratedRefs = migrateReferenceState({ ...state, scenes: loadedScenes });
    loadedScenes = migratedRefs.scenes;

    setScenes(loadedScenes);

    setImageGallery(state.imageGallery || []);
    setVideoGallery(state.videoGallery || []);
    setReferenceImages(migratedRefs.references);
    setRefAssignments(pruneAssignments(migratedRefs.assignments, {
      references: migratedRefs.references,
      scenes: loadedScenes
    }));
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
    setBatchConcurrency(state.batchConcurrency || 3);
    setAttachTagsForImages(state.attachTagsForImages !== false);
    setAttachTagsForVideos(state.attachTagsForVideos === true);
    // Folds the flat pre/post and system-prompt fields older projects saved at
    // the top level into the prompt bag.
    setPromptSettings(migratePromptSettings(state));
    // Projects saved before the editor existed simply have no `edit` key.
    setEdit(migrateEdit(state.edit));
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
      refAssignments,
      referenceSchemaVersion: REFERENCE_SCHEMA_VERSION,
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
      batchConcurrency,
      attachTagsForImages,
      attachTagsForVideos,
      // Only the slots that differ from their defaults are written, so a future
      // change to a default still reaches projects that never edited it.
      promptSettings: compactPromptSettings(promptSettings),
      // Mirrored flat for anything still reading the old shape (shot-list
      // export, older tooling). The prompt bag is the source of truth.
      prePrompt,
      postPrompt,
      videoPrePrompt,
      videoPostPrompt,
      imageSystemPrompt,
      videoSystemPrompt,
      concatenatedVideo: extra.concatenatedVideo !== undefined ? extra.concatenatedVideo : concatenatedVideo,
      edit: extra.edit !== undefined ? extra.edit : edit,
      activeSceneId: extra.activeSceneId !== undefined ? extra.activeSceneId : activeSceneId,
      activeShotId: extra.activeShotId !== undefined ? extra.activeShotId : activeShotId,
      ...extra
    };
  };

  // Auto-Save Project State
  const saveProjectState = async (updatedScenes = scenes, extra = {}) => {
    // Nothing to write to yet in the hosted build until a folder is picked.
    if (isStatic() && !projectFs.getActiveHandle()) return;
    try {
      await apiFetch(`/api/state`, {
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
  // Refresh the checkpoint list whenever the Projects panel is opened, so it
  // reflects anything written by another window or by hand on disk.
  useEffect(() => {
    if (activeOverlay === 'projects') loadCheckpoints();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOverlay]);

  // The docked panel overlays the page rather than reflowing it, so the app
  // needs a right gutter while it is open or the timeline sits underneath.
  useEffect(() => {
    document.body.classList.toggle('reference-docked', referencePanelOpen);
    return () => document.body.classList.remove('reference-docked');
  }, [referencePanelOpen]);

  const saveStateRef = useRef();
  saveStateRef.current = () => { saveProjectState(); };
  useEffect(() => {
    if (scenes.length === 0) return undefined;
    const timer = setTimeout(() => saveStateRef.current(), 600);
    return () => clearTimeout(timer);
  }, [scenes, imageGallery, videoGallery, referenceImages, refAssignments, assetLibrary, promptSnippets, activeLlm, llmModel, activeImageGenerator, imageModel, imageResolution, activeVideoGenerator, videoResolution, videoModel, videoDuration, batchConcurrency, attachTagsForImages, attachTagsForVideos, promptSettings, concatenatedVideo, edit]);

  // Save Credentials
  const saveConfig = async (newKeys) => {
    try {
      const res = await apiFetch(`/api/config`, {
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
    // Everything this shot is set to send — its own references first, then the
    // ones it inherits from its scene and the project, minus anything held back.
    // Trimmed to the model's capacity so the preview never promises more than
    // will be uploaded.
    setGenModalInputImages(shotReferencePaths(shot).slice(
      0,
      refImageCapacity(type, type === 'image' ? (shot.imageModel || imageModel) : (shot.videoModel || videoModel))
    ));
    setGenModalDuration(videoDuration);
    setGenModalExcludedImages([]);

    setGenModalAttachTags(type === 'image' ? attachTagsForImages : attachTagsForVideos);

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
      // "Add Iteration" must reproduce the group exactly — prompt *and* every
      // setting — or the result lands in a new group instead of this gallery.
      const promptList = (type === 'image' ? shot.imagePrompts : shot.videoPrompts) || [];
      const found = promptList.find(p => p.id === existingPromptId);
      if (found) {
        // Reload the RAW prompt. `found.prompt` is the composed text with the
        // global pre/post already baked in — feeding that back would apply them
        // twice and fork a new group instead of adding to this one.
        // Older groups predate rawPrompt, so fall back to the composed text.
        initialPromptText = found.rawPrompt ?? found.prompt ?? '';
        if (found.model) setGenModalModel(found.model);
        if (found.resolution) setGenModalRes(found.resolution);
        if (found.attachTaggedImages !== undefined) setGenModalAttachTags(found.attachTaggedImages !== false);
        setGenModalExcludedImages(found.excludedImagePaths || []);
        if (type === 'image') {
          setGenModalInputImages(found.primaryImagePaths || found.inputImagePaths || []);
        } else {
          if (found.duration) setGenModalDuration(found.duration);
          setGenModalImageInput((found.primaryImagePaths || [])[0] ?? found.imageInput ?? '');
        }
      }
    } else {
      const draftField = type === 'image' ? 'draftImagePrompt' : 'draftVideoPrompt';
      initialPromptText = shot[draftField] !== undefined && shot[draftField] !== null && shot[draftField] !== '' ? shot[draftField] : (shot.description || '');
      setGenModalImageInput(shot.selectedImage || '');
    }

    setGenModalPrompt(initialPromptText);
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
    const isImage = generationModal.type === 'image';
    const systemPrompt = isImage ? imageSystemPrompt : videoSystemPrompt;
    const sceneOfShot = scenes.find(s => (s.shots || []).some(sh => sh.id === shot.id));
    const promptPayload = fillTemplate(
      promptText(promptSettings, isImage ? 'imageUserTemplate' : 'videoUserTemplate'),
      {
        description: shot.description,
        setup: shot.setup,
        notes: shot.notes,
        dialogue: shot.dialogue,
        name: shot.name,
        sceneName: sceneOfShot?.name || ''
      }
    );

    try {
      const res = await apiFetch(`/api/llm/generate`, {
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
      if (!data.text?.trim()) throw new Error('The model returned an empty prompt.');

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

  // Identity of a prompt group.
  //
  // Keyed on the RAW inputs the user controls, never the composed output. The
  // composed prompt already has the global pre/post text baked in, so matching
  // on it meant "+ Add Iteration" — which reloads the group and recomposes —
  // produced a different string every time and forked a fresh group.
  const imagePromptSignature = (group) => JSON.stringify([
    group.rawPrompt ?? group.prompt ?? '',
    group.model || '',
    group.resolution || '',
    group.primaryImagePaths || [],
    group.attachTaggedImages !== false,
    group.excludedImagePaths || []
  ]);

  const videoPromptSignature = (group) => JSON.stringify([
    group.rawPrompt ?? group.prompt ?? '',
    group.model || '',
    group.resolution || '',
    group.duration || '',
    group.primaryImagePaths || [],
    group.attachTaggedImages !== false,
    group.excludedImagePaths || []
  ]);

  // --- PROMPT COMPOSITION ---
  // The single place where a raw shot prompt becomes the string a model sees:
  // global pre/post prompt + <Tag> substitution + reference image resolution.
  const buildPrompt = (type, rawPrompt, modelId, primaryImagePaths = [], attachTaggedImages = null, excludedImagePaths = []) => composeGenerationPrompt({
    prompt: rawPrompt,
    prePrompt: type === 'image' ? prePrompt : videoPrePrompt,
    postPrompt: type === 'image' ? postPrompt : videoPostPrompt,
    assetLibrary,
    primaryImagePaths,
    attachTaggedImages: attachTaggedImages === null
      ? (type === 'image' ? attachTagsForImages : attachTagsForVideos)
      : attachTaggedImages,
    excludedImagePaths,
    type,
    modelId
  });

  const handleDeselectSentImage = (imagePath, origin) => {
    if (origin === 'primary') {
      if (generationModal?.type === 'image') {
        setGenModalInputImages(prev => prev.filter(p => p !== imagePath));
      } else {
        if (genModalImageInput === imagePath) {
          setGenModalImageInput('');
        }
      }
    }
    setGenModalExcludedImages(prev => [...prev, imagePath]);
  };

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
      primaryImagePaths: type === 'image'
        ? genModalInputImages
        : (genModalImageInput ? [genModalImageInput] : []),
      attachTaggedImages: genModalAttachTags,
      excludedImagePaths: genModalExcludedImages
    });
  };

  /**
   * Queue one generation. Used by the modal and by the batch runner alike, so
   * both go through identical prompt composition and identical result handling.
   * Resolves (never rejects) once the job settles.
   */
  const submitGenerationJob = async ({
    type, shotId, shotName,
    // existingPromptId is no longer needed: groups are matched by their recipe,
    // so a generation lands in the right gallery regardless of where it started.
    rawPrompt, model, resolution, duration,
    primaryImagePaths = [], attachTaggedImages = null,
    excludedImagePaths = []
  }) => {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const composed = buildPrompt(type, rawPrompt, model, primaryImagePaths, attachTaggedImages, excludedImagePaths);

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

    // What the group is keyed on: exactly what the user chose, so reopening it
    // reproduces this generation byte for byte.
    const recipe = {
      rawPrompt: rawPrompt || '',
      model,
      resolution,
      duration,
      primaryImagePaths,
      attachTaggedImages: composed.attachTaggedImages,
      excludedImagePaths
    };

    if (type === 'image') {
      return runAsyncImageJob(jobId, shotId, composed.prompt, composed.inputImagePaths, recipe);
    }
    return runAsyncVideoJob(jobId, shotId, composed.prompt, composed.inputImagePaths[0] || '', recipe);
  };

  const runAsyncImageJob = async (jobId, shotId, promptText, inputImagePaths = [], recipe = {}) => {
    const { model, resolution: resOption } = recipe;
    try {
      const res = await apiFetch(`/api/image/generate`, {
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

      let groupId = null;
      setScenes(prevScenes => prevScenes.map(scene => {
        const hasShot = (scene.shots || []).some(s => s.id === shotId);
        if (!hasShot) return scene;

        return {
          ...scene,
          shots: scene.shots.map(s => {
            if (s.id === shotId) {
              // Match on the settings themselves, across every group — not just
              // the one this generation was launched from. Re-running with
              // identical settings belongs in the same gallery, otherwise the
              // dropdown fills with indistinguishable duplicates.
              let updatedPrompts = [...(s.imagePrompts || [])];
              const signature = imagePromptSignature(recipe);
              const matchIndex = updatedPrompts.findIndex(p => imagePromptSignature(p) === signature);

              if (matchIndex >= 0) {
                updatedPrompts = updatedPrompts.map((p, i) => (
                  i === matchIndex ? { ...p, outputs: [...(p.outputs || []), newOutput] } : p
                ));
                groupId = updatedPrompts[matchIndex].id;
              } else {
                groupId = 'prompt_img_' + Date.now();
                updatedPrompts.push({
                  id: groupId,
                  ...recipe,
                  prompt: promptText,          // composed, for display
                  inputImagePaths,             // what actually went to the model
                  outputs: [newOutput]
                });
              }

              return {
                ...s,
                imagePrompts: updatedPrompts,
                // Always jump to what was just made — you asked for it, so show it.
                selectedImage: newOutput.path
              };
            }
            return s;
          })
        };
      }));

      // Show the gallery the new image landed in.
      if (groupId) setActiveShotImagePromptGroup(prev => ({ ...prev, [shotId]: groupId }));

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

  const runAsyncVideoJob = async (jobId, shotId, promptText, imageInput, recipe = {}) => {
    const { model, resolution: resOption, duration } = recipe;
    try {
      const imageUrlsToSend = imageInput ? [imageInput] : [];
      const res = await apiFetch(`/api/video/generate`, {
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

      let groupId = null;
      setScenes(prevScenes => prevScenes.map(scene => {
        const hasShot = (scene.shots || []).some(s => s.id === shotId);
        if (!hasShot) return scene;

        return {
          ...scene,
          shots: scene.shots.map(s => {
            if (s.id === shotId) {
              // Same rule as images: identical settings share one gallery.
              let updatedPrompts = [...(s.videoPrompts || [])];
              const signature = videoPromptSignature(recipe);
              const matchIndex = updatedPrompts.findIndex(p => videoPromptSignature(p) === signature);

              if (matchIndex >= 0) {
                updatedPrompts = updatedPrompts.map((p, i) => (
                  i === matchIndex ? { ...p, outputs: [...(p.outputs || []), newOutput] } : p
                ));
                groupId = updatedPrompts[matchIndex].id;
              } else {
                groupId = 'prompt_vid_' + Date.now();
                updatedPrompts.push({
                  id: groupId,
                  ...recipe,
                  prompt: promptText,          // composed, for display
                  imageInput,
                  outputs: [newOutput]
                });
              }

              return {
                ...s,
                videoPrompts: updatedPrompts,
                selectedVideo: newOutput.path
              };
            }
            return s;
          })
        };
      }));

      if (groupId) setActiveShotVideoPromptGroup(prev => ({ ...prev, [shotId]: groupId }));

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

        // Video batches animate the shot's own selected still. That image is
        // the primary input and must never be displaced by a tagged asset.
        //
        // Image batches use the same resolution the generation modal shows, so
        // a reference you unticked on a shot stays unticked when the batch runs
        // — previously the modal's choices were session-only and a sweep sent
        // everything regardless.
        const primaryImagePaths = isImage
          ? shotReferencePaths(shot)
          : (shot.selectedImage ? [shot.selectedImage] : []);

        const result = await submitGenerationJob({
          type,
          shotId: shot.id,
          shotName: shot.name,
          rawPrompt: resolveShotPrompt(shot, type),
          model,
          resolution,
          duration: shot.videoDuration || videoDuration,
          primaryImagePaths,
          attachTaggedImages: isImage ? attachTagsForImages : attachTagsForVideos
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
      ? { ...asset, images: [...(asset.images || [])], inputImages: assetInputImages(asset) }
      : {
        tag: '', type: 'character', name: '', description: '',
        images: [], primaryImage: null, inputImages: [],
        imagePrompt: '', imageModel: null, imageResolution: null,
        applyGlobalPrompts: false
      });
  };

  /** The model the asset editor will generate with, and how many refs it takes. */
  const assetEditorModel = (draft) => (draft?.imageModel || imageModel);
  const assetRefCapacity = (draft) => refImageCapacity('image', assetEditorModel(draft));

  /**
   * Toggle one of an asset's reference images in or out of the set sent with
   * the next generation, refusing to overfill the model.
   */
  const toggleAssetInputImage = (imagePath) => {
    setAssetEditor(prev => {
      if (!prev) return prev;
      const selected = assetInputImages(prev);
      if (selected.includes(imagePath)) {
        return { ...prev, inputImages: selected.filter(p => p !== imagePath) };
      }
      const capacity = assetRefCapacity(prev);
      // A model with no image inputs must not block the choice — the panel says
      // the ticks are kept for when you switch models, so it has to keep them.
      if (capacity <= 0) {
        return { ...prev, inputImages: [...selected, imagePath] };
      }
      if (selected.length >= capacity) {
        showToast(`This model accepts up to ${capacity} reference image${capacity === 1 ? '' : 's'}. Deselect one first.`, 'warning');
        return { ...prev, inputImages: selected };
      }
      return { ...prev, inputImages: [...selected, imagePath] };
    });
  };

  /** The asset editor's prompt, falling back to one derived from the description. */
  const effectiveAssetPrompt = (draft) => (
    draft?.imagePrompt?.trim() ? draft.imagePrompt : defaultAssetPrompt(draft, promptSettings)
  );

  /**
   * Compose an asset's generation prompt. Other assets' <Tag>s still resolve
   * (an environment can reference a character), but the asset being generated
   * is excluded from its own library so <Ralph> inside Ralph doesn't recurse.
   */
  const buildAssetPrompt = (draft) => {
    const others = assetLibrary.filter(a => a.id !== draft.id);
    const modelId = draft.imageModel || imageModel;
    // Only images still in the asset's pool can be sent — one deleted from the
    // grid must not keep riding along invisibly in the saved selection.
    const pool = draft.images || [];
    const picked = assetInputImages(draft).filter(p => pool.includes(p));

    // Three-way, because reference art and film frames want opposite treatment.
    // 'asset' is the default: the dedicated asset pre/post, which is usually
    // neutral. 'image' borrows the film's own grade language, which is only
    // right when you want the reference to match the look. 'none' sends the
    // prompt bare.
    const wrap = draft.promptWrap || (draft.applyGlobalPrompts ? 'image' : 'asset');
    const wraps = {
      none: ['', ''],
      image: [prePrompt, postPrompt],
      asset: [assetPrePrompt, assetPostPrompt]
    }[wrap] || ['', ''];

    return composeGenerationPrompt({
      prompt: effectiveAssetPrompt(draft),
      prePrompt: wraps[0],
      postPrompt: wraps[1],
      assetLibrary: others,
      primaryImagePaths: picked,
      attachTaggedImages: true,
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
      const res = await apiFetch(`/api/image/generate`, {
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

    // How many lines is a settings slot now — more is more faithful and more
    // expensive, and 12 was only ever a guess baked into the source.
    return lines.slice(0, promptNumber(promptSettings, 'assetContextLimit'));
  };

  /**
   * Ask the LLM for a reference-image prompt (and a fuller description).
   * Prefers JSON, but a plain-text reply is treated as the prompt so a chatty
   * model still produces something usable.
   */
  const writeAssetPromptWithLlm = async (asset) => {
    const context = gatherAssetContext(asset);
    const styleHint = [prePrompt, postPrompt].filter(Boolean).join(' … ');

    const systemPrompt = promptText(promptSettings, 'assetWriterSystem');

    const userPrompt = fillTemplate(promptText(promptSettings, 'assetWriterUser'), {
      type: asset.type || 'character',
      tag: asset.tag || '',
      name: asset.name || asset.tag,
      description: asset.description?.trim() || '(none — infer it)',
      context: context.length > 0
        ? `\nScript lines referencing this subject:\n${context.join('\n')}`
        : '\n(This subject is not referenced in any shot yet — work from the name and description alone.)',
      styleHint: styleHint
        ? `\nProject look, for tone only — do NOT copy this into the reference prompt: ${styleHint}`
        : ''
    });

    const res = await apiFetch(`/api/llm/generate`, {
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

    const images = assetEditor.images || [];
    const record = {
      id: assetEditor.id || `asset_${Date.now()}`,
      tag,
      type: assetEditor.type || 'character',
      name: (assetEditor.name || '').trim() || tag,
      description: (assetEditor.description || '').trim(),
      images,
      primaryImage: assetEditor.primaryImage || images[0] || null,
      inputImages: assetInputImages(assetEditor).filter(p => images.includes(p)),
      imagePrompt: assetEditor.imagePrompt || '',
      imageModel: assetEditor.imageModel || null,
      imageResolution: assetEditor.imageResolution || null,
      promptWrap: assetEditor.promptWrap || (assetEditor.applyGlobalPrompts ? 'image' : 'asset')
    };

    setAssetLibrary(prev => (
      prev.some(a => a.id === record.id) ? prev.map(a => (a.id === record.id ? record : a)) : [...prev, record]
    ));

    // An asset built from a board selection links back to those references, so
    // the board can show which asset each one belongs to and the two never
    // drift into being separate copies of the same file.
    if (assetEditor.linkedReferenceIds?.length) {
      handleUpdateReferences(assetEditor.linkedReferenceIds, { assetId: record.id });
    }
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
        const res = await apiFetch(`/api/upload`, { method: 'POST', body: formData });
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
      if (isStatic()) {
        const name = projectFs.getActiveName();
        setProject({
          path: name,
          name: name || 'No project folder',
          workingFolder: name || '',
          isLegacy: false,
          needsFolder: !name,
          recent: (await projectFs.listRecentProjects()).map(entry => ({
            path: entry.name, name: entry.name, handle: entry.handle, lastOpened: entry.lastOpened
          }))
        });
        return;
      }
      const res = await apiFetch(`/api/project`);
      if (res.ok) setProject(await res.json());
    } catch (err) {
      console.error(err);
    }
  };

  /** Static build: adopt a folder from the picker or the recents list. */
  const adoptStaticProject = async (handle = null) => {
    setLoadingStates(prev => ({ ...prev, project: true }));
    try {
      const result = handle
        ? await projectFs.openRecentProject(handle)
        : await projectFs.pickProjectFolder();

      projectFs.clearAssetUrlCache(); // old blob: URLs point at the previous folder
      const state = await projectFs.readProjectState();
      applyLoadedState(state || {});
      if (!state) await projectFs.writeProjectState(buildStatePayload([]));

      await fetchProject();
      setNeedsFolderPermission(false);
      setActiveOverlay(null);
      showToast(`Project folder "${result.name}" ready.`, 'success');
    } catch (err) {
      console.error(err);
      // Cancelling the OS picker is not an error worth shouting about.
      if (err.name !== 'AbortError') showToast(err.message, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, project: false }));
    }
  };

  /** Re-grant access to the folder remembered from last session. */
  const handleReconnectFolder = async () => {
    try {
      if (await projectFs.reconnectProject()) {
        setNeedsFolderPermission(false);
        projectFs.clearAssetUrlCache();
        applyLoadedState((await projectFs.readProjectState()) || {});
        await fetchProject();
        showToast('Project folder reconnected.', 'success');
      } else {
        showToast('Permission declined.', 'warning');
      }
    } catch (err) {
      console.error(err);
      showToast(err.message, 'error');
    }
  };

  /** Ask the backend to open a native Windows dialog. Returns a path or null. */
  const browseForPath = async (mode, defaultName = '') => {
    setLoadingStates(prev => ({ ...prev, browse: true }));
    try {
      const res = await apiFetch(`/api/project/browse`, {
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

  const handleOpenProject = async (explicitPath = null, handle = null) => {
    if (isStatic()) {
      await flushSave();
      await adoptStaticProject(handle);
      return;
    }

    const projectPath = explicitPath || await browseForPath('open');
    if (!projectPath) return;

    await flushSave();
    setLoadingStates(prev => ({ ...prev, project: true }));
    try {
      const res = await apiFetch(`/api/project/open`, {
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
    if (isStatic()) {
      // Pick an empty destination folder; state and media are copied into it.
      setLoadingStates(prev => ({ ...prev, project: true }));
      try {
        const sourceHandle = projectFs.getActiveHandle();
        const assetPaths = collectReferencedAssetPaths();
        await projectFs.pickProjectFolder('new');
        const mapping = sourceHandle ? await projectFs.copyAssetsFrom(sourceHandle, assetPaths) : new Map();
        const remapped = remapStateAssetPaths(buildStatePayload(), mapping);
        await projectFs.writeProjectState(remapped);
        projectFs.clearAssetUrlCache();
        applyLoadedState(remapped);
        await fetchProject();
        showToast(`Branched into "${projectFs.getActiveName()}" — ${mapping.size} media file(s) copied.`, 'success');
      } catch (err) {
        console.error(err);
        if (err.name !== 'AbortError') showToast(`Save As failed: ${err.message}`, 'error');
      } finally {
        setLoadingStates(prev => ({ ...prev, project: false }));
      }
      return;
    }

    const chosen = await browseForPath('saveAs', `${project.name || 'Untitled'}.mmproj.json`);
    if (!chosen) return;

    setLoadingStates(prev => ({ ...prev, project: true }));
    try {
      const res = await apiFetch(`/api/project/save-as`, {
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

  /** Every assets/ path the current project state points at. */
  const collectReferencedAssetPaths = () => {
    const paths = new Set();
    const add = (p) => { if (typeof p === 'string' && p.startsWith('assets/')) paths.add(p); };

    scenes.forEach(scene => (scene.shots || []).forEach(shot => {
      add(shot.selectedImage);
      add(shot.selectedVideo);
      add(shot.lipSyncAudio);
      [...(shot.imagePrompts || []), ...(shot.videoPrompts || [])].forEach(group => {
        (group.outputs || []).forEach(out => add(out.path));
        (group.inputImagePaths || []).forEach(add);
        add(group.imageInput);
      });
    }));
    imageGallery.forEach(item => add(item.path));
    videoGallery.forEach(item => add(item.path));
    referenceImages.forEach(item => add(item.path));
    assetLibrary.forEach(asset => {
      (asset.images || []).forEach(add);
      add(asset.primaryImage);
    });
    return [...paths];
  };

  /** Rewrite every assets/ path in a state blob through a copy mapping. */
  const remapStateAssetPaths = (state, mapping) => {
    if (mapping.size === 0) return state;
    const swap = (value) => (typeof value === 'string' && mapping.has(value) ? mapping.get(value) : value);
    const walk = (node) => {
      if (Array.isArray(node)) return node.map(walk);
      if (node && typeof node === 'object') {
        return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value)]));
      }
      return swap(node);
    };
    return walk(state);
  };

  const handleCreateProject = async () => {
    if (isStatic()) {
      await flushSave();
      setLoadingStates(prev => ({ ...prev, project: true }));
      try {
        await projectFs.pickProjectFolder('new');
        projectFs.clearAssetUrlCache();
        applyLoadedState({});
        await projectFs.writeProjectState(buildStatePayload([]));
        await fetchProject();
        setNewProjectDraft(null);
        setActiveOverlay(null);
        showToast(`New project in "${projectFs.getActiveName()}".`, 'success');
      } catch (err) {
        console.error(err);
        if (err.name !== 'AbortError') showToast(`Create failed: ${err.message}`, 'error');
      } finally {
        setLoadingStates(prev => ({ ...prev, project: false }));
      }
      return;
    }

    if (!newProjectDraft?.directory || !newProjectDraft?.name?.trim()) {
      showToast('Pick a parent folder and give the project a name.', 'warning');
      return;
    }

    await flushSave();
    setLoadingStates(prev => ({ ...prev, project: true }));
    try {
      const res = await apiFetch(`/api/project/new`, {
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
    if (isStatic()) {
      setLoadingStates(prev => ({ ...prev, project: true }));
      try {
        // Pick the OTHER project's folder, read its library, copy its images here.
        const sourceHandle = await window.showDirectoryPicker({ id: 'moviemaker-import', mode: 'read' });
        const fileHandle = await sourceHandle.getFileHandle(projectFs.PROJECT_FILENAME);
        const raw = JSON.parse(await (await fileHandle.getFile()).text());
        const sourceState = raw.state && typeof raw.state === 'object' ? raw.state : raw;
        const incoming = sourceState.assetLibrary || [];

        if (incoming.length === 0) {
          showToast(`"${sourceHandle.name}" has no assets to import.`, 'warning');
          return;
        }

        const allImages = incoming.flatMap(a => a.images || []);
        const mapping = await projectFs.copyAssetsFrom(sourceHandle, allImages);

        let skipped = 0;
        setAssetLibrary(prev => {
          const additions = incoming
            .filter(asset => {
              const clash = prev.some(existing => normalizeTag(existing.tag) === normalizeTag(asset.tag));
              if (clash) skipped += 1;
              return !clash;
            })
            .map(asset => {
              const images = (asset.images || []).map(p => mapping.get(p)).filter(Boolean);
              return {
                ...asset,
                id: `asset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                images,
                primaryImage: mapping.get(asset.primaryImage) || images[0] || null,
                inputImages: assetInputImages(asset).map(p => mapping.get(p)).filter(Boolean)
              };
            });
          return [...prev, ...additions];
        });

        showToast(`Imported ${incoming.length - skipped} asset(s) from "${sourceHandle.name}"${skipped ? `, skipped ${skipped} duplicate tag(s)` : ''}.`, 'success');
      } catch (err) {
        console.error(err);
        if (err.name === 'NotFoundError') showToast('That folder has no project file in it.', 'error');
        else if (err.name !== 'AbortError') showToast(`Asset import failed: ${err.message}`, 'error');
      } finally {
        setLoadingStates(prev => ({ ...prev, project: false }));
      }
      return;
    }

    const sourcePath = await browseForPath('open');
    if (!sourcePath) return;

    setLoadingStates(prev => ({ ...prev, project: true }));
    try {
      const res = await apiFetch(`/api/project/import-assets`, {
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
      try {
        applyImportedDocument(parsed, mode);
      } catch (err) {
        showToast(`Import failed: ${err.message}`, 'error');
      }
    };
    reader.readAsText(file);
  };

  /**
   * Load an imported document into the studio.
   *
   * Handles both shapes: the shot-list schema (`assets`, per-shot `imagePrompt`,
   * nested `project` block) and a full state export (`assetLibrary`, galleries,
   * flat settings). Throws with a readable message if the document is unusable.
   */
  const applyImportedDocument = (parsed, mode = 'replace', { restoreGalleries = false } = {}) => {
    const { project, assets, promptSnippets: importedSnippets, scenes: importedScenes, warnings } =
      normalizeImportedShotList(parsed);

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

    // A full state export also carries media libraries; a shot list does not.
    if (restoreGalleries) {
      setImageGallery(parsed.imageGallery || []);
      setVideoGallery(parsed.videoGallery || []);
      setReferenceImages(parsed.referenceImages || []);
      setConcatenatedVideo(parsed.concatenatedVideo || null);
      // A shot list on its own carries no edit; a full state export does.
      if (parsed.edit) setEdit(migrateEdit(parsed.edit));
    }

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
              primaryImage: existing.primaryImage || incoming.primaryImage,
              inputImages: assetInputImages(existing).length ? assetInputImages(existing) : assetInputImages(incoming)
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
    const undefinedTags = collectUndefinedTags(importedScenes, assets);
    setImportReport({
      sceneCount: importedScenes.length,
      shotCount,
      assetCount: assets.length,
      mode,
      undefinedTags,
      warnings: [
        ...warnings,
        ...(undefinedTags.length > 0
          ? [`Prompts reference undefined asset tag(s): <${undefinedTags.join('>, <')}>. Create them below, or they will be sent through as literal text.`]
          : [])
      ]
    });
    showToast(`Imported ${importedScenes.length} scene${importedScenes.length === 1 ? '' : 's'} / ${shotCount} shots / ${assets.length} asset${assets.length === 1 ? '' : 's'}.`, 'success');
  };

  /** <Tags> used in imported prompts that no asset defines. */
  const collectUndefinedTags = (importedScenes, importedAssets) => {
    const known = [...assetLibrary, ...importedAssets];
    const missing = new Set();
    importedScenes.forEach(scene => (scene.shots || []).forEach(shot => {
      [shot.draftImagePrompt, shot.draftVideoPrompt].forEach(text => {
        extractTags(text).forEach(tag => {
          if (!findAssetByTag(known, tag)) missing.add(tag);
        });
      });
    }));
    return [...missing];
  };

  /** Create empty assets for tags a prompt uses but nothing defines. */
  const handleCreateMissingAssets = (tags) => {
    const additions = tags
      .filter(tag => !findAssetByTag(assetLibrary, tag))
      .map(tag => ({
        id: `asset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        tag,
        type: 'character',
        name: tag,
        description: '',
        images: [],
        primaryImage: null,
        inputImages: [],
        imagePrompt: '',
        imageModel: null,
        imageResolution: null,
        applyGlobalPrompts: false
      }));
    if (additions.length === 0) return;
    setAssetLibrary(prev => [...prev, ...additions]);
    setImportReport(prev => (prev ? { ...prev, undefinedTags: [], assetCount: prev.assetCount + additions.length } : prev));
    showToast(`Created ${additions.length} asset${additions.length === 1 ? '' : 's'}. Add descriptions, then Batch Generate.`, 'success');
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
      const res = await apiFetch(`/api/reveal`, {
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
      imgElement.src = zoomImageUrl || await resolveAssetUrl(zoomImage.path);

      imgElement.onload = async () => {
        try {
          ctx.drawImage(imgElement, pixelX, pixelY, pixelW, pixelH, 0, 0, pixelW, pixelH);
          const dataUrl = canvas.toDataURL('image/png');

          // Convert dataUrl to blob
          const blob = await (await fetch(dataUrl)).blob();
          const formData = new FormData();
          formData.append('file', blob, `crop_${Date.now()}.png`);

          const res = await apiFetch(`/api/upload`, {
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

  /** Say plainly how much of a compile was real footage vs held stills. */
  const describeCompile = (data) => {
    const parts = [];
    if (data.videoCount) parts.push(`${data.videoCount} video${data.videoCount === 1 ? '' : 's'}`);
    if (data.stillCount) parts.push(`${data.stillCount} still${data.stillCount === 1 ? '' : 's'} held as placeholders`);
    const skipped = data.skipped?.length ? ` ${data.skipped.length} shot(s) skipped (no media).` : '';
    return `Compiled ${parts.join(' + ') || 'timeline'}.${skipped}`;
  };

  /**
   * Grab the frame a <video> is currently showing and save it as a project
   * image, so you can continue a shot from an exact moment.
   *
   * Reads straight from the element rather than re-fetching, so it captures the
   * frame you are actually looking at. Needs the video to be CORS-clean or the
   * canvas is tainted and toBlob() throws.
   */
  const handleCaptureVideoFrame = async (videoEl, shotId, label = 'frame') => {
    if (!videoEl || !videoEl.videoWidth) {
      showToast('Let the video load a frame first.', 'warning');
      return;
    }
    const at = videoEl.currentTime;
    setLoadingStates(prev => ({ ...prev, capture: true }));
    try {
      const canvas = document.createElement('canvas');
      canvas.width = videoEl.videoWidth;
      canvas.height = videoEl.videoHeight;
      canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise((resolve, reject) => {
        try {
          canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Frame capture produced no data.'))), 'image/png');
        } catch (err) {
          reject(err);
        }
      });

      const formData = new FormData();
      formData.append('file', blob, `frame_${Math.round(at * 1000)}.png`);
      const res = await apiFetch(`/api/upload`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save the frame.');

      const name = `${label} @ ${at.toFixed(2)}s`;
      setImageGallery(prev => [{
        id: `img_frame_${Date.now()}`,
        path: data.filePath,
        prompt: `Frame captured at ${at.toFixed(2)}s`,
        name,
        createdAt: new Date().toISOString()
      }, ...prev]);

      // Always lands in the gallery; ask what (if anything) to do with a shot
      // rather than silently overwriting the shot currently being viewed.
      if (shotId) {
        setFrameCaptureChoice({ imagePath: data.filePath, imageName: name, shotId });
      } else {
        showToast(`Captured ${name} — saved to the image gallery.`, 'success');
      }
    } catch (err) {
      console.error(err);
      showToast(
        /tainted|SecurityError/i.test(err.message || err.name)
          ? 'The browser blocked reading this video (CORS). Reload the page and try again.'
          : `Frame capture failed: ${err.message}`,
        'error'
      );
    } finally {
      setLoadingStates(prev => ({ ...prev, capture: false }));
    }
  };

  /** Whichever shot immediately follows contextShotId, scene boundaries included. */
  const getNextShot = (contextShotId) => {
    const idx = shots.findIndex(s => s.id === contextShotId);
    if (idx === -1 || idx === shots.length - 1) return null;
    return shots[idx + 1];
  };

  // Resolve the three "Capture Frame" choices. The captured image is already
  // in the gallery by this point — these only decide what else happens to it.
  const handleFrameChoiceNextShot = () => {
    if (!frameCaptureChoice) return;
    const { imagePath, imageName, shotId } = frameCaptureChoice;
    const next = getNextShot(shotId);
    if (!next) {
      showToast('There is no next shot to set — it stayed in the image gallery.', 'warning');
      setFrameCaptureChoice(null);
      return;
    }
    handleUpdateShotField(next.id, 'selectedImage', imagePath);
    showToast(`${imageName} is now ${next.name || 'the next shot'}'s image.`, 'success');
    setFrameCaptureChoice(null);
  };

  const handleFrameChoiceInsertShot = () => {
    if (!frameCaptureChoice) return;
    const { imagePath, imageName, shotId } = frameCaptureChoice;
    const scene = scenes.find(s => (s.shots || []).some(sh => sh.id === shotId));
    if (!scene) {
      setFrameCaptureChoice(null);
      return;
    }
    const newId = 'shot_' + Date.now();
    const insertAt = scene.shots.findIndex(sh => sh.id === shotId) + 1;
    const newShot = {
      id: newId,
      name: `Shot ${scene.shots.length + 1}`,
      setup: '',
      description: '',
      dialogue: '',
      notes: '',
      selectedImage: imagePath,
      selectedVideo: null,
      referenceImages: [],
      lipSyncAudio: null,
      imagePrompts: [],
      videoPrompts: [],
      draftImagePrompt: '',
      draftVideoPrompt: ''
    };

    const newShots = [...scene.shots];
    newShots.splice(insertAt, 0, newShot);
    const updated = scenes.map(s => (s.id === scene.id ? { ...s, shots: newShots } : s));

    const newCollapseState = { ...collapsedShots };
    shots.forEach(s => { newCollapseState[s.id] = true; });
    newCollapseState[newId] = false;
    setCollapsedShots(newCollapseState);

    setScenes(updated);
    setActiveSceneId(scene.id);
    setActiveShotId(newId);
    saveProjectState(updated, { activeShotId: newId });
    showToast(`Inserted new shot with ${imageName} as its image.`, 'success');
    setFrameCaptureChoice(null);
  };

  const handleFrameChoiceLibraryOnly = () => {
    if (!frameCaptureChoice) return;
    showToast(`${frameCaptureChoice.imageName} saved to the image gallery.`, 'success');
    setFrameCaptureChoice(null);
  };

  // --- FFMEG COMPILATION ---
  const handleStitchCompilation = async () => {
    // Shots with no video contribute their still, so a partly generated edit
    // still plays end to end as an animatic.
    const timeline = scenes.flatMap(s => (s.shots || []).map(sh => ({
      video: sh.selectedVideo || null,
      image: sh.selectedImage || null,
      duration: Number(sh.videoDuration || videoDuration) || 5,
      name: sh.name
    }))).filter(entry => entry.video || entry.image);

    if (timeline.length === 0) {
      showToast('No shot has a video or an image to compile.', 'warning');
      return;
    }

    setLoadingStates(prev => ({ ...prev, compilation: true }));
    try {
      const res = await apiFetch(`/api/concatenate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: timeline })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'FFmpeg failed');

      window.open(await resolveAssetUrl(data.filePath), '_blank');
      setConcatenatedVideo(data.filePath);
      saveProjectState(scenes, { concatenatedVideo: data.filePath });
      showToast(describeCompile(data), 'success');
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

    const timeline = (targetScene.shots || []).map(sh => ({
      video: sh.selectedVideo || null,
      image: sh.selectedImage || null,
      duration: Number(sh.videoDuration || videoDuration) || 5,
      name: sh.name
    })).filter(entry => entry.video || entry.image);

    if (timeline.length === 0) {
      showToast('No shot in this scene has a video or an image.', 'warning');
      return;
    }

    setLoadingStates(prev => ({ ...prev, compilation: true }));
    try {
      const res = await apiFetch(`/api/concatenate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: timeline })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'FFmpeg failed');

      window.open(await resolveAssetUrl(data.filePath), '_blank');
      
      const updated = scenes.map(s => {
        if (s.id === sceneId) {
          return { ...s, sceneConcatenatedVideo: data.filePath };
        }
        return s;
      });
      setScenes(updated);
      saveProjectState(updated);
      showToast(describeCompile(data), 'success');
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
      const res = await apiFetch(`/api/upload`, { method: 'POST', body: formData });
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
      const res = await apiFetch(`/api/lipsync`, {
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
        const res = await apiFetch(`/api/upload`, { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        return { file, data, index };
      }));

      if (dest === 'ref') {
        const newRefs = uploaded.map(({ file, data, index }) => normalizeReference({
          id: `ref_${Date.now()}_${index}`,
          path: data.filePath,
          // Drop the extension: "neon_alley.png" is a filename, "neon_alley" is
          // a name you might actually keep.
          name: file.name.replace(/\.[^.]+$/, ''),
          source: 'upload'
        }));
        setReferenceImages(prev => [...newRefs, ...prev]);
        if (generationModal?.type === 'image') {
          const capacity = refImageCapacity('image', genModalModel);
          setGenModalInputImages(prev => [...prev, ...newRefs.map(ref => ref.path)].slice(0, capacity));
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
      const res = await apiFetch(`/api/upload`, { method: 'POST', body: formData });
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
      const res = await apiFetch(`/api/project-images`);
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
      if (referenceImages.some(r => r.path === image.path)) {
        showToast('This image is already on the reference board.', 'warning');
        setProjectImagesSelector(null);
        return;
      }
      const newRef = normalizeReference({
        path: image.path,
        name: image.name.replace(/\.[^.]+$/, ''),
        source: 'project'
      });
      setReferenceImages(prev => [newRef, ...prev]);

      // Adding from inside the generation modal means "use this now", so it goes
      // straight into the inputs — trimmed to what the model will actually read.
      if (generationModal?.type === 'image' || generationModal?.type === 'video') {
        const capacity = refImageCapacity(generationModal.type, genModalModel);
        setGenModalInputImages(prev => [...prev, image.path].slice(0, capacity));
      }

      // Adding from the board itself does not silently attach to whatever shot
      // happens to be active — that hidden side effect is why references used to
      // turn up on shots nobody assigned them to. Use the panel's Assign for it.
      showToast(`Added ${newRef.name} to the reference board.`, 'success');
    }
    setProjectImagesSelector(null);
  };

  // --- REFERENCE BOARD ------------------------------------------------------

  /**
   * Apply the assign dialog's result: attach where a target was ticked, detach
   * where one was unticked. Both halves in one state update so a single edit
   * cannot half-apply.
   */
  const handleApplyAssignments = (refIds, toAssign, toUnassign, options) => {
    setRefAssignments(prev => {
      let next = prev;
      if (toUnassign.length > 0) next = unassignReferences(next, refIds, toUnassign);
      if (toAssign.length > 0) next = assignReferences(next, refIds, toAssign, options);
      return next;
    });

    const parts = [];
    if (toAssign.length) parts.push(`attached to ${toAssign.length}`);
    if (toUnassign.length) parts.push(`detached from ${toUnassign.length}`);
    showToast(
      `${refIds.length} reference${refIds.length === 1 ? '' : 's'} ${parts.join(' and ')}${options?.enabled === false ? ' — held back until you switch them on' : ''}.`,
      'success'
    );
  };

  /** Detach from specific targets, or from everywhere when targets is null. */
  const handleUnassignReferences = (refIds, targets) => {
    setRefAssignments(prev => unassignReferences(prev, refIds, targets));
    showToast(targets ? 'Reference detached.' : `${refIds.length} reference${refIds.length === 1 ? '' : 's'} detached everywhere.`);
  };

  /**
   * Patch a set of references. `patch` may be an object applied to all of them,
   * or a function of the reference for per-item values such as merging tags.
   */
  const handleUpdateReferences = (refIds, patch) => {
    const ids = new Set(refIds);
    setReferenceImages(prev => prev.map(ref => (
      ids.has(ref.id) ? { ...ref, ...(typeof patch === 'function' ? patch(ref) : patch) } : ref
    )));
  };

  const handleLinkReferencesToAsset = (refIds, assetId) => {
    handleUpdateReferences(refIds, { assetId });
    showToast(assetId ? 'Linked to asset.' : 'Unlinked.');
  };

  /**
   * Turn a selection into a new asset.
   *
   * The images are *linked*, not copied: the asset's own pool used to receive
   * duplicate paths off the board, leaving two records for one file that then
   * drifted apart. Here the reference stays the single record and the asset
   * points at it.
   */
  const handleCreateAssetFromReferences = (refs) => {
    if (refs.length === 0) return;
    const paths = refs.map(ref => ref.path);
    const suggestedTag = (refs[0].name || 'Asset').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]/g, '') || 'Asset';

    setAssetEditor({
      tag: suggestedTag,
      type: refs[0].kind === 'scenery' ? 'environment' : (ASSET_TYPES.some(t => t.id === refs[0].kind) ? refs[0].kind : 'character'),
      name: refs[0].name || '',
      description: refs.map(ref => ref.notes).filter(Boolean).join('; '),
      images: paths,
      primaryImage: paths[0],
      inputImages: [],
      imagePrompt: '',
      imageModel: null,
      imageResolution: null,
      applyGlobalPrompts: false,
      // Remembered so saving the asset can stamp its id back onto the sources.
      linkedReferenceIds: refs.map(ref => ref.id)
    });
    setReferencePanelOpen(false);
  };

  const handleDeleteReferences = (refIds) => {
    const ids = new Set(refIds);
    setReferenceImages(prev => prev.filter(ref => !ids.has(ref.id)));
    setRefAssignments(prev => prev.filter(edge => !ids.has(edge.refId)));
    showToast(`${refIds.length} reference${refIds.length === 1 ? '' : 's'} removed from the board.`);
  };

  /** Flip whether one resolved entry is uploaded with this shot's generations. */
  const toggleShotReferenceEntry = (shot, entry) => {
    if (entry.inherited) {
      // An inherited reference is switched per shot, so the scene keeps it for
      // every other shot that wants it.
      const current = shot.refExclusions || [];
      const next = current.includes(entry.ref.id)
        ? current.filter(id => id !== entry.ref.id)
        : [...current, entry.ref.id];
      handleUpdateShotField(shot.id, 'refExclusions', next);
      return;
    }
    setRefAssignments(prev => setEdgeEnabled(prev, entry.edge.id, !entry.enabled));
  };

  const toggleSceneReferenceEntry = (entry) => {
    // A project-wide reference is only shown here for context. Toggling it from
    // a scene header would quietly switch it off for the whole film, which is
    // never what the click meant — that decision belongs to the board.
    if (entry.inherited) {
      showToast('That one is assigned to the whole project — change it in the reference board.', 'warning');
      return;
    }
    setRefAssignments(prev => setEdgeEnabled(prev, entry.edge.id, !entry.enabled));
  };

  /** Everything in play for a shot, with provenance and send state. */
  const shotReferenceEntries = (shot) => resolveShotReferences({
    shot,
    scene: scenes.find(s => (s.shots || []).some(sh => sh.id === shot.id)),
    references: referenceImages,
    assignments: refAssignments
  });

  /** Just the paths a generation for this shot should receive, in send order. */
  const shotReferencePaths = (shot) => enabledReferencePaths({
    shot,
    scene: scenes.find(s => (s.shots || []).some(sh => sh.id === shot.id)),
    references: referenceImages,
    assignments: refAssignments
  });

  /**
   * Copy board references into assets' own image pools, ticked to send.
   *
   * A push, not a link. Once the paths are in the asset's `images` it owns
   * them — the existing per-image checkbox unticks one, the ✕ deletes it — with
   * no trip back to the board. Re-running it on images an asset already has
   * simply re-ticks them, which makes it double as "switch these back on".
   */
  const handleAddReferencesToAssets = (refIds, assetIds) => {
    const paths = referenceImages.filter(r => refIds.includes(r.id)).map(r => r.path).filter(Boolean);
    if (paths.length === 0) return;

    const targets = new Set(assetIds);
    const applyTo = (asset) => {
      const images = [...new Set([...(asset.images || []), ...paths])];
      return {
        ...asset,
        images,
        primaryImage: asset.primaryImage || images[0] || null,
        // Ticked on arrival. Capacity is not clamped here: the asset editor
        // already flags an over-full selection and shows where the model's cut
        // falls, and silently dropping some of what you just added would be
        // less obvious than showing it and saying so.
        inputImages: [...new Set([...assetInputImages(asset), ...paths])]
      };
    };

    setAssetLibrary(prev => prev.map(asset => (targets.has(asset.id) ? applyTo(asset) : asset)));
    // Keep an open editor in step rather than letting it save over the change.
    setAssetEditor(prev => (prev && targets.has(prev.id) ? applyTo(prev) : prev));

    showToast(
      `${paths.length} image${paths.length === 1 ? '' : 's'} added to ${assetIds.length} asset${assetIds.length === 1 ? '' : 's'}, ticked to send.`,
      'success'
    );
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
      handleDeleteReferences([id]);
      return;
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

  // --- CHECKPOINTS ---
  // Named snapshots of everything — shot list, settings, galleries, the edit —
  // kept beside the project. Cheap enough to take freely because they share the
  // project's media rather than copying it.

  const loadCheckpoints = async () => {
    try {
      const res = await apiFetch('/api/checkpoints');
      const data = await res.json();
      if (res.ok) setCheckpoints(data.checkpoints || []);
    } catch (err) {
      console.error('Could not list checkpoints:', err);
    }
  };

  const saveCheckpoint = async (name, { quiet = false } = {}) => {
    const res = await apiFetch('/api/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, state: buildStatePayload() })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save the checkpoint.');
    if (!quiet) showToast(`Checkpoint "${data.checkpoint.name}" saved.`, 'success');
    return data.checkpoint;
  };

  const handleSaveCheckpoint = async () => {
    setLoadingStates(prev => ({ ...prev, checkpoint: true }));
    try {
      await saveCheckpoint(checkpointName);
      setCheckpointName('');
      await loadCheckpoints();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, checkpoint: false }));
    }
  };

  /**
   * Load a checkpoint back over the current state.
   *
   * The current state is snapshotted first, so this can never lose work and
   * does not need a scary confirmation — if it was the wrong checkpoint, the
   * one above it in the list is where you just were.
   */
  const handleRestoreCheckpoint = async (checkpoint) => {
    setLoadingStates(prev => ({ ...prev, checkpoint: true }));
    try {
      await saveCheckpoint(`Before restoring "${checkpoint.name}"`, { quiet: true });

      const res = await apiFetch(`/api/checkpoints/${checkpoint.id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not read the checkpoint.');

      applyLoadedState(data.checkpoint.state || {});
      await saveProjectState(data.checkpoint.state?.scenes || []);
      await loadCheckpoints();
      setActiveOverlay(null);
      showToast(`Restored "${checkpoint.name}". Your previous state was saved as a checkpoint first.`, 'success');
    } catch (err) {
      showToast(`Restore failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, checkpoint: false }));
    }
  };

  const handleDeleteCheckpoint = async (checkpoint) => {
    try {
      const res = await apiFetch(`/api/checkpoints/${checkpoint.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'Delete failed');
      setCheckpoints(prev => prev.filter(entry => entry.id !== checkpoint.id));
    } catch (err) {
      showToast(`Could not delete: ${err.message}`, 'error');
    }
  };

  // --- STATE IMPORT/EXPORT ---
  const handleExportState = () => {
    // Built by the same function autosave and Save As use. It used to list the
    // fields by hand, which meant anything added later — the edit, the tag
    // flags — quietly failed to export.
    const payload = buildStatePayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'project_state.json';
    link.click();
    URL.revokeObjectURL(url);
    showToast('Project State JSON exported.');
  };

  // Both import buttons run the same normaliser, so a shot-list document works
  // through "Import State JSON" and a full export works through "Import Shot
  // List". Previously the legacy path only understood `assetLibrary`, so an
  // LLM-authored file's `assets` were silently discarded.
  const handleImportState = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      let parsed;
      try {
        parsed = JSON.parse(evt.target.result);
      } catch (err) {
        showToast('JSON Parse Error: ' + err.message, 'error');
        return;
      }
      try {
        applyImportedDocument(parsed, 'replace', { restoreGalleries: true });
        showToast('Project state imported.', 'success');
      } catch (err) {
        showToast('Import failed: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  };

  // Filter batch jobs active count
  const activeJobsCount = batchJobs.filter(j => j.status === 'running').length;

  const activeScene = scenes.find(s => s.id === activeSceneId) || scenes[0];
  const activeSceneShots = activeScene ? (activeScene.shots || []) : [];

  // Hosted build, no usable folder yet: everything else is pointless until the
  // user grants access, so gate the whole app behind one clear choice.
  const showStartupGate = runtimeMode === 'static'
    && (needsFolderPermission || project.needsFolder || !projectFs.isFileSystemAccessSupported());

  // The editor is a separate view, not an overlay: it unmounts the creation UI
  // entirely so the two never have to share layout or keyboard shortcuts.
  if (view === 'edit' && !showStartupGate) {
    return (
      <EditView
        scenes={scenes}
        edit={edit}
        setEdit={setEdit}
        videoDuration={videoDuration}
        onToast={showToast}
        onClose={() => setView('create')}
      />
    );
  }

  if (showStartupGate) {
    const unsupported = !projectFs.isFileSystemAccessSupported();
    return (
      <div className="app-container">
        {toast && (
          <div className="toast"><Sparkles size={16} /><span>{toast.message}</span></div>
        )}
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
          <div className="glass-panel" style={{ padding: '32px', maxWidth: '560px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div className="header-logo">MM</div>
              <div>
                <h1 style={{ fontSize: '1.5rem' }}>MovieMaker Studio</h1>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>Hosted build — your files stay on your machine</span>
              </div>
            </div>

            {unsupported ? (
              <>
                <div style={{ display: 'flex', gap: '8px', color: 'var(--accent)', fontSize: '0.9rem' }}>
                  <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: '2px' }} />
                  <span>This browser can't open local folders.</span>
                </div>
                <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  MovieMaker stores your projects as real files on your own disk, which needs the File System
                  Access API — currently Chrome, Edge and other Chromium browsers. Firefox and Safari don't
                  implement it. Open this page in Chrome or Edge to continue.
                </p>
              </>
            ) : needsFolderPermission ? (
              <>
                <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  Welcome back. Your browser needs one click to re-grant access to
                  {' '}<strong style={{ color: 'var(--text-main)' }}>{projectFs.getActiveName()}</strong>.
                </p>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  <button className="btn btn-primary" onClick={handleReconnectFolder}>
                    <FolderOpen size={16} /> Reconnect "{projectFs.getActiveName()}"
                  </button>
                  <button className="btn btn-secondary" onClick={() => adoptStaticProject()}>
                    Choose a different folder…
                  </button>
                </div>
              </>
            ) : (
              <>
                <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  Pick a folder to work in. The project file and every generated image and video are written
                  straight into it — nothing is uploaded to this site, and there's no server involved.
                  An empty folder starts a new project; a folder you've used before reopens it.
                </p>
                <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={loadingStates.project} onClick={() => adoptStaticProject()}>
                  {loadingStates.project ? <RefreshCw className="spinner" size={16} /> : <FolderOpen size={16} />} Choose Project Folder…
                </button>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                  You'll also need API keys — add them under Settings once you're in. They're stored in this
                  browser only.
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

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
              <span
                title={isStatic()
                  ? 'Hosted build: files on your disk, keys in this browser, no server'
                  : 'Local server build: FFmpeg stitching and native dialogs available'}
                style={{ marginLeft: '2px', fontSize: '0.6rem', letterSpacing: '0.04em', textTransform: 'uppercase', padding: '1px 5px', borderRadius: '3px', background: 'rgba(255,255,255,0.08)', color: 'var(--text-dim)' }}
              >
                {runtimeMode === 'static' ? 'local files' : 'server'}
              </span>
            </button>
          </div>
        </div>

        <div className="header-actions">
          {/* Menus carry every global command. What stays outside them reports
              live state (the batch chip) or switches mode (Create / Edit) —
              neither is a command, so neither belongs in a dropdown. */}
          <nav className="menu-bar">
            <Menu label="Project" icon={FolderOpen}>
              <MenuItem icon={Plus} onClick={() => { setActiveOverlay('projects'); setNewProjectDraft({ directory: '', name: '' }); }}>
                New project…
              </MenuItem>
              <MenuItem icon={FolderOpen} onClick={() => setActiveOverlay('projects')}>
                Open / recent…
              </MenuItem>
              <MenuItem icon={Save} disabled={isStatic()} onClick={handleSaveProjectAs} title={isStatic() ? 'Needs the local server build' : undefined}>
                Save a copy as…
              </MenuItem>
              <MenuItem icon={Clock} onClick={() => setActiveOverlay('projects')}>
                Checkpoints…
              </MenuItem>

              <MenuSeparator />
              <MenuLabel>Shot list</MenuLabel>
              <MenuItem
                icon={Copy}
                onClick={handleCopyLlmPrompt}
                title="Copy the full schema + live model list to paste into an LLM"
              >
                Copy LLM prompt
              </MenuItem>
              <MenuItem
                icon={Upload}
                onClick={() => { shotListInputRef.current.dataset.mode = 'replace'; shotListInputRef.current.click(); }}
              >
                Import shot list…
              </MenuItem>
              <MenuItem
                icon={Plus}
                onClick={() => { shotListInputRef.current.dataset.mode = 'append'; shotListInputRef.current.click(); }}
                hint="append"
              >
                Import and add after…
              </MenuItem>

              <MenuSeparator />
              <MenuItem icon={FileJson} onClick={() => setActiveOverlay('settings')}>
                Backup / export…
              </MenuItem>
              <MenuItem icon={Upload} disabled={isStatic()} onClick={handleImportAssetsFromProject}>
                Import assets from another project…
              </MenuItem>
            </Menu>

            <Menu label="Library" icon={Layers}>
              {(() => {
                const missingImages = assetLibrary.filter(a => (a.images || []).length === 0).length;
                return (
                  <MenuItem
                    icon={Users}
                    onClick={() => setActiveOverlay('assets')}
                    badge={assetLibrary.length > 0 && (
                      <span className={`menu-badge ${missingImages ? 'warn' : 'ok'}`}>
                        {missingImages ? `${missingImages} / ${assetLibrary.length}` : assetLibrary.length}
                      </span>
                    )}
                  >
                    Assets
                  </MenuItem>
                );
              })()}
              <MenuItem
                icon={ImageIcon}
                onClick={() => setReferencePanelOpen(true)}
                badge={referenceImages.length > 0 && <span className="menu-badge">{referenceImages.length}</span>}
              >
                Reference board
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={ImageIcon} onClick={() => setActiveOverlay('images')}>Generated images</MenuItem>
              <MenuItem icon={Film} onClick={() => setActiveOverlay('videos')}>Generated videos</MenuItem>
              <MenuItem icon={MessageSquare} onClick={() => setActiveOverlay('snippets')}>Prompt snippets</MenuItem>
            </Menu>

            <Menu label="Generate" icon={Zap}>
              <MenuItem
                icon={ImageIcon}
                disabled={Boolean(batchRunner)}
                onClick={() => setBatchDialog({ type: 'image', scope: 'scene' })}
              >
                Batch images…
              </MenuItem>
              <MenuItem
                icon={Film}
                disabled={Boolean(batchRunner)}
                onClick={() => setBatchDialog({ type: 'video', scope: 'scene' })}
              >
                Batch videos…
              </MenuItem>
              <MenuItem
                icon={Users}
                disabled={Boolean(batchRunner) || assetLibrary.length === 0}
                onClick={() => setAssetBatchDialog({ onlyMissing: true, useLlm: true, rewriteExisting: false })}
              >
                Batch asset references…
              </MenuItem>

              <MenuSeparator />
              <MenuItem
                icon={Clock}
                onClick={() => setActiveOverlay('batch')}
                badge={activeJobsCount > 0 && <span className="menu-badge">{activeJobsCount}</span>}
              >
                Batch manager
              </MenuItem>
              {batchRunner && (
                <MenuItem icon={StopCircle} danger onClick={handleCancelBatch}>
                  Stop the running batch ({batchRunner.done}/{batchRunner.total})
                </MenuItem>
              )}
            </Menu>

            <Menu label="Render" icon={Film}>
              <MenuItem
                icon={Film}
                disabled={loadingStates.compilation || isStatic()}
                onClick={handleStitchCompilation}
                title={isStatic() ? 'Stitching needs FFmpeg — only in the local server build' : 'Stitch every selected shot video'}
              >
                Concatenate the whole film
              </MenuItem>
              <MenuItem
                icon={Film}
                disabled={loadingStates.compilation || isStatic() || !activeScene}
                onClick={() => activeScene && handleConcatenateScene(activeScene.id)}
              >
                Compile this scene only
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={LayoutGrid} onClick={() => setActiveOverlay('storyboard')}>
                Storyboard
              </MenuItem>
            </Menu>
          </nav>

          {/* Create / Edit is a mode switch, so it reads as one rather than as
              another button in the row. */}
          <div className="view-switch">
            <button className="active">Create</button>
            <button onClick={() => setView('edit')} title="Trim, reorder, dissolve and mix">
              <Scissors size={13} /> Edit
            </button>
          </div>

          <div
            className={`batch-status-chip ${activeJobsCount > 0 ? 'active' : ''}`}
            onClick={() => setActiveOverlay('batch')}
            title="Open the batch manager"
          >
            <Clock size={16} />
            <span>
              {batchRunner
                ? `Batch ${batchRunner.done}/${batchRunner.total}`
                : `${activeJobsCount} generating`}
            </span>
          </div>

          <button
            className={`btn btn-secondary ${referencePanelOpen ? 'active' : ''}`}
            style={{ padding: '8px', borderRadius: '50%' }}
            onClick={() => setReferencePanelOpen(v => !v)}
            title="Reference board"
          >
            <ImageIcon size={17} />
          </button>

          <button
            className={`btn btn-secondary ${activeOverlay === 'settings' ? 'active' : ''}`}
            style={{ padding: '8px', borderRadius: '50%' }}
            onClick={() => setActiveOverlay(activeOverlay === 'settings' ? null : 'settings')}
            title="Settings"
          >
            <Settings size={17} />
          </button>

          <button
            className="btn btn-secondary"
            style={{ padding: '8px', borderRadius: '50%' }}
            onClick={() => setActiveOverlay('help')}
            title="Help & import guide"
          >
            <HelpCircle size={17} />
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
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    className="btn btn-secondary"
                    style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                    disabled={loadingStates.capture}
                    title="Save the frame at the playhead as an image, for use on any following shot"
                    onClick={(e) => handleCaptureVideoFrame(
                      e.currentTarget.closest('.glass-panel')?.querySelector('video'),
                      null,
                      'Compiled frame'
                    )}
                  >
                    <ImageIcon size={11} /> Capture Frame
                  </button>
                  <button className="btn btn-secondary" style={{ padding: '2px 6px', fontSize: '0.7rem' }} onClick={() => setConcatenatedVideo(null)}>
                    Clear Preview
                  </button>
                </div>
              </div>
              <AssetVideo path={concatenatedVideo} controls style={{ width: '100%', borderRadius: '6px', maxHeight: '250px', background: '#000' }} />
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

            {/* The shot-list file input is hidden but must stay mounted — the
                Project menu triggers it. */}
            <input type="file" accept=".json" ref={shotListInputRef} onChange={(e) => handleImportShotList(e, shotListInputRef.current?.dataset.mode || 'replace')} style={{ display: 'none' }} />

            {activeScene && (
              <div className="scene-meta-row">
                <label>
                  Scene name
                  <input
                    type="text"
                    className="input-field"
                    value={activeScene.name || ''}
                    onChange={(e) => handleRenameScene(activeScene.id, e.target.value)}
                  />
                </label>

                {/* References the whole scene carries, and whether each is
                    actually sent. Shots inherit these unless they opt out. */}
                <ReferenceStrip
                  compact
                  label="Scene references"
                  entries={resolveSceneReferences({ scene: activeScene, references: referenceImages, assignments: refAssignments })}
                  onToggleEntry={toggleSceneReferenceEntry}
                  onOpenPanel={() => setReferencePanelOpen(true)}
                  // A scene generates nothing itself, so there is no model and
                  // no capacity claim to make here.
                  capacity={null}
                />
              </div>
            )}
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
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    className="btn btn-secondary"
                    style={{ padding: '1px 4px', fontSize: '0.65rem' }}
                    disabled={loadingStates.capture}
                    title="Save the frame at the playhead as an image, for use on any following shot"
                    onClick={(e) => handleCaptureVideoFrame(
                      e.currentTarget.closest('.glass-panel')?.querySelector('video'),
                      null,
                      'Scene frame'
                    )}
                  >
                    <ImageIcon size={10} /> Capture Frame
                  </button>
                  <button className="btn btn-secondary" style={{ padding: '1px 4px', fontSize: '0.65rem' }} onClick={() => {
                    const updated = scenes.map(s => s.id === activeScene.id ? { ...s, sceneConcatenatedVideo: null } : s);
                    setScenes(updated);
                    saveProjectState(updated);
                  }}>
                    Clear Preview
                  </button>
                </div>
              </div>
              <AssetVideo path={activeScene.sceneConcatenatedVideo} controls style={{ width: '100%', borderRadius: '4px', maxHeight: '180px', background: '#000' }} />
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
                          <AssetImage path={shot.selectedImage} alt="select visual" />
                        ) : (
                          'No Image'
                        )}
                      </div>

                      <div className="mini-preview" title="Active Video Select">
                        {shot.selectedVideo ? (
                          <AssetVideo path={shot.selectedVideo} />
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
                      
                      <div className="form-group" style={{ marginBottom: '12px' }}>
                        <label className="form-label">Shot Name</label>
                        <input
                          type="text"
                          className="input-field"
                          value={shot.name || ''}
                          onChange={(e) => handleUpdateShotField(shot.id, 'name', e.target.value)}
                          placeholder={`Shot ${index + 1}`}
                        />
                      </div>

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

                      {/* What this shot will actually upload. Assigned references
                          were previously invisible here — you could attach one and
                          never see it again outside the generation modal. Each tick
                          persists, so a batch run sends exactly this set. */}
                      <div style={{ marginTop: '12px' }}>
                        <ReferenceStrip
                          entries={shotReferenceEntries(shot)}
                          capacity={refImageCapacity('image', shot.imageModel || imageModel)}
                          onToggleEntry={(entry) => toggleShotReferenceEntry(shot, entry)}
                          onOpenPanel={() => { setActiveShotId(shot.id); setReferencePanelOpen(true); }}
                        />
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
                                <AssetImage path={shot.selectedImage} alt="active visual" />
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
                                <AssetVideo path={shot.selectedVideo} controls />
                                <button
                                  className="btn btn-primary"
                                  style={{ position: 'absolute', bottom: '6px', left: '6px', padding: '4px 8px', fontSize: '0.7rem' }}
                                  disabled={loadingStates.capture}
                                  title="Save the frame at the playhead as an image — you'll choose what happens with it next"
                                  onClick={(e) => handleCaptureVideoFrame(
                                    e.currentTarget.closest('.preview-slot')?.querySelector('video'),
                                    shot.id,
                                    shot.name || 'Frame'
                                  )}
                                >
                                  <ImageIcon size={11} /> Capture Frame
                                </button>
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
                                    {shot.imagePrompts.map((pg, i) => (
                                      <option key={pg.id} value={pg.id}>
                                        {`#${i + 1} (${(pg.outputs || []).length}) `}
                                        {pg.prompt.length > 40 ? pg.prompt.substring(0, 40) + '...' : pg.prompt}
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
                                          <AssetImage path={out.path} alt={out.name} />
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
                                    {shot.videoPrompts.map((pg, i) => (
                                      <option key={pg.id} value={pg.id}>
                                        {`#${i + 1} (${(pg.outputs || []).length}) `}
                                        {pg.prompt.length > 40 ? pg.prompt.substring(0, 40) + '...' : pg.prompt}
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
                                          <AssetVideo path={out.path} controls />
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
                                              className="btn btn-secondary"
                                              style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                                              disabled={loadingStates.capture}
                                              title="Save the frame at the playhead as an image — you'll choose what happens with it next"
                                              onClick={(e) => handleCaptureVideoFrame(
                                                e.currentTarget.closest('.iteration-card')?.querySelector('video'),
                                                shot.id,
                                                out.name
                                              )}
                                            >
                                              <ImageIcon size={10} /> Frame
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
                  Auto Prompt
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
                  generationModal.type === 'image' ? genModalInputImages : (genModalImageInput ? [genModalImageInput] : []),
                  genModalAttachTags,
                  genModalExcludedImages
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

                    {preview.missingTags.length > 0 && (
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px', alignItems: 'center' }}>
                        <AlertTriangle size={12} style={{ color: 'var(--accent)' }} />
                        <span style={{ fontSize: '0.72rem', color: 'var(--accent)' }}>
                          Undefined tag{preview.missingTags.length === 1 ? '' : 's'}: &lt;{preview.missingTags.join('&gt;, &lt;')}&gt; — add them in Assets or they go through as plain text.
                        </span>
                      </div>
                    )}

                    {/* Exactly which images go with the request, in send order. */}
                    <div style={{ marginTop: '12px', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '10px', background: 'rgba(0,0,0,0.18)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' }}>
                        <span style={{ fontSize: '0.78rem', fontWeight: 'bold' }}>
                          Images sent with this request
                          <span style={{ marginLeft: '6px', fontWeight: 'normal', color: 'var(--text-dim)' }}>
                            {preview.imageSources.length} of {preview.capacity} slot{preview.capacity === 1 ? '' : 's'}
                          </span>
                        </span>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                          <input
                            type="checkbox"
                            checked={genModalAttachTags}
                            onChange={(e) => setGenModalAttachTags(e.target.checked)}
                          />
                          Attach tagged images
                        </label>
                      </div>

                      {preview.imageSources.length === 0 ? (
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                          {preview.capacity === 0
                            ? 'This model takes no image input — text only.'
                            : generationModal.type === 'video'
                              ? 'None — this will be text-to-video. Pick a shot image below to animate it instead.'
                              : 'None — this will be generated from the prompt alone.'}
                        </span>
                      ) : (
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                          {preview.imageSources.map((entry, index) => (
                            <div key={entry.path} style={{ width: '86px', textAlign: 'center', position: 'relative' }}>
                              <div style={{ position: 'relative', height: '58px', borderRadius: '4px', overflow: 'hidden', border: `2px solid ${entry.origin === 'primary' ? 'var(--success)' : 'var(--primary)'}`, background: '#000' }}>
                                <AssetImage path={entry.path} alt={entry.label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                <span style={{ position: 'absolute', top: '2px', left: '2px', fontSize: '0.6rem', fontWeight: 'bold', background: 'rgba(0,0,0,0.75)', color: '#fff', borderRadius: '3px', padding: '0 4px' }}>
                                  {index + 1}
                                </span>
                                <button
                                  type="button"
                                  className="btn btn-danger"
                                  style={{
                                    position: 'absolute',
                                    top: '2px',
                                    right: '2px',
                                    padding: '2px',
                                    borderRadius: '50%',
                                    width: '18px',
                                    height: '18px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    zIndex: 3,
                                    cursor: 'pointer'
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeselectSentImage(entry.path, entry.origin);
                                  }}
                                  title={`Deselect ${entry.label}`}
                                >
                                  <X size={10} />
                                </button>
                              </div>
                              <span style={{ fontSize: '0.62rem', color: entry.origin === 'primary' ? 'var(--success)' : 'var(--primary-hover)', display: 'block', marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {entry.label}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      {preview.droppedImageSources.length > 0 && (
                        <div style={{ fontSize: '0.72rem', color: 'var(--accent)', marginTop: '8px', display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
                          <AlertTriangle size={11} style={{ marginTop: '2px', flexShrink: 0 }} />
                          <span>
                            Not sent (model takes {preview.capacity}):{' '}
                            {/* Collapse repeats so eight images from one asset
                                read as "<Sara> ×8" rather than eight entries. */}
                            {Object.entries(
                              preview.droppedImageSources.reduce((acc, entry) => {
                                acc[entry.label] = (acc[entry.label] || 0) + 1;
                                return acc;
                              }, {})
                            ).map(([label, count]) => (count > 1 ? `${label} ×${count}` : label)).join(', ')}
                          </span>
                        </div>
                      )}
                    </div>
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
                      const selected = genModalInputImages.includes(ref.path) && !genModalExcludedImages.includes(ref.path);
                      return (
                        <button
                          key={ref.id}
                          type="button"
                          className={`generation-reference-card ${selected ? 'selected' : ''}`}
                          onClick={() => {
                            setGenModalExcludedImages(prev => prev.filter(p => p !== ref.path));
                            setGenModalInputImages(prev => {
                              if (prev.includes(ref.path)) return prev.filter(path => path !== ref.path);
                              const capacity = refImageCapacity('image', genModalModel);
                              if (prev.length >= capacity) {
                                showToast(`This model accepts up to ${capacity} input image${capacity === 1 ? '' : 's'}.`, 'warning');
                                return prev;
                              }
                              return [...prev, ref.path];
                            });
                          }}
                          title={selected ? `Remove ${ref.name}` : `Add ${ref.name}`}
                        >
                          <AssetImage path={ref.path} alt={ref.name} />
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
                                    <AssetImage path={img.path} alt={img.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
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

      {/* --- A0. FLOATING OVERLAY: STORYBOARD --- */}
      {activeOverlay === 'storyboard' && (() => {
        const totalShots = scenes.reduce((n, s) => n + (s.shots || []).length, 0);
        const withImage = scenes.reduce((n, s) => n + (s.shots || []).filter(sh => sh.selectedImage).length, 0);

        return (
          <div className="modal-overlay" onClick={() => setActiveOverlay(null)}>
            <div className="modal-window gallery-modal-window" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <LayoutGrid size={20} /> Storyboard
                  <span style={{ fontSize: '0.8rem', fontWeight: 'normal', color: 'var(--text-dim)' }}>
                    {withImage} / {totalShots} shots have an image
                  </span>
                </h2>
                <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setActiveOverlay(null)}>
                  <X size={16} />
                </button>
              </div>

              <div className="modal-body">
                {scenes.map((scene, sceneIndex) => (
                  <div key={scene.id} style={{ marginBottom: '28px' }}>
                    <h3 style={{
                      fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '8px',
                      borderBottom: '1px solid var(--border-light)', paddingBottom: '6px', marginBottom: '12px'
                    }}>
                      <Film size={15} />
                      Scene {sceneIndex + 1}: {scene.name}
                      <span style={{ fontWeight: 'normal', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
                        {(scene.shots || []).length} shot{(scene.shots || []).length === 1 ? '' : 's'}
                      </span>
                    </h3>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '14px' }}>
                      {(scene.shots || []).map((shot, shotIndex) => (
                        <div
                          key={shot.id}
                          onClick={() => {
                            setActiveSceneId(scene.id);
                            setActiveShotId(shot.id);
                            setCollapsedShots(prev => ({ ...prev, [shot.id]: false }));
                            setActiveOverlay(null);
                          }}
                          title="Jump to this shot"
                          style={{
                            cursor: 'pointer', borderRadius: '6px', overflow: 'hidden',
                            border: `1px solid ${shot.id === activeShotId ? 'var(--primary)' : 'var(--border-light)'}`,
                            background: 'rgba(255,255,255,0.02)', display: 'flex', flexDirection: 'column'
                          }}
                        >
                          <div style={{ position: 'relative', aspectRatio: '16 / 9', background: '#000' }}>
                            {shot.selectedImage ? (
                              <AssetImage
                                path={shot.selectedImage}
                                alt={shot.name}
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              />
                            ) : (
                              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: '0.72rem', textAlign: 'center', padding: '8px' }}>
                                No image yet
                              </div>
                            )}
                            <span style={{ position: 'absolute', top: '4px', left: '4px', fontSize: '0.62rem', fontWeight: 'bold', background: 'rgba(0,0,0,0.75)', color: '#fff', borderRadius: '3px', padding: '1px 5px' }}>
                              {sceneIndex + 1}.{shotIndex + 1}
                            </span>
                            {shot.selectedVideo && (
                              <span title="Has video" style={{ position: 'absolute', top: '4px', right: '4px', background: 'rgba(16,185,129,0.85)', color: '#fff', borderRadius: '3px', padding: '1px 4px', display: 'flex', alignItems: 'center' }}>
                                <Film size={10} />
                              </span>
                            )}
                          </div>
                          <div style={{ padding: '7px 8px' }}>
                            <div style={{ fontSize: '0.76rem', fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {shot.name || `Shot ${shotIndex + 1}`}
                            </div>
                            <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                              {shot.description || shot.setup || ''}
                            </div>
                          </div>
                        </div>
                      ))}
                      {(scene.shots || []).length === 0 && (
                        <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>No shots in this scene.</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

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
                {!project.needsFolder && (
                  <span style={{ fontSize: '0.78rem', color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '5px', marginTop: '4px' }}>
                    <Check size={12} /> Autosaves continuously — no save button needed.
                  </span>
                )}

                {project.needsFolder && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--accent)', display: 'flex', alignItems: 'flex-start', gap: '5px', marginTop: '4px' }}>
                    <AlertTriangle size={12} style={{ marginTop: '3px', flexShrink: 0 }} />
                    <span>Nothing is being saved yet. Choose a folder on your machine — the project file and every generated image and video land there.</span>
                  </div>
                )}

                {project.isLegacy && !isStatic() && (
                  <div style={{ fontSize: '0.78rem', color: 'var(--accent)', display: 'flex', alignItems: 'flex-start', gap: '5px', marginTop: '4px' }}>
                    <AlertTriangle size={12} style={{ marginTop: '3px', flexShrink: 0 }} />
                    <span>Not a real project file yet. Use <strong>Save As</strong> to turn this into a proper project folder you can reopen later.</span>
                  </div>
                )}

                {project.path && !isStatic() && (
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
                <button
                  className="btn btn-primary"
                  disabled={loadingStates.browse || loadingStates.project}
                  onClick={() => (isStatic() ? handleCreateProject() : setNewProjectDraft({ directory: '', name: '' }))}
                >
                  <Plus size={14} /> New Project{isStatic() ? ' Folder…' : ''}
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

              {/* Checkpoints — versions of this project, without a new project */}
              <div className="glass-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Checkpoints</span>
                  <p style={{ margin: '4px 0 0', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    A named snapshot of the shot list, every setting, the galleries and the edit.
                    Media is shared rather than copied, so these are cheap — take one before any
                    big change. Restoring saves where you are first, so nothing is ever lost.
                  </p>
                </div>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    className="form-input"
                    style={{ flex: 1 }}
                    placeholder="Name this checkpoint (optional)"
                    value={checkpointName}
                    onChange={(e) => setCheckpointName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSaveCheckpoint(); }}
                    disabled={project.needsFolder}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={handleSaveCheckpoint}
                    disabled={loadingStates.checkpoint || project.needsFolder}
                    title={project.needsFolder ? 'Choose a project folder first' : 'Snapshot everything as it is right now'}
                  >
                    {loadingStates.checkpoint ? <RefreshCw className="spinner" size={14} /> : <Save size={14} />} Save checkpoint
                  </button>
                </div>

                {checkpoints.length === 0 ? (
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                    No checkpoints yet.
                  </span>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '260px', overflowY: 'auto' }}>
                    {checkpoints.map(entry => (
                      <div
                        key={entry.id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px',
                          borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-light)',
                          background: 'var(--bg-card)'
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '0.82rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {entry.name}
                          </div>
                          <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>
                            {new Date(entry.createdAt).toLocaleString()}
                            {entry.summary && ` · ${entry.summary.shots} shots, ${entry.summary.shotsWithVideo} with video${entry.summary.editClips ? `, ${entry.summary.editClips} clips cut` : ''}`}
                          </div>
                        </div>
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: '0.72rem', padding: '4px 10px' }}
                          disabled={loadingStates.checkpoint}
                          onClick={() => handleRestoreCheckpoint(entry)}
                        >
                          <RotateCcw size={12} /> Restore
                        </button>
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: '0.72rem', padding: '4px 8px' }}
                          title="Delete this checkpoint"
                          onClick={() => handleDeleteCheckpoint(entry)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* New project inline form (server build only — the hosted build
                  uses the browser's own folder picker) */}
              {newProjectDraft && !isStatic() && (
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
                          onClick={() => handleOpenProject(entry.path, entry.handle)}
                        >
                          {isActive ? 'Open' : 'Switch'}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>

              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                {isStatic() ? (
                  <>
                    A project is a folder you pick on your own machine: <code>project.mmproj.json</code> plus
                    an <code>assets/</code> directory holding every generated image and video. Nothing is
                    uploaded to the site — the page reads and writes those files directly. Browsers only allow
                    this in Chrome or Edge.
                  </>
                ) : (
                  <>
                    A project is a folder: <code>MyFilm/MyFilm.mmproj.json</code> plus <code>MyFilm/assets/</code>.
                    Zip it, move it, or drop it on a shared drive — the project re-anchors to wherever the file
                    actually is, so media keeps resolving.
                  </>
                )}
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
                          <AssetImage path={asset.primaryImage} alt={asset.tag} />
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
                const capacity = refImageCapacity('image', modelId);
                const picked = assetInputImages(assetEditor).filter(p => (assetEditor.images || []).includes(p));
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

                    {/* Three-way rather than a checkbox: reference art usually
                        wants its own neutral wrapper, not the film's grade. The
                        old boolean could only pick between the image pre/post
                        and nothing at all. */}
                    <div className="form-group" style={{ maxWidth: '320px' }}>
                      <label className="form-label">Pre / post prompt to wrap this in</label>
                      <select
                        className="select-field"
                        value={assetEditor.promptWrap || (assetEditor.applyGlobalPrompts ? 'image' : 'asset')}
                        onChange={(e) => setAssetEditor({ ...assetEditor, promptWrap: e.target.value })}
                      >
                        <option value="asset">Asset reference pre/post{assetPrePrompt || assetPostPrompt ? '' : ' (empty — set it in Settings)'}</option>
                        <option value="image">The film's image pre/post</option>
                        <option value="none">None — prompt exactly as written</option>
                      </select>
                    </div>

                    {/* What the model is being shown. Picked below in Reference
                        Images, and topped up by whatever the board aims at this
                        asset. The bulk-select helpers stay available whatever
                        the model does, so a model change never removes controls. */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                      {capacity === 0 ? (
                        <span><strong>{getImageModel(modelId)?.label || modelId}</strong> takes no reference images — prompt only. Your picks below are kept.</span>
                      ) : (
                        <>
                          <span>
                            Sending <strong>{picked.length}</strong> of up to <strong>{capacity}</strong> reference image{capacity === 1 ? '' : 's'}.
                          </span>
                          {picked.length > capacity && (
                            <span style={{ color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <AlertTriangle size={12} /> This model reads only the first {capacity}; untick the rest.
                            </span>
                          )}
                        </>
                      )}
                      <button
                        className="btn btn-secondary"
                        style={{ fontSize: '0.72rem', padding: '3px 8px' }}
                        disabled={!assetEditor.primaryImage}
                        onClick={() => setAssetEditor({ ...assetEditor, inputImages: assetEditor.primaryImage ? [assetEditor.primaryImage] : [] })}
                      >
                        Just the primary
                      </button>
                      <button
                        className="btn btn-secondary"
                        style={{ fontSize: '0.72rem', padding: '3px 8px' }}
                        disabled={(assetEditor.images || []).length === 0}
                        onClick={() => setAssetEditor({
                          ...assetEditor,
                          inputImages: capacity > 0
                            ? (assetEditor.images || []).slice(0, capacity)
                            : [...(assetEditor.images || [])]
                        })}
                      >
                        Select all
                      </button>
                      <button
                        className="btn btn-secondary"
                        style={{ fontSize: '0.72rem', padding: '3px 8px' }}
                        disabled={picked.length === 0}
                        onClick={() => setAssetEditor({ ...assetEditor, inputImages: [] })}
                      >
                        Clear
                      </button>
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

              {(() => {
                const pool = assetEditor.images || [];
                const capacity = assetRefCapacity(assetEditor);
                const picked = assetInputImages(assetEditor).filter(p => pool.includes(p));

                return (
                  <div className="form-group">
                    <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      Reference Images ({pool.length})
                      <span style={{ fontWeight: 'normal', fontSize: '0.75rem', color: capacity > 0 && picked.length >= capacity ? 'var(--accent)' : 'var(--text-dim)' }}>
                        {capacity > 0
                          ? `${picked.length}/${capacity} ticked to send with the next generation`
                          : `${picked.length} ticked — kept for when you pick a model that reads them`}
                      </span>
                    </label>
                    <span className="input-help" style={{ fontSize: '0.75rem', color: 'var(--text-dim)', display: 'block', marginBottom: '8px' }}>
                      Click one to make it the primary — that is the single image sent with &lt;{assetEditor.tag || 'Tag'}&gt; in other prompts.
                      Tick the checkboxes to send several of them <em>into</em> this asset's own generation, up to what the model takes.
                      Double-click to view large.
                    </span>

                    {/* The ticks used to disappear entirely on a model with no
                        image inputs, which reads as the control having been
                        taken away rather than as a fact about the model. Say
                        which model, and keep the choices editable so switching
                        model does not mean re-picking everything. */}
                    {capacity === 0 && pool.length > 0 && (
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', marginBottom: '8px', padding: '7px 9px', borderRadius: '6px', background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.25)', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        <AlertTriangle size={13} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: '1px' }} />
                        <span>
                          <strong>{getImageModel(assetEditorModel(assetEditor))?.label || assetEditorModel(assetEditor)}</strong> reads no
                          reference images, so nothing below is uploaded no matter what is ticked. Your ticks are still
                          saved — switch the <em>Model</em> above to one that accepts inputs and they take effect.
                        </span>
                      </div>
                    )}
                    <input type="file" accept="image/*" multiple ref={assetUploadRef} onChange={handleAssetImageUpload} style={{ display: 'none' }} />
                    <div className="generation-reference-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '8px' }}>
                      {pool.map(imagePath => {
                        const isPrimary = assetEditor.primaryImage === imagePath;
                        const isSending = picked.includes(imagePath);
                        return (
                          <div
                            key={imagePath}
                            className={`generation-reference-card ${isPrimary ? 'selected' : ''}`}
                            style={{ position: 'relative', height: '110px', borderRadius: '6px', overflow: 'hidden', border: isSending ? '2px solid var(--primary)' : '1px solid var(--border-light)', cursor: 'pointer' }}
                            onClick={() => setAssetEditor({ ...assetEditor, primaryImage: imagePath })}
                            onDoubleClick={() => handleImageDoubleClick(imagePath, assetEditor.tag || 'asset')}
                            title={isPrimary ? 'Primary reference' : 'Click to make primary, double-click to enlarge'}
                          >
                            <AssetImage path={imagePath} alt="asset reference" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            {isPrimary && <Check size={14} style={{ position: 'absolute', top: '4px', left: '4px', background: 'var(--success)', color: '#fff', borderRadius: '50%', padding: '2px' }} />}
                            {/* Always rendered. A control that vanishes when the
                                model changes is indistinguishable from one that
                                was removed. */}
                            <label
                              onClick={(e) => e.stopPropagation()}
                              title={capacity === 0
                                ? 'Saved, but this model reads no reference images'
                                : (isSending ? 'Sent as a reference with the next generation' : 'Send this image with the next generation')}
                              style={{ position: 'absolute', top: '4px', right: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', borderRadius: '4px', background: 'rgba(0,0,0,0.55)', cursor: 'pointer', opacity: capacity === 0 ? 0.55 : 1 }}
                            >
                              <input
                                type="checkbox"
                                checked={isSending}
                                onChange={() => toggleAssetInputImage(imagePath)}
                                style={{ cursor: 'pointer', margin: 0 }}
                              />
                            </label>
                            <button
                              className="btn btn-danger"
                              style={{ position: 'absolute', bottom: '4px', right: '4px', padding: '3px' }}
                              onClick={(e) => {
                                e.stopPropagation();
                                const remaining = pool.filter(p => p !== imagePath);
                                setAssetEditor({
                                  ...assetEditor,
                                  images: remaining,
                                  primaryImage: isPrimary ? (remaining[0] || null) : assetEditor.primaryImage,
                                  inputImages: picked.filter(p => p !== imagePath)
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
                        onClick={() => setRefBoardPicker({ selected: [] })}
                        style={{ border: '2px dashed var(--border-light)', background: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', color: 'var(--text-muted)', height: '110px', borderRadius: '6px' }}
                      >
                        <ImageIcon size={16} />
                        <span style={{ fontSize: '0.68rem', textAlign: 'center' }}>From Reference Board</span>
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
                );
              })()}
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setAssetEditor(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveAsset}><Save size={14} /> Save Asset</button>
            </div>
          </div>
        </div>
      )}

      {/* --- A3b. PULL REFERENCES OFF THE MASTER BOARD INTO AN ASSET --- */}
      {refBoardPicker && assetEditor && (() => {
        const pool = assetEditor.images || [];
        const chosen = refBoardPicker.selected;
        const toggle = (path) => setRefBoardPicker(prev => ({
          ...prev,
          selected: prev.selected.includes(path)
            ? prev.selected.filter(p => p !== path)
            : [...prev.selected, path]
        }));

        return (
          <div className="modal-overlay" onClick={() => setRefBoardPicker(null)}>
            <div className="modal-window" style={{ maxWidth: '760px', width: '92%', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <ImageIcon size={20} /> Reference Board → &lt;{assetEditor.tag || 'Asset'}&gt;
                </h2>
                <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setRefBoardPicker(null)}>
                  <X size={16} />
                </button>
              </div>

              <div className="modal-body" style={{ flex: 1, overflowY: 'auto' }}>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
                  Pick as many as you like — they join this asset's reference images. You then tick which of them
                  actually ride along with a generation, since the model caps how many it will read.
                </div>

                {referenceImages.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
                    The master reference board is empty. Add images to it from the Reference Imagery panel first.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '10px' }}>
                    {referenceImages.map(ref => {
                      const already = pool.includes(ref.path);
                      const selected = chosen.includes(ref.path);
                      return (
                        <button
                          key={ref.id}
                          type="button"
                          disabled={already}
                          onClick={() => toggle(ref.path)}
                          title={already ? 'Already one of this asset\'s reference images' : ref.name}
                          style={{
                            position: 'relative', padding: 0, borderRadius: '6px', overflow: 'hidden',
                            border: selected ? '2px solid var(--primary)' : '1px solid var(--border-color)',
                            background: 'rgba(255,255,255,0.02)', cursor: already ? 'default' : 'pointer',
                            opacity: already ? 0.45 : 1, display: 'flex', flexDirection: 'column'
                          }}
                        >
                          <div style={{ height: '95px', width: '100%', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <AssetImage path={ref.path} alt={ref.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                          </div>
                          {selected && <Check size={16} style={{ position: 'absolute', top: '4px', right: '4px', background: 'var(--success)', color: '#fff', borderRadius: '50%', padding: '2px' }} />}
                          <span style={{ fontSize: '0.68rem', padding: '5px 4px', color: 'var(--text-muted)', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%' }}>
                            {already ? `${ref.name} — added` : ref.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setRefBoardPicker(null)}>Cancel</button>
                <button
                  className="btn btn-primary"
                  disabled={chosen.length === 0}
                  onClick={() => {
                    // Also remember which board records these came from, so
                    // saving the asset links them instead of leaving two
                    // unrelated records pointing at one file.
                    const sourceIds = referenceImages.filter(r => chosen.includes(r.path)).map(r => r.id);
                    let ticked = 0;
                    setAssetEditor(prev => {
                      if (!prev) return prev;
                      const capacityHere = assetRefCapacity(prev);
                      // Pulling an image in is a statement of intent, so it
                      // arrives switched on rather than sitting inert until you
                      // notice a second checkbox. Only up to what the model
                      // reads, so nothing silently overflows.
                      const already = assetInputImages(prev);
                      const room = Math.max(0, capacityHere - already.length);
                      const newlySent = chosen.filter(p => !already.includes(p)).slice(0, room);
                      ticked = newlySent.length;

                      return {
                        ...prev,
                        images: [...(prev.images || []), ...chosen.filter(p => !(prev.images || []).includes(p))],
                        primaryImage: prev.primaryImage || chosen[0],
                        inputImages: [...already, ...newlySent],
                        linkedReferenceIds: [...new Set([...(prev.linkedReferenceIds || []), ...sourceIds])]
                      };
                    });
                    setRefBoardPicker(null);
                    showToast(
                      ticked === chosen.length
                        ? `${chosen.length} reference${chosen.length === 1 ? '' : 's'} added and set to send.`
                        : `${chosen.length} added, ${ticked} set to send — the model takes no more.`,
                      'success'
                    );
                  }}
                >
                  <Plus size={14} /> Add {chosen.length || ''} to asset
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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
                  {(() => {
                    const attaching = batchDialog.type === 'image' ? attachTagsForImages : attachTagsForVideos;
                    const withoutStill = batchDialog.type === 'video'
                      ? candidates.filter(({ shot }) => !shot.selectedImage).length
                      : 0;
                    // Count what will really be uploaded, so the dialog agrees
                    // with the ticks on the shot cards rather than promising
                    // every assigned reference.
                    const refTotal = batchDialog.type === 'image'
                      ? candidates.reduce((n, { shot }) => n + shotReferencePaths(shot).length, 0)
                      : 0;
                    const withoutRefs = batchDialog.type === 'image'
                      ? candidates.filter(({ shot }) => shotReferencePaths(shot).length === 0).length
                      : 0;
                    return (
                      <>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                          Reference images: <strong style={{ color: 'var(--text-muted)' }}>
                            {batchDialog.type === 'video'
                              ? "each shot's own selected image"
                              : `${refTotal} across these shots — only the ones still ticked`}
                          </strong>
                          {attaching ? ', plus tagged asset images where slots remain.' : '. Tagged asset images are NOT attached.'}
                          {' '}Change this in Settings.
                        </div>
                        {withoutRefs > 0 && batchDialog.type === 'image' && (
                          <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                            {withoutRefs} shot{withoutRefs === 1 ? '' : 's'} will run from the prompt alone — no references assigned or all held back.
                          </div>
                        )}
                        {withoutStill > 0 && (
                          <div style={{ fontSize: '0.78rem', color: 'var(--accent)', display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
                            <AlertTriangle size={12} style={{ marginTop: '3px', flexShrink: 0 }} />
                            <span>{withoutStill} shot{withoutStill === 1 ? ' has' : 's have'} no selected image — those run as text-to-video.</span>
                          </div>
                        )}
                      </>
                    );
                  })()}
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

              {importReport.undefinedTags?.length > 0 && (
                <div className="glass-panel" style={{ padding: '14px', background: 'rgba(139,92,246,0.06)', display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '12px' }}>
                  <span style={{ fontSize: '0.85rem' }}>
                    {importReport.undefinedTags.length} tag{importReport.undefinedTags.length === 1 ? ' is' : 's are'} used in prompts but not defined:
                    {' '}<strong style={{ color: 'var(--primary-hover)' }}>&lt;{importReport.undefinedTags.join('&gt; &lt;')}&gt;</strong>
                  </span>
                  <button
                    className="btn btn-primary"
                    style={{ alignSelf: 'flex-start' }}
                    onClick={() => handleCreateMissingAssets(importReport.undefinedTags)}
                  >
                    <Plus size={14} /> Create {importReport.undefinedTags.length} missing asset{importReport.undefinedTags.length === 1 ? '' : 's'}
                  </button>
                </div>
              )}

              {importReport.assetCount > 0 && (
                <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '12px', lineHeight: 1.6 }}>
                  Your {importReport.assetCount} asset{importReport.assetCount === 1 ? '' : 's'} came in with descriptions but no
                  images. Open <strong>Assets</strong> and hit <strong>Batch Generate</strong> to make a reference image for each —
                  after that, every <code>&lt;Tag&gt;</code> in a shot prompt carries that image into generation.
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => { setImportReport(null); setActiveOverlay('assets'); }}>
                <Users size={14} /> Open Assets ({importReport.assetCount})
              </button>
              <button className="btn btn-secondary" onClick={() => setImportReport(null)}>Done</button>
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
                        <AssetImage path={img.path} alt={img.name} />
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
                      <AssetVideo path={vid.path} controls />
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

      {/* --- REFERENCE BOARD (docked panel, not a modal — see ReferencePanel) --- */}
      {referencePanelOpen && (
        <ReferencePanel
          references={referenceImages}
          assignments={refAssignments}
          scenes={scenes}
          assetLibrary={assetLibrary}
          activeSceneId={activeSceneId}
          activeShotId={activeShotId}
          busy={loadingStates.ref_upload || loadingStates.project_images}
          onClose={() => setReferencePanelOpen(false)}
          onApplyAssignments={handleApplyAssignments}
          onAddToAssets={handleAddReferencesToAssets}
          onUnassign={handleUnassignReferences}
          onUpdateReferences={handleUpdateReferences}
          onDeleteReferences={handleDeleteReferences}
          onLinkToAsset={handleLinkReferencesToAsset}
          onCreateAssetFrom={handleCreateAssetFromReferences}
          onUpload={(files) => handleGalleryImageUpload({ target: { files } }, 'ref')}
          onAddFromProject={() => openProjectImageSelector('ref')}
          onPreview={(ref) => handleImageDoubleClick(ref.path, ref.name)}
        />
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
                        <AssetImage path={img.path} alt={img.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
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

      {/* --- SETTINGS (tabbed — see SettingsPanel) --- */}
      {activeOverlay === 'settings' && (
        <SettingsPanel
          apiKeys={apiKeys}
          setApiKeys={setApiKeys}
          onSaveCredentials={saveConfig}
          isStatic={isStatic()}
          activeLlm={activeLlm} setActiveLlm={setActiveLlm}
          llmModel={llmModel} setLlmModel={setLlmModel}
          llmModelsList={llmModelsList}
          imageModel={imageModel} setImageModel={setImageModel}
          imageResolution={imageResolution} setImageResolution={setImageResolution}
          videoModel={videoModel} setVideoModel={setVideoModel}
          videoResolution={videoResolution} setVideoResolution={setVideoResolution}
          videoDuration={videoDuration} setVideoDuration={setVideoDuration}
          batchConcurrency={batchConcurrency} setBatchConcurrency={setBatchConcurrency}
          attachTagsForImages={attachTagsForImages} setAttachTagsForImages={setAttachTagsForImages}
          attachTagsForVideos={attachTagsForVideos} setAttachTagsForVideos={setAttachTagsForVideos}
          theme={theme} onToggleTheme={handleToggleTheme}
          promptSettings={promptSettings}
          setPromptSetting={setPromptSetting}
          resetPromptSetting={resetPromptSetting}
          onImportState={handleImportState}
          onExportState={handleExportState}
          ModelOptions={ModelOptions}
          onClose={() => setActiveOverlay(null)}
        />
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

      {/* --- K. CAPTURE FRAME CHOICE MODAL --- */}
      {frameCaptureChoice && (
        <div className="modal-overlay" onClick={handleFrameChoiceLibraryOnly}>
          <div className="modal-window" style={{ maxWidth: '440px', width: '95%' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Frame Captured</h2>
              <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={handleFrameChoiceLibraryOnly}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: 0 }}>
                {frameCaptureChoice.imageName} is saved to the image gallery. What else should it do?
              </p>
              <button className="btn btn-primary" style={{ justifyContent: 'flex-start' }} onClick={handleFrameChoiceNextShot}>
                <ImageIcon size={14} /> Set as next shot's image
              </button>
              <button className="btn btn-primary" style={{ justifyContent: 'flex-start' }} onClick={handleFrameChoiceInsertShot}>
                <Plus size={14} /> Insert new shot with this image
              </button>
              <button className="btn btn-secondary" style={{ justifyContent: 'flex-start' }} onClick={handleFrameChoiceLibraryOnly}>
                Just keep it in the asset library
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
                    src={zoomImageUrl || undefined}
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
                <AssetImage path={zoomImage.path}
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
