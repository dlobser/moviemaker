// One resolver for "which model/resolution/duration does this generation use?"
//
// The studio used to answer that with inline `shot.imageModel || imageModel`
// chains at five call sites — which meant an empty string silently fell
// through (correct by accident), scenes could not carry defaults at all, and
// nothing could say *where* a value came from. Here the precedence is
// explicit, each field resolves independently, and every resolved value names
// its source so the UI can show provenance and a cost estimate can group by
// origin.
//
// Precedence (most specific wins):
//   shot/asset explicit override > scene default > asset-type default > project default
//
// Empty string, null and undefined all mean "inherit" on every level — the
// fix for the `||` idiom where '' fell through only by luck of JS truthiness.

const FIELD_KEYS = {
  image: { model: 'imageModel', resolution: 'imageResolution', duration: null },
  video: { model: 'videoModel', resolution: 'videoResolution', duration: 'videoDuration' }
};

const isSet = (value) => value !== undefined && value !== null && value !== '';

/**
 * Resolve the generation settings for one target.
 *
 * `project` is the flat project-level defaults bag:
 *   { imageModel, imageResolution, videoModel, videoResolution, videoDuration,
 *     assetTypeModels: { character: 'higgsfield-ai/soul-id', ... } }
 * `scene`/`shot` carry the same optional field names; `asset` is an asset
 * record (its `type` keys into assetTypeModels).
 *
 * Returns { model, resolution, duration, source, sources } where `source` is
 * where the *model* came from ('shot' | 'asset' | 'scene' | 'assetType' |
 * 'project') and `sources` reports it per field.
 */
export function resolveModelSettings({ type = 'image', project = {}, scene = null, shot = null, asset = null }) {
  const keys = FIELD_KEYS[type] || FIELD_KEYS.image;

  // Ordered most-specific-first; each entry offers whichever fields it holds.
  const levels = [];
  if (shot) {
    levels.push({
      source: 'shot',
      model: shot[keys.model],
      resolution: shot[keys.resolution],
      duration: keys.duration ? shot[keys.duration] : undefined
    });
  }
  if (asset) {
    levels.push({
      source: 'asset',
      model: asset[keys.model],
      resolution: asset[keys.resolution],
      duration: undefined
    });
  }
  if (scene) {
    levels.push({
      source: 'scene',
      model: scene[keys.model],
      resolution: scene[keys.resolution],
      duration: keys.duration ? scene[keys.duration] : undefined
    });
  }
  if (asset && type === 'image' && project.assetTypeModels) {
    levels.push({
      source: 'assetType',
      model: project.assetTypeModels[asset.type || 'character'],
      resolution: undefined,
      duration: undefined
    });
  }
  levels.push({
    source: 'project',
    model: project[keys.model],
    resolution: project[keys.resolution],
    duration: keys.duration ? project[keys.duration] : undefined
  });

  const resolveField = (field) => {
    for (const level of levels) {
      if (isSet(level[field])) return { value: level[field], source: level.source };
    }
    return { value: null, source: 'project' };
  };

  const model = resolveField('model');
  const resolution = resolveField('resolution');
  const duration = keys.duration ? resolveField('duration') : { value: null, source: null };

  return {
    model: model.value,
    resolution: resolution.value,
    duration: duration.value,
    source: model.source,
    sources: { model: model.source, resolution: resolution.source, duration: duration.source }
  };
}

/** The scene-level default fields the importer and UI understand. */
export const SCENE_DEFAULT_FIELDS = [
  'imageModel', 'imageResolution', 'videoModel', 'videoResolution', 'videoDuration'
];
