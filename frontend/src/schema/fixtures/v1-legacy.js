// A project saved before scenes, the reference schema, the prompt bag and the
// editor existed: flat `shots`, a `referenceImages` array on the shot, flat
// pre/post prompt fields, no `edit` key, no `referenceSchemaVersion`. The v1
// normalizers the migration imports have to run for this to come out right.
//
// Paths only; no real project data.

export function legacyProject() {
  return {
    shots: [
      {
        id: 'shot_1',
        name: 'Shot 1',
        setup: 'Dawn.',
        description: 'A hover-car crosses the skyline.',
        dialogue: '',
        notes: '',
        selectedImage: 'assets/img_1.png',
        selectedVideo: null,
        referenceImages: ['ref_1', 'ref_missing'],
        imagePrompts: [
          {
            id: 'prompt_img_old',
            prompt: 'A hover-car crosses the skyline.',
            model: 'fal-ai/flux/schnell',
            resolution: '16:9',
            imageInput: 'assets/ref_1.png',
            outputs: [
              { id: 'out_img_old', path: 'assets/img_1.png', name: 'Iteration 1', createdAt: '2025-09-01T10:00:00.000Z' }
            ]
          }
        ],
        videoPrompts: []
      }
    ],
    referenceImages: [
      { id: 'ref_1', path: 'assets/ref_1.png', name: 'Skyline', createdAt: '2025-08-30T10:00:00.000Z' }
    ],
    assetLibrary: [],
    imageGallery: [
      { id: 'img_1', path: 'assets/img_1.png', prompt: 'A hover-car crosses the skyline.', name: 'Iteration 1', createdAt: '2025-09-01T10:00:00.000Z' }
    ],
    videoGallery: [],
    prePrompt: 'cinematic',
    postPrompt: 'grain',
    imageSystemPrompt: 'You write prompts.',
    activeImageGenerator: 'fal-ai',
    imageModel: 'fal-ai/flux/schnell',
    batchJobs: []
  };
}
