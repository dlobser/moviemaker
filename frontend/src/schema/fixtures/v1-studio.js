// A small v1 project in the shape `buildStatePayload` wrote on November 6,
// 2026, hand-written to exercise every branch of the v2 migration: a group
// with meta and two outputs, a group without meta, an empty group, a lip-sync
// group, a selection that matches no output, a colliding output id, the same
// file spelled with both separators, an external audio reference, a reference
// linked to an asset but absent from its pool, dangling assignments, an edit
// with shot and asset clips, a running job, and a pipeline run.
//
// Paths only. There is no media behind them and no real project data.

const SHOT1 = 'assets/shots/01-cold-open/01-shot-1';
const SHOT2 = 'assets/shots/01-cold-open/02-shot-2';

export const PATHS = {
  shot1Image1: `${SHOT1}/images/shot-1_v01.png`,
  shot1Image2: `${SHOT1}/images/shot-1_v02.png`,
  shot1Image3: `${SHOT1}/images/shot-1_v03.png`,
  shot1Video1: `${SHOT1}/video/shot-1_v01.mp4`,
  shot1Video2: `${SHOT1}/video/shot-1_v02.mp4`,
  shot1Voice: `${SHOT1}/audio/voice.wav`,
  shot2Image1: `${SHOT2}/images/shot-2_v01.png`,
  ralph1: 'assets/library/characters/ralph/ralph_01.png',
  ralph2: 'assets/library/characters/ralph/ralph_02.png',
  alley: 'assets/alley_1.png',
  alleyBackslash: 'assets\\alley_1.png',
  ralphTurnaround: 'assets/reference/ralph_turnaround.png',
  rainStyle: 'assets/reference/rain_style.jpg',
  vocalUrl: 'https://cdn.example.com/vocal.mp3',
  moveUrl: 'https://cdn.example.com/move.mp4?sig=abc',
  moveClip: 'assets/uploads/move.mp4',
  crop1: 'assets/crops/crop_1.png',
  crop2: 'assets/crops/crop_2.png',
  dreamFrame: 'assets/dream_frame_1.png',
  moodboard: 'assets/uploads/moodboard.png',
  titles: 'assets/bin/titles.mp4',
  music: 'assets/bin/music.mp3',
  watermark: 'assets/watermark.png',
  finalCut: 'assets/final_cut.mp4',
  scene1Cut: 'assets/scene1_concat.mp4'
};

/** The composed prompt the first image group sent. */
const COMPOSED_1 = 'cinematic. Ralph (rusty robot) walks down the Neon Alley (a rain-slick alley lit by signs). film grain';

export function studioProject() {
  const shot1 = {
    id: 'sh_1',
    name: 'Shot 1',
    setup: 'Night. The alley.',
    description: '<Ralph> walks down the <Alley>',
    dialogue: '',
    notes: '',
    selectedImage: PATHS.shot1Image2,
    selectedVideo: PATHS.shot1Video2,
    referenceImages: [],
    lipSyncAudio: PATHS.shot1Voice,
    audioRefs: [PATHS.vocalUrl],
    videoRefs: [PATHS.moveClip, PATHS.moveUrl],
    draftImagePrompt: '',
    draftVideoPrompt: '',
    imagePrompts: [
      {
        id: 'prompt_img_1',
        rawPrompt: '<Ralph> walks down the <Alley>',
        model: 'fal-ai/flux/dev',
        resolution: '16:9',
        duration: '5',
        primaryImagePaths: [PATHS.ralph1],
        attachTaggedImages: true,
        excludedImagePaths: [],
        usePrePrompt: true,
        usePostPrompt: true,
        promptOverride: null,
        prompt: COMPOSED_1,
        inputImagePaths: [PATHS.ralph1, PATHS.alley],
        meta: {
          taggedAssetIds: ['asset_ralph', 'asset_alley'],
          assetStamps: {
            asset_ralph: { updatedAt: '2026-10-20T10:00:00.000Z', primaryImage: PATHS.ralph1 },
            asset_alley: { updatedAt: '2026-10-19T08:00:00.000Z', primaryImage: PATHS.alley }
          },
          createdAt: '2026-10-21T09:00:05.000Z'
        },
        outputs: [
          { id: 'out_img_1001', path: PATHS.shot1Image1, name: 'Iteration 1001', createdAt: '2026-10-21T09:00:00.000Z' },
          { id: 'out_img_1002', path: PATHS.shot1Image2, name: 'Iteration 1002', createdAt: '2026-10-21T09:00:05.000Z' }
        ]
      },
      {
        // Older group: no meta, nothing attached.
        id: 'prompt_img_2',
        rawPrompt: 'wide shot of the alley',
        model: 'fal-ai/flux/schnell',
        resolution: '16:9',
        duration: '5',
        primaryImagePaths: [],
        attachTaggedImages: false,
        excludedImagePaths: [],
        usePrePrompt: true,
        usePostPrompt: false,
        promptOverride: null,
        prompt: 'cinematic. wide shot of the alley',
        inputImagePaths: [],
        outputs: [
          { id: 'out_img_1003', path: PATHS.shot1Image3, name: 'Iteration 1003', createdAt: '2026-10-21T09:10:00.000Z' }
        ]
      },
      {
        id: 'prompt_img_3',
        rawPrompt: 'never generated',
        model: 'fal-ai/flux/schnell',
        resolution: '16:9',
        primaryImagePaths: [],
        excludedImagePaths: [],
        prompt: 'never generated',
        inputImagePaths: [],
        outputs: []
      }
    ],
    videoPrompts: [
      {
        id: 'prompt_vid_1',
        rawPrompt: 'he walks towards camera',
        model: 'fal-ai/kling-video',
        resolution: '1280x720',
        duration: '5',
        primaryImagePaths: [],
        attachTaggedImages: false,
        excludedImagePaths: [],
        usePrePrompt: true,
        usePostPrompt: true,
        promptOverride: null,
        prompt: 'he walks towards camera',
        imageInput: PATHS.shot1Image2,
        inputImagePaths: [PATHS.shot1Image2],
        meta: {
          taggedAssetIds: [],
          assetStamps: {},
          createdAt: '2026-10-21T10:00:00.000Z'
        },
        outputs: [
          { id: 'out_vid_2001', path: PATHS.shot1Video1, name: 'Iteration 2001', createdAt: '2026-10-21T10:00:00.000Z' }
        ]
      },
      {
        id: 'prompt_sync_2002',
        prompt: 'Lipsync synced with: voice.wav',
        outputs: [
          { id: 'out_vid_2002', path: PATHS.shot1Video2, name: 'Lipsynced_2002', createdAt: '2026-10-21T11:00:00.000Z' }
        ]
      }
    ]
  };

  const shot2 = {
    id: 'sh_2',
    name: 'Shot 2',
    setup: '',
    description: 'The car arrives.',
    dialogue: '',
    notes: '',
    selectedImage: PATHS.shot2Image1,
    selectedVideo: null,
    referenceImages: [],
    lipSyncAudio: null,
    audioRefs: [],
    videoRefs: [],
    imagePrompts: [
      {
        // An old group that only ever recorded `imageInput`, whose output id
        // collides with one in Shot 1 (a same-millisecond batch).
        id: 'prompt_img_4',
        rawPrompt: 'a car arrives',
        model: 'fal-ai/flux/schnell',
        resolution: '16:9',
        primaryImagePaths: [],
        excludedImagePaths: [],
        prompt: 'cinematic. a car arrives. film grain',
        outputs: [
          { id: 'out_img_1001', path: PATHS.shot2Image1, name: 'Iteration 1001', createdAt: '2026-10-21T09:00:00.000Z' }
        ]
      }
    ],
    videoPrompts: []
  };

  const shot3 = {
    id: 'sh_3',
    name: 'Shot 3',
    setup: '',
    description: 'A still from the gallery.',
    dialogue: '',
    notes: '',
    // A gallery crop picked as the still: no output ever produced it.
    selectedImage: PATHS.crop1,
    selectedVideo: null,
    referenceImages: [],
    lipSyncAudio: null,
    audioRefs: [],
    videoRefs: [],
    imagePrompts: [],
    videoPrompts: []
  };

  const scenes = [
    {
      id: 'sc_1',
      name: 'Cold Open',
      number: 1,
      shots: [shot1, shot2],
      sceneConcatenatedVideo: PATHS.scene1Cut
    },
    {
      id: 'sc_2',
      name: 'The Garage',
      number: 2,
      shots: [shot3],
      sceneConcatenatedVideo: null
    }
  ];

  return {
    scenes,
    shots: scenes.flatMap(scene => scene.shots),
    imageGallery: [
      { id: 'img_crop_3002', path: PATHS.crop2, prompt: 'Crop of Nowhere', name: 'crop_Nowhere', createdAt: '2026-10-22T12:00:00.000Z' },
      { id: 'img_6001', path: PATHS.moodboard, prompt: 'uploaded moodboard', name: 'moodboard', createdAt: '2026-10-22T11:00:00.000Z' },
      { id: 'img_dream_5001', path: PATHS.dreamFrame, prompt: 'Dream clip 1 — final frame', name: 'Dream frame 1', createdAt: '2026-10-22T10:00:00.000Z' },
      { id: 'img_crop_3001', path: PATHS.crop1, prompt: 'Crop of Iteration 1002', name: 'crop_Iteration 1002', createdAt: '2026-10-21T12:00:00.000Z' },
      { id: 'img_1003', path: PATHS.shot1Image3, prompt: 'cinematic. wide shot of the alley', name: 'Iteration 1003', createdAt: '2026-10-21T09:10:00.000Z' },
      { id: 'img_1002', path: PATHS.shot1Image2, prompt: COMPOSED_1, name: 'Iteration 1002', createdAt: '2026-10-21T09:00:05.000Z' },
      { id: 'img_1001', path: PATHS.shot1Image1, prompt: COMPOSED_1, name: 'Iteration 1001', createdAt: '2026-10-21T09:00:00.000Z' },
      { id: 'img_asset_4001', path: PATHS.alley, prompt: 'reference art of a rain-slick alley', name: 'Alley reference', createdAt: '2026-10-19T08:00:00.000Z' }
    ],
    videoGallery: [
      { id: 'vid_2002', path: PATHS.shot1Video2, prompt: 'Lipsync output', name: 'Lipsynced_2002', createdAt: '2026-10-21T11:00:00.000Z' },
      { id: 'vid_2001', path: PATHS.shot1Video1, prompt: 'he walks towards camera', name: 'Iteration 2001', createdAt: '2026-10-21T10:00:00.000Z' }
    ],
    referenceImages: [
      { id: 'ref_a', path: PATHS.ralphTurnaround, name: 'Ralph turnaround', kind: 'character', tags: ['Ralph'], notes: 'three-quarter view', assetId: 'asset_ralph', source: 'upload', createdAt: '2026-10-18T09:00:00.000Z' },
      { id: 'ref_b', path: PATHS.ralph2, name: 'Ralph 2', kind: 'character', tags: ['Ralph'], notes: '', assetId: 'asset_ralph', source: 'generated', createdAt: '2026-10-20T10:00:00.000Z' },
      { id: 'ref_c', path: PATHS.rainStyle, name: 'Rain style', kind: 'style', tags: ['rain'], notes: 'moody', assetId: null, source: 'upload', createdAt: '2026-10-18T09:30:00.000Z' }
    ],
    refAssignments: [
      { id: 'edge_1', refId: 'ref_c', scope: 'project', targetId: null, role: 'style', enabled: true, order: 0 },
      { id: 'edge_2', refId: 'ref_a', scope: 'shot', targetId: 'sh_1', role: 'subject', enabled: true, order: 0 },
      { id: 'edge_3', refId: 'ref_c', scope: 'scene', targetId: 'sc_1', role: 'style', enabled: false, order: 0 },
      { id: 'edge_4', refId: 'ref_ghost', scope: 'shot', targetId: 'sh_1', role: 'style', enabled: true, order: 1 },
      { id: 'edge_5', refId: 'ref_a', scope: 'shot', targetId: 'sh_gone', role: 'style', enabled: true, order: 0 }
    ],
    referenceSchemaVersion: 2,
    assetLibrary: [
      {
        id: 'asset_ralph',
        tag: 'Ralph',
        type: 'character',
        name: 'Ralph',
        description: 'A tired maintenance robot with one cracked eye.',
        shotDescription: 'rusty robot',
        images: [PATHS.ralph1, PATHS.ralph2],
        primaryImage: PATHS.ralph1,
        inputImages: [PATHS.ralph2],
        imagePrompt: 'character sheet of a rusty maintenance robot',
        imageModel: 'fal-ai/flux/dev',
        imageResolution: '1:1',
        applyGlobalPrompts: true,
        updatedAt: '2026-10-20T10:00:00.000Z'
      },
      {
        // Saved before multi-select existed: the old single flag, and the
        // image spelled with a backslash.
        id: 'asset_alley',
        tag: 'Alley',
        type: 'environment',
        name: 'Neon Alley',
        description: 'a rain-slick alley lit by signs',
        images: [PATHS.alleyBackslash],
        primaryImage: PATHS.alleyBackslash,
        useExistingAsReference: true,
        imagePrompt: 'reference art of a rain-slick alley',
        imageModel: 'fal-ai/flux/schnell',
        imageResolution: '16:9',
        applyGlobalPrompts: false,
        updatedAt: '2026-10-19T08:00:00.000Z'
      },
      {
        id: 'asset_car',
        tag: 'Car',
        type: 'vehicle',
        name: 'The Car',
        description: 'a dented hover-car',
        images: [],
        primaryImage: null,
        inputImages: [],
        imagePrompt: '',
        applyGlobalPrompts: true,
        updatedAt: null
      }
    ],
    promptSnippets: [],
    activeLlm: 'gemini',
    llmModel: 'gemini-2.5-flash',
    activeImageGenerator: 'fal-ai',
    imageModel: 'fal-ai/flux/schnell',
    imageResolution: '16:9',
    activeVideoGenerator: 'fal-ai',
    videoResolution: '1280x720',
    videoModel: 'fal-ai/kling-video',
    videoDuration: '5',
    batchConcurrency: 3,
    attachTagsForImages: true,
    attachTagsForVideos: false,
    atlasSafetyChecker: true,
    customModelCaps: {},
    assetTypeModels: {},
    autoAttachRefs: true,
    batchJobs: [
      { id: 'job_3', shotId: null, assetId: 'asset_alley', shotName: 'Asset <Alley>', type: 'image', model: 'fal-ai/flux/schnell', prompt: 'reference art of a rain-slick alley', taggedAssets: [], status: 'failed', createdAt: '2026-10-22T09:00:00.000Z', error: 'provider timeout' },
      { id: 'job_1', shotId: 'sh_1', shotName: 'Shot 1', type: 'video', model: 'fal-ai/kling-video', prompt: 'he walks towards camera', taggedAssets: [], status: 'running', createdAt: '2026-10-21T10:00:00.000Z', error: null },
      { id: 'job_2', shotId: 'sh_1', shotName: 'Shot 1', type: 'image', model: 'fal-ai/flux/dev', prompt: COMPOSED_1, taggedAssets: ['Ralph', 'Alley'], status: 'completed', createdAt: '2026-10-21T09:00:04.000Z', error: null, outputPath: PATHS.shot1Image2 }
    ],
    pipelineRun: {
      id: 'run_1',
      status: 'done',
      startedAt: '2026-10-21T08:00:00.000Z',
      finishedAt: '2026-10-21T08:30:00.000Z',
      options: { skip: [], dryRun: false },
      stageStates: { prompts: { status: 'done', total: 2, done: 2, failed: [] } }
    },
    dreamSettings: {},
    promptSettings: { prePrompt: 'cinematic.' },
    prePrompt: 'cinematic.',
    postPrompt: 'film grain',
    videoPrePrompt: '',
    videoPostPrompt: '',
    imageSystemPrompt: '',
    videoSystemPrompt: '',
    concatenatedVideo: PATHS.finalCut,
    watermarkImage: PATHS.watermark,
    watermarkMotion: 'drift',
    edit: {
      version: 1,
      settings: { width: 1280, height: 720, fps: 24, resolutionAuto: false },
      smart: true,
      video: [
        {
          id: 'vc_1',
          source: { kind: 'shot', shotId: 'sh_1' },
          start: 0,
          in: 0,
          out: 4,
          boundTo: PATHS.shot1Video2,
          transition: null,
          audio: { gain: 1, fadeIn: 0, fadeOut: 0, detached: false },
          manual: false
        },
        {
          id: 'vc_2',
          source: { kind: 'asset', path: PATHS.titles, name: 'Titles', stream: 'video' },
          start: 4,
          in: 0,
          out: null,
          boundTo: null,
          transition: { type: 'dissolve', duration: 0.5 },
          audio: { gain: 1, fadeIn: 0, fadeOut: 0, detached: false },
          manual: false
        }
      ],
      audio: [
        {
          id: 'at_1',
          name: 'Music',
          gain: 1,
          muted: false,
          solo: false,
          forPicture: false,
          clips: [
            { id: 'ac_1', source: { kind: 'asset', path: PATHS.music, name: 'Music', stream: 'audio' }, start: 0, in: 0, out: 7, boundTo: PATHS.music, gain: 1, fadeIn: 0, fadeOut: 1, link: null, detachedFrom: null }
          ]
        }
      ],
      bin: [
        { id: 'bin_1', path: PATHS.titles, name: 'Titles', type: 'video', addedAt: '2026-10-23T09:00:00.000Z' },
        { id: 'bin_2', path: PATHS.music, name: 'Music', type: 'audio', addedAt: '2026-10-23T09:01:00.000Z' }
      ],
      durations: {
        [PATHS.shot1Video2]: { duration: 5.2, width: 1280, height: 720, fps: 24, hasAudio: true, isImage: false },
        [PATHS.titles]: { duration: 3, width: 1920, height: 1080, fps: 25, hasAudio: false, isImage: false }
      }
    },
    activeSceneId: 'sc_1',
    activeShotId: 'sh_1'
  };
}

/** The distinct files the studio project names, for count assertions. */
export const STUDIO_DISTINCT_PATHS = 24;

/** A fixed clock for deterministic migrations in tests: 2026-11-06T12:00:00Z. */
export const FIXED_NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
