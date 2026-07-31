// Dream mode: one unbroken shot, generated a clip at a time.
//
// Every other generation path in the studio starts from a shot the user wrote.
// Dream inverts that: the user writes standing instructions once, picks a shot
// to start from, and the studio then keeps handing the last frame of the clip it
// just made back to the LLM and asking "what happens next?". Each answer becomes
// a new shot, so the run leaves an ordinary shot list behind — nothing about the
// result is special-cased anywhere else in the app.
//
// This module is deliberately dependency-free: it is the pure half (prompt
// assembly and reply parsing), so it can be unit tested without a browser. The
// side-effecting halves live in dreamFrame.js (video → last frame) and in the
// runner inside App.jsx.

export const DEFAULT_DREAM_SYSTEM_PROMPT = `You are directing one unbroken dream: a single continuous shot, generated one clip at a time, where every clip begins on the exact frame the previous clip ended on.

You will be shown that final frame. Read it before you write — the light, the lens, where the camera is, who and what is in it, what state they are in — because the next clip has to continue from it with no cut.

Then write the next clip. Go somewhere: let the camera travel, let something enter, transform or fall away, let the logic slip the way it does in a dream. Surprise is the point. But every surprise stays inside the director's standing instructions below, and inside the world they describe.

Write for a video model: dense, visual, present tense, motion first. Describe what HAPPENS, not what the frame already shows, and never narrate the story or name shot numbers.

Reply with ONLY a JSON object, no markdown fence:
{"description":"<one plain sentence naming what happens in this clip, for the shot list>","videoPrompt":"<the motion prompt sent to the video model>"}`;

/** How many previous clips are recounted to the LLM by default. */
export const DEFAULT_DREAM_HISTORY_DEPTH = 3;

/**
 * A dream configuration, with every field defaulted.
 *
 * Model fields are left null on purpose: null means "whatever the project is set
 * to", so a dream saved months ago still runs on the project's current models
 * rather than pinning one that may no longer exist.
 */
export function createDreamSettings(overrides = {}) {
  return {
    instructions: '',
    iterations: 5,
    systemPrompt: DEFAULT_DREAM_SYSTEM_PROMPT,
    historyDepth: DEFAULT_DREAM_HISTORY_DEPTH,
    startShotId: null,
    imageModel: null,
    imageResolution: null,
    videoModel: null,
    videoResolution: null,
    videoDuration: null,
    ...overrides
  };
}

/** Only the fields worth writing into the project file. */
export function compactDreamSettings(settings) {
  const base = createDreamSettings();
  const out = {};
  Object.keys(base).forEach(key => {
    const value = settings ? settings[key] : undefined;
    if (value === undefined || value === null) return;
    if (value === base[key]) return;
    out[key] = value;
  });
  return out;
}

/**
 * The cast list handed to the LLM, so a dream can reach for the characters and
 * environments the project already defines instead of inventing strangers.
 *
 * Assets with no description still appear: knowing a name exists is enough for
 * the model to tag it, and the tag pulls the reference image in at generation
 * time regardless of what was written here.
 */
export function describeAssetLibrary(assetLibrary = []) {
  return (assetLibrary || [])
    .filter(asset => asset && (asset.tag || asset.name))
    .map(asset => {
      const tag = asset.tag ? `<${asset.tag}>` : '';
      const name = (asset.name || asset.tag || '').trim();
      const description = (asset.description || '').trim();
      const head = [tag, `${asset.type || 'character'}:`, name].filter(Boolean).join(' ');
      return description ? `- ${head} — ${description}` : `- ${head}`;
    })
    .join('\n');
}

/**
 * The user message for one continuation.
 *
 * The final frame itself travels alongside as an image attachment; this is only
 * the text around it.
 */
export function buildDreamUserMessage({
  instructions = '',
  assetLibrary = [],
  history = [],
  clipNumber = 1,
  totalClips = 1,
  hasFrame = true,
  historyDepth = DEFAULT_DREAM_HISTORY_DEPTH
} = {}) {
  const sections = [];

  sections.push(`This is clip ${clipNumber} of ${totalClips} in one continuous shot.`);

  if (hasFrame) {
    sections.push(
      `The attached image is the final frame of clip ${clipNumber - 1}. ` +
      'It is literally the first frame of the clip you are writing — continue from it.'
    );
  }

  const directions = String(instructions || '').trim();
  sections.push(directions
    ? `=== DIRECTOR'S STANDING INSTRUCTIONS ===\n${directions}`
    : "=== DIRECTOR'S STANDING INSTRUCTIONS ===\n(none given — follow wherever the frame leads)");

  const cast = describeAssetLibrary(assetLibrary);
  if (cast) {
    sections.push(
      '=== THE WORLD, ALREADY DEFINED ===\n' +
      'Reach for these rather than inventing replacements. Writing a tag exactly as shown, ' +
      'angle brackets included, expands into its description and carries its reference art into the generation.\n' +
      cast
    );
  }

  // Only the tail: the model needs to know where it has been, not a transcript.
  const recent = history.slice(-Math.max(0, historyDepth));
  if (recent.length > 0) {
    const firstNumber = clipNumber - recent.length;
    sections.push(
      '=== CLIPS SO FAR ===\n' +
      recent.map((line, i) => `${firstNumber + i}. ${String(line || '').trim()}`).join('\n') +
      '\n\nDo not repeat these. Move on.'
    );
  }

  return sections.join('\n\n');
}

/**
 * Read a continuation out of the model's reply.
 *
 * A model that ignores the JSON instruction and simply writes the prompt has
 * still done the useful thing, so a plain-text reply is accepted as the prompt
 * rather than failing the whole run mid-dream.
 */
export function parseDreamReply(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('The model returned nothing.');

  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(unfenced.slice(start, end + 1));
      const videoPrompt = String(parsed.videoPrompt || parsed.prompt || '').trim();
      if (videoPrompt) {
        return { description: String(parsed.description || '').trim(), videoPrompt };
      }
    } catch {
      // Not valid JSON after all — fall through and take it as prose.
    }
  }

  return { description: '', videoPrompt: unfenced };
}

/** The name a generated dream shot gets. */
export function dreamShotName(clipNumber) {
  return `Dream ${clipNumber}`;
}
