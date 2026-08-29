import React, { useState, useEffect, useMemo, useRef } from 'react';
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
  RotateCcw,
  Moon,
  ClipboardPaste,
  Undo2,
  Redo2,
  FileText
} from 'lucide-react';
import SaveGuardBanner from './SaveGuardBanner.jsx';
import { emptyBaseline, adoptBaseline, saveHeaders } from './saveGuard.js';
import {
  IMAGE_MODELS,
  VIDEO_MODELS,
  LLM_PROVIDERS,
  PROVIDER_LABELS,
  getImageModel,
  getVideoModel,
  isKnownImageModel,
  isKnownVideoModel,
  priceLabel,
  groupedModelOptions,
  parseModelId,
  durationOptions,
  modelCapabilities,
  refAudioCapacity,
  refImageCapacity,
  setCustomModelOverrides,
  sizeOptions
} from './catalog.js';
import {
  ASSET_TYPES,
  assetInputImages,
  assetPrimaryImage,
  assetPromptText,
  buildAutoPromptContext,
  assetShotDescription,
  composeGenerationPrompt,
  defaultAssetPrompt,
  droppedTags,
  extractTags,
  findAssetByTag,
  normalizeTag,
  scanPromptTags,
  tagPreservationRule
} from './promptTags.js';
import {
  insertIntoPrompt,
  remapDecorations,
  removeDecoration,
  undecorate
} from './promptDecorations.js';
import PromptEditor, { EffectivePrompt } from './PromptEditor.jsx';
import { buildLlmImportPrompt, extractJsonDocument, normalizeImportedShotList } from './shotListImport.js';
import { apiFetch, resolveAssetUrl, detectMode, isStatic } from './client.js';
import {
  createAudioTrack, createEmptyEdit, deriveAudioClipsForShots, deriveVideoClips, migrateEdit
} from './edit/model.js';
import { makeContext, normalize } from './edit/timing.js';
import { reconcile } from './edit/reconcile.js';
import { createPipelineRun, estimateRun } from './pipeline.js';
import { autoAssignReferences } from './refAutoAssign.js';
import PipelinePanel from './PipelinePanel.jsx';
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
  KIND_BY_ASSET_TYPE,
  REFERENCE_SCHEMA_VERSION,
  assignReferences,
  enabledReferencePaths,
  migrateReferenceState,
  normalizeAssignment,
  normalizeReference,
  pruneAssignments,
  resolveSceneReferences,
  resolveShotReferences,
  setEdgeEnabled,
  unassignReferences
} from './references.js';
import ReferencePanel, { ReferenceStrip } from './ReferencePanel.jsx';
import SettingsPanel from './SettingsPanel.jsx';
import CustomModelPath from './CustomModelPath.jsx';
import { resolveModelSettings } from './modelSettings.js';
import { generateShotListFromIdea } from './scriptGen.js';
import { buildDirtyMap, dirtyImageCandidates, dirtyVideoCandidates, groupForSelection } from './dirty.js';
import MediaPickerDialog from './MediaPickerDialog.jsx';
import { collectShotMedia } from './imagePicker.js';
import DreamDialog from './DreamDialog.jsx';
import {
  DEFAULT_DREAM_SYSTEM_PROMPT,
  buildDreamUserMessage,
  compactDreamSettings,
  createDreamSettings,
  dreamShotName,
  parseDreamReply
} from './dream.js';
import { captureLastFrame } from './dreamFrame.js';
import {
  canRedo as historyCanRedo,
  canUndo as historyCanUndo,
  createHistory,
  describeChange,
  pushHistory,
  redoHistory,
  redoLabel as historyRedoLabel,
  undoHistory,
  undoLabel as historyUndoLabel
} from './history.js';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from './MenuBar.jsx';
import './reference.css';
import './menu.css';
import './settings.css';

// What each kind of queued job is called in the Batch Manager. Local ffmpeg work
// sits in the same queue as the remote generations — it is the slowest thing
// here, and a compile you cannot see running is a compile you start twice.
const JOB_TYPE_LABELS = {
  image: 'Image Prompt',
  video: 'Video Prompt',
  lipsync: 'Lip Sync',
  compile: 'FFmpeg Compile',
  watermark: 'FFmpeg Watermark',
  render: 'FFmpeg Render'
};

/**
 * A compact model pill: the resolved model + where it came from, and (when
 * editable) a hidden <select> over the whole pill so clicking it overrides or
 * clears the level it sits on. Clearing means inherit, never "no model".
 */
function ModelPill({ type, resolved, value, onChange, title }) {
  const models = type === 'image' ? IMAGE_MODELS : VIDEO_MODELS;
  const label = (type === 'image' ? getImageModel(resolved.model) : getVideoModel(resolved.model))?.label || resolved.model || '—';
  return (
    <span
      className="model-pill"
      title={title || `${type === 'image' ? 'Image' : 'Video'} model: ${resolved.model || 'none'} (from ${resolved.source})`}
      style={{
        position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '4px',
        padding: '1px 8px', borderRadius: '999px', fontSize: '0.68rem', cursor: onChange ? 'pointer' : 'default',
        background: resolved.source === 'project' ? 'rgba(100,116,139,0.15)' : 'rgba(139,92,246,0.18)',
        border: '1px solid rgba(139,92,246,0.25)', color: 'var(--text-dim)', maxWidth: '220px', whiteSpace: 'nowrap'
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {type === 'image' ? '🖼' : '🎬'} {label}
      </span>
      <em style={{ fontStyle: 'normal', opacity: 0.7 }}>· {resolved.source}</em>
      {onChange && (
        <select
          value={value || ''}
          onChange={(e) => onChange(e.target.value || null)}
          style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', cursor: 'pointer' }}
          title=""
        >
          <option value="">Inherit ({resolved.source === 'shot' || resolved.source === 'scene' ? 'clear override' : label})</option>
          <ModelOptions models={models} unit={type === 'image' ? 'img' : 'video'} />
        </select>
      )}
    </span>
  );
}

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

  // The freshest scenes, for async runners that outlive a render (the
  // two-stage stale regeneration re-derives its video candidates from state
  // as it stood AFTER the image stage finished).
  const scenesRef = useRef(scenes);
  useEffect(() => { scenesRef.current = scenes; }, [scenes]);

  // Same for anything else a long-lived pipeline run must read fresh: React
  // closures captured at run start go stale the moment a stage writes state.
  const assetLibraryRef = useRef([]);
  const pipelineFnsRef = useRef({});

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
  // Atlas Cloud's open-weight image models expose their safety checker as a
  // request flag. Defaults to the provider's own default (on).
  const [atlasSafetyChecker, setAtlasSafetyChecker] = useState(true);
  const [attachTagsForVideos, setAttachTagsForVideos] = useState(false);
  const [genModalAttachTags, setGenModalAttachTags] = useState(true);

  // Per-project capability overrides for custom model paths, keyed by the id
  // as typed: { 'higgsfield:vendor/model': { refImages: 8 } }. The catalog
  // reads these through a registry so every capacity check sees them.
  const [customModelCaps, setCustomModelCaps] = useState({});
  useEffect(() => { setCustomModelOverrides(customModelCaps); }, [customModelCaps]);

  // Per-asset-type image model defaults, e.g. characters on an
  // identity-preserving model while environments use cheap t2i. Read by
  // resolveModelSettings between an asset's own override and the project default.
  const [assetTypeModels, setAssetTypeModels] = useState({});

  // Whether a <Tag> may spend a model's spare input slots on board references
  // linked to that asset (beyond the primary it always carried). Mirrors
  // attachTagsForImages: a project-level behaviour switch.
  const [autoAttachRefs, setAutoAttachRefs] = useState(true);

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
  const [batchOnlyDirty, setBatchOnlyDirty] = useState(false);
  // Shot-list display filter: show only shots whose image or video is stale.
  const [showOnlyStale, setShowOnlyStale] = useState(false);
  const [batchConcurrency, setBatchConcurrency] = useState(3);

  // --- UNDO / REDO ---
  // Snapshots of the whole project, taken from the same payload the autosave
  // writes. See history.js for why it is whole-project rather than per-action.
  const [history, setHistory] = useState(createHistory);
  const lastSnapshotRef = useRef(null);   // the state the last snapshot captured
  const skipHistoryRef = useRef(true);    // true while loading, so a load is not a step

  // --- DREAM MODE (self-contained; nothing else reads this) ---
  const [dreamOpen, setDreamOpen] = useState(false);
  const [dreamSettings, setDreamSettings] = useState(() => createDreamSettings());
  const [dreamRun, setDreamRun] = useState(null); // { active, total, clip, completed, phase, log[] }
  const dreamCancelRef = useRef(false);

  // --- PROJECTS (one folder per project) ---
  const [project, setProject] = useState({ path: null, name: 'Loading…', workingFolder: '', isLegacy: true, recent: [] });
  const [newProjectDraft, setNewProjectDraft] = useState(null); // { directory, name }
  const [runtimeMode, setRuntimeMode] = useState(null); // 'server' | 'static'
  const [needsFolderPermission, setNeedsFolderPermission] = useState(false);
  const [folderNoticeDismissed, setFolderNoticeDismissed] = useState(false);

  // --- SHOT LIST IMPORT ---
  const [importReport, setImportReport] = useState(null); // { added, warnings[] }
  const [llmPromptSource, setLlmPromptSource] = useState('');
  const shotListInputRef = useRef(null);
  // Pasting an LLM's reply straight in, as an alternative to saving it to a file
  // first. Same document, same normaliser — only the way it arrives differs.
  const [pasteImport, setPasteImport] = useState(null); // null | { text, mode }

  // Idea → Script: in-app script generation replacing the clipboard round-trip.
  const [scriptGenOpen, setScriptGenOpen] = useState(false);
  const [scriptGenIdea, setScriptGenIdea] = useState('');
  const [scriptGenBusy, setScriptGenBusy] = useState(false);
  const [scriptGenPreview, setScriptGenPreview] = useState(null); // result of generateShotListFromIdea

  // --- PIPELINE (one-button generate) ---
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [pipelineIdea, setPipelineIdea] = useState('');
  const [pipelineSkip, setPipelineSkip] = useState(() => new Set());
  const [pipelineRunState, setPipelineRunState] = useState(null); // last snapshot; persisted
  const [pipelineEstimate, setPipelineEstimate] = useState(null);
  const pipelineRunRef = useRef(null); // live controller
  const pipelineIdeaRef = useRef('');
  useEffect(() => { pipelineIdeaRef.current = pipelineIdea; }, [pipelineIdea]);

  // --- UI STATES ---
  const [activeShotId, setActiveShotId] = useState(null);
  const [collapsedShots, setCollapsedShots] = useState({}); // { [shotId]: boolean } (true = collapsed)
  const [activeOverlay, setActiveOverlay] = useState(null); // 'images', 'videos', 'reference', 'snippets', 'settings', 'batch'
  const [loadingStates, setLoadingStates] = useState({});
  const [toast, setToast] = useState(null);
  const [projectImagesSelector, setProjectImagesSelector] = useState(null); // null | { target: 'ref' }
  // Picking a shot's active still or clip from anywhere in the project.
  const [mediaPicker, setMediaPicker] = useState(null); // null | { shotId, kind }
  const [projectImagesList, setProjectImagesList] = useState([]);

  // --- MODALS FOR GENERATION PER SHOT ---
  const [generationModal, setGenerationModal] = useState(null); 
  // { type: 'image'|'video', shotId: string, existingPromptId: string|null }

  const [genModalPrompt, setGenModalPrompt] = useState('');
  const [genModalInputImages, setGenModalInputImages] = useState([]);
  const [genModalDuration, setGenModalDuration] = useState('5');
  const [genModalModel, setGenModalModel] = useState('');
  const [genModalRes, setGenModalRes] = useState('');
  const [genModalExcludedImages, setGenModalExcludedImages] = useState([]);
  // The project's pre/post prompt, per generation. They are wrapped around
  // every prompt by default; turning one off here is how you get a shot out
  // from under the film's global grade without editing the project settings.
  const [genModalUsePre, setGenModalUsePre] = useState(true);
  const [genModalUsePost, setGenModalUsePost] = useState(true);
  // Ranges in genModalPrompt that were inserted rather than typed — snippets
  // and inlined pre/post text. Shown in their own colour so the prompt says
  // where it came from. Purely a composing aid: they live as long as the modal
  // does and are never saved, since the text alone is what gets generated.
  const [genModalDecorations, setGenModalDecorations] = useState([]);
  // Where to put the caret once the next prompt change has rendered.
  const [genModalCaret, setGenModalCaret] = useState(null);
  // A hand-edited effective prompt. null means "compose it from the fields
  // above"; a string means the user took the wheel and it is sent verbatim.
  const [genModalOverride, setGenModalOverride] = useState(null);
  const [genModalEffectiveOpen, setGenModalEffectiveOpen] = useState(false);
  // --- Auto Prompt controls ---
  const [genModalAutoInstructions, setGenModalAutoInstructions] = useState('');
  const [genModalAutoContext, setGenModalAutoContext] = useState(false);
  const [genModalAutoBare, setGenModalAutoBare] = useState(false);
  const [genModalAutoOpen, setGenModalAutoOpen] = useState(false);

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
  // null when the dialog is closed; otherwise { status, summary, preview, ... }
  const [cleanFiles, setCleanFiles] = useState(null);
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

  // --- WATERMARK ---
  // The mark travels with the project so a re-compile can be re-stamped with
  // the same image; `drift` wanders continuously, `jump` hops every few seconds.
  const [watermarkImage, setWatermarkImage] = useState(null);
  const [watermarkMotion, setWatermarkMotion] = useState('drift');
  const watermarkInputRef = useRef(null);

  // refs
  const audioInputRefs = useRef({});
  const audioRefInputRefs = useRef({});
  // Half-typed audio URLs, per shot — draft text, never saved with the project.
  const [audioRefDrafts, setAudioRefDrafts] = useState({});

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
          // Not a gate: the app opens as normal and a banner offers the click.
          // Reading the folder is what has to wait, so the state load does too.
          setNeedsFolderPermission(true);
          await fetchConfig();
          await fetchProject();
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

  /**
   * Read the project, and remember which version of it we read.
   *
   * The early return on failure is the important line. Falling through to a
   * default project here is what used to arm the disaster: the app would boot
   * the built-in placeholder and then autosave it over the real file the moment
   * the drive came back.
   */
  const fetchProjectState = async ({ quiet = false } = {}) => {
    try {
      const res = await apiFetch(`/api/state`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSaveBlock({
          reason: data.reason || 'unreadable',
          message: data.error || `Could not read the project (${res.status}).`,
          detail: data
        });
        return false;
      }
      const state = await res.json();
      baselineRef.current = adoptBaseline(baselineRef.current, res, null);
      setSaveBlock(null);
      applyLoadedState(state);
      if (!quiet) lastRevisionSeenRef.current = baselineRef.current.revision;
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  };

  /**
   * Give every prompt snippet an id on the way in.
   *
   * Snippets are applied straight from the saved blob, so one written before
   * they carried ids — or edited by hand — arrives without one. React reports
   * that as a missing key, but the real damage is in the delete handler:
   * `filter(s => s.id !== snip.id)` with undefined on both sides matches every
   * other id-less snippet, so removing one silently removed them all.
   */
  const withSnippetIds = (snippets) => (
    Array.isArray(snippets)
      ? snippets.map((snip, index) => (snip?.id ? snip : { ...snip, id: `snip_load_${index}` }))
      : null
  );

  /**
   * Push a saved state blob into every piece of studio state.
   *
   * `resetHistory` is on for every real load — opening a project, restoring a
   * checkpoint, importing — because undoing across a project switch would
   * paste one film into another. Undo and redo replay through here too, and
   * pass false so they keep the stack they are walking.
   */
  const applyLoadedState = (state, { resetHistory = true } = {}) => {
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
    setPromptSnippets(withSnippetIds(state.promptSnippets) || promptSnippets);
    setWatermarkImage(state.watermarkImage || null);
    setWatermarkMotion(state.watermarkMotion === 'jump' ? 'jump' : 'drift');
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
    setAtlasSafetyChecker(state.atlasSafetyChecker !== false);
    setCustomModelCaps(state.customModelCaps && typeof state.customModelCaps === 'object' ? state.customModelCaps : {});
    setAssetTypeModels(state.assetTypeModels && typeof state.assetTypeModels === 'object' ? state.assetTypeModels : {});
    setAutoAttachRefs(state.autoAttachRefs !== false);
    // The job log survives reload now; anything mid-flight when the page died
    // is marked so rather than spinning forever.
    setBatchJobs((Array.isArray(state.batchJobs) ? state.batchJobs : [])
      .map(job => (job.status === 'running' ? { ...job, status: 'failed', error: 'interrupted by reload' } : job)));
    setPipelineRunState(state.pipelineRun || null);
    // Only the fields a dream saved are stored, so unset ones follow the
    // project's current models rather than a pinned stale one.
    setDreamSettings(createDreamSettings(state.dreamSettings || {}));
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

    // A load is not an undoable step: the next snapshot becomes the new floor.
    if (resetHistory) setHistory(createHistory());
    skipHistoryRef.current = true;
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
      atlasSafetyChecker,
      customModelCaps,
      assetTypeModels,
      autoAttachRefs,
      // Capped: the job log is a log, not an archive. Not in the autosave
      // dependency list — it rides along with whatever else triggers a save.
      batchJobs: batchJobs.slice(0, 100),
      pipelineRun: pipelineRunState,
      dreamSettings: compactDreamSettings(dreamSettings),
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
      watermarkImage,
      watermarkMotion,
      edit: extra.edit !== undefined ? extra.edit : edit,
      activeSceneId: extra.activeSceneId !== undefined ? extra.activeSceneId : activeSceneId,
      activeShotId: extra.activeShotId !== undefined ? extra.activeShotId : activeShotId,
      ...extra
    };
  };

  // --- AUTOSAVE, AND WHAT IT REFUSES TO DO ----------------------------------
  //
  // Which version of which file the state in this window came from. Every save
  // quotes it back, and the server refuses one that no longer matches what is
  // on disk. `loaded: false` means we have never successfully read the project,
  // so what is in memory is the built-in placeholder — never write that.

  const baselineRef = useRef(emptyBaseline());
  const lastRevisionSeenRef = useRef(null);
  const [saveBlock, setSaveBlock] = useState(null);
  const saveBlockRef = useRef(null);
  saveBlockRef.current = saveBlock;

  /**
   * Write the project.
   *
   * `force` is the user answering the banner: it skips our own gates and tells
   * the server to skip its own, which is the only way to deliberately overwrite
   * a file that moved on. The server copies the old one aside first.
   */
  const saveProjectState = async (updatedScenes = scenes, extra = {}, { force = false } = {}) => {
    // Nothing to write to yet in the hosted build until a folder is picked —
    // and a folder we have not been re-granted access to would only throw.
    if (isStatic() && (!projectFs.getActiveHandle() || needsFolderPermission)) return false;
    if (!force && !baselineRef.current.loaded) return false;
    if (!force && saveBlockRef.current) return false;

    try {
      const res = await apiFetch(`/api/state`, {
        method: 'POST',
        headers: saveHeaders(baselineRef.current, { force }),
        body: JSON.stringify(buildStatePayload(updatedScenes, extra))
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        baselineRef.current = adoptBaseline(baselineRef.current, res, data);
        lastRevisionSeenRef.current = baselineRef.current.revision;
        if (saveBlockRef.current) setSaveBlock(null);
        return true;
      }

      console.warn('[state] save refused:', data);
      setSaveBlock({
        reason: data.reason || 'refused',
        message: data.error || `Save refused (${res.status}).`,
        detail: data
      });
      return false;
    } catch (err) {
      console.error('Error saving state:', err);
      return false;
    }
  };

  /** The banner's "overwrite" button: write what is on screen, on purpose. */
  const forceSaveProjectState = async () => {
    const ok = await saveProjectState(scenes, {}, { force: true });
    showToast(ok
      ? 'Overwrote the project file. The previous version is in checkpoints/auto-backups.'
      : 'The forced save still failed — check the server log.', ok ? 'success' : 'error');
  };

  /** The banner's "reload" button: throw this window away and take the file. */
  const reloadProjectState = async () => {
    skipHistoryRef.current = true;
    const ok = await fetchProjectState();
    await fetchProject();
    if (ok) showToast('Reloaded the project from disk.', 'success');
  };

  /**
   * Notice a project that moved on while this window was in the background.
   *
   * The stale-tab case never reaches the server on its own: the tab sits there
   * holding an old state and only finds out when it writes — by which point it
   * has written. A cheap revision check on focus turns that into a banner
   * before the next keystroke rather than after it.
   */
  useEffect(() => {
    if (isStatic()) return undefined;
    const check = async () => {
      if (document.hidden || !baselineRef.current.loaded) return;
      try {
        const res = await apiFetch('/api/state/revision');
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data.reason) setSaveBlock({ reason: data.reason, message: data.error || '', detail: data });
          return;
        }
        const data = await res.json();
        if (data.revision && data.revision !== baselineRef.current.revision) {
          setSaveBlock({
            reason: data.target !== baselineRef.current.target ? 'target-changed' : 'stale',
            message: 'The project file changed on disk.',
            detail: { current: data.target, revision: data.revision }
          });
        }
      } catch { /* server down; the save path will report it */ }
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

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

  /**
   * Capture the state that existed *before* the change we just settled on.
   *
   * Sharing the autosave's debounce is deliberate: it means a burst of typing
   * becomes one undo step rather than sixty, and that what undo restores is
   * always something that was also written to disk.
   */
  const recordHistory = () => {
    const snapshot = buildStatePayload();
    if (skipHistoryRef.current) {
      // The change came from a load or from undo itself — take it as the new
      // baseline without recording a step.
      skipHistoryRef.current = false;
      lastSnapshotRef.current = snapshot;
      return;
    }
    const previous = lastSnapshotRef.current;
    lastSnapshotRef.current = snapshot;
    if (!previous) return;
    setHistory(prev => pushHistory(prev, {
      state: previous,
      label: describeChange(previous, snapshot),
      at: Date.now()
    }));
  };

  const saveStateRef = useRef();
  saveStateRef.current = () => { saveProjectState(); recordHistory(); };
  useEffect(() => {
    // Two gates, not one. An empty scene list has nothing to write; a project
    // we have never successfully read has something to write and no business
    // writing it — that state is the built-in placeholder, not this film.
    if (scenes.length === 0) return undefined;
    if (!baselineRef.current.loaded) return undefined;
    const timer = setTimeout(() => saveStateRef.current(), 600);
    return () => clearTimeout(timer);
  }, [scenes, imageGallery, videoGallery, referenceImages, refAssignments, assetLibrary, promptSnippets, activeLlm, llmModel, activeImageGenerator, imageModel, imageResolution, activeVideoGenerator, videoResolution, videoModel, videoDuration, batchConcurrency, attachTagsForImages, attachTagsForVideos, atlasSafetyChecker, customModelCaps, assetTypeModels, autoAttachRefs, promptSettings, concatenatedVideo, edit, dreamSettings]);

  // --- UNDO / REDO ----------------------------------------------------------

  const undoBusyReason = () => {
    if (batchRunner) return 'a batch is running';
    if (dreamRun?.active) return 'a dream is running';
    return null;
  };

  /**
   * Step the whole project back one state.
   *
   * Refused mid-batch and mid-dream: those write results in asynchronously, so
   * rolling the project back underneath them would drop whatever landed next
   * into a project that no longer expects it.
   */
  const handleUndo = () => {
    const busy = undoBusyReason();
    if (busy) {
      showToast(`Cannot undo while ${busy}. Stop it first.`, 'warning');
      return;
    }
    const label = historyUndoLabel(history);
    const step = undoHistory(history, { state: buildStatePayload(), label, at: Date.now() });
    if (!step) {
      showToast('Nothing left to undo.', 'info');
      return;
    }
    applyLoadedState(step.entry.state, { resetHistory: false });
    setHistory(step.history);
    showToast(`Undid ${step.entry.label}.`);
  };

  const handleRedo = () => {
    const busy = undoBusyReason();
    if (busy) {
      showToast(`Cannot redo while ${busy}. Stop it first.`, 'warning');
      return;
    }
    const label = historyRedoLabel(history);
    const step = redoHistory(history, { state: buildStatePayload(), label, at: Date.now() });
    if (!step) {
      showToast('Nothing left to redo.', 'info');
      return;
    }
    applyLoadedState(step.entry.state, { resetHistory: false });
    setHistory(step.history);
    showToast(`Redid ${label || 'change'}.`);
  };

  // Kept in refs so the key listener can be bound once rather than rebound on
  // every history change.
  const undoRef = useRef();
  const redoRef = useRef();
  undoRef.current = handleUndo;
  redoRef.current = handleRedo;

  useEffect(() => {
    const onKey = (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;

      // A text field has its own undo stack and the browser's is better than
      // ours inside one — stepping the whole project back mid-sentence is not
      // what Ctrl+Z means while the caret is in a textarea.
      const target = event.target;
      if (target?.isContentEditable) return;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      event.preventDefault();
      if (key === 'y' || event.shiftKey) redoRef.current();
      else undoRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
          audioRefs: [],
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

  /** Write one field on a scene (null clears it back to inherit). */
  const handleUpdateSceneField = (sceneId, field, value) => {
    const updated = scenes.map(s => (s.id === sceneId ? { ...s, [field]: value } : s));
    setScenes(updated);
    saveProjectState(updated);
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
      audioRefs: [],
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

  // --- MODEL SETTINGS RESOLUTION ---
  // Every "which model does this generation use?" question funnels through
  // resolveModelSettings so shot overrides, scene defaults, asset-type
  // defaults and project defaults agree everywhere (modal, batch, asset gen).
  const projectModelDefaults = {
    imageModel, imageResolution, videoModel, videoResolution, videoDuration, assetTypeModels
  };

  const sceneOfShot = (shotId) => scenes.find(sc => (sc.shots || []).some(s => s.id === shotId)) || null;

  const resolveShotModelSettings = (type, shot) => resolveModelSettings({
    type,
    project: projectModelDefaults,
    scene: shot ? sceneOfShot(shot.id) : null,
    shot
  });

  const resolveAssetModelSettings = (asset) => resolveModelSettings({
    type: 'image',
    project: projectModelDefaults,
    asset
  });

  // --- OPEN GENERATION MODALS ---
  const openGenerationModal = (type, shotId, existingPromptId = null) => {
    const shot = shots.find(s => s.id === shotId);
    if (!shot) return;

    setGenerationModal({ type, shotId, existingPromptId });
    setGenModalPrompt('');
    const resolved = resolveShotModelSettings(type, shot);
    const startingModel = resolved.model;
    // Image: everything this shot is set to send — its own references first,
    // then the ones it inherits from its scene and the project, minus anything
    // held back. Video: the shot's own still, which is what a video model has
    // always been handed. Both are trimmed to the model's capacity so the
    // preview never promises more than will be uploaded.
    setGenModalInputImages((type === 'image'
      ? shotReferencePaths(shot)
      : (shot.selectedImage ? [shot.selectedImage] : [])
    ).slice(0, refImageCapacity(type, startingModel)));
    setGenModalDuration(videoDuration);
    setGenModalExcludedImages([]);
    setGenModalUsePre(true);
    setGenModalUsePost(true);
    setGenModalDecorations([]);
    setGenModalCaret(null);
    setGenModalOverride(null);
    setGenModalEffectiveOpen(false);
    setGenModalAutoInstructions('');
    setGenModalAutoContext(false);
    setGenModalAutoBare(false);
    setGenModalAutoOpen(false);

    setGenModalAttachTags(type === 'image' ? attachTagsForImages : attachTagsForVideos);

    // Shot overrides > scene defaults > project defaults, via the resolver.
    setGenModalModel(resolved.model);
    setGenModalRes(resolved.resolution);
    if (type === 'video') setGenModalDuration(resolved.duration || videoDuration);

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
        setGenModalUsePre(found.usePrePrompt !== false);
        setGenModalUsePost(found.usePostPrompt !== false);
        setGenModalOverride(typeof found.promptOverride === 'string' ? found.promptOverride : null);
        if (type === 'video' && found.duration) setGenModalDuration(found.duration);
        // Video groups saved before video took more than one image carry a lone
        // `imageInput`; reading it as a one-element list reproduces them exactly.
        setGenModalInputImages(
          found.primaryImagePaths
          || found.inputImagePaths
          || (found.imageInput ? [found.imageInput] : [])
        );
      }
    } else {
      const draftField = type === 'image' ? 'draftImagePrompt' : 'draftVideoPrompt';
      initialPromptText = shot[draftField] !== undefined && shot[draftField] !== null && shot[draftField] !== '' ? shot[draftField] : (shot.description || '');
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

  // What "at the cursor" is measured against. Read straight off the element:
  // a blurred textarea still remembers its selection, where React's onSelect
  // does not fire for every way a caret can move.
  const genModalInputRef = useRef(null);
  const genModalSelection = useRef({ start: 0, end: 0 });
  const modalCaret = () => {
    const el = genModalInputRef.current;
    return el ? { start: el.selectionStart, end: el.selectionEnd } : genModalSelection.current;
  };

  /** One place for "the prompt changed": text, decorations and the shot draft. */
  const updateModalPrompt = (nextText, nextDecorations) => {
    setGenModalDecorations(nextDecorations !== undefined
      ? nextDecorations
      : remapDecorations(genModalDecorations, genModalPrompt, nextText));
    setGenModalPrompt(nextText);
    updateDraftPrompt(nextText);
  };

  /**
   * Drop text in at the caret and mark it as inserted.
   *
   * Inserting always used to append to the end, which made a snippet or a tag
   * useless for anything but the tail of a prompt — you wrote the sentence, hit
   * the chip, then cut and pasted it into place.
   */
  const insertIntoModalPrompt = (text, options) => {
    const result = insertIntoPrompt(genModalPrompt, genModalDecorations, modalCaret(), text, options);
    genModalSelection.current = { start: result.cursor, end: result.cursor };
    updateModalPrompt(result.text, result.decorations);
    // Hand the caret back so you can keep typing where the insert left off,
    // rather than having to click into the field again after every chip.
    setGenModalCaret({ pos: result.cursor, nonce: Date.now() });
  };

  const appendSnippetToModalPrompt = (snippetText, name) => {
    insertIntoModalPrompt(snippetText, { kind: 'snippet', label: name || 'snippet', joiner: ', ' });
  };

  /**
   * Fold a global pre/post prompt into this prompt so it can be edited here.
   *
   * It stops being applied globally for this generation at the same moment —
   * otherwise clicking it to tweak a word would send it twice.
   */
  const inlineAffix = (side) => {
    const text = generationModal?.type === 'image'
      ? (side === 'pre' ? prePrompt : postPrompt)
      : (side === 'pre' ? videoPrePrompt : videoPostPrompt);
    if (!text) return;
    const at = side === 'pre' ? 0 : genModalPrompt.length;
    const result = insertIntoPrompt(genModalPrompt, genModalDecorations, { start: at, end: at }, text, {
      kind: 'affix',
      label: `${side === 'pre' ? 'pre' : 'post'}-prompt`,
      joiner: ', '
    });
    if (side === 'pre') setGenModalUsePre(false); else setGenModalUsePost(false);
    updateModalPrompt(result.text, result.decorations);
  };

  // --- AUTO-GENERATE PROMPT FROM SHOT VIA LLM ---

  /**
   * Write one shot's image or video prompt via the LLM.
   *
   * Stage-shaped — shot in, `{ ok, text?, error?, lostTags }` out, no UI
   * coupling — so the modal button, the "write all prompts" batch and the
   * pipeline orchestrator all share one implementation. Resolves, never
   * rejects.
   */
  const writeShotPrompt = async (shot, type, { instructions = '', bare = false, withContext = false } = {}) => {
    const isImage = type === 'image';
    // Without the shot template there is nothing to write *from* except the
    // instructions, so those become the requirement instead of the description.
    if (bare && !instructions) return { ok: false, error: 'Instructions-only mode sends nothing else — write the instructions first.', lostTags: [] };
    if (!bare && !shot?.description) return { ok: false, error: 'No visual description to write from.', lostTags: [] };
    if (!shot) return { ok: false, error: 'Shot not found.', lostTags: [] };

    const systemPrompt = bare ? '' : (isImage ? imageSystemPrompt : videoSystemPrompt);
    const shotScene = sceneOfShot(shot.id);
    // Whatever the writer is shown is what it can preserve, so the tags are
    // collected from exactly the fields the template can send.
    const shotText = [shot.description, shot.setup, shot.notes, shot.dialogue].filter(Boolean).join(' ');

    const sections = [];

    // Context first: the writer needs to know what exists before it is asked to
    // write about it, and the tag list is only useful ahead of the request.
    if (withContext) {
      const index = shots.findIndex(s => s.id === shot.id);
      const context = buildAutoPromptContext({
        assetLibrary,
        previousShot: index > 0 ? shots[index - 1] : null,
        nextShot: index >= 0 && index < shots.length - 1 ? shots[index + 1] : null
      });
      if (context) sections.push(`${promptText(promptSettings, 'autoContextIntro')}\n\n${context}`);
    }

    if (!bare) {
      sections.push(fillTemplate(
        promptText(promptSettings, isImage ? 'imageUserTemplate' : 'videoUserTemplate'),
        {
          description: shot.description,
          setup: shot.setup,
          notes: shot.notes,
          dialogue: shot.dialogue,
          name: shot.name,
          sceneName: shotScene?.name || '',
          tags: tagPreservationRule(shotText)
        }
      ));
    }

    // Last, so they are the freshest thing in the window and read as the final
    // word when they contradict the template.
    if (instructions) {
      sections.push(bare
        ? instructions
        : `=== EXTRA INSTRUCTIONS (these override anything above) ===\n${instructions}`);
    }

    try {
      const res = await apiFetch(`/api/llm/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: activeLlm,
          prompt: sections.filter(Boolean).join('\n\n'),
          systemPrompt,
          model: llmModel
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed prompt generation');
      if (!data.text?.trim()) throw new Error('The model returned an empty prompt.');

      // A dropped tag is invisible until the generation comes back without the
      // character in it — report them. Only meaningful when the writer was
      // shown the shot; in instructions-only mode it never saw the tags.
      return { ok: true, text: data.text, lostTags: bare ? [] : droppedTags(shotText, data.text) };
    } catch (err) {
      console.error(err);
      return { ok: false, error: err.message, lostTags: [] };
    }
  };

  const handleAutoGeneratePromptInModal = async () => {
    const { shotId } = generationModal;
    const shot = shots.find(s => s.id === shotId);

    setLoadingStates(prev => ({ ...prev, modal_llm: true }));
    const result = await writeShotPrompt(shot, generationModal.type, {
      instructions: genModalAutoInstructions.trim(),
      bare: genModalAutoBare,
      withContext: genModalAutoContext
    });
    setLoadingStates(prev => ({ ...prev, modal_llm: false }));

    if (!result.ok) {
      const preflight = result.error.includes('write the instructions') || result.error.includes('No visual description');
      showToast(preflight ? result.error : `Prompt failed: ${result.error}`, preflight ? 'warning' : 'error');
      return;
    }

    // A wholly new prompt keeps none of the old one's inserted blocks — the
    // text they marked is gone.
    updateModalPrompt(result.text, []);

    if (result.lostTags.length > 0) {
      showToast(
        `Prompt written, but the writer dropped <${result.lostTags.join('>, <')}> — add ${result.lostTags.length === 1 ? 'it' : 'them'} back or its reference art will not be sent.`,
        'warning'
      );
    } else {
      showToast('Prompt generated via LLM!', 'success');
    }
  };

  // Identity of a prompt group.
  //
  // Keyed on the RAW inputs the user controls, never the composed output. The
  // composed prompt already has the global pre/post text baked in, so matching
  // on it meant "+ Add Iteration" — which reloads the group and recomposes —
  // produced a different string every time and forked a fresh group.
  // `!== false` throughout, so a group saved before a flag existed reads as the
  // default it was generated under and keeps its own gallery.
  const imagePromptSignature = (group) => JSON.stringify([
    group.rawPrompt ?? group.prompt ?? '',
    group.model || '',
    group.resolution || '',
    group.primaryImagePaths || [],
    group.attachTaggedImages !== false,
    group.excludedImagePaths || [],
    group.usePrePrompt !== false,
    group.usePostPrompt !== false,
    group.promptOverride ?? null
  ]);

  const videoPromptSignature = (group) => JSON.stringify([
    group.rawPrompt ?? group.prompt ?? '',
    group.model || '',
    group.resolution || '',
    group.duration || '',
    group.primaryImagePaths || [],
    group.attachTaggedImages !== false,
    group.excludedImagePaths || [],
    group.usePrePrompt !== false,
    group.usePostPrompt !== false,
    group.promptOverride ?? null
  ]);

  /**
   * Let a hand-edited effective prompt stand in for the composed text.
   *
   * Deliberately the *last* step and deliberately text-only. The images were
   * already decided by the tags and the thumbnails, and they stay decided:
   * deleting "@image3" from the override unbinds that image from the prompt
   * without unsending it, which is the honest reading — the picture really is
   * still in the request. Taking it out is what the thumbnail's ✕ is for.
   */
  const applyPromptOverride = (composed, override) => (
    typeof override === 'string'
      ? { ...composed, prompt: override, overridden: true }
      : { ...composed, overridden: false }
  );

  // --- PROMPT COMPOSITION ---
  // The single place where a raw shot prompt becomes the string a model sees:
  // global pre/post prompt + <Tag> substitution + reference image resolution.
  // `wrap.shot` wires the reference board in: with it, tags auto-attach their
  // linked board references and the shot's pinned/inherited edges resolve at
  // generation time, all under the model's capacity.
  const buildPrompt = (type, rawPrompt, modelId, primaryImagePaths = [], attachTaggedImages = null, excludedImagePaths = [], wrap = {}) => applyPromptOverride(composeGenerationPrompt({
    prompt: rawPrompt,
    // The pre/post prompt is on unless this particular generation turned it
    // off, so every existing caller and every saved group behaves as before.
    prePrompt: wrap.usePrePrompt === false ? '' : (type === 'image' ? prePrompt : videoPrePrompt),
    postPrompt: wrap.usePostPrompt === false ? '' : (type === 'image' ? postPrompt : videoPostPrompt),
    assetLibrary,
    primaryImagePaths,
    attachTaggedImages: attachTaggedImages === null
      ? (type === 'image' ? attachTagsForImages : attachTagsForVideos)
      : attachTaggedImages,
    excludedImagePaths,
    type,
    modelId,
    references: referenceImages,
    assignments: refAssignments,
    shot: wrap.shot || null,
    scene: wrap.shot ? sceneOfShot(wrap.shot.id) : null,
    autoAttachRefs
  }), wrap.promptOverride);

  const handleDeselectSentImage = (imagePath, origin) => {
    if (origin === 'primary') {
      setGenModalInputImages(prev => prev.filter(p => p !== imagePath));
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
      primaryImagePaths: genModalInputImages,
      attachTaggedImages: genModalAttachTags,
      excludedImagePaths: genModalExcludedImages,
      usePrePrompt: genModalUsePre,
      usePostPrompt: genModalUsePost,
      promptOverride: genModalOverride
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
    excludedImagePaths = [], usePrePrompt = true, usePostPrompt = true, promptOverride = null
  }) => {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const composed = buildPrompt(type, rawPrompt, model, primaryImagePaths, attachTaggedImages, excludedImagePaths, {
      usePrePrompt, usePostPrompt, promptOverride,
      shot: shots.find(s => s.id === shotId) || null
    });

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

    const caps = modelCapabilities(type, model);

    // Warn, never silently truncate: an over-limit prompt is still sent, and
    // whatever the provider does with it happens in the open.
    if (composed.promptOverflow) {
      showToast(`Prompt is ${composed.promptOverflow.length} characters — ${caps.label} documents a limit of ${composed.promptOverflow.limit}. Sent anyway; expect the provider to reject or truncate it.`, 'warning');
    }

    // A model that cannot run without an input image fails here, locally,
    // before any request is billed.
    if (caps.refMode === 'required' && composed.inputImagePaths.length === 0) {
      const error = `${caps.label} requires at least one input reference image. Please add a reference image to this shot first.`;
      setBatchJobs(prev => prev.map(j => (j.id === jobId ? { ...j, status: 'failed', error } : j)));
      showToast(error, 'error');
      return { ok: false, error };
    }

    // Reference audio belongs to the shot rather than to a prompt recipe: it is
    // part of what the shot sounds like, so every video generation of that shot
    // carries it. Only a video job can, and only some models will.
    const audioRefs = type === 'video'
      ? ((shots.find(s => s.id === shotId) || {}).audioRefs || []).filter(Boolean)
      : [];
    // Where a clip may live depends on the host — Fal uploads a local file for
    // you, Atlas needs it already reachable — so the adapters judge that and
    // say which is wrong. Only the count is decidable from here.
    if (audioRefs.length > (caps.maxRefAudio || 0)) {
      const error = caps.maxRefAudio
        ? `${caps.label} takes at most ${caps.maxRefAudio} reference audio clip${caps.maxRefAudio === 1 ? '' : 's'}, and this shot has ${audioRefs.length}.`
        : `${caps.label} does not take reference audio, and this shot has ${audioRefs.length}. `
          + `Only the Seedance 2.0 reference-to-video models do — an image-to-video endpoint treats your still as a `
          + `first frame, and Atlas will not combine a first frame with reference media. Switch the shot to ref2v, or remove the audio.`;
      setBatchJobs(prev => prev.map(j => (j.id === jobId ? { ...j, status: 'failed', error } : j)));
      showToast(error, 'error');
      return { ok: false, error };
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
      excludedImagePaths,
      usePrePrompt,
      usePostPrompt,
      promptOverride
    };

    // A snapshot of every tagged asset as it looked at generation time, kept
    // *beside* the recipe (never inside it — the signature must not fork
    // groups over metadata). This is what dirty-shot detection compares the
    // asset's current state against.
    const meta = {
      taggedAssetIds: composed.taggedAssets.map(a => a.id),
      assetStamps: Object.fromEntries(composed.taggedAssets.map(a => [
        a.id, { updatedAt: a.updatedAt || null, primaryImage: assetPrimaryImage(a) }
      ])),
      createdAt: new Date().toISOString()
    };

    if (type === 'image') {
      return runAsyncImageJob(jobId, shotId, composed.prompt, composed.inputImagePaths, recipe, meta);
    }
    return runAsyncVideoJob(jobId, shotId, composed.prompt, composed.inputImagePaths, recipe, meta, audioRefs);
  };

  /**
   * Where a generation's output should be filed.
   *
   * A descriptor describes rather than points: it carries the scene and shot
   * names rather than an id to look up. The host resolving an id would be
   * reading whatever the last autosave wrote, so a shot generated seconds after
   * it was created would resolve to nothing and the file would land in the bin.
   *
   * Nothing here reaches a folder name unslugified — see shared/assetPaths.js.
   */
  const shotDestination = (shotId, media) => {
    const list = scenesRef.current?.length ? scenesRef.current : scenes;
    for (let sceneIndex = 0; sceneIndex < list.length; sceneIndex += 1) {
      const shots = list[sceneIndex]?.shots || [];
      const shotIndex = shots.findIndex(shot => shot.id === shotId);
      if (shotIndex < 0) continue;
      const scene = list[sceneIndex];
      return {
        kind: 'shot',
        media,
        scene: { index: sceneIndex, name: scene.name, number: scene.number },
        shot: { index: shotIndex, name: shots[shotIndex].name }
      };
    }
    return null; // unknown shot: the host files it in the bin rather than failing
  };

  /** The same idea for an asset's own generations. */
  const assetDestination = (asset) => (
    asset ? { kind: 'asset', asset: { type: asset.type, tag: asset.tag, name: asset.name } } : null
  );

  const runAsyncImageJob = async (jobId, shotId, promptText, inputImagePaths = [], recipe = {}, meta = null) => {
    const { model, resolution: resOption } = recipe;
    try {
      const res = await apiFetch(`/api/image/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: model,
          // A custom path may declare its host as `fal:` / `higgsfield:`;
          // a catalog model carries its provider in the catalog itself.
          providerFamily: parseModelId(model).family || getImageModel(model)?.provider || null,
          prompt: promptText,
          resolution: resOption,
          inputImagePaths,
          safetyChecker: atlasSafetyChecker,
          destination: shotDestination(shotId, 'image')
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
                // The latest output defines the group's currency: refresh the
                // asset snapshot so dirtiness is judged against this run.
                updatedPrompts = updatedPrompts.map((p, i) => (
                  i === matchIndex ? { ...p, outputs: [...(p.outputs || []), newOutput], ...(meta ? { meta } : {}) } : p
                ));
                groupId = updatedPrompts[matchIndex].id;
              } else {
                groupId = 'prompt_img_' + Date.now();
                updatedPrompts.push({
                  id: groupId,
                  ...recipe,
                  prompt: promptText,          // composed, for display
                  inputImagePaths,             // what actually went to the model
                  ...(meta ? { meta } : {}),
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

  // `imageInputs` is every reference the composition decided to send, in slot
  // order. It used to be a single path, which was fine while every video model
  // took one image and quietly wrong once Seedance 2.0's reference endpoint
  // took nine — the prompt pointed at @image3 and only @image1 was ever sent.
  const runAsyncVideoJob = async (jobId, shotId, promptText, imageInputs = [], recipe = {}, meta = null, audioInputs = []) => {
    const { model, resolution: resOption, duration } = recipe;
    const imageUrlsToSend = Array.isArray(imageInputs) ? imageInputs.filter(Boolean) : [imageInputs].filter(Boolean);
    const imageInput = imageUrlsToSend[0] || '';
    try {
      const res = await apiFetch(`/api/video/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: model,
          providerFamily: parseModelId(model).family || getVideoModel(model)?.provider || null,
          videoModel: model,
          prompt: promptText,
          imageUrls: imageUrlsToSend,
          audioUrls: audioInputs,
          resolution: resOption,
          duration: duration,
          destination: shotDestination(shotId, 'video')
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
                // Latest output defines the group's currency — refresh the
                // asset snapshot alongside it.
                updatedPrompts = updatedPrompts.map((p, i) => (
                  i === matchIndex ? { ...p, outputs: [...(p.outputs || []), newOutput], ...(meta ? { meta } : {}) } : p
                ));
                groupId = updatedPrompts[matchIndex].id;
              } else {
                groupId = 'prompt_vid_' + Date.now();
                updatedPrompts.push({
                  id: groupId,
                  ...recipe,
                  prompt: promptText,          // composed, for display
                  imageInput,                  // first slot, for older readers
                  inputImagePaths: imageUrlsToSend,
                  ...(meta ? { meta } : {}),
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

  /**
   * Put a local ffmpeg run in the same queue the generations use.
   *
   * A compile or a render is the longest thing this app does and, until now, the
   * only thing it did with no entry anywhere: a spinner on the button that
   * vanished on reload, so a run that died while you were elsewhere looked
   * exactly like one that never started. It is a job like any other — it takes
   * minutes, it can fail, and the answer should stay put.
   *
   * Returns the id to hand to `finishJob`.
   */
  const startJob = ({ type, shotId = null, shotName, prompt, model = 'ffmpeg (local)' }) => {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setBatchJobs(prev => [{
      id: jobId,
      shotId,
      shotName,
      type,
      model,
      prompt,
      status: 'running',
      createdAt: new Date().toISOString(),
      error: null
    }, ...prev]);
    return jobId;
  };

  const finishJob = (jobId, patch) => {
    setBatchJobs(prev => prev.map(job => (job.id === jobId ? { ...job, ...patch } : job)));
  };

  /**
   * Follow a timeline render to the end from the queue rather than the editor.
   *
   * The encoder outlives the view that started it: leaving the editor for the
   * shot list does not stop ffmpeg, so the thing that watches it cannot be a
   * panel inside the editor. The queue holds the encoder's own job id and polls
   * the backend directly, which is also what makes the render visible from the
   * side of the app where you spend the wait.
   */
  const renderProgressRef = useRef({});
  const trackedRenders = batchJobs
    .filter(job => job.type === 'render' && job.status === 'running' && job.renderJobId)
    .map(job => `${job.id}|${job.renderJobId}`)
    .join(',');

  useEffect(() => {
    if (!trackedRenders) return undefined;
    const tracked = trackedRenders.split(',').map(entry => {
      const [id, renderJobId] = entry.split('|');
      return { id, renderJobId };
    });
    let cancelled = false;

    const timer = setInterval(async () => {
      for (const job of tracked) {
        try {
          const res = await apiFetch(`/api/render/${job.renderJobId}`);
          const data = await res.json();
          if (cancelled) return;
          if (!res.ok) throw new Error(data.error || 'the backend lost track of this render');

          if (data.state === 'done') {
            delete renderProgressRef.current[job.id];
            finishJob(job.id, { status: 'completed', progress: 1, outputPath: data.filePath });
          } else if (data.state === 'error') {
            delete renderProgressRef.current[job.id];
            finishJob(job.id, { status: 'failed', error: data.error });
          } else {
            // Whole steps only. The editor's own bar is the place for 2Hz; every
            // update here re-renders the app around it.
            const percent = Math.round((data.progress || 0) * 100);
            if (percent >= (renderProgressRef.current[job.id] ?? 0)) {
              renderProgressRef.current[job.id] = percent + 5;
              finishJob(job.id, { progress: data.progress || 0 });
            }
          }
        } catch (error) {
          if (!cancelled) finishJob(job.id, { status: 'failed', error: error.message });
        }
      }
    }, 1000);

    return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackedRenders]);

  // --- BATCH GENERATION -----------------------------------------------------

  /** The prompt a batch run uses for a shot, before pre/post and tag expansion. */
  // No raw-description fallback any more: sending an unwritten description as
  // a prompt was a silent quality trap, and the write-all-prompts stage (or
  // button) supersedes it — promptless shots are skipped by the candidate
  // predicates instead.
  const resolveShotPrompt = (shot, type) => {
    if (type === 'image') {
      const lastGroup = (shot.imagePrompts || [])[(shot.imagePrompts || []).length - 1];
      return shot.draftImagePrompt || lastGroup?.prompt || '';
    }
    const lastGroup = (shot.videoPrompts || [])[(shot.videoPrompts || []).length - 1];
    return shot.draftVideoPrompt || lastGroup?.prompt || shot.draftImagePrompt || '';
  };

  const shotsForScope = (scope) => {
    if (scope === 'scene') {
      const scene = scenes.find(s => s.id === activeSceneId);
      return (scene?.shots || []).map(shot => ({ shot, sceneName: scene.name }));
    }
    return scenes.flatMap(scene => (scene.shots || []).map(shot => ({ shot, sceneName: scene.name })));
  };

  // Which shots are stale, recomputed whenever the shot list or an asset
  // changes. String ops over shots × tags — trivial at personal-project scale.
  const dirtyMap = useMemo(() => buildDirtyMap(scenes, assetLibrary), [scenes, assetLibrary]);

  /** Shots a batch would actually act on, given the current dialog options. */
  const batchCandidates = (type, scope, onlyMissing, onlyDirty = false) => shotsForScope(scope)
    .filter(({ shot }) => {
      if (onlyDirty) return Boolean(dirtyMap.get(shot.id)?.[type]?.dirty);
      if (!resolveShotPrompt(shot, type).trim()) return false;
      if (!onlyMissing) return true;
      // "Only shots without a result yet" — the point of a first full sweep.
      return type === 'image'
        ? !(shot.imagePrompts || []).some(p => (p.outputs || []).length > 0)
        : !(shot.videoPrompts || []).some(p => (p.outputs || []).length > 0);
    });

  /**
   * The worker-pool body every generation batch shares: run `submitFor` over
   * the candidates with bounded concurrency, driving the runner UI. Returns
   * { completed, failed, cancelled }.
   */
  const runBatchOver = async (candidates, type, submitFor, { label } = {}) => {
    cancelBatchRef.current = false;
    setBatchRunner({ total: candidates.length, done: 0, type, label: label || `${type} × ${candidates.length}` });

    // Fixed-size worker pool so we do not slam the provider with N parallel
    // requests; each worker pulls the next candidate off the shared cursor.
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

        const result = await submitFor(candidates[index]);
        if (result?.ok) completed += 1; else failed += 1;
        setBatchRunner(prev => (prev ? { ...prev, done: completed + failed } : prev));
      }
    };

    await Promise.all(Array.from({ length: workerCount }, worker));
    setBatchRunner(null);
    const cancelled = cancelBatchRef.current;
    cancelBatchRef.current = false;
    return { completed, failed, cancelled, total: candidates.length };
  };

  /** The standard per-shot submission a scope batch performs. */
  const submitForShot = (type) => ({ shot }) => {
    const isImage = type === 'image';
    const resolved = resolveShotModelSettings(type, shot);

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

    return submitGenerationJob({
      type,
      shotId: shot.id,
      shotName: shot.name,
      rawPrompt: resolveShotPrompt(shot, type),
      model: resolved.model,
      resolution: resolved.resolution,
      duration: resolved.duration || videoDuration,
      primaryImagePaths,
      attachTaggedImages: isImage ? attachTagsForImages : attachTagsForVideos
    });
  };

  const handleRunBatch = async () => {
    if (!batchDialog) return;
    const { type, scope } = batchDialog;
    const candidates = batchCandidates(type, scope, batchOnlyMissing, batchOnlyDirty);

    if (candidates.length === 0) {
      showToast(batchOnlyDirty
        ? 'No stale shots in this scope.'
        : 'No shots match — every shot either has no prompt or already has output.', 'warning');
      return;
    }

    setBatchDialog(null);
    setActiveOverlay('batch');

    const scopeLabel = scope === 'scene' ? `scene "${scenes.find(s => s.id === activeSceneId)?.name}"` : 'all scenes';
    showToast(`Batch started: ${candidates.length} ${type} generation${candidates.length === 1 ? '' : 's'}.`, 'info');

    // A dirtiness-selected candidate regenerates from its producing recipe,
    // not from the draft prompt — the whole point is reproducing the original
    // request with the asset's fresh material.
    const submitFor = batchOnlyDirty
      ? ({ shot }) => submitFromProducingGroup(shot, type)
      : submitForShot(type);

    const { completed, failed, cancelled, total } = await runBatchOver(
      candidates, type, submitFor,
      { label: `${type} × ${candidates.length} in ${scopeLabel}` }
    );

    if (cancelled) {
      showToast(`Batch stopped. ${completed} finished, ${failed} failed, ${total - completed - failed} skipped.`, 'warning');
    } else if (failed > 0) {
      showToast(`Batch done: ${completed} succeeded, ${failed} failed. See the Batch Manager for errors.`, 'warning');
    } else {
      showToast(`Batch complete — ${completed} ${type}${completed === 1 ? '' : 's'} generated.`, 'success');
    }
  };

  // Stops dispatching new jobs; requests already in flight are left to finish.
  const handleCancelBatch = () => {
    cancelBatchRef.current = true;
    showToast('Batch will stop after the in-flight generations finish.', 'warning');
  };

  // --- STALE REGENERATION ---------------------------------------------------

  /**
   * Regenerate from the recipe that produced the current selection — raw
   * prompt, model, exclusions and all — not from the draft prompt. Tags
   * resolve at compose time, so fresh asset text and images attach
   * automatically; the signature match lands the output in the same group and
   * refreshes its stamps, which is what clears the dirty state.
   *
   * Videos animate the CURRENT shot.selectedImage, not the recorded one.
   */
  const submitFromProducingGroup = (shot, type) => {
    const groups = type === 'image' ? shot.imagePrompts : shot.videoPrompts;
    const selected = type === 'image' ? shot.selectedImage : shot.selectedVideo;
    const group = groupForSelection(groups || [], selected);
    if (!group) {
      return Promise.resolve({ ok: false, error: 'No producing group for the current selection.' });
    }

    return submitGenerationJob({
      type,
      shotId: shot.id,
      shotName: shot.name,
      rawPrompt: group.rawPrompt ?? group.prompt ?? '',
      model: group.model,
      resolution: group.resolution,
      duration: group.duration,
      primaryImagePaths: type === 'video'
        ? (shot.selectedImage ? [shot.selectedImage] : [])
        : (group.primaryImagePaths || []),
      attachTaggedImages: group.attachTaggedImages !== false,
      excludedImagePaths: group.excludedImagePaths || [],
      usePrePrompt: group.usePrePrompt !== false,
      usePostPrompt: group.usePostPrompt !== false,
      promptOverride: typeof group.promptOverride === 'string' ? group.promptOverride : null
    });
  };

  /**
   * One button: stale images first, then — judged against the state those
   * regenerations produced — the stale videos. The order matters: a
   * regenerated image flips its video to dirty via the source-image rule.
   */
  const handleRegenerateStale = async () => {
    const imageCandidates = dirtyImageCandidates(scenesRef.current, assetLibrary);
    if (imageCandidates.length > 0) {
      showToast(`Regenerating ${imageCandidates.length} stale image${imageCandidates.length === 1 ? '' : 's'}…`, 'info');
      setActiveOverlay('batch');
      const { cancelled } = await runBatchOver(
        imageCandidates, 'image',
        ({ shot }) => submitFromProducingGroup(shot, 'image'),
        { label: `stale images × ${imageCandidates.length}` }
      );
      if (cancelled) return;
    }

    // Re-derive from the freshest state: the image stage changed selections.
    const videoCandidates = dirtyVideoCandidates(scenesRef.current, assetLibrary);
    if (videoCandidates.length === 0) {
      showToast(imageCandidates.length > 0 ? 'Stale images regenerated; no stale videos.' : 'Nothing is stale.', 'success');
      return;
    }
    showToast(`Now regenerating ${videoCandidates.length} stale video${videoCandidates.length === 1 ? '' : 's'}…`, 'info');
    const { completed, failed } = await runBatchOver(
      videoCandidates, 'video',
      ({ shot: staleShot }) => {
        // Read the freshest copy — the image stage may have re-selected.
        const fresh = scenesRef.current.flatMap(s => s.shots || []).find(s => s.id === staleShot.id) || staleShot;
        return submitFromProducingGroup(fresh, 'video');
      },
      { label: `stale videos × ${videoCandidates.length}` }
    );
    showToast(`Stale sweep done: ${completed} regenerated${failed ? `, ${failed} failed` : ''}.`, failed ? 'warning' : 'success');
  };

  // --- WRITE ALL PROMPTS (LLM batch) ---------------------------------------

  /** Shots with a description but no draft prompt of this type — the natural
      candidate predicate, so LLM-scripted projects that already carry drafts
      skip this stage entirely. */
  const shotsMissingPrompts = (type, scope = 'all') => shotsForScope(scope).filter(({ shot }) => {
    const field = type === 'image' ? 'draftImagePrompt' : 'draftVideoPrompt';
    return !String(shot[field] || '').trim() && String(shot.description || '').trim();
  });

  /**
   * Fill every empty draft prompt via the LLM. Stage-shaped like the
   * generation batches, but with a small fixed pool — LLM providers
   * rate-limit harder than image hosts.
   */
  const handleWriteAllPrompts = async (type, scope = 'all') => {
    const candidates = shotsMissingPrompts(type, scope);
    if (candidates.length === 0) {
      showToast(`Every shot with a description already has a ${type} prompt.`, 'info');
      return;
    }

    cancelBatchRef.current = false;
    setBatchRunner({ total: candidates.length, done: 0, type: 'prompt', label: `${type} prompts × ${candidates.length}` });
    showToast(`Writing ${candidates.length} ${type} prompt${candidates.length === 1 ? '' : 's'}…`, 'info');

    let cursor = 0;
    let completed = 0;
    let failed = 0;
    const lostTagShots = [];

    const worker = async () => {
      while (true) {
        if (cancelBatchRef.current) return;
        const index = cursor;
        cursor += 1;
        if (index >= candidates.length) return;

        const { shot } = candidates[index];
        const result = await writeShotPrompt(shot, type, { withContext: true });
        if (result.ok) {
          handleUpdateShotField(shot.id, type === 'image' ? 'draftImagePrompt' : 'draftVideoPrompt', result.text);
          if (result.lostTags.length > 0) lostTagShots.push(`${shot.name} (<${result.lostTags.join('>, <')}>)`);
          completed += 1;
        } else {
          failed += 1;
        }
        setBatchRunner(prev => (prev ? { ...prev, done: completed + failed } : prev));
      }
    };

    await Promise.all(Array.from({ length: Math.min(2, candidates.length) }, worker));

    setBatchRunner(null);
    if (cancelBatchRef.current) {
      showToast(`Stopped. ${completed} written, ${failed} failed.`, 'warning');
    } else if (failed > 0) {
      showToast(`Prompts written: ${completed}; failed: ${failed}.`, 'warning');
    } else {
      showToast(`All ${completed} ${type} prompt${completed === 1 ? '' : 's'} written.`, 'success');
    }
    if (lostTagShots.length > 0) {
      showToast(`The writer dropped tags on: ${lostTagShots.join('; ')} — check those prompts.`, 'warning');
    }
    cancelBatchRef.current = false;
  };

  // --- DREAM MODE -----------------------------------------------------------
  //
  // One continuous shot, made a clip at a time: generate, capture the clip's
  // last frame, show that frame to the LLM, let it decide what happens next,
  // animate the frame with that answer, repeat.
  //
  // Everything it touches is ordinary studio state — it creates ordinary shots
  // and queues ordinary generation jobs through submitGenerationJob — so the
  // result behaves like a hand-built sequence everywhere else in the app, and
  // nothing outside this block and DreamDialog.jsx knows dreams exist.

  const dreamLog = (text, level = 'info') => {
    setDreamRun(prev => (prev ? { ...prev, log: [...prev.log, { text, level }] } : prev));
  };

  const dreamPhase = (clip, phase) => {
    setDreamRun(prev => (prev ? { ...prev, clip, phase } : prev));
  };

  /**
   * Open a new shot immediately after `afterShotId`, already holding the frame
   * the previous clip ended on. Returns its id.
   */
  const appendDreamShot = (afterShotId, patch) => {
    const newId = `shot_dream_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const blank = {
      id: newId,
      name: 'Dream',
      setup: '',
      description: '',
      dialogue: '',
      notes: '',
      selectedImage: null,
      selectedVideo: null,
      referenceImages: [],
      lipSyncAudio: null,
      audioRefs: [],
      imagePrompts: [],
      videoPrompts: [],
      draftImagePrompt: '',
      draftVideoPrompt: ''
    };

    setScenes(prev => {
      let placed = false;
      const next = prev.map(scene => {
        const index = (scene.shots || []).findIndex(s => s.id === afterShotId);
        if (index === -1) return scene;
        placed = true;
        const shotList = [...scene.shots];
        shotList.splice(index + 1, 0, { ...blank, ...patch });
        return { ...scene, shots: shotList };
      });
      if (placed) return next;
      // The shot we were following got deleted mid-dream — land in the active
      // scene rather than dropping the clip on the floor.
      return next.map(scene => (
        scene.id === activeSceneId ? { ...scene, shots: [...(scene.shots || []), { ...blank, ...patch }] } : scene
      ));
    });

    // A dream can add dozens of shots; leaving them all expanded buries the
    // rest of the timeline.
    setCollapsedShots(prev => ({ ...prev, [newId]: true }));
    return newId;
  };

  /**
   * Show the LLM a frame and get a clip back.
   *
   * `opening` marks the one call where the frame is the shot's own still rather
   * than something captured off a previous clip, so the model is not told to
   * continue from a clip that does not exist.
   */
  const askDreamForClip = async ({ settings, framePath, clip, total, history, opening = false }) => {
    const res = await apiFetch('/api/llm/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: activeLlm,
        model: llmModel,
        systemPrompt: settings.systemPrompt || DEFAULT_DREAM_SYSTEM_PROMPT,
        prompt: buildDreamUserMessage({
          instructions: settings.instructions,
          assetLibrary,
          history,
          clipNumber: clip,
          totalClips: total,
          hasFrame: true,
          opening,
          historyDepth: settings.historyDepth
        }),
        imagePaths: [framePath]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'The LLM call failed.');
    return parseDreamReply(data.text);
  };

  /**
   * The shots a chain run will walk: the start shot and everything after it, in
   * timeline order, capped at the requested count.
   */
  const dreamChainShots = (startShotId, count) => {
    const startIndex = shots.findIndex(s => s.id === startShotId);
    if (startIndex === -1) return [];
    return shots.slice(startIndex, startIndex + Math.max(1, count));
  };

  const handleRunDream = async () => {
    const settings = dreamSettings;
    const chaining = settings.mode === 'chain';
    const startShot = shots.find(s => s.id === settings.startShotId);

    if (!startShot) {
      showToast('Pick a shot to start the dream from.', 'warning');
      return;
    }

    // Chaining can never run past the last shot — there is nothing to hand the
    // next frame to, and inventing one is the other mode's job.
    const chainShots = chaining ? dreamChainShots(startShot.id, Number(settings.iterations) || 1) : [];
    const total = chaining
      ? chainShots.length
      : Math.max(1, Math.min(60, Number(settings.iterations) || 1));

    if (chaining && total === 0) {
      showToast('There are no shots after that one to chain through.', 'warning');
      return;
    }

    const imageModelId = settings.imageModel || imageModel;
    const imageRes = settings.imageResolution || imageResolution;
    const videoModelId = settings.videoModel || videoModel;
    const videoRes = settings.videoResolution || videoResolution;
    const duration = settings.videoDuration || videoDuration;

    dreamCancelRef.current = false;
    setDreamRun({ active: true, total, clip: 1, completed: 0, phase: 'starting', log: [], stopped: false, failed: false });

    // What the LLM is told it has already dreamt.
    const history = [];
    let shotId = startShot.id;
    let shotName = startShot.name || 'Shot';
    let currentImage = startShot.selectedImage;
    let currentVideo = startShot.selectedVideo;
    let currentVideoPrompt = resolveShotPrompt(startShot, 'video');
    let previousVideo = null;
    let failure = null;

    try {
      for (let clip = 1; clip <= total; clip++) {
        if (dreamCancelRef.current) break;

        if (clip > 1) {
          dreamPhase(clip, 'capturing the last frame');
          const framePath = await captureLastFrame(previousVideo);
          setImageGallery(prev => [{
            id: `img_dream_${Date.now()}`,
            path: framePath,
            prompt: `Dream clip ${clip - 1} — final frame`,
            name: `Dream frame ${clip - 1}`,
            createdAt: new Date().toISOString()
          }, ...prev]);

          if (dreamCancelRef.current) break;

          if (chaining) {
            // Nothing is written here: the shot keeps the prompt it already has
            // and only its opening still is replaced by the frame we captured.
            const nextShot = chainShots[clip - 1];
            shotId = nextShot.id;
            shotName = nextShot.name || `Shot ${clip}`;
            currentVideoPrompt = resolveShotPrompt(nextShot, 'video');
            if (!currentVideoPrompt.trim()) {
              throw new Error(`${shotName} has no video prompt or description of its own to chain from.`);
            }
            handleUpdateShotField(shotId, 'selectedImage', framePath);
            history.push(nextShot.description || currentVideoPrompt);
            dreamLog(`${clip}. ${shotName} — continuing from the previous frame`);
          } else {
            dreamPhase(clip, 'asking the LLM what happens next');
            const next = await askDreamForClip({ settings, framePath, clip, total, history });

            shotName = dreamShotName(clip);
            shotId = appendDreamShot(shotId, {
              name: shotName,
              description: next.description,
              draftVideoPrompt: next.videoPrompt,
              selectedImage: framePath,
              videoModel: videoModelId,
              videoResolution: videoRes,
              videoDuration: duration
            });
            currentVideoPrompt = next.videoPrompt;
            history.push(next.description || next.videoPrompt);
            dreamLog(`${clip}. ${next.description || next.videoPrompt.slice(0, 100)}`);
          }

          currentImage = framePath;
          currentVideo = null;
        }

        if (dreamCancelRef.current) break;

        // --- opening shot only: fill in whatever it is missing ---------------
        // Everything after clip 1 arrives with a still already captured off the
        // previous clip, so none of this can apply to it.

        // No still and no clip: draw one from whatever the shot has written.
        if (!currentImage && !currentVideo) {
          const openingPrompt = resolveShotPrompt(startShot, 'image');
          if (!openingPrompt.trim()) {
            throw new Error(`${shotName} has no image, and no description to generate one from.`);
          }
          dreamPhase(clip, 'generating the opening image');
          const result = await submitGenerationJob({
            type: 'image',
            shotId,
            shotName,
            rawPrompt: openingPrompt,
            model: imageModelId,
            resolution: imageRes,
            primaryImagePaths: shotReferencePaths(startShot),
            attachTaggedImages: attachTagsForImages
          });
          if (!result?.ok) throw new Error(result?.error || 'The opening image failed to generate.');
          currentImage = result.path;
          dreamLog('1. opening image ready');
        }

        // A still but nothing written to animate it with. This is the common
        // way in — a frame grabbed off another clip, dropped on an empty shot —
        // so read the image and write the opening clip rather than refusing.
        if (clip === 1 && !currentVideo && !currentVideoPrompt.trim()) {
          if (!currentImage) {
            throw new Error(`${shotName} has nothing to start from — give it an image or a description.`);
          }
          dreamPhase(1, 'writing the opening clip from the image');
          const opening = await askDreamForClip({
            settings, framePath: currentImage, clip: 1, total, history: [], opening: true
          });
          currentVideoPrompt = opening.videoPrompt;
          // Write them onto the shot so the run leaves a shot you can re-roll
          // by hand, exactly like every shot the invent mode creates.
          handleUpdateShotField(shotId, 'draftVideoPrompt', opening.videoPrompt);
          if (opening.description && !String(startShot.description || '').trim()) {
            handleUpdateShotField(shotId, 'description', opening.description);
          }
          dreamLog(`1. ${opening.description || opening.videoPrompt.slice(0, 100)}`);
        }

        if (clip === 1) {
          history.push(startShot.description || currentVideoPrompt || '');
        }

        if (!currentVideo) {
          if (!String(currentVideoPrompt || '').trim()) {
            throw new Error(`${shotName} has no video prompt to work from.`);
          }
          dreamPhase(clip, 'generating the clip');
          const result = await submitGenerationJob({
            type: 'video',
            shotId,
            shotName,
            rawPrompt: currentVideoPrompt,
            model: videoModelId,
            resolution: videoRes,
            duration,
            primaryImagePaths: currentImage ? [currentImage] : [],
            attachTaggedImages: attachTagsForVideos
          });
          if (!result?.ok) throw new Error(result?.error || 'The clip failed to generate.');
          currentVideo = result.path;
        } else {
          dreamLog(`${clip}. reusing ${shotName}'s existing clip`);
        }

        previousVideo = currentVideo;
        setDreamRun(prev => (prev ? { ...prev, completed: clip } : prev));
      }
    } catch (error) {
      console.error('Dream failed:', error);
      failure = error.message || String(error);
      dreamLog(`Stopped: ${failure}`, 'error');
    }

    const stopped = dreamCancelRef.current;
    setDreamRun(prev => (prev ? { ...prev, active: false, phase: '', stopped, failed: Boolean(failure) } : prev));
    dreamCancelRef.current = false;

    // No explicit save: this closure captured `scenes` as they were before the
    // dream added anything, so writing them here would overwrite the run. The
    // debounced autosave already fired on every clip.

    if (failure) {
      showToast(`Dream ended early: ${failure}`, 'error');
    } else if (stopped) {
      showToast('Dream stopped. Everything generated so far is in your shot list.', 'warning');
    } else {
      showToast(`Dream complete — ${total} clip${total === 1 ? '' : 's'}.`, 'success');
    }
  };

  const handleStopDream = () => {
    dreamCancelRef.current = true;
    dreamLog('Stopping after the clip in flight…', 'info');
    showToast('Dream will stop once the current clip finishes.', 'warning');
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
  const assetEditorModel = (draft) => resolveAssetModelSettings(draft || {}).model;
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
    const modelId = assetEditorModel(draft);
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

  /**
   * Stamp an asset as edited in a way *shots can see* — tag, name, description
   * or primary image. The stamp is what dirty-shot detection (Phase C) compares
   * against each generation's recorded snapshot, so it must NOT move on edits
   * that only affect the asset's own artwork generation (inputImages, models,
   * promptWrap): those would flag every shot for changes no shot can observe.
   */
  const touchAsset = (asset) => ({ ...asset, updatedAt: new Date().toISOString() });

  /** Attach a freshly generated image to an asset, in the library and the open editor. */
  const attachImageToAsset = (assetId, imagePath) => {
    setAssetLibrary(prev => prev.map(asset => {
      if (asset.id !== assetId) return asset;
      const next = {
        ...asset,
        images: [...(asset.images || []), imagePath],
        primaryImage: asset.primaryImage || imagePath
      };
      // Only a change to the *effective* primary is visible to shots.
      return assetPrimaryImage(next) !== assetPrimaryImage(asset) ? touchAsset(next) : next;
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
    const resolvedAsset = resolveAssetModelSettings(asset);
    const model = resolvedAsset.model;
    const resolution = resolvedAsset.resolution || imageResolution;
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
          // A custom path may declare its host as `fal:` / `higgsfield:`;
          // a catalog model carries its provider in the catalog itself.
          providerFamily: parseModelId(model).family || getImageModel(model)?.provider || null,
          prompt: composed.prompt,
          resolution,
          inputImagePaths: composed.inputImagePaths,
          safetyChecker: atlasSafetyChecker,
          destination: assetDestination(asset)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Image API request failed');

      attachImageToAsset(asset.id, data.filePath);
      // The board indexes everything the resolver can auto-attach, so a
      // generated asset image registers itself — linked, kinded and tagged.
      // Shot outputs deliberately do not (they would flood the board with
      // takes); the gallery's "Add to ref board" action covers those.
      setReferenceImages(prev => {
        if (prev.some(r => r.path === data.filePath)) return prev;
        return [...prev, normalizeReference({
          path: data.filePath,
          name: `${asset.name || asset.tag} ${(asset.images || []).length + 1}`,
          kind: KIND_BY_ASSET_TYPE[asset.type] || 'other',
          assetId: asset.id,
          tags: asset.tag ? [asset.tag] : [],
          source: 'generated'
        })];
      });
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
          const descriptionChanged = (filledDescription || '') !== (asset.description || '');
          asset = { ...asset, imagePrompt, description: filledDescription };
          setAssetLibrary(prev => prev.map(a => {
            if (a.id !== asset.id) return a;
            const next = { ...a, imagePrompt, description: filledDescription };
            return descriptionChanged ? touchAsset(next) : next;
          }));
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
      shotDescription: (assetEditor.shotDescription || '').trim(),
      images,
      primaryImage: assetEditor.primaryImage || images[0] || null,
      inputImages: assetInputImages(assetEditor).filter(p => images.includes(p)),
      imagePrompt: assetEditor.imagePrompt || '',
      imageModel: assetEditor.imageModel || null,
      imageResolution: assetEditor.imageResolution || null,
      promptWrap: assetEditor.promptWrap || (assetEditor.applyGlobalPrompts ? 'image' : 'asset')
    };

    // Bump updatedAt only when a shot-visible field moved; otherwise carry the
    // old stamp so saving cosmetic settings never dirties every shot.
    const previous = assetLibrary.find(a => a.id === record.id) || null;
    // The comparison is on what a shot actually *sees*, not on the raw fields:
    // rewriting the full description to get better reference art is not a
    // reason to flag every shot, so long as the in-shot line is unchanged. It
    // still catches an edit to the full one when there is no short one, because
    // then the fallback means shots really did change.
    const shotVisibleChange = !previous
      || previous.tag !== record.tag
      || (previous.name || '') !== record.name
      || assetShotDescription(previous) !== assetShotDescription(record)
      || assetPrimaryImage(previous) !== assetPrimaryImage(record);
    record.updatedAt = shotVisibleChange ? new Date().toISOString() : (previous?.updatedAt || null);

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

  /**
   * Insert <Tag> at the caret in the generation modal prompt.
   *
   * No decoration: a tag is highlighted wherever it appears, whether it was
   * typed or inserted, because it is the text itself that is special.
   */
  const appendAssetTagToModalPrompt = (tag) => {
    insertIntoModalPrompt(`<${tag}>`, { decorate: false, joiner: ' ' });
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
    // Whatever is on screen right now and has never been written anywhere.
    // Since the app opens without a folder, this is the normal way a project
    // starts: poke around, make something, then say where it lives.
    const unsavedWork = !projectFs.getActiveHandle() && (
      scenes.length > 0 || imageGallery.length > 0 || videoGallery.length > 0 || assetLibrary.length > 0
    );

    setLoadingStates(prev => ({ ...prev, project: true }));
    try {
      const result = handle
        ? await projectFs.openRecentProject(handle)
        : await projectFs.pickProjectFolder();

      projectFs.clearAssetUrlCache(); // old blob: URLs point at the previous folder
      const state = await projectFs.readProjectState();

      if (!state) {
        // An empty folder becomes the home of what is already open, rather
        // than resetting it — otherwise picking a folder late would throw away
        // the very work that made you pick one.
        await projectFs.writeProjectState(buildStatePayload());
      } else if (unsavedWork && !window.confirm(
        `"${result.name}" already holds a project. Opening it replaces what you have on screen, ` +
        `which has never been saved. Open it anyway?`
      )) {
        // Backing out has to un-adopt the folder as well, or autosave would
        // quietly write the scratch work over the project we just declined.
        await projectFs.clearActiveProject();
        showToast('Kept what you had. Pick an empty folder to save it into.', 'info');
        return;
      } else {
        applyLoadedState(state);
      }

      await fetchProject();
      setNeedsFolderPermission(false);
      setFolderNoticeDismissed(false);
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
        const state = await projectFs.readProjectState();
        // Nothing was saved while the folder was out of reach, so anything on
        // screen would vanish under the project we are about to load.
        if (state && scenes.length > 0 && !window.confirm(
          `Loading "${projectFs.getActiveName()}" replaces what you have on screen, which has not been saved. Continue?`
        )) return;

        setNeedsFolderPermission(false);
        projectFs.clearAssetUrlCache();
        if (state) applyLoadedState(state);
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

      baselineRef.current = adoptBaseline(baselineRef.current, res, data);
      lastRevisionSeenRef.current = baselineRef.current.revision;
      setSaveBlock(null);
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

    // The watermark is a real file in the project, so Save As has to carry it.
    add(watermarkImage);

    scenes.forEach(scene => (scene.shots || []).forEach(shot => {
      add(shot.selectedImage);
      add(shot.selectedVideo);
      add(shot.lipSyncAudio);
      // Audio references may be URLs or asset:// ids, which `add` ignores —
      // only the ones uploaded into the project are files to copy.
      (shot.audioRefs || []).forEach(add);
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

  // --- CLEAN FILES ----------------------------------------------------------
  //
  // Two round trips, deliberately. The first plans and reports; nothing on disk
  // moves until the count has been shown and agreed to. The second carries it
  // out and hands back what *actually* moved — the mapping is built from the
  // renames that succeeded, never from the plan, so a file that could not be
  // moved keeps a path that still points at it.

  const organizeRequest = (apply) => apiFetch('/api/assets/organize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: buildStatePayload(), apply })
  });

  const handlePlanCleanFiles = async () => {
    setCleanFiles({ status: 'planning' });
    try {
      // Save first. Planning against a shot list the disk has not seen yet
      // would file this session's generations as strays.
      await flushSave();
      const res = await organizeRequest(false);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not read the project folder.');
      setCleanFiles({ status: 'preview', ...data });
    } catch (err) {
      setCleanFiles(null);
      showToast(`Clean Files failed: ${err.message}`, 'error');
    }
  };

  const handleApplyCleanFiles = async () => {
    setCleanFiles(prev => ({ ...prev, status: 'working' }));
    try {
      const res = await organizeRequest(true);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not move the files.');

      const mapping = new Map(data.mapping || []);
      const remapped = remapStateAssetPaths(buildStatePayload(), mapping);
      applyLoadedState(remapped, { resetHistory: false });
      if (isStatic()) projectFs.clearAssetUrlCache();
      // `extra` spreads last inside buildStatePayload, so the remapped state
      // wins over the hook values React has not re-rendered with yet.
      await saveProjectState(remapped.scenes, remapped, { force: true });

      setCleanFiles(null);
      const failures = (data.failed || []).length;
      showToast(
        `Filed ${data.moved} file${data.moved === 1 ? '' : 's'}` +
        (failures ? ` — ${failures} could not be moved and were left where they are.` : '.'),
        failures ? 'warning' : 'success'
      );
    } catch (err) {
      setCleanFiles(null);
      showToast(`Clean Files failed: ${err.message}`, 'error');
    }
  };

  /**
   * What Clean Files is about to do, before it does any of it.
   *
   * The preview is capped server-side — a first run on a real project is
   * thousands of rows, and nobody reads row eight hundred. The counts are the
   * part that matters; the sample is there to make the naming concrete.
   */
  const renderCleanFilesDialog = () => {
    if (!cleanFiles || cleanFiles.status === 'planning') return null;
    const { summary = {}, preview = [], moves = 0, status } = cleanFiles;
    const busy = status === 'working';

    return (
      <div className="modal-overlay" onClick={() => (busy ? null : setCleanFiles(null))}>
        <div className="modal-window" style={{ maxWidth: '720px' }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2 style={{ fontSize: '1.25rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <FolderOpen size={20} /> Clean Files
            </h2>
            {!busy && (
              <button className="btn btn-secondary" onClick={() => setCleanFiles(null)}><X size={16} /></button>
            )}
          </div>

          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {moves === 0 ? (
              <p style={{ margin: 0, fontSize: '0.85rem' }}>
                Everything is already where it belongs — {summary.total || 0} file
                {summary.total === 1 ? '' : 's'} checked, nothing to move.
              </p>
            ) : (
              <>
                <p style={{ margin: 0, fontSize: '0.85rem', lineHeight: 1.6 }}>
                  <strong>{moves}</strong> of {summary.total} file{summary.total === 1 ? '' : 's'} will move.
                  {summary.binned > 0 && (
                    <> <strong>{summary.binned}</strong> nothing in the project points at will go to{' '}
                    <code>assets/bin/</code> rather than being deleted.</>
                  )}
                  {summary.alreadyPlaced > 0 && <> {summary.alreadyPlaced} are already in place.</>}
                </p>
                <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  Files are moved, never copied or deleted, and a forwarding record is kept — so
                  checkpoints and auto-backups taken before this still open with their images intact.
                </p>

                <div style={{ maxHeight: '260px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.72rem', fontFamily: 'monospace' }}>
                    <tbody>
                      {preview.map(move => (
                        <tr key={move.from} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '6px 10px', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{move.from}</td>
                          <td style={{ padding: '6px 4px', color: 'var(--text-dim)' }}>→</td>
                          <td style={{ padding: '6px 10px', wordBreak: 'break-all' }}>{move.to}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {moves > preview.length && (
                  <span style={{ fontSize: '0.74rem', color: 'var(--text-dim)' }}>
                    …and {moves - preview.length} more.
                  </span>
                )}
              </>
            )}
          </div>

          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setCleanFiles(null)} disabled={busy}>
              {moves === 0 ? 'Close' : 'Cancel'}
            </button>
            {moves > 0 && (
              <button className="btn btn-primary" onClick={handleApplyCleanFiles} disabled={busy}>
                {busy ? <RefreshCw className="spinner" size={14} /> : <FolderOpen size={14} />}
                {busy ? ' Moving…' : ` Move ${moves} file${moves === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
        </div>
      </div>
    );
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
        const fileHandle = await projectFs.findProjectFileHandle(sourceHandle);
        if (!fileHandle) throw new Error(`No MovieMaker project file found in "${sourceHandle.name}".`);
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
              return touchAsset({
                ...asset,
                id: `asset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                images,
                primaryImage: mapping.get(asset.primaryImage) || images[0] || null,
                inputImages: assetInputImages(asset).map(p => mapping.get(p)).filter(Boolean)
              });
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
        const additions = incoming
          .filter(asset => {
            const clash = prev.some(existing => normalizeTag(existing.tag) === normalizeTag(asset.tag));
            if (clash) skipped += 1;
            return !clash;
          })
          .map(touchAsset);
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

  // --- IDEA → SCRIPT (in-app) ----------------------------------------------

  const handleGenerateScript = async () => {
    setScriptGenBusy(true);
    setScriptGenPreview(null);
    try {
      const result = await generateShotListFromIdea({
        idea: scriptGenIdea,
        assetLibrary,
        llm: { provider: activeLlm, model: llmModel },
        apiFetch,
        intro: promptText(promptSettings, 'importIntro')
      });
      setScriptGenPreview(result);
    } catch (err) {
      console.error(err);
      showToast(`Script generation failed: ${err.message}`, 'error');
    } finally {
      setScriptGenBusy(false);
    }
  };

  /** Commit the previewed document through the same path a pasted reply takes. */
  const handleApplyGeneratedScript = (mode) => {
    if (!scriptGenPreview?.raw) return;
    try {
      applyImportedDocument(scriptGenPreview.raw, mode);
      setScriptGenOpen(false);
      setScriptGenPreview(null);
    } catch (err) {
      showToast(`Import failed: ${err.message}`, 'error');
    }
  };

  // --- PIPELINE STAGES -------------------------------------------------------
  // Everything a long-lived run touches goes through pipelineFnsRef (updated
  // every render) and scenesRef/assetLibraryRef, because the closures captured
  // when the run started go stale the moment the script stage replaces the
  // project.

  useEffect(() => { assetLibraryRef.current = assetLibrary; }, [assetLibrary]);
  // No dependency array on purpose: refreshed after EVERY render so a running
  // pipeline always calls the newest closures. (An inline render assignment
  // would hit the temporal dead zone — applyImportedDocument is declared
  // further down the component.)
  useEffect(() => {
    pipelineFnsRef.current = {
      submitGenerationJob,
      writeShotPrompt,
      generateAssetImage,
      applyImportedDocument,
      handleUpdateShotField,
      submitFromProducingGroup,
      resolveShotPrompt
    };
  });

  const freshShots = () => scenesRef.current.flatMap(s => (s.shots || []).map(shot => ({ shot, sceneName: s.name })));

  /**
   * The stage list is a straight line with skippable nodes — no DAG machinery.
   * Candidate predicates re-derive work from live state, so a rerun after a
   * stop (or a reload) only does what is still missing, and the dirty stages
   * import their predicates from dirty.js rather than growing a second
   * dirtiness implementation.
   */
  const buildPipelineStages = () => {
    const fns = () => pipelineFnsRef.current;
    const submitShot = (type) => ({ shot }) => {
      const scene = scenesRef.current.find(sc => (sc.shots || []).some(s => s.id === shot.id)) || null;
      const resolved = resolveModelSettings({ type, project: projectModelDefaults, scene, shot });
      const isImage = type === 'image';
      return fns().submitGenerationJob({
        type,
        shotId: shot.id,
        shotName: shot.name,
        rawPrompt: fns().resolveShotPrompt(shot, type),
        model: resolved.model,
        resolution: resolved.resolution,
        duration: resolved.duration || videoDuration,
        primaryImagePaths: isImage ? shotReferencePaths(shot) : (shot.selectedImage ? [shot.selectedImage] : []),
        attachTaggedImages: isImage ? attachTagsForImages : attachTagsForVideos
      });
    };

    return [
      {
        id: 'script',
        label: 'Generate script',
        candidates: () => (
          freshShots().length === 0 && pipelineIdeaRef.current.trim() ? [{ id: 'script' }] : []
        ),
        run: async () => {
          const result = await generateShotListFromIdea({
            idea: pipelineIdeaRef.current,
            assetLibrary: assetLibraryRef.current,
            llm: { provider: activeLlm, model: llmModel },
            apiFetch,
            intro: promptText(promptSettings, 'importIntro')
          });
          fns().applyImportedDocument(result.raw, 'replace');
          // Let React commit the new scenes before the next stage derives from them.
          await new Promise(resolve => setTimeout(resolve, 50));
        },
        concurrency: 1
      },
      {
        id: 'assetImages',
        label: 'Asset reference images',
        candidates: () => assetLibraryRef.current
          .filter(asset => (asset.images || []).length === 0
            && (String(asset.description || '').trim() || String(asset.imagePrompt || '').trim()))
          .map(asset => ({ id: asset.id, asset })),
        run: ({ asset }) => {
          const fresh = assetLibraryRef.current.find(a => a.id === asset.id) || asset;
          return fns().generateAssetImage(fresh);
        },
        concurrency: 1 // strictly serial, like the existing asset batch
      },
      {
        id: 'shotPrompts',
        label: 'Write shot prompts',
        candidates: () => {
          const out = [];
          for (const { shot } of freshShots()) {
            if (!String(shot.description || '').trim()) continue;
            if (!String(shot.draftImagePrompt || '').trim()) out.push({ id: `${shot.id}_img`, shot, type: 'image' });
            if (!String(shot.draftVideoPrompt || '').trim()) out.push({ id: `${shot.id}_vid`, shot, type: 'video' });
          }
          return out;
        },
        run: async ({ shot, type }) => {
          const result = await fns().writeShotPrompt(shot, type, { withContext: true });
          if (result.ok) {
            fns().handleUpdateShotField(shot.id, type === 'image' ? 'draftImagePrompt' : 'draftVideoPrompt', result.text);
          }
          return result;
        },
        concurrency: 2 // LLM providers rate-limit harder than image hosts
      },
      {
        id: 'shotImages',
        label: 'Generate shot images',
        candidates: () => freshShots().filter(({ shot }) => (
          pipelineFnsRef.current.resolveShotPrompt(shot, 'image').trim()
          && !(shot.imagePrompts || []).some(p => (p.outputs || []).length > 0)
        )),
        run: submitShot('image'),
        concurrency: batchConcurrency
      },
      {
        id: 'select',
        label: 'Select stills',
        candidates: () => freshShots().filter(({ shot }) => (
          !shot.selectedImage && (shot.imagePrompts || []).some(p => (p.outputs || []).length > 0)
        )),
        run: ({ shot }) => {
          const outputs = (shot.imagePrompts || []).flatMap(p => p.outputs || []);
          const newest = [...outputs].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
          if (newest) fns().handleUpdateShotField(shot.id, 'selectedImage', newest.path);
          return { ok: Boolean(newest) };
        },
        concurrency: 1
      },
      {
        id: 'dirtyImages',
        label: 'Regenerate stale images',
        candidates: () => dirtyImageCandidates(scenesRef.current, assetLibraryRef.current),
        run: ({ shot }) => {
          const fresh = scenesRef.current.flatMap(s => s.shots || []).find(s => s.id === shot.id) || shot;
          return fns().submitFromProducingGroup(fresh, 'image');
        },
        concurrency: batchConcurrency
      },
      {
        id: 'shotVideos',
        label: 'Generate shot videos',
        candidates: () => freshShots().filter(({ shot }) => (
          pipelineFnsRef.current.resolveShotPrompt(shot, 'video').trim()
          && shot.selectedImage
          && !(shot.videoPrompts || []).some(p => (p.outputs || []).length > 0)
        )),
        run: submitShot('video'),
        concurrency: Math.min(2, batchConcurrency)
      },
      {
        id: 'dirtyVideos',
        label: 'Regenerate stale videos',
        candidates: () => dirtyVideoCandidates(scenesRef.current, assetLibraryRef.current),
        run: ({ shot }) => {
          const fresh = scenesRef.current.flatMap(s => s.shots || []).find(s => s.id === shot.id) || shot;
          return fns().submitFromProducingGroup(fresh, 'video');
        },
        concurrency: Math.min(2, batchConcurrency)
      },
      {
        id: 'timeline',
        label: 'Build timeline',
        candidates: () => (freshShots().some(({ shot }) => shot.selectedVideo || shot.selectedImage) ? [{ id: 'timeline' }] : []),
        run: () => {
          setEdit(previous => {
            const ctx = makeContext(scenesRef.current, previous.durations, Number(videoDuration) || 5);
            if ((previous.video || []).length === 0) {
              const clips = deriveVideoClips(scenesRef.current);
              const audioClips = deriveAudioClipsForShots(scenesRef.current, clips);
              const audio = audioClips.length > 0
                ? [...(previous.audio || []), { ...createAudioTrack('Dialogue'), clips: audioClips }]
                : (previous.audio || []);
              return normalize({ ...previous, video: clips, audio }, ctx);
            }
            // An existing cut is real work: reconcile keeps trims, transitions
            // and linked audio, only updating the running order.
            return reconcile(previous, scenesRef.current, ctx, { add: true, prune: true, reorder: true });
          });
          return { ok: true };
        },
        concurrency: 1
      }
    ];
  };

  /** Known catalog prices per candidate; null = credit-priced. LLM calls count as free. */
  const pipelinePriceFor = (stage, candidate) => {
    const modelPrice = (type, model) => {
      const record = type === 'image' ? getImageModel(model) : getVideoModel(model);
      return { price: typeof record?.price === 'number' ? record.price : null };
    };
    if (stage.id === 'assetImages') {
      return modelPrice('image', resolveAssetModelSettings(candidate.asset).model);
    }
    if (stage.id === 'shotImages' || stage.id === 'dirtyImages') {
      return modelPrice('image', resolveShotModelSettings('image', candidate.shot).model);
    }
    if (stage.id === 'shotVideos' || stage.id === 'dirtyVideos') {
      return modelPrice('video', resolveShotModelSettings('video', candidate.shot).model);
    }
    return { price: 0 };
  };

  // The panel's live counts + cost estimate, recomputed while it is open.
  useEffect(() => {
    if (!pipelineOpen) return undefined;
    let cancelled = false;
    estimateRun({ stages: buildPipelineStages(), skip: pipelineSkip, priceFor: pipelinePriceFor })
      .then(rows => { if (!cancelled) setPipelineEstimate(rows); })
      .catch(() => { if (!cancelled) setPipelineEstimate(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineOpen, pipelineSkip, scenes, assetLibrary, pipelineIdea]);

  const handleRunPipeline = () => {
    if (pipelineRunRef.current) return;
    const run = createPipelineRun({
      stages: buildPipelineStages(),
      options: {
        skip: pipelineSkip,
        concurrency: batchConcurrency,
        retry: { attempts: 2, backoffMs: 2000 }
      }
    });
    pipelineRunRef.current = run;
    run.subscribe(setPipelineRunState);
    run.start().then(finalState => {
      pipelineRunRef.current = null;
      const failed = Object.values(finalState.stageStates).reduce((sum, s) => sum + (s.failed?.length || 0), 0);
      showToast(
        finalState.status === 'cancelled'
          ? 'Pipeline stopped. Rerun to pick up where it left off.'
          : failed > 0
            ? `Pipeline finished with ${failed} failure${failed === 1 ? '' : 's'} — rerun to retry just those.`
            : 'Pipeline complete.',
        finalState.status === 'cancelled' || failed > 0 ? 'warning' : 'success'
      );
    });
  };

  const handleCopyLlmPrompt = async () => {
    const text = buildLlmImportPrompt({ assetLibrary, sourceMaterial: llmPromptSource, intro: promptText(promptSettings, 'importIntro') });
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

  /** The same import, from the paste box rather than a file on disk. */
  const handleImportPastedShotList = () => {
    if (!pasteImport) return;
    let parsed;
    try {
      parsed = extractJsonDocument(pasteImport.text);
    } catch (err) {
      showToast(`JSON parse error: ${err.message}`, 'error');
      return;
    }
    try {
      applyImportedDocument(parsed, pasteImport.mode);
      setPasteImport(null);
    } catch (err) {
      showToast(`Import failed: ${err.message}`, 'error');
    }
  };

  /**
   * Load an imported document into the studio.
   *
   * Handles both shapes: the shot-list schema (`assets`, per-shot `imagePrompt`,
   * nested `project` block) and a full state export (`assetLibrary`, galleries,
   * flat settings). Throws with a readable message if the document is unusable.
   */
  const applyImportedDocument = (parsed, mode = 'replace', { restoreGalleries = false } = {}) => {
    const { project, assets, promptSnippets: importedSnippets, scenes: importedScenes, warnings, idMap, legacyShotRefs } =
      normalizeImportedShotList(parsed);

    // Project-level settings.
    //
    // The pre/post and system prompts have no state of their own any more —
    // they are slots in `promptSettings`. Writing them through the setters they
    // used to have threw a ReferenceError that the import handlers caught and
    // reported as a plain "Import failed", so any document carrying a pre-prompt
    // could not be imported at all.
    const importedSlots = {};
    [
      'prePrompt', 'postPrompt', 'videoPrePrompt', 'videoPostPrompt',
      'imageSystemPrompt', 'videoSystemPrompt'
    ].forEach(slot => {
      if (typeof project[slot] === 'string') importedSlots[slot] = project[slot];
    });
    // A full state export carries the whole bag, including the slots that have
    // no flat mirror (asset templates, the import intro). The flat six win, so a
    // hand-written shot list still overrides what the bag happens to hold.
    const importedBag = parsed.promptSettings && typeof parsed.promptSettings === 'object'
      ? parsed.promptSettings
      : {};
    if (Object.keys(importedSlots).length > 0 || Object.keys(importedBag).length > 0) {
      setPromptSettings(prev => ({ ...prev, ...importedBag, ...importedSlots }));
    }

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
      const restoredRefs = (parsed.referenceImages || []).map(normalizeReference);
      setReferenceImages(restoredRefs);
      // Assignments in the export point at the exporter's scene/shot ids; the
      // normaliser mints fresh ids, so remap every edge target through its
      // idMap. Legacy pre-v2 exports carried per-shot refId arrays instead —
      // those become shot-scope edges here, because the schema migration only
      // runs at project load and can never see an imported document.
      const knownRefIds = new Set(restoredRefs.map(r => r.id));
      let restoredEdges = (parsed.refAssignments || [])
        .map(normalizeAssignment)
        .filter(edge => edge && knownRefIds.has(edge.refId))
        .map(edge => (edge.scope === 'project' ? edge : { ...edge, targetId: idMap[edge.targetId] || edge.targetId }));
      legacyShotRefs.forEach(({ shotId, refIds }) => {
        const usable = refIds.filter(id => knownRefIds.has(id));
        if (usable.length > 0) restoredEdges = assignReferences(restoredEdges, usable, [{ scope: 'shot', targetId: shotId }]);
      });
      setRefAssignments(restoredEdges);
      setConcatenatedVideo(parsed.concatenatedVideo || null);
      // A shot list on its own carries no edit; a full state export does.
      if (parsed.edit) setEdit(migrateEdit(parsed.edit));
    } else if (legacyShotRefs.length > 0) {
      // Shot-list import into an existing project: legacy per-shot refIds can
      // only mean references already on this project's board.
      setRefAssignments(prev => {
        const known = new Set(referenceImages.map(r => r.id));
        let next = prev;
        legacyShotRefs.forEach(({ shotId, refIds }) => {
          const usable = refIds.filter(id => known.has(id));
          if (usable.length > 0) next = assignReferences(next, usable, [{ scope: 'shot', targetId: shotId }]);
        });
        return next;
      });
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
            const next = {
              ...existing,
              type: incoming.type || existing.type,
              name: incoming.name || existing.name,
              description: incoming.description || existing.description,
              images: existing.images?.length ? existing.images : incoming.images,
              primaryImage: existing.primaryImage || incoming.primaryImage,
              inputImages: assetInputImages(existing).length ? assetInputImages(existing) : assetInputImages(incoming)
            };
            const shotVisibleChange = (existing.name || '') !== (next.name || '')
              || (existing.description || '') !== (next.description || '')
              || assetPrimaryImage(existing) !== assetPrimaryImage(next);
            merged[existingIndex] = shotVisibleChange ? touchAsset(next) : next;
          } else {
            merged.push(touchAsset(incoming));
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
        applyGlobalPrompts: false,
        updatedAt: new Date().toISOString()
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
    const sound = data.audioCount ? ` ${data.audioCount} shot(s) carried sound.` : ' Nothing had sound to carry.';
    // A shot whose audio file has gone missing compiles silent, which is easy to
    // mistake for "there was never any sound there".
    const lost = data.missingAudio?.length ? ` Audio missing for: ${data.missingAudio.slice(0, 3).join(', ')}.` : '';
    const skipped = data.skipped?.length ? ` ${data.skipped.length} shot(s) skipped (no media).` : '';
    return `Compiled ${parts.join(' + ') || 'timeline'}.${sound}${lost}${skipped}`;
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
      audioRefs: [],
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

  /**
   * What a shot contributes to a compile.
   *
   * Shots with no video contribute their still, so a partly generated edit still
   * plays end to end as an animatic. Its audio file goes along with it: the
   * compile mixes the clip's own soundtrack and the shot's audio together, the
   * same way the editor does, so a narrated animatic is watchable without going
   * through the timeline first.
   */
  const compileItems = (shotList) => (shotList || []).map(sh => ({
    video: sh.selectedVideo || null,
    image: sh.selectedImage || null,
    audio: sh.lipSyncAudio || null,
    duration: Number(sh.videoDuration || videoDuration) || 5,
    name: sh.name
  })).filter(entry => entry.video || entry.image);

  /** One line for the queue saying what this compile is made of. */
  const compileSummary = (timeline, label) => {
    const withAudio = timeline.filter(entry => entry.audio).length;
    return `Compile ${label} — ${timeline.length} shot${timeline.length === 1 ? '' : 's'}`
      + (withAudio ? `, ${withAudio} with its own audio` : '');
  };

  const handleStitchCompilation = async () => {
    const timeline = compileItems(scenes.flatMap(s => s.shots || []));

    if (timeline.length === 0) {
      showToast('No shot has a video or an image to compile.', 'warning');
      return;
    }

    setLoadingStates(prev => ({ ...prev, compilation: true }));
    const jobId = startJob({
      type: 'compile',
      shotName: 'Full film',
      prompt: compileSummary(timeline, 'the whole film')
    });
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
      finishJob(jobId, { status: 'completed', outputPath: data.filePath });
      showToast(describeCompile(data), 'success');
    } catch (err) {
      console.error(err);
      finishJob(jobId, { status: 'failed', error: err.message });
      showToast(`Compilation failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, compilation: false }));
    }
  };

  const handleConcatenateScene = async (sceneId) => {
    const targetScene = scenes.find(s => s.id === sceneId);
    if (!targetScene) return;

    const timeline = compileItems(targetScene.shots);

    if (timeline.length === 0) {
      showToast('No shot in this scene has a video or an image.', 'warning');
      return;
    }

    setLoadingStates(prev => ({ ...prev, compilation: true }));
    const jobId = startJob({
      type: 'compile',
      shotName: targetScene.name || 'Scene',
      prompt: compileSummary(timeline, targetScene.name || 'this scene')
    });
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
      finishJob(jobId, { status: 'completed', outputPath: data.filePath });
      showToast(describeCompile(data), 'success');
    } catch (err) {
      console.error(err);
      finishJob(jobId, { status: 'failed', error: err.message });
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

  /**
   * Attach reference audio to a shot, as a URL you host yourself.
   *
   * Deliberately not the same field as `lipSyncAudio`: that one is a track to
   * sync an *already generated* video against, while these are inputs the model
   * generates *from* — Seedance 2.0 will sing to them, speak to them or cut to
   * their beat, addressed from the prompt as @audio1..@audio3.
   *
   * A URL rather than an upload because Atlas has to fetch the file itself.
   * The studio briefly relayed local files through Fal storage to manufacture
   * one; that needed a second API key, sent your audio to a provider that was
   * not generating anything, and still depended on an Atlas endpoint that
   * refused API keys. Hosting it yourself is fewer moving parts than any of it.
   */
  /** Room left for another clip on this shot, by its resolved video model. */
  const audioRefRoom = (shot) => (
    refAudioCapacity('video', resolveShotModelSettings('video', shot).model) - (shot?.audioRefs || []).length
  );

  const attachAudioRef = (shotId, ref) => {
    const shot = shots.find(s => s.id === shotId);
    const existing = shot?.audioRefs || [];
    if (existing.includes(ref)) {
      showToast('That clip is already on this shot.', 'warning');
      return false;
    }
    if (audioRefRoom(shot) <= 0) {
      const capacity = refAudioCapacity('video', resolveShotModelSettings('video', shot).model);
      showToast(`This shot already has the ${capacity} reference clip${capacity === 1 ? '' : 's'} the model accepts.`, 'warning');
      return false;
    }
    handleUpdateShotField(shotId, 'audioRefs', [...existing, ref]);
    showToast(`Attached as @audio${existing.length + 1}.`, 'success');
    return true;
  };

  const handleAddAudioRef = (shotId) => {
    const url = String(audioRefDrafts[shotId] || '').trim();
    if (!url) return;
    // Either a link the model host can fetch, or an id for a clip already
    // uploaded to Atlas's own Asset Library.
    if (!/^(https?|asset):\/\//i.test(url)) {
      showToast('Needs a full https:// URL, or an asset:// id from the Atlas Asset Library.', 'warning');
      return;
    }
    if (attachAudioRef(shotId, url)) setAudioRefDrafts(prev => ({ ...prev, [shotId]: '' }));
  };

  /**
   * Attach a clip from disk. Only Fal can use one: it uploads the file to its
   * own storage and hands the model that address, where Atlas forwards the
   * string untouched and needs somewhere already reachable.
   */
  const handleAudioRefUpload = async (shotId, e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;

    const room = audioRefRoom(shots.find(s => s.id === shotId));
    if (room <= 0) {
      showToast('No slots left for another clip on this shot.', 'warning');
      return;
    }

    const key = `audioref_${shotId}`;
    setLoadingStates(prev => ({ ...prev, [key]: true }));
    try {
      for (const file of files.slice(0, room)) {
        const formData = new FormData();
        formData.append('file', file);
        const res = await apiFetch(`/api/upload`, { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        attachAudioRef(shotId, data.filePath);
      }
    } catch (err) {
      console.error(err);
      showToast(`Upload failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, [key]: false }));
    }
  };

  // Removal renumbers everything after it, so a prompt pointing at @audio2
  // starts addressing a different clip. Worth saying out loud.
  const handleRemoveAudioRef = (shotId, path) => {
    const shot = shots.find(s => s.id === shotId);
    const remaining = (shot?.audioRefs || []).filter(p => p !== path);
    handleUpdateShotField(shotId, 'audioRefs', remaining);
    if (remaining.length > 0) {
      showToast('Removed — the clips after it have shifted up a slot, so check any @audio pointers in the prompt.', 'info');
    }
  };

  /**
   * Write the project out as a readable folder tree.
   *
   * Flushes first: the export reads the saved state from disk, so anything
   * typed in the last half-second would otherwise be missing from a file that
   * looks complete.
   */
  const handleExportProject = async () => {
    setLoadingStates(prev => ({ ...prev, export: true }));
    try {
      await flushSave();
      const res = await apiFetch(`/api/export`, { method: 'POST' });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.error || 'Export failed');

      const missing = (data.missing || []).length;
      showToast(
        `Exported ${data.files} file${data.files === 1 ? '' : 's'} and ${data.sheets} sheet${data.sheets === 1 ? '' : 's'} to export/.`
        + (missing > 0 ? ` ${missing} referenced file${missing === 1 ? ' was' : 's were'} missing from disk.` : ''),
        missing > 0 ? 'warning' : 'success'
      );
      if (missing > 0) console.warn('Export: missing files', data.missing);
    } catch (err) {
      console.error(err);
      showToast(`Export failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, export: false }));
    }
  };

  // --- WATERMARK PASS ---------------------------------------------------------

  const handleWatermarkUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setLoadingStates(prev => ({ ...prev, watermark: true }));
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiFetch(`/api/upload`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setWatermarkImage(data.filePath);
      showToast(`Watermark set to ${file.name}. Click Render Watermark to stamp it on.`, 'success');
    } catch (err) {
      console.error(err);
      showToast(`Upload failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, watermark: false }));
    }
  };

  /**
   * Stamp the mark onto the compiled video.
   *
   * The result replaces the preview but not the file: the clean master stays on
   * disk under its own name, so a marked cut is something you made rather than
   * something that happened to the only copy.
   */
  const handleRenderWatermark = async () => {
    if (!concatenatedVideo || !watermarkImage) return;
    setLoadingStates(prev => ({ ...prev, watermark: true }));
    const jobId = startJob({
      type: 'watermark',
      shotName: 'Master',
      prompt: `Stamp ${pathBaseName(watermarkImage)} onto ${pathBaseName(concatenatedVideo)} (${watermarkMotion})`
    });
    try {
      const res = await apiFetch(`/api/watermark`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoPath: concatenatedVideo, markPath: watermarkImage, motion: watermarkMotion })
      });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.error || 'Watermark failed');

      setVideoGallery(prev => [{
        id: 'vid_' + Date.now(),
        path: data.filePath,
        prompt: `Watermarked with ${pathBaseName(watermarkImage)}`,
        name: `Marked_${Date.now().toString().slice(-4)}`,
        createdAt: new Date().toISOString()
      }, ...prev]);
      setConcatenatedVideo(data.filePath);
      finishJob(jobId, { status: 'completed', outputPath: data.filePath });
      showToast('Watermarked. The clean master is still in your project folder.', 'success');
    } catch (err) {
      console.error(err);
      finishJob(jobId, { status: 'failed', error: err.message });
      showToast(`Watermark failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, watermark: false }));
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

    // Lipsync is a minutes-long remote job like any generation, but it used to
    // report only through a word on a tiny button and a toast that clears
    // itself — so a run in progress and a run that failed while you looked away
    // were indistinguishable from nothing having happened. It gets a job entry
    // for the same reason generations do: somewhere the answer stays put.
    const jobId = startJob({
      type: 'lipsync',
      shotId,
      shotName: shot.name || 'Shot',
      model: 'fal-ai/sync-lipsync',
      prompt: `Lipsync ${pathBaseName(shot.selectedVideo)} to ${pathBaseName(shot.lipSyncAudio)}`
    });
    showToast('Lip-sync started — track it in the Batch Manager.', 'info');

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

      finishJob(jobId, { status: 'completed', outputPath: data.filePath });
      showToast('Lip-sync complete! Output added and selected.', 'success');
    } catch (err) {
      console.error(err);
      finishJob(jobId, { status: 'failed', error: err.message });
      showToast(`Lip sync failed: ${err.message}`, 'error');
    } finally {
      setLoadingStates(prev => ({ ...prev, [key]: false }));
    }
  };

  /**
   * A response body, whether or not it turned out to be JSON.
   *
   * `await res.json()` on an Express 404 throws `Unexpected token '<'`, because
   * the body is an HTML error page — which says nothing about the actual
   * problem. And the actual problem is almost always the same one: the route
   * exists in the source but not in the process still running from before the
   * edit. Node caches modules; the backend has to be restarted.
   */
  const readJsonResponse = async (res) => {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      if (res.status === 404) {
        return { error: 'The backend does not have this endpoint — it is still running the build from before this change. Restart it with "node server.js".' };
      }
      return { error: `The backend replied with ${res.status} and no JSON: ${text.slice(0, 160)}` };
    }
  };

  const pathBaseName = (p) => {
    if (!p) return '';
    return p.split('/').pop().split('\\').pop();
  };

  // Audio references are URLs, and a signed one carries a query string longer
  // than the filename. Show the file, keep the whole thing in the tooltip.
  const audioRefLabel = (url) => pathBaseName(String(url || '').split(/[?#]/)[0]) || url;

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

  /**
   * Re-read the project's assets folder.
   *
   * This is the catch-all image source — captured frames, hand-copied files,
   * anything the named galleries never learned about. Split out from the
   * selector below so the shot picker can refresh it without also opening a
   * different dialog. Resolves either way; a failure just means the picker
   * shows the sources it does know about.
   */
  const fetchProjectImages = async () => {
    setLoadingStates(prev => ({ ...prev, project_images: true }));
    try {
      const res = await apiFetch(`/api/project-images`);
      if (!res.ok) {
        showToast('Failed to load project images', 'error');
        return false;
      }
      setProjectImagesList(await res.json());
      return true;
    } catch (err) {
      console.error(err);
      showToast('Error loading project images', 'error');
      return false;
    } finally {
      setLoadingStates(prev => ({ ...prev, project_images: false }));
    }
  };

  const openProjectImageSelector = async (target) => {
    if (await fetchProjectImages()) setProjectImagesSelector({ target });
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
  /**
   * Link unassigned references to assets by reading their filenames.
   *
   * Proposes rather than applies. A wrong link is invisible — it rides along
   * with every future generation of that character and only shows up in an
   * output — so the guesses go in front of you first, with the near-ties
   * flagged.
   */
  const handleAutoAssignReferences = () => {
    if (assetLibrary.length === 0) {
      showToast('No assets to match against — define some first.', 'warning');
      return null;
    }
    const proposals = autoAssignReferences({ references: referenceImages, assetLibrary });
    if (proposals.length === 0) {
      showToast('No filenames matched an asset tag or name.', 'info');
      return null;
    }
    return proposals;
  };

  const handleApplyRefProposals = (proposals) => {
    const byAsset = new Map();
    proposals.forEach(({ refId, assetId }) => {
      if (!byAsset.has(assetId)) byAsset.set(assetId, []);
      byAsset.get(assetId).push(refId);
    });
    byAsset.forEach((refIds, assetId) => handleUpdateReferences(refIds, { assetId }));
    showToast(`Linked ${proposals.length} reference${proposals.length === 1 ? '' : 's'}.`, 'success');
  };

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

  /**
   * One-click "Add to ref board" for gallery stills. Shot outputs are never
   * auto-registered (they would flood the board with takes); this is the
   * deliberate opt-in for the keepers.
   */
  const handleAddPathToBoard = (path, name = '') => {
    if (!path) return;
    if (referenceImages.some(r => r.path === path)) {
      showToast('Already on the reference board.', 'warning');
      return;
    }
    setReferenceImages(prev => [normalizeReference({
      path,
      name: String(name).replace(/\.[^.]+$/, '') || 'Still',
      source: 'generated'
    }), ...prev]);
    showToast('Added to the reference board.', 'success');
  };

  /** Promote an auto/inherited reference to a shot-scope edge — it survives model swaps and batches. */
  const handlePinReferenceToShot = (shotId, refId) => {
    setRefAssignments(prev => assignReferences(prev, [refId], [{ scope: 'shot', targetId: shotId }]));
    showToast('Reference pinned to this shot.', 'success');
  };

  /** Opt this shot out of a board-contributed reference (auto-attached or inherited). */
  const handleExcludeReferenceFromShot = (shot, refId) => {
    const current = shot.refExclusions || [];
    if (!current.includes(refId)) {
      handleUpdateShotField(shot.id, 'refExclusions', [...current, refId]);
    }
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

  /**
   * Open the picker, and refresh the assets-folder listing while it loads.
   *
   * That listing is the catch-all source — captured frames, hand-copied files,
   * anything the named galleries never learned about — so it has to be current
   * rather than whatever was fetched the last time some other dialog needed it.
   */
  const openMediaPicker = (shotId, kind) => {
    setMediaPicker({ shotId, kind });
    if (kind === 'image') fetchProjectImages();
  };

  const handlePickShotMedia = (path) => {
    if (!mediaPicker) return;
    const { shotId, kind } = mediaPicker;
    const field = kind === 'video' ? 'selectedVideo' : 'selectedImage';
    handleUpdateShotField(shotId, field, path);
    setMediaPicker(null);
    showToast(`${kind === 'video' ? 'Clip' : 'Image'} set${path ? '' : ' — slot cleared'}.`, 'success');
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

  // Hosted build, no usable folder yet. This used to gate the whole app behind
  // a folder picker on first paint, which meant you had to commit to a place on
  // disk before you could even look around. Nothing here needs a folder until
  // something is written, so it is a banner now — the picker comes when the
  // work does.
  const folderNotice = runtimeMode !== 'static' || folderNoticeDismissed ? null
    : !projectFs.isFileSystemAccessSupported() ? 'unsupported'
    : needsFolderPermission ? 'reconnect'
    : project.needsFolder ? 'none'
    : null;

  // The editor is a separate view, not an overlay: it unmounts the creation UI
  // entirely so the two never have to share layout or keyboard shortcuts.
  if (view === 'edit') {
    return (
      <EditView
        scenes={scenes}
        edit={edit}
        setEdit={setEdit}
        videoDuration={videoDuration}
        onToast={showToast}
        onJobStart={startJob}
        onJobUpdate={finishJob}
        onClose={() => setView('create')}
        banner={(
          <SaveGuardBanner
            block={saveBlock}
            onReload={reloadProjectState}
            onForce={forceSaveProjectState}
          />
        )}
      />
    );
  }

  return (
    <div className="app-container">
      {/* Autosave has stopped. Above everything, because everything below it is
          no longer being written to disk. */}
      <SaveGuardBanner
        block={saveBlock}
        onReload={reloadProjectState}
        onForce={forceSaveProjectState}
      />

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
              title={project.needsFolder
                ? 'No folder chosen yet — nothing is being saved. Click to pick one.'
                : project.path || 'No project file — using the loose project_state.json'}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.75rem', color: project.isLegacy || project.needsFolder ? 'var(--accent)' : 'var(--text-dim)', fontFamily: 'inherit' }}
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
              <MenuItem
                icon={Undo2}
                disabled={!historyCanUndo(history)}
                hint="Ctrl+Z"
                onClick={handleUndo}
              >
                {historyCanUndo(history) ? `Undo ${historyUndoLabel(history)}` : 'Undo'}
              </MenuItem>
              <MenuItem
                icon={Redo2}
                disabled={!historyCanRedo(history)}
                hint="Ctrl+Shift+Z"
                onClick={handleRedo}
              >
                {historyCanRedo(history) ? `Redo ${historyRedoLabel(history)}` : 'Redo'}
              </MenuItem>
              <MenuSeparator />
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
              <MenuItem
                icon={FolderOpen}
                disabled={Boolean(cleanFiles) || project.needsFolder}
                onClick={handlePlanCleanFiles}
                title={project.needsFolder
                  ? 'Choose a project folder first'
                  : 'File every generation under its shot, asset or reference — shows what will move before anything does'}
              >
                Clean files…
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
                icon={ClipboardPaste}
                onClick={() => setPasteImport({ text: '', mode: 'replace' })}
                title="Paste an LLM's reply straight in, fence and all"
              >
                Paste shot list…
              </MenuItem>
              <MenuItem
                icon={Upload}
                onClick={() => { shotListInputRef.current.dataset.mode = 'replace'; shotListInputRef.current.click(); }}
                hint="file"
              >
                Import shot list…
              </MenuItem>
              <MenuItem
                icon={Plus}
                onClick={() => { shotListInputRef.current.dataset.mode = 'append'; shotListInputRef.current.click(); }}
                hint="file, append"
              >
                Import and add after…
              </MenuItem>

              <MenuSeparator />
              <MenuItem icon={FileJson} onClick={() => setActiveOverlay('settings')}>
                Backup / export…
              </MenuItem>
              <MenuItem
                icon={FolderOpen}
                disabled={isStatic() || loadingStates.export}
                onClick={handleExportProject}
                title={isStatic()
                  ? 'Needs the local server build — it writes a folder tree'
                  : 'Write export/ with readable names, one folder per scene, and a sheet per shot'}
              >
                {loadingStates.export ? 'Exporting…' : 'Export readable folder…'}
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
                icon={Zap}
                disabled={Boolean(batchRunner)}
                onClick={() => setPipelineOpen(true)}
                badge={pipelineRunRef.current && <span className="menu-badge">running</span>}
                title="One button: idea → script → assets → prompts → images → videos → timeline"
              >
                Pipeline…
              </MenuItem>
              <MenuSeparator />
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
                icon={Sparkles}
                disabled={Boolean(batchRunner)}
                onClick={() => handleWriteAllPrompts('image', 'all')}
                title="LLM-writes an image prompt for every shot that has a description but no draft prompt yet"
              >
                Write all image prompts
              </MenuItem>
              <MenuItem
                icon={Sparkles}
                disabled={Boolean(batchRunner)}
                onClick={() => handleWriteAllPrompts('video', 'all')}
                title="LLM-writes a video prompt for every shot that has a description but no draft prompt yet"
              >
                Write all video prompts
              </MenuItem>
              <MenuItem
                icon={FileText}
                disabled={Boolean(batchRunner)}
                onClick={() => setScriptGenOpen(true)}
                title="Describe the film in a few sentences; the LLM writes the scenes, shots and assets"
              >
                Idea → Script…
              </MenuItem>

              <MenuSeparator />
              {(() => {
                const staleImages = [...dirtyMap.values()].filter(d => d.image.dirty).length;
                const staleVideos = [...dirtyMap.values()].filter(d => d.video.dirty).length;
                const total = staleImages + staleVideos;
                return (
                  <MenuItem
                    icon={RefreshCw}
                    disabled={Boolean(batchRunner) || total === 0}
                    onClick={handleRegenerateStale}
                    badge={total > 0 && <span className="menu-badge">{total}</span>}
                    title="Regenerate every shot whose assets changed since it was made: images first, then the videos that depended on them"
                  >
                    Regenerate stale
                  </MenuItem>
                );
              })()}
              <MenuSeparator />
              <MenuItem
                icon={Moon}
                onClick={() => setDreamOpen(true)}
                badge={dreamRun?.active && <span className="menu-badge">{dreamRun.completed}/{dreamRun.total}</span>}
                title="One continuous shot: each clip animates the last frame of the one before it"
              >
                Dream…
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

          <div style={{ display: 'flex', gap: '2px' }}>
            <button
              className="btn btn-secondary"
              style={{ padding: '8px', borderRadius: '50%' }}
              disabled={!historyCanUndo(history)}
              onClick={handleUndo}
              title={historyCanUndo(history) ? `Undo ${historyUndoLabel(history)} (Ctrl+Z)` : 'Nothing to undo'}
            >
              <Undo2 size={17} />
            </button>
            <button
              className="btn btn-secondary"
              style={{ padding: '8px', borderRadius: '50%' }}
              disabled={!historyCanRedo(history)}
              onClick={handleRedo}
              title={historyCanRedo(history) ? `Redo ${historyRedoLabel(history)} (Ctrl+Shift+Z)` : 'Nothing to redo'}
            >
              <Redo2 size={17} />
            </button>
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

      {/* Hosted build, folder not settled yet. Informational, never blocking:
          look around all you like, the picker is one click away when you have
          something worth keeping. */}
      {folderNotice && (
        <div
          className="glass-panel"
          style={{
            margin: '12px 24px 0', padding: '10px 14px', display: 'flex', alignItems: 'center',
            gap: '12px', flexWrap: 'wrap', background: 'rgba(139,92,246,0.08)',
            border: '1px solid var(--border-light)'
          }}
        >
          <AlertTriangle size={15} style={{ flexShrink: 0, color: 'var(--accent)' }} />
          <span style={{ flex: 1, minWidth: '260px', fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {folderNotice === 'unsupported' ? (
              <>
                This browser can't open local folders, so nothing can be saved. MovieMaker keeps projects as
                real files on your disk via the File System Access API — Chrome, Edge and other Chromium
                browsers. Open this page there when you're ready to work for real.
              </>
            ) : folderNotice === 'reconnect' ? (
              <>
                <strong style={{ color: 'var(--text-main)' }}>{projectFs.getActiveName()}</strong> is waiting —
                your browser needs one click to re-grant access before it loads and saves again.
              </>
            ) : (
              <>
                Nothing is being saved yet. Choose a folder when you're ready — the project file and every
                generated image and video are written straight into it, with nothing uploaded to this site.
              </>
            )}
          </span>
          {folderNotice === 'reconnect' && (
            <button className="btn btn-primary" style={{ fontSize: '0.78rem', padding: '5px 12px' }} onClick={handleReconnectFolder}>
              <FolderOpen size={13} /> Reconnect
            </button>
          )}
          {folderNotice !== 'unsupported' && (
            <button
              className={folderNotice === 'reconnect' ? 'btn btn-secondary' : 'btn btn-primary'}
              style={{ fontSize: '0.78rem', padding: '5px 12px' }}
              disabled={loadingStates.project}
              onClick={() => adoptStaticProject()}
            >
              {loadingStates.project ? <RefreshCw className="spinner" size={13} /> : <FolderOpen size={13} />}
              {folderNotice === 'reconnect' ? 'Different folder…' : 'Choose project folder…'}
            </button>
          )}
          <button
            className="btn btn-secondary"
            title="Hide this — the project name in the header always says where you stand"
            style={{ padding: '5px', borderRadius: '50%' }}
            onClick={() => setFolderNoticeDismissed(true)}
          >
            <X size={13} />
          </button>
        </div>
      )}

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
                  {/* A second pass over the finished master, not part of the
                      compile: the mark is a decision made after watching it,
                      and the clean cut stays on disk beside the marked one. */}
                  <input
                    type="file"
                    accept="image/*"
                    ref={watermarkInputRef}
                    onChange={handleWatermarkUpload}
                    style={{ display: 'none' }}
                  />
                  <button
                    className="btn btn-secondary"
                    style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                    disabled={loadingStates.watermark || isStatic()}
                    title={isStatic()
                      ? 'Needs the local server build — this is an FFmpeg pass'
                      : (watermarkImage
                        ? `Stamp ${pathBaseName(watermarkImage)} onto the compiled video, drifting across the frame`
                        : 'Pick a black-and-white image to stamp onto the compiled video')}
                    onClick={() => (watermarkImage ? handleRenderWatermark() : watermarkInputRef.current?.click())}
                  >
                    {loadingStates.watermark
                      ? <><RefreshCw className="spinner" size={11} /> Marking…</>
                      : <><Sparkles size={11} /> Render Watermark</>}
                  </button>
                  {watermarkImage && !loadingStates.watermark && (
                    <button
                      className="btn btn-secondary"
                      style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                      title={`Using ${pathBaseName(watermarkImage)} — click to choose a different image`}
                      onClick={() => watermarkInputRef.current?.click()}
                    >
                      <ImageIcon size={11} /> {pathBaseName(watermarkImage).slice(0, 14)}
                    </button>
                  )}
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

                {/* Scene-level model defaults: shots inherit these unless they
                    carry their own override. */}
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <ModelPill
                    type="image"
                    resolved={resolveModelSettings({ type: 'image', project: projectModelDefaults, scene: activeScene })}
                    value={activeScene.imageModel}
                    onChange={(v) => handleUpdateSceneField(activeScene.id, 'imageModel', v)}
                  />
                  <ModelPill
                    type="video"
                    resolved={resolveModelSettings({ type: 'video', project: projectModelDefaults, scene: activeScene })}
                    value={activeScene.videoModel}
                    onChange={(v) => handleUpdateSceneField(activeScene.id, 'videoModel', v)}
                  />
                </div>

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

          {/* Stale-only display filter, shown only when something is stale. */}
          {[...dirtyMap.values()].some(d => d.image.dirty || d.video.dirty) && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.78rem', color: 'var(--warning, #f59e0b)', alignSelf: 'flex-start' }}>
              <input type="checkbox" checked={showOnlyStale} onChange={(e) => setShowOnlyStale(e.target.checked)} />
              Stale only ({[...dirtyMap.values()].filter(d => d.image.dirty || d.video.dirty).length} shot{[...dirtyMap.values()].filter(d => d.image.dirty || d.video.dirty).length === 1 ? '' : 's'} whose assets changed since generation)
            </label>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {activeSceneShots.map((shot, index) => {
              const isCollapsed = isShotCollapsed(shot.id);
              const isActive = shot.id === activeShotId;
              const shotDirty = dirtyMap.get(shot.id);
              const isStale = Boolean(shotDirty?.image.dirty || shotDirty?.video.dirty);
              if (showOnlyStale && !isStale) return null;

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
                      {isStale && (
                        <span
                          style={{ fontSize: '0.65rem', background: 'rgba(245, 158, 11, 0.15)', color: 'var(--warning, #f59e0b)', padding: '2px 6px', borderRadius: '999px', whiteSpace: 'nowrap' }}
                          title={[
                            ...(shotDirty.image.dirty ? shotDirty.image.reasons.map(r => `image: ${r}`) : []),
                            ...(shotDirty.video.dirty ? shotDirty.video.reasons.map(r => `video: ${r}`) : [])
                          ].join('\n')}
                        >
                          stale
                        </span>
                      )}
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
                              {/* Lipsync re-animates a finished clip, so it needs
                                  one to work on. A greyed button that never says
                                  why reads as broken rather than as waiting. */}
                              {shot.lipSyncAudio && (
                                <button
                                  className="btn btn-primary"
                                  style={{ padding: '2px 6px', fontSize: '0.65rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                                  onClick={() => handleRunLipSync(shot.id)}
                                  disabled={!shot.selectedVideo || loadingStates[`sync_${shot.id}`]}
                                  title={shot.selectedVideo
                                    ? `Re-animate the active clip's mouth to ${pathBaseName(shot.lipSyncAudio)}`
                                    : 'No active video on this shot yet — generate a clip and double-click it to select it, or pick one from the project.'}
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
                      {/* Which models this shot resolves to and why; click to
                          override on the shot, pick Inherit to clear. */}
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '10px' }}>
                        <ModelPill
                          type="image"
                          resolved={resolveShotModelSettings('image', shot)}
                          value={shot.imageModel}
                          onChange={(v) => handleUpdateShotField(shot.id, 'imageModel', v)}
                        />
                        <ModelPill
                          type="video"
                          resolved={resolveShotModelSettings('video', shot)}
                          value={shot.videoModel}
                          onChange={(v) => handleUpdateShotField(shot.id, 'videoModel', v)}
                        />
                      </div>

                      <div style={{ marginTop: '12px' }}>
                        <ReferenceStrip
                          entries={shotReferenceEntries(shot)}
                          capacity={refImageCapacity('image', resolveShotModelSettings('image', shot).model)}
                          onToggleEntry={(entry) => toggleShotReferenceEntry(shot, entry)}
                          onOpenPanel={() => { setActiveShotId(shot.id); setReferencePanelOpen(true); }}
                        />
                      </div>

                      {/* Reference audio, shown only where the shot's video model
                          takes it. Slots are positional and the prompt names them,
                          so each clip wears its own @audioN. */}
                      {(() => {
                        const audioCapacity = refAudioCapacity('video', resolveShotModelSettings('video', shot).model);
                        if (audioCapacity === 0) return null;
                        const clips = shot.audioRefs || [];
                        return (
                          <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                              Audio refs {clips.length}/{audioCapacity}
                            </span>
                            {clips.map((path, audioIndex) => (
                              <span
                                key={path}
                                title={path}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.7rem',
                                  padding: '3px 6px', borderRadius: 'var(--radius-sm)',
                                  border: '1px solid var(--border-light)', background: 'var(--bg-card)'
                                }}
                              >
                                <Music size={10} style={{ color: 'var(--accent)' }} />
                                <code style={{ color: 'var(--accent)' }}>@audio{audioIndex + 1}</code>
                                <span style={{ maxWidth: '130px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                                  {audioRefLabel(path)}
                                </span>
                                <button
                                  className="btn btn-danger"
                                  style={{ padding: '1px 3px' }}
                                  onClick={() => handleRemoveAudioRef(shot.id, path)}
                                >
                                  <X size={9} />
                                </button>
                              </span>
                            ))}
                            {clips.length < audioCapacity && (
                              <>
                                <input
                                  type="url"
                                  className="input-field"
                                  style={{ width: '230px', padding: '2px 6px', fontSize: '0.68rem' }}
                                  placeholder="https://…/vocal.mp3 or asset://…"
                                  value={audioRefDrafts[shot.id] || ''}
                                  onChange={(e) => setAudioRefDrafts(prev => ({ ...prev, [shot.id]: e.target.value }))}
                                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddAudioRef(shot.id); }}
                                  title="A public mp3 or wav URL the model can fetch, or an asset:// id from the Atlas Asset Library. 15 seconds across all clips."
                                />
                                <button
                                  className="btn btn-secondary"
                                  style={{ padding: '2px 8px', fontSize: '0.68rem' }}
                                  onClick={() => handleAddAudioRef(shot.id)}
                                >
                                  <Plus size={10} /> Add
                                </button>
                                <input
                                  type="file"
                                  accept="audio/*"
                                  multiple
                                  ref={el => audioRefInputRefs.current[shot.id] = el}
                                  onChange={(e) => handleAudioRefUpload(shot.id, e)}
                                  style={{ display: 'none' }}
                                />
                                <button
                                  className="btn btn-secondary"
                                  style={{ padding: '2px 8px', fontSize: '0.68rem' }}
                                  disabled={loadingStates[`audioref_${shot.id}`]}
                                  onClick={() => audioRefInputRefs.current[shot.id]?.click()}
                                  title="Upload a clip from disk. Works on the Fal Seedance models, which host it for you; the Atlas ones need a URL or an asset:// id."
                                >
                                  {loadingStates[`audioref_${shot.id}`] ? <RefreshCw className="spinner" size={10} /> : <Upload size={10} />} File
                                </button>
                              </>
                            )}
                            {clips.length > 0 && (
                              <span style={{ fontSize: '0.66rem', color: 'var(--text-dim)' }}>
                                Point the prompt at them by name, e.g. "she sings @audio1".
                              </span>
                            )}
                          </div>
                        );
                      })()}

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
                              <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem', textAlign: 'center' }}>
                                Double click an iteration output to set it, or choose from the project below
                              </span>
                            )}
                          </div>
                          {/* Always offered, filled or not — swapping a still that
                              is already set was previously impossible. */}
                          <button
                            className="btn btn-secondary"
                            style={{ width: '100%', fontSize: '0.78rem' }}
                            onClick={() => openMediaPicker(shot.id, 'image')}
                          >
                            <Layers size={13} /> {shot.selectedImage ? 'Replace from project…' : 'Choose from project…'}
                          </button>
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
                              <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem', textAlign: 'center' }}>
                                Select a video iteration to make active, or choose from the project below
                              </span>
                            )}
                          </div>
                          <button
                            className="btn btn-secondary"
                            style={{ width: '100%', fontSize: '0.78rem' }}
                            onClick={() => openMediaPicker(shot.id, 'video')}
                          >
                            <Layers size={13} /> {shot.selectedVideo ? 'Replace from project…' : 'Choose from project…'}
                          </button>
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
                                              className="btn btn-secondary"
                                              style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                                              onClick={() => handleAddPathToBoard(out.path, `${shot.name} ${out.name}`)}
                                              title="Add to ref board"
                                            >
                                              + Board
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
      {generationModal && (() => {
        // Composed once for the whole modal: the prompt field, the image list
        // and the counters all have to describe the same request.
        const preview = buildPrompt(
          generationModal.type,
          genModalPrompt,
          genModalModel,
          genModalInputImages,
          genModalAttachTags,
          genModalExcludedImages,
          {
            usePrePrompt: genModalUsePre, usePostPrompt: genModalUsePost, promptOverride: genModalOverride,
            shot: shots.find(s => s.id === generationModal.shotId) || null
          }
        );
        const modalPre = genModalUsePre
          ? (generationModal.type === 'image' ? prePrompt : videoPrePrompt)
          : '';
        const modalPost = genModalUsePost
          ? (generationModal.type === 'image' ? postPrompt : videoPostPrompt)
          : '';
        // <Tag> highlighting is derived from the text, not stored: a tag typed
        // by hand and one dropped in by a chip are the same thing.
        const tagMarks = scanPromptTags(genModalPrompt, assetLibrary).occurrences.map((occurrence, index) => {
          const slot = occurrence.asset
            ? preview.imageSources.findIndex(source => source.asset && source.asset.id === occurrence.asset.id)
            : -1;
          const pointer = preview.usesRefTags && slot >= 0 ? preview.imageSources[slot].token : '';
          return {
            id: `tag_${index}_${occurrence.start}`,
            kind: occurrence.asset ? 'tag' : 'missing-tag',
            start: occurrence.start,
            end: occurrence.end,
            removable: false,
            label: occurrence.asset
              ? `<${occurrence.asset.tag}> → ${pointer || assetPromptText(occurrence.asset)}`
              : `<${occurrence.raw}> — no such asset`
          };
        });

        return (
        <div className="modal-overlay">
          <div className="modal-window">
            <div className="modal-header">
              <h2 style={{ fontSize: '1.25rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                {generationModal.type === 'image' ? <ImageIcon size={20} /> : <Film size={20} />}
                Generate {generationModal.type === 'image' ? 'Image' : 'Video'} Variation for {shots.find(s => s.id === generationModal.shotId)?.name}
                {(() => {
                  const shot = shots.find(s => s.id === generationModal.shotId);
                  if (!shot) return null;
                  const resolved = resolveShotModelSettings(generationModal.type, shot);
                  // Read-only provenance: the dropdown below is the override.
                  return <ModelPill type={generationModal.type} resolved={resolved} />;
                })()}
              </h2>
              <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setGenerationModal(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div className="auto-prompt-bar">
                <button
                  type="button"
                  className="btn btn-accent"
                  onClick={handleAutoGeneratePromptInModal}
                  disabled={loadingStates.modal_llm}
                >
                  {loadingStates.modal_llm ? <RefreshCw className="spinner" size={14} /> : <Sparkles size={14} />}
                  Auto Prompt
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '6px 10px', fontSize: '0.75rem' }}
                  onClick={() => setGenModalAutoOpen(open => !open)}
                  title="Steer what Auto Prompt is told"
                >
                  {genModalAutoOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  Auto Prompt options
                  {(genModalAutoInstructions.trim() || genModalAutoContext || genModalAutoBare) && (
                    <span className="auto-prompt-dot" title="Options are set" />
                  )}
                </button>
              </div>

              {genModalAutoOpen && (
                <div className="auto-prompt-panel">
                  <label className="form-label" style={{ fontSize: '0.75rem' }}>Extra instructions for the prompt writer</label>
                  <textarea
                    className="input-field"
                    style={{ minHeight: '64px', fontSize: '0.82rem' }}
                    value={genModalAutoInstructions}
                    onChange={(e) => setGenModalAutoInstructions(e.target.value)}
                    placeholder="e.g. keep it under 40 words, shoot it from below, no dialogue, lean harder on <Rex>"
                  />

                  <label className="auto-prompt-check">
                    <input
                      type="checkbox"
                      checked={genModalAutoContext}
                      onChange={(e) => setGenModalAutoContext(e.target.checked)}
                    />
                    <span>
                      <strong>Include all context</strong>
                      <em>
                        Sends every asset tag and its description, plus the shots either side of this one,
                        so the writer can stay continuous and use tags instead of inventing descriptions.
                      </em>
                    </span>
                  </label>

                  <label className="auto-prompt-check">
                    <input
                      type="checkbox"
                      checked={genModalAutoBare}
                      onChange={(e) => setGenModalAutoBare(e.target.checked)}
                    />
                    <span>
                      <strong>Instructions only</strong>
                      <em>
                        Drops the system prompt and the shot template — the model gets your instructions
                        {genModalAutoContext ? ' and the context above' : ''}, nothing else.
                      </em>
                    </span>
                  </label>
                </div>
              )}

              <div className="form-group">
                <label className="form-label">
                  Prompt Sent to Model
                  <span style={{ marginLeft: '8px', fontWeight: 'normal', color: 'var(--text-dim)', fontSize: '0.75rem' }}>
                    everything below goes to the model, colour-coded by where it came from
                  </span>
                </label>
                <PromptEditor
                  value={genModalPrompt}
                  onChange={(next) => updateModalPrompt(next)}
                  decorations={genModalDecorations}
                  marks={tagMarks}
                  prePrompt={modalPre}
                  postPrompt={modalPost}
                  usePre={genModalUsePre && Boolean(modalPre)}
                  usePost={genModalUsePost && Boolean(modalPost)}
                  onTogglePre={() => setGenModalUsePre(false)}
                  onTogglePost={() => setGenModalUsePost(false)}
                  onInlinePre={() => inlineAffix('pre')}
                  onInlinePost={() => inlineAffix('post')}
                  inputRef={genModalInputRef}
                  caretRequest={genModalCaret}
                  onSelectionChange={(selection) => { genModalSelection.current = selection; }}
                  onUndecorate={(id) => setGenModalDecorations(prev => undecorate(prev, id))}
                  onRemoveDecoration={(id) => {
                    const result = removeDecoration(genModalPrompt, genModalDecorations, id);
                    updateModalPrompt(result.text, result.decorations);
                  }}
                  placeholder="Cinematic visual setup description..."
                  footer={(
                    <div className="prompt-editor-footer">
                      <span>{preview.prompt.length} chars</span>
                      {preview.promptOverflow && (
                        <span style={{ color: 'var(--warning, #f59e0b)', fontWeight: 600 }}
                          title={`This model documents a ${preview.promptOverflow.limit}-character prompt limit; the composed prompt is ${preview.promptOverflow.length}. It will be sent as-is — expect the provider to reject or truncate it.`}>
                          ⚠ over the {preview.promptOverflow.limit}-char limit
                        </span>
                      )}
                      <span>
                        {preview.inputImagePaths.length}/{preview.capacity} reference image{preview.capacity === 1 ? '' : 's'}
                      </span>
                      {genModalDecorations.some(d => d.kind === 'snippet') && (
                        <span className="prompt-legend">
                          <span className="prompt-legend-swatch" style={{ background: 'var(--mark-snippet)' }} /> snippet
                        </span>
                      )}
                      {tagMarks.length > 0 && (
                        <span className="prompt-legend">
                          <span className="prompt-legend-swatch" style={{ background: 'var(--mark-tag)' }} />
                          {preview.usesRefTags ? `tag → ${preview.refTagSample}` : 'tag → description'}
                        </span>
                      )}
                      {/* Turned off pre/post is offered back rather than lost. */}
                      {!genModalUsePre && (generationModal.type === 'image' ? prePrompt : videoPrePrompt) && (
                        <button type="button" className="prompt-affix-restore" onClick={() => setGenModalUsePre(true)}>
                          + pre-prompt
                        </button>
                      )}
                      {!genModalUsePost && (generationModal.type === 'image' ? postPrompt : videoPostPrompt) && (
                        <button type="button" className="prompt-affix-restore" onClick={() => setGenModalUsePost(true)}>
                          + post-prompt
                        </button>
                      )}
                    </div>
                  )}
                />

                {/* The result of all of the above, always on screen. The field
                    higher up holds <Sara>; this is the "@image2" the model
                    actually receives, and the two cannot be the same box. */}
                <EffectivePrompt
                  text={preview.prompt}
                  overridden={preview.overridden}
                  expanded={genModalEffectiveOpen}
                  onToggleExpanded={() => setGenModalEffectiveOpen(open => !open)}
                  onEdit={(current) => setGenModalOverride(current)}
                  onChange={(next) => setGenModalOverride(next)}
                  onRevert={() => setGenModalOverride(null)}
                  capacity={preview.capacity}
                  imageCount={preview.inputImagePaths.length}
                />
              </div>

              {/* Asset tags — click to insert <Tag> into the prompt */}
              {assetLibrary.length > 0 && (
                <div className="form-group">
                  <label className="form-label">Insert Asset Tag at the cursor (adds &lt;Tag&gt; + its reference image)</label>
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
                <label className="form-label">Insert Prompt Snippet at the cursor</label>
                <div className="snippet-chips-container">
                  {promptSnippets.map(snip => (
                    <button
                      key={snip.id}
                      type="button"
                      className="snippet-chip"
                      title={snip.text}
                      onClick={() => appendSnippetToModalPrompt(snip.text, snip.name)}
                    >
                      + {snip.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Which images go with the request. The prompt itself is no
                  longer previewed here — it is the field above, in place. */}
              {(
                  <div className="form-group">
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
                          {preview.imageSources.map((entry, index) => {
                            const modalShot = shots.find(s => s.id === generationModal.shotId);
                            const originColor = {
                              primary: 'var(--success)',
                              pinned: 'var(--primary)',
                              inherited: '#38bdf8',
                              'auto-tag': 'var(--warning, #f59e0b)',
                              tag: 'var(--warning, #f59e0b)'
                            }[entry.origin] || 'var(--primary)';
                            const boardEntry = Boolean(entry.refId);
                            return (
                            <div key={entry.path} style={{ width: '86px', textAlign: 'center', position: 'relative' }}>
                              <div style={{ position: 'relative', height: '58px', borderRadius: '4px', overflow: 'hidden', border: `2px solid ${originColor}`, background: '#000' }}>
                                <AssetImage path={entry.path} alt={entry.label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                {/* On a pointer model this badge is not
                                    decoration — it is the name the prompt
                                    calls this image by. */}
                                <span style={{ position: 'absolute', top: '2px', left: '2px', fontSize: '0.6rem', fontWeight: 'bold', background: entry.token ? 'var(--primary)' : 'rgba(0,0,0,0.75)', color: '#fff', borderRadius: '3px', padding: '0 4px' }}>
                                  {entry.token || index + 1}
                                </span>
                                {/* Pin: turn an automatic or inherited pick into
                                    a shot-scope edge that survives everything. */}
                                {boardEntry && modalShot && (entry.origin === 'auto-tag' || entry.origin === 'inherited') && (
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    style={{ position: 'absolute', bottom: '2px', left: '2px', padding: '1px 4px', fontSize: '0.6rem', zIndex: 3, cursor: 'pointer' }}
                                    onClick={(e) => { e.stopPropagation(); handlePinReferenceToShot(modalShot.id, entry.refId); }}
                                    title="Pin to this shot"
                                  >
                                    📌
                                  </button>
                                )}
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
                                    // Board-contributed entries opt out per shot
                                    // (persists); recipe-only ones just leave
                                    // this generation.
                                    if (boardEntry && modalShot && entry.origin !== 'primary') {
                                      handleExcludeReferenceFromShot(modalShot, entry.refId);
                                    } else {
                                      handleDeselectSentImage(entry.path, entry.origin);
                                    }
                                  }}
                                  title={`Deselect ${entry.label}`}
                                >
                                  <X size={10} />
                                </button>
                              </div>
                              <span
                                title={`${entry.label} — ${entry.origin}`}
                                style={{ fontSize: '0.62rem', color: originColor, display: 'block', marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              >
                                {entry.origin === 'primary' ? '' : `${entry.origin} · `}{entry.label}
                              </span>
                            </div>
                          ); })}
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

                    {/* Audio goes with a video request too, and unlike the
                        images it leaves no trace in the prompt preview — so
                        without this panel the only way to know it was sent was
                        to watch the result. Capacity is read off the model
                        chosen *here*, not the shot's, because this dropdown is
                        what the request will actually use. */}
                    {generationModal.type === 'video' && (() => {
                      const modalShot = shots.find(s => s.id === generationModal.shotId);
                      const clips = modalShot?.audioRefs || [];
                      const capacity = refAudioCapacity('video', genModalModel);
                      if (clips.length === 0 && capacity === 0) return null;
                      const overCapacity = clips.length > capacity;
                      return (
                        <div style={{ marginTop: '10px', border: `1px solid ${overCapacity ? 'var(--accent)' : 'var(--border-light)'}`, borderRadius: '6px', padding: '10px', background: 'rgba(0,0,0,0.18)' }}>
                          <div style={{ fontSize: '0.78rem', fontWeight: 'bold', marginBottom: clips.length ? '8px' : 0 }}>
                            Audio sent with this request
                            <span style={{ marginLeft: '6px', fontWeight: 'normal', color: 'var(--text-dim)' }}>
                              {clips.length} of {capacity} slot{capacity === 1 ? '' : 's'}
                            </span>
                          </div>

                          {clips.length === 0 ? (
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                              None — this model takes reference audio. Add clips on the shot to sing, speak or cut to them.
                            </span>
                          ) : (
                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                              {clips.map((path, audioIndex) => (
                                <span
                                  key={path}
                                  title={path}
                                  style={{
                                    display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.72rem',
                                    padding: '4px 7px', borderRadius: '4px', background: 'var(--bg-card)',
                                    border: `2px solid ${audioIndex < capacity ? 'var(--primary)' : 'var(--accent)'}`
                                  }}
                                >
                                  <Music size={11} style={{ color: 'var(--accent)' }} />
                                  <code style={{ color: 'var(--accent)' }}>@audio{audioIndex + 1}</code>
                                  <span style={{ maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                                    {audioRefLabel(path)}
                                  </span>
                                </span>
                              ))}
                            </div>
                          )}

                          {overCapacity && (
                            <div style={{ fontSize: '0.72rem', color: 'var(--accent)', marginTop: '8px', display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
                              <AlertTriangle size={11} style={{ marginTop: '2px', flexShrink: 0 }} />
                              <span>
                                {capacity === 0
                                  ? `${modelCapabilities('video', genModalModel).label} takes no reference audio — Atlas will not combine a first frame with reference media, so only the ref2v models can carry it. This will be refused before it is billed: pick a Seedance 2.0 ref2v model above, or remove the clips.`
                                  : `Only ${capacity} fit. This will be refused before it is billed — remove the extras on the shot.`}
                              </span>
                            </div>
                          )}

                          {clips.length > 0 && !overCapacity && (
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '8px' }}>
                              Name them in the prompt to say what each is for — the model indexes them by position, so
                              "@audio1" is the only thing that ties a clip to the action.
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
              )}

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
                    {sizeOptions(generationModal.type, genModalModel, genModalRes).map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {!(generationModal.type === 'image' ? isKnownImageModel(genModalModel) : isKnownVideoModel(genModalModel)) && (
                <div style={{ marginTop: '10px' }}>
                  <CustomModelPath
                    label="Custom Model Path"
                    value={genModalModel}
                    onChange={(next) => {
                      setGenModalModel(next);
                      if (generationModal.type === 'image') setImageModel(next);
                      else setVideoModel(next);
                    }}
                    placeholder={generationModal.type === 'image' ? 'e.g. fal-ai/flux-lora' : 'e.g. bytedance/seedance-2.0/image-to-video'}
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
                      {durationOptions(genModalModel, genModalDuration).map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label className="form-label">
                      Input Context ({genModalInputImages.length}/{refImageCapacity('video', genModalModel)})
                    </label>
                    <span className="input-help" style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '8px' }}>
                      {refImageCapacity('video', genModalModel) > 1
                        ? 'Pick as many references as this model takes — order matters, slot 1 is the strongest. Leave empty for text-to-video.'
                        : 'Choose an image to guide video generation, or click Add Reference to select a project asset. Leave unselected for Text-to-Video.'}
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
                              const isSelected = genModalInputImages.includes(img.path)
                                && !genModalExcludedImages.includes(img.path);
                              return (
                                <button
                                  key={img.id}
                                  type="button"
                                  className={`generation-reference-card ${isSelected ? 'selected' : ''}`}
                                  onClick={() => {
                                    setGenModalExcludedImages(prev => prev.filter(p => p !== img.path));
                                    setGenModalInputImages(prev => {
                                      if (prev.includes(img.path)) return prev.filter(p => p !== img.path);
                                      const capacity = refImageCapacity('video', genModalModel);
                                      // One slot means picking a second one is a
                                      // swap, not an error — that is what the
                                      // single-select control always did.
                                      if (capacity <= 1) return [img.path];
                                      if (prev.length >= capacity) {
                                        showToast(`This model accepts up to ${capacity} input image${capacity === 1 ? '' : 's'}.`, 'warning');
                                        return prev;
                                      }
                                      return [...prev, img.path];
                                    });
                                  }}
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
        );
      })()}

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

              {/* Clean Files — the media tree, put back in order */}
              <div className="glass-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Clean Files</span>
                  <p style={{ margin: '4px 0 0', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    Files every generation into <code>assets/library/</code>, <code>assets/shots/</code> and{' '}
                    <code>assets/reference/</code>, named after the character, scene and shot they belong to.
                    Anything the project no longer points at goes to <code>assets/bin/</code>.
                    New generations are filed as they arrive, so this is here for imports, older
                    projects, and shots you have since renamed.
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button
                    className="btn btn-secondary"
                    onClick={handlePlanCleanFiles}
                    disabled={Boolean(cleanFiles) || project.needsFolder}
                    title={project.needsFolder ? 'Choose a project folder first' : 'Look at the project folder and report what would move'}
                  >
                    {cleanFiles?.status === 'planning' ? <RefreshCw className="spinner" size={14} /> : <FolderOpen size={14} />} Clean Files…
                  </button>
                  <span style={{ fontSize: '0.74rem', color: 'var(--text-dim)' }}>
                    Shows you what will move before anything does.
                  </span>
                </div>
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
                <label className="form-label">Full description (for generating this asset's own art)</label>
                <textarea
                  className="input-field"
                  style={{ minHeight: '80px' }}
                  value={assetEditor.description}
                  onChange={(e) => setAssetEditor({ ...assetEditor, description: e.target.value })}
                  placeholder="grizzled mechanic in his 60s, oil-stained canvas overalls, close-cropped grey beard, deep crow's feet, a wedding ring worn thin"
                />
                <span className="input-help" style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                  Every detail worth having. This builds the reference art below and is not
                  sent to shots unless the short one is empty.
                </span>
              </div>

              <div className="form-group">
                <label className="form-label">In-shot description (substituted for the tag)</label>
                <textarea
                  className="input-field"
                  style={{ minHeight: '56px' }}
                  value={assetEditor.shotDescription || ''}
                  onChange={(e) => setAssetEditor({ ...assetEditor, shotDescription: e.target.value })}
                  placeholder="grizzled mechanic, grey beard, oil-stained overalls"
                />
                <span className="input-help" style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                  {(() => {
                    const short = (assetEditor.shotDescription || '').trim();
                    const used = short || (assetEditor.description || '').trim();
                    const rendered = [assetEditor.name || assetEditor.tag, used].filter(Boolean).length
                      ? `${assetEditor.name || assetEditor.tag}${used ? ` (${used})` : ''}`
                      : '…';
                    return (
                      <>
                        &lt;{assetEditor.tag || 'Tag'}&gt; becomes: "{rendered}"
                        {!short && ' — falling back to the full description.'}
                      </>
                    );
                  })()}
                </span>
              </div>

              {/* Generate reference art — same iterate-and-pick loop as a shot */}
              {(() => {
                const modelId = assetEditorModel(assetEditor);
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
                          {sizeOptions('image', modelId, assetEditor.imageResolution).map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                        </select>
                      </div>
                    </div>

                    {!isKnownImageModel(modelId) && (
                      <CustomModelPath
                        label="Custom Model Path"
                        value={assetEditor.imageModel || ''}
                        onChange={(next) => setAssetEditor({ ...assetEditor, imageModel: next })}
                        placeholder="e.g. higgsfield-ai/soul/standard"
                      />
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
                      Tick the ones that represent this asset. They are what gets sent — both <em>into</em> this
                      asset's own generation and along with &lt;{assetEditor.tag || 'Tag'}&gt; wherever it is tagged,
                      up to what each model takes. Tick nothing and only the primary travels.
                      Click an image to make it the primary; it leads the order. Double-click to view large.
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
        const candidates = batchCandidates(batchDialog.type, batchDialog.scope, batchOnlyMissing, batchOnlyDirty);
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
                    <input type="checkbox" checked={batchOnlyMissing} disabled={batchOnlyDirty} onChange={(e) => setBatchOnlyMissing(e.target.checked)} />
                    Skip shots that already have output
                  </label>
                  <span className="input-help" style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                    Leave this on for the first sweep, turn it off to re-roll everything.
                  </span>
                </div>

                <div className="form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.9rem' }}>
                    <input type="checkbox" checked={batchOnlyDirty} onChange={(e) => setBatchOnlyDirty(e.target.checked)} />
                    Only stale shots
                  </label>
                  <span className="input-help" style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                    Shots whose tagged assets changed since their selected {batchDialog.type} was made.
                    Regenerates from the original recipe with the fresh asset material.
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

      {/* --- A4a. SHOT MEDIA PICKER --- */}
      {mediaPicker && (() => {
        const shot = shots.find(s => s.id === mediaPicker.shotId);
        return (
          <MediaPickerDialog
            kind={mediaPicker.kind}
            shotName={shot?.name || ''}
            currentPath={mediaPicker.kind === 'video' ? shot?.selectedVideo : shot?.selectedImage}
            groups={collectShotMedia({
              kind: mediaPicker.kind,
              shot,
              imageGallery,
              videoGallery,
              referenceImages,
              assetLibrary,
              projectFiles: projectImagesList
            })}
            onPick={handlePickShotMedia}
            onClear={() => handlePickShotMedia(null)}
            onClose={() => setMediaPicker(null)}
          />
        );
      })()}

      {/* --- A4b. DREAM --- */}
      {dreamOpen && (
        <DreamDialog
          settings={dreamSettings}
          onChange={setDreamSettings}
          scenes={scenes}
          assetLibrary={assetLibrary}
          defaults={{ imageModel, imageResolution, videoModel, videoResolution, videoDuration }}
          run={dreamRun}
          onRun={handleRunDream}
          onStop={handleStopDream}
          onClose={() => setDreamOpen(false)}
        />
      )}

      {/* --- A4b1. PIPELINE --- */}
      {pipelineOpen && (
        <PipelinePanel
          stages={buildPipelineStages().map(stage => ({ id: stage.id, label: stage.label }))}
          estimate={pipelineEstimate}
          skip={pipelineSkip}
          onToggleSkip={(stageId) => setPipelineSkip(prev => {
            const next = new Set(prev);
            if (next.has(stageId)) next.delete(stageId); else next.add(stageId);
            return next;
          })}
          runState={pipelineRunState}
          running={Boolean(pipelineRunRef.current)}
          idea={pipelineIdea}
          onIdeaChange={setPipelineIdea}
          showIdeaBox={shots.length === 0}
          llmControls={(
            <div style={{ display: 'flex', gap: '10px', marginTop: '6px' }}>
              <select className="select-field" value={activeLlm} onChange={(e) => setActiveLlm(e.target.value)}>
                {LLM_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <select className="select-field" value={llmModel} onChange={(e) => setLlmModel(e.target.value)}>
                {llmModelsList.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
          )}
          onRun={handleRunPipeline}
          onPause={() => pipelineRunRef.current?.pause()}
          onResume={() => pipelineRunRef.current?.resume()}
          onCancel={() => pipelineRunRef.current?.cancel()}
          onClose={() => setPipelineOpen(false)}
        />
      )}

      {/* --- A4b2. IDEA → SCRIPT --- */}
      {scriptGenOpen && (() => {
        const previewCounts = scriptGenPreview && {
          scenes: scriptGenPreview.scenes.length,
          shots: scriptGenPreview.scenes.reduce((sum, s) => sum + s.shots.length, 0),
          assets: scriptGenPreview.assets.length
        };
        const existingTagSet = new Set(assetLibrary.map(a => normalizeTag(a.tag)));
        const newTags = scriptGenPreview
          ? scriptGenPreview.assets.filter(a => !existingTagSet.has(normalizeTag(a.tag))).map(a => a.tag)
          : [];
        return (
          <div className="modal-overlay" onClick={() => setScriptGenOpen(false)}>
            <div className="modal-window" style={{ maxWidth: '720px' }} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <FileText size={20} /> Idea → Script
                </h2>
                <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setScriptGenOpen(false)}>
                  <X size={16} />
                </button>
              </div>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div className="form-group">
                  <label className="form-label">
                    Idea, logline, treatment or full script
                    <span style={{ marginLeft: '8px', fontWeight: 'normal', color: 'var(--text-dim)', fontSize: '0.75rem' }}>
                      the LLM writes the scenes, shots and assets; nothing is applied until you review it
                    </span>
                  </label>
                  <textarea
                    className="input-field"
                    style={{ minHeight: '140px' }}
                    value={scriptGenIdea}
                    onChange={(e) => setScriptGenIdea(e.target.value)}
                    placeholder="Two paragraphs are plenty. e.g. A retired mechanic discovers his junkyard robot has been rebuilding itself at night…"
                  />
                </div>

                <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">LLM</label>
                    <select className="select-field" value={activeLlm} onChange={(e) => setActiveLlm(e.target.value)}>
                      {LLM_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Model</label>
                    <select className="select-field" value={llmModel} onChange={(e) => setLlmModel(e.target.value)}>
                      {llmModelsList.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </div>
                  <button
                    className="btn btn-primary"
                    disabled={scriptGenBusy || !scriptGenIdea.trim()}
                    onClick={handleGenerateScript}
                  >
                    {scriptGenBusy ? <><RefreshCw className="spinner" size={14} /> Writing…</> : <><Sparkles size={14} /> Generate script</>}
                  </button>
                  <button
                    className="btn btn-secondary"
                    title="Fallback: copy the full import prompt to use in any chat model, then paste the reply via Import > Paste"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(buildLlmImportPrompt({
                          assetLibrary, sourceMaterial: scriptGenIdea, intro: promptText(promptSettings, 'importIntro')
                        }));
                        showToast('Import prompt copied — paste it into any chat model.', 'success');
                      } catch { showToast('Clipboard blocked by the browser.', 'error'); }
                    }}
                  >
                    <Copy size={14} /> Copy prompt instead
                  </button>
                </div>

                {scriptGenPreview && (
                  <div className="glass-panel" style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <strong style={{ fontSize: '0.9rem' }}>
                      Parsed: {previewCounts.scenes} scene{previewCounts.scenes === 1 ? '' : 's'} · {previewCounts.shots} shot{previewCounts.shots === 1 ? '' : 's'} · {previewCounts.assets} asset{previewCounts.assets === 1 ? '' : 's'}
                    </strong>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                      {newTags.length > 0
                        ? <>New tags: &lt;{newTags.join('>, <')}&gt;{scriptGenPreview.assets.length > newTags.length ? ` — ${scriptGenPreview.assets.length - newTags.length} reuse existing assets` : ''}</>
                        : 'All tags reuse existing assets.'}
                    </span>
                    {scriptGenPreview.warnings.length > 0 && (
                      <span style={{ fontSize: '0.78rem', color: 'var(--warning, #f59e0b)' }}>
                        ⚠ {scriptGenPreview.warnings.join(' · ')}
                      </span>
                    )}
                    <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                      <button className="btn btn-primary" onClick={() => handleApplyGeneratedScript('replace')}>
                        Replace project with this script
                      </button>
                      <button className="btn btn-secondary" onClick={() => handleApplyGeneratedScript('append')}>
                        Append to project
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* --- A4c. PASTE SHOT LIST --- */}
      {pasteImport && (() => {
        // Validate as you paste rather than on submit: the whole point of the
        // box is that you can see the document was understood before it
        // replaces the project.
        let preview = null;
        let problem = null;
        if (pasteImport.text.trim()) {
          try {
            const normalized = normalizeImportedShotList(extractJsonDocument(pasteImport.text));
            preview = {
              scenes: normalized.scenes.length,
              shots: normalized.scenes.reduce((sum, s) => sum + s.shots.length, 0),
              assets: normalized.assets.length,
              snippets: normalized.promptSnippets.length,
              warnings: normalized.warnings
            };
          } catch (err) {
            problem = err.message;
          }
        }

        return (
          <div className="modal-overlay" onClick={() => setPasteImport(null)}>
            <div className="modal-window" style={{ maxWidth: '720px' }} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <ClipboardPaste size={20} /> Paste Shot List
                </h2>
                <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={() => setPasteImport(null)}>
                  <X size={16} />
                </button>
              </div>

              <div className="modal-body">
                <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: 0, lineHeight: 1.6 }}>
                  Paste the JSON an LLM gave you. A <code>```json</code> fence or a sentence either side of it is
                  fine — the document is found and read out of whatever you paste.
                </p>

                <div className="form-group">
                  <textarea
                    autoFocus
                    className="input-field"
                    style={{ fontFamily: 'monospace', fontSize: '0.72rem', minHeight: '280px', width: '100%' }}
                    placeholder={'{\n  "schemaVersion": 1,\n  "project": { … },\n  "assets": [ … ],\n  "scenes": [ … ]\n}'}
                    value={pasteImport.text}
                    onChange={(e) => setPasteImport({ ...pasteImport, text: e.target.value })}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">On import</label>
                  <select
                    className="select-field"
                    value={pasteImport.mode}
                    onChange={(e) => setPasteImport({ ...pasteImport, mode: e.target.value })}
                  >
                    <option value="replace">Replace every scene in the project</option>
                    <option value="append">Add after the existing scenes</option>
                  </select>
                </div>

                {problem && (
                  <div className="glass-panel" style={{ padding: '12px', background: 'rgba(244,63,94,0.07)', display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                    <AlertTriangle size={14} style={{ marginTop: '2px', flexShrink: 0, color: 'var(--accent)' }} />
                    <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{problem}</span>
                  </div>
                )}

                {preview && (
                  <div className="glass-panel" style={{ padding: '14px', background: 'rgba(139,92,246,0.06)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ fontSize: '0.9rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Check size={14} color="var(--success)" />
                      {preview.scenes} scene{preview.scenes === 1 ? '' : 's'}, {preview.shots} shot{preview.shots === 1 ? '' : 's'},
                      {' '}{preview.assets} asset{preview.assets === 1 ? '' : 's'}
                      {preview.snippets > 0 ? `, ${preview.snippets} snippet${preview.snippets === 1 ? '' : 's'}` : ''}
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                      {pasteImport.mode === 'replace'
                        ? `Replaces the ${scenes.length} scene${scenes.length === 1 ? '' : 's'} currently in this project.`
                        : `Added after the ${scenes.length} scene${scenes.length === 1 ? '' : 's'} already here.`}
                    </div>
                    {preview.warnings.map((warning, i) => (
                      <div key={i} style={{ fontSize: '0.78rem', color: 'var(--accent)' }}>• {warning}</div>
                    ))}
                  </div>
                )}
              </div>

              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setPasteImport(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={handleImportPastedShotList} disabled={!preview}>
                  <ClipboardPaste size={14} /> Import
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
                            className="btn btn-secondary"
                            style={{ padding: '4px', width: '100%', fontSize: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
                            onClick={() => handleAddPathToBoard(img.path, img.name)}
                          >
                            + Add to ref board
                          </button>
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
          onAutoAssign={handleAutoAssignReferences}
          onApplyAutoAssign={handleApplyRefProposals}
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
          customModelCaps={customModelCaps}
          setCustomModelCap={(id, refImages) => setCustomModelCaps(prev => {
            if (!id) return prev;
            if (refImages === null || refImages === undefined) {
              const { [id]: _, ...rest } = prev;
              return rest;
            }
            return { ...prev, [id]: { ...prev[id], refImages } };
          })}
          assetTypeModels={assetTypeModels}
          setAssetTypeModel={(typeId, model) => setAssetTypeModels(prev => {
            if (!model) {
              const { [typeId]: _, ...rest } = prev;
              return rest;
            }
            return { ...prev, [typeId]: model };
          })}
          attachTagsForImages={attachTagsForImages} setAttachTagsForImages={setAttachTagsForImages}
          attachTagsForVideos={attachTagsForVideos} setAttachTagsForVideos={setAttachTagsForVideos}
          autoAttachRefs={autoAttachRefs} setAutoAttachRefs={setAutoAttachRefs}
          atlasSafetyChecker={atlasSafetyChecker} setAtlasSafetyChecker={setAtlasSafetyChecker}
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
                  pre/post prompts, system prompts and model choices — bring it back with <strong>Paste Shot
                  List</strong> (straight from the chat window, fence and all) or save it and use <strong>Import
                  from File</strong>. The prompt is generated from this project's live model catalog and existing
                  asset tags.
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
                  value={buildLlmImportPrompt({ assetLibrary, sourceMaterial: llmPromptSource, intro: promptText(promptSettings, 'importIntro') })}
                />

                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '10px' }}>
                  <button className="btn btn-primary" onClick={handleCopyLlmPrompt}>
                    <Copy size={14} /> Copy LLM Prompt
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => { setActiveOverlay(null); setPasteImport({ text: '', mode: 'replace' }); }}
                  >
                    <ClipboardPaste size={14} /> Paste Shot List
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => { shotListInputRef.current.dataset.mode = 'replace'; shotListInputRef.current.click(); }}
                  >
                    <Upload size={14} /> Import from File
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
                          {JOB_TYPE_LABELS[job.type] || 'Video Prompt'}
                        </span>
                        {typeof job.progress === 'number' && job.status === 'running' && (
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                            {Math.round(job.progress * 100)}%
                          </span>
                        )}
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

      {renderCleanFilesDialog()}
    </div>
  );
}
