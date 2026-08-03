import React, { useState } from 'react';
import {
  AlertTriangle,
  Download,
  FileJson,
  KeyRound,
  Layers,
  MessageSquare,
  RotateCcw,
  Save,
  Settings,
  Sliders,
  X
} from 'lucide-react';

import {
  IMAGE_MODELS,
  LLM_PROVIDERS,
  VIDEO_MODELS,
  durationOptions,
  isKnownImageModel,
  isKnownVideoModel,
  sizeOptions
} from './catalog.js';
import { PROMPT_GROUPS, PROMPT_SLOTS, isPromptOverridden, promptDefault, promptText } from './prompts.js';
import { ASSET_TYPES } from './promptTags.js';
import CustomModelPath from './CustomModelPath.jsx';

const TABS = [
  { id: 'providers', label: 'Providers & keys', icon: KeyRound },
  { id: 'models', label: 'Models', icon: Sliders },
  { id: 'prompts', label: 'Prompts', icon: MessageSquare },
  { id: 'behaviour', label: 'Behaviour', icon: Settings },
  { id: 'project', label: 'Project files', icon: FileJson }
];

const KEY_FIELDS = [
  { id: 'geminiKey', label: 'Google AI Studio (Gemini)', placeholder: 'AIzaSy…' },
  { id: 'openaiKey', label: 'OpenAI (ChatGPT / DALL·E)', placeholder: 'sk-proj-…' },
  { id: 'claudeKey', label: 'Anthropic (Claude)', placeholder: 'sk-ant-…' },
  { id: 'falKey', label: 'Fal.ai (Flux / Nano Banana / Wav2Lip)', placeholder: 'fal-key-…' },
  { id: 'runwayKey', label: 'Runway (Gen-3)', placeholder: 'rwy-…' },
  { id: 'klingKey', label: 'Kling AI', placeholder: 'Kling dev key…' },
  { id: 'higgsfieldKey', label: 'Higgsfield key', placeholder: 'from cloud.higgsfield.ai' },
  { id: 'higgsfieldSecret', label: 'Higgsfield secret', placeholder: 'paired secret' },
  { id: 'atlasKey', label: 'Atlas Cloud key', placeholder: 'from atlascloud.ai — one key, 400+ models' }
];

/**
 * Settings, in tabs.
 *
 * The old panel was five stacked cards and roughly twenty-five fields in one
 * scroll, with a Save button that in fact saved only the API keys while
 * everything else autosaved silently. Here the tabs carry the grouping and the
 * save model is uniform: keys are pushed explicitly (they leave the browser),
 * everything else autosaves with the rest of the project.
 */
export default function SettingsPanel({
  apiKeys, setApiKeys, onSaveCredentials,
  isStatic,
  activeLlm, setActiveLlm, llmModel, setLlmModel, llmModelsList,
  imageModel, setImageModel, imageResolution, setImageResolution,
  videoModel, setVideoModel, videoResolution, setVideoResolution,
  videoDuration, setVideoDuration,
  batchConcurrency, setBatchConcurrency,
  customModelCaps, setCustomModelCap,
  assetTypeModels, setAssetTypeModel,
  attachTagsForImages, setAttachTagsForImages,
  attachTagsForVideos, setAttachTagsForVideos,
  atlasSafetyChecker, setAtlasSafetyChecker,
  theme, onToggleTheme,
  promptSettings, setPromptSetting, resetPromptSetting,
  onImportState, onExportState,
  ModelOptions,
  onClose
}) {
  const [tab, setTab] = useState('providers');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-window settings-window" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2><Settings size={19} /> Settings</h2>
          <button className="btn btn-secondary icon-btn" onClick={onClose}><X size={15} /></button>
        </div>

        <div className="settings-layout">
          <nav className="settings-tabs">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={`settings-tab ${tab === id ? 'active' : ''}`}
                onClick={() => setTab(id)}
              >
                <Icon size={15} /> {label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {tab === 'providers' && (
              <section className="settings-section">
                <h3>API keys</h3>
                <p className="settings-note">
                  {isStatic
                    ? 'Saved in this browser’s localStorage and sent straight from this page to each provider — this site has no server to receive them. Anything running on this origin can read them, so prefer keys you can rotate.'
                    : 'Stored by the local server in config.json, next to the project.'}
                </p>

                {KEY_FIELDS.map(field => {
                  const value = apiKeys[field.id] || '';
                  return (
                    <div className="form-group" key={field.id}>
                      <label className="form-label">
                        <span className={`key-dot ${value ? 'set' : ''}`} />
                        {field.label}
                      </label>
                      <input
                        type="password"
                        className="input-field"
                        value={value}
                        onChange={(e) => setApiKeys({ ...apiKeys, [field.id]: e.target.value })}
                        placeholder={field.placeholder}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                  );
                })}

                {isStatic ? (
                  <div className="form-group">
                    <label className="form-label">CORS proxy (optional)</label>
                    <input
                      type="text"
                      className="input-field"
                      value={apiKeys.corsProxy || ''}
                      onChange={(e) => setApiKeys({ ...apiKeys, corsProxy: e.target.value })}
                      placeholder="https://my-proxy.example/?url={url}"
                    />
                    <small className="field-hint">
                      Only needed if a provider refuses direct browser calls. Use a proxy you control — it will
                      see your API keys.
                    </small>
                  </div>
                ) : (
                  <div className="form-group">
                    <label className="form-label">Shared working folder (optional)</label>
                    <input
                      type="text"
                      className="input-field"
                      value={apiKeys.workingFolder || ''}
                      onChange={(e) => setApiKeys({ ...apiKeys, workingFolder: e.target.value })}
                      placeholder="e.g. X:\SharedFolder"
                    />
                  </div>
                )}

                <button className="btn btn-primary settings-save" onClick={() => onSaveCredentials(apiKeys)}>
                  <Save size={14} /> Save credentials
                </button>
              </section>
            )}

            {tab === 'models' && (
              <>
                <section className="settings-section">
                  <h3>Prompt writer</h3>
                  <div className="control-grid">
                    <div className="form-group">
                      <label className="form-label">LLM provider</label>
                      <select className="select-field" value={activeLlm} onChange={(e) => setActiveLlm(e.target.value)}>
                        {LLM_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label">Model</label>
                      <select className="select-field" value={llmModel} onChange={(e) => setLlmModel(e.target.value)}>
                        {llmModelsList.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </div>
                  </div>
                </section>

                <section className="settings-section">
                  <h3>Image defaults</h3>
                  <div className="control-grid">
                    <div className="form-group">
                      <label className="form-label">Model</label>
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
                      <label className="form-label">Aspect ratio</label>
                      <select className="select-field" value={imageResolution} onChange={(e) => setImageResolution(e.target.value)}>
                        {sizeOptions('image', imageModel, imageResolution).map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                      </select>
                    </div>
                  </div>
                  {!isKnownImageModel(imageModel) && (
                    <CustomModelPath
                      label="Custom image model id"
                      value={imageModel}
                      onChange={setImageModel}
                      placeholder="e.g. fal-ai/flux-lora"
                      refImagesOverride={customModelCaps?.[imageModel]?.refImages}
                      onRefImagesOverride={setCustomModelCap ? (n) => setCustomModelCap(imageModel, n) : undefined}
                    />
                  )}
                </section>

                <section className="settings-section">
                  <h3>Video defaults</h3>
                  <div className="control-grid">
                    <div className="form-group">
                      <label className="form-label">Model</label>
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
                      <label className="form-label">Resolution</label>
                      <select className="select-field" value={videoResolution} onChange={(e) => setVideoResolution(e.target.value)}>
                        {sizeOptions('video', videoModel, videoResolution).map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                      </select>
                    </div>
                  </div>
                  {!isKnownVideoModel(videoModel) && (
                    <CustomModelPath
                      label="Custom video model id"
                      value={videoModel}
                      onChange={setVideoModel}
                      placeholder="e.g. bytedance/seedance-2.0/image-to-video"
                      refImagesOverride={customModelCaps?.[videoModel]?.refImages}
                      onRefImagesOverride={setCustomModelCap ? (n) => setCustomModelCap(videoModel, n) : undefined}
                    />
                  )}
                  <div className="form-group" style={{ maxWidth: '220px' }}>
                    <label className="form-label">Duration</label>
                    <select className="select-field" value={videoDuration} onChange={(e) => setVideoDuration(e.target.value)}>
                      {durationOptions(videoModel, videoDuration).map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                  </div>
                </section>

                <section className="settings-section">
                  <h3>Asset-type image defaults</h3>
                  <p className="settings-note">
                    Which image model each asset *type* uses when the asset has no override of its
                    own — characters on an identity-preserving model, environments on cheap t2i.
                    Blank inherits the project default above.
                  </p>
                  <div className="control-grid">
                    {ASSET_TYPES.map(assetType => (
                      <div className="form-group" key={assetType.id}>
                        <label className="form-label">{assetType.label}</label>
                        <select
                          className="select-field"
                          value={assetTypeModels?.[assetType.id] || ''}
                          onChange={(e) => setAssetTypeModel(assetType.id, e.target.value || null)}
                        >
                          <option value="">Project default</option>
                          <ModelOptions models={IMAGE_MODELS} unit="img" />
                        </select>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="settings-section">
                  <h3>Batch</h3>
                  <div className="form-group" style={{ maxWidth: '260px' }}>
                    <label className="form-label">Parallel generations</label>
                    <select className="select-field" value={batchConcurrency} onChange={(e) => setBatchConcurrency(Number(e.target.value))}>
                      <option value={1}>1 — slowest, gentlest on rate limits</option>
                      <option value={2}>2</option>
                      <option value={3}>3 — balanced</option>
                      <option value={5}>5</option>
                      <option value={8}>8 — fastest, may hit rate limits</option>
                    </select>
                    <small className="field-hint">Now saved with the project, so a batch behaves the same next session.</small>
                  </div>
                </section>
              </>
            )}

            {tab === 'prompts' && (
              <PromptsTab
                promptSettings={promptSettings}
                setPromptSetting={setPromptSetting}
                resetPromptSetting={resetPromptSetting}
              />
            )}

            {tab === 'behaviour' && (
              <>
                <section className="settings-section">
                  <h3><Layers size={15} /> Tagged asset images</h3>
                  <p className="settings-note">
                    Whether a <code>&lt;Tag&gt;</code>’s reference image is uploaded with the request. Your explicitly
                    chosen images always take the first slots — most image-to-video models accept only one input, so
                    tagged images would otherwise displace the shot frame you meant to animate.
                  </p>
                  <label className="settings-check">
                    <input type="checkbox" checked={attachTagsForImages} onChange={(e) => setAttachTagsForImages(e.target.checked)} />
                    <span>Attach on image generation <em>recommended on — this is how characters stay consistent</em></span>
                  </label>
                  <label className="settings-check">
                    <input type="checkbox" checked={attachTagsForVideos} onChange={(e) => setAttachTagsForVideos(e.target.checked)} />
                    <span>Attach on video generation <em>recommended off — animate the shot’s own image</em></span>
                  </label>
                </section>

                <section className="settings-section">
                  <h3>Atlas Cloud</h3>
                  <p className="settings-note">
                    Atlas’s open-weight image models (FLUX, Qwen-Image, Z-Image) expose their safety checker as a
                    request flag; closed partner models moderate upstream and ignore it. Turning it off only affects
                    Atlas image generation, and Atlas’s own acceptable-use policy still applies to everything you make.
                  </p>
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      checked={atlasSafetyChecker !== false}
                      onChange={(e) => setAtlasSafetyChecker(e.target.checked)}
                    />
                    <span>Safety checker on Atlas image models <em>provider default — on</em></span>
                  </label>
                </section>

                <section className="settings-section">
                  <h3>Appearance</h3>
                  <label className="settings-check">
                    <input type="checkbox" checked={theme === 'light'} onChange={onToggleTheme} />
                    <span>Light theme</span>
                  </label>
                </section>
              </>
            )}

            {tab === 'project' && (
              <section className="settings-section">
                <h3><FileJson size={15} /> Backup and sharing</h3>
                <p className="settings-note">
                  The project autosaves to its own folder as you work. These are for taking a copy elsewhere.
                </p>
                <div style={{ display: 'flex', gap: '12px' }}>
                  <label className="btn btn-secondary" style={{ cursor: 'pointer', flex: 1 }}>
                    <FileJson size={14} /> Import state JSON…
                    <input type="file" accept=".json" onChange={onImportState} style={{ display: 'none' }} />
                  </label>
                  <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onExportState}>
                    <Download size={14} /> Export state JSON
                  </button>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Every prompt the studio can send, in one editable list.
 *
 * Before this, five of them were string literals at their call sites — the
 * shot-to-prompt user message, the asset reference writer's system and user
 * prompts, the per-type asset templates and the import preamble — so tuning any
 * of them meant editing source.
 */
function PromptsTab({ promptSettings, setPromptSetting, resetPromptSetting }) {
  return (
    <>
      {PROMPT_GROUPS.map(group => {
        const slots = PROMPT_SLOTS.filter(slot => slot.group === group.id);
        if (slots.length === 0) return null;

        return (
          <section className="settings-section" key={group.id}>
            <h3>{group.label}</h3>
            <p className="settings-note">{group.hint}</p>
            {slots.map(slot => (
              <PromptSlot
                key={slot.id}
                slot={slot}
                value={promptText(promptSettings, slot.id)}
                overridden={isPromptOverridden(promptSettings, slot.id)}
                onChange={(value) => setPromptSetting(slot.id, value)}
                onReset={() => resetPromptSetting(slot.id)}
              />
            ))}
          </section>
        );
      })}
    </>
  );
}

function PromptSlot({ slot, value, overridden, onChange, onReset }) {
  const [open, setOpen] = useState(false);
  const isLong = (slot.rows || 3) > 3;

  return (
    <div className={`prompt-slot ${overridden ? 'overridden' : ''}`}>
      <div className="prompt-slot-head">
        <button className="prompt-slot-title" onClick={() => setOpen(v => !v)}>
          {slot.label}
          {overridden && <span className="prompt-slot-badge">edited</span>}
        </button>
        {overridden && (
          <button className="prompt-slot-reset" onClick={onReset} title="Restore the shipped default">
            <RotateCcw size={11} /> Reset
          </button>
        )}
      </div>

      {(open || !isLong) && (
        <>
          <p className="prompt-slot-desc">{slot.description}</p>

          {slot.kind === 'number' ? (
            <input
              type="number"
              className="input-field"
              style={{ maxWidth: '140px' }}
              min={slot.min}
              max={slot.max}
              value={value}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <textarea
              className="input-field prompt-slot-body"
              rows={slot.rows || 3}
              value={value}
              placeholder={slot.placeholder || promptDefault(slot.id)}
              onChange={(e) => onChange(e.target.value)}
              spellCheck={false}
            />
          )}

          {slot.placeholders && (
            <div className="prompt-slot-tokens">
              {slot.placeholders.map(token => <code key={token}>{token}</code>)}
              <span>a line whose only placeholder is empty is dropped</span>
            </div>
          )}

          {slot.id === 'assetWriterSystem' && (
            <div className="prompt-slot-warning">
              <AlertTriangle size={12} />
              Keep the JSON reply instruction, or the asset description stops being filled in.
            </div>
          )}
        </>
      )}
    </div>
  );
}
