// Identity of a prompt group.
//
// Lifted from App.jsx byte for byte so the migration (which stamps every take
// with its group's key) and the app (which still folds reruns into the group
// with the same key) can never disagree about which gallery a result belongs
// in. When App.jsx stops carrying its own copy, this is the only one left.
//
// Keyed on the RAW inputs the user controls, never the composed output. The
// composed prompt already has the global pre/post text baked in, so matching
// on it meant "+ Add Iteration" — which reloads the group and recomposes —
// produced a different string every time and forked a fresh group.
// `!== false` throughout, so a group saved before a flag existed reads as the
// default it was generated under and keeps its own gallery.

export const imagePromptSignature = (group) => JSON.stringify([
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

export const videoPromptSignature = (group) => JSON.stringify([
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

/** The signature for a group of either kind. Anything not 'image' is a video group. */
export function groupSignature(kind, group) {
  return kind === 'image' ? imagePromptSignature(group) : videoPromptSignature(group);
}
