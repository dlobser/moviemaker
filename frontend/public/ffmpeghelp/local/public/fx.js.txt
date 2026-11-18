/* Audio effects: the one list of effects, their parameters, presets and ffmpeg filter builders.
   Loaded by the browser (as window.FX) and by the server (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FX = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const f = (n) => String(+(+n).toFixed(6));
  const lin = (db) => Math.pow(10, db / 20);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  // ---------------------------------------------------------------- parameter helpers
  // range: a slider. log: logarithmic slider (frequencies, times). step: rounding.
  const R = (key, label, min, max, def, unit = '', o = {}) => ({ type: 'range', key, label, min, max, def, unit, step: 0.01, ...o });
  const SEL = (key, label, opts, def, o = {}) => ({ type: 'select', key, label, opts, def: def ?? opts[0][0], ...o });
  const CHK = (key, label, def = false, o = {}) => ({ type: 'check', key, label, def, ...o });

  const HZ = (key, label, min, max, def, o = {}) => R(key, label, min, max, def, 'Hz', { log: true, step: 1, ...o });
  const DB = (key, label, min, max, def, o = {}) => R(key, label, min, max, def, 'dB', { step: 0.5, ...o });
  const MS = (key, label, min, max, def, o = {}) => R(key, label, min, max, def, 'ms', { log: true, step: 0.1, ...o });
  const PCT = (key, label, def, o = {}) => R(key, label, 0, 100, def, '%', { step: 1, ...o });

  const SLOPES = [['12', '12 dB/oct (gentle)'], ['24', '24 dB/oct'], ['36', '36 dB/oct'], ['48', '48 dB/oct (steep)']];

  /** High/low-pass at a slope: 2-pole stages stacked; resonance only on the last one. */
  function pass(kind, freq, slope, q, sr) {
    const n = Math.max(1, Math.round(Number(slope) / 12));
    const fr = clamp(freq, 10, sr * 0.45);
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(`${kind}=f=${f(Math.round(fr))}:p=2${i === n - 1 && q && Math.abs(q - 0.71) > 0.01 ? `:t=q:w=${f(q)}` : ''}`);
    return parts.join(',');
  }

  function atempo(speed) {
    const parts = [];
    let s = speed;
    while (s > 2) {
      parts.push('atempo=2');
      s /= 2;
    }
    while (s < 0.5) {
      parts.push('atempo=0.5');
      s /= 0.5;
    }
    if (Math.abs(s - 1) > 1e-6 || !parts.length) parts.push(`atempo=${f(s)}`);
    return parts.join(',');
  }

  /** Blend a processed copy with the dry signal (for effects that have no mix control of their own). */
  const parallel = (u, wetChain, mix) => (inL, outL) => {
    const m = mix / 100;
    return `[${inL}]asplit=2[pd${u}][pw${u}];[pw${u}]${wetChain}[pr${u}];[pd${u}][pr${u}]amix=inputs=2:duration=first:normalize=0:weights='${f(1 - m)} ${f(m)}'[${outL}]`;
  };

  // ---------------------------------------------------------------- effects

  const CATEGORIES = [
    ['filter', 'Filter & EQ'],
    ['dynamics', 'Dynamics'],
    ['dirt', 'Distortion & lo-fi'],
    ['signal', 'Noise & radio signal'],
    ['space', 'Reverb & echo'],
    ['mod', 'Modulation'],
    ['pitch', 'Pitch & time'],
    ['util', 'Channels'],
  ];

  const EFFECTS = {
    highpass: {
      name: 'High-pass',
      cat: 'filter',
      desc: 'Cuts everything below the cutoff — removes rumble and body, makes things thinner.',
      params: [HZ('freq', 'Cutoff', 20, 8000, 300), SEL('slope', 'Slope', SLOPES, '24'), R('q', 'Resonance (Q)', 0.3, 4, 0.71, '', { log: true })],
      presets: [['Rumble cut', { freq: 80, slope: '24', q: 0.71 }], ['Thin', { freq: 300, slope: '24', q: 0.71 }], ['Radio', { freq: 500, slope: '36', q: 0.71 }], ['Tiny speaker', { freq: 900, slope: '24', q: 1.4 }]],
      build: (p, c) => pass('highpass', p.freq, p.slope, p.q, c.sr),
    },
    lowpass: {
      name: 'Low-pass',
      cat: 'filter',
      desc: 'Cuts everything above the cutoff — muffles, darkens, sounds far away or behind a wall.',
      params: [HZ('freq', 'Cutoff', 100, 20000, 3000), SEL('slope', 'Slope', SLOPES, '24'), R('q', 'Resonance (Q)', 0.3, 4, 0.71, '', { log: true })],
      presets: [['Through a wall', { freq: 400, slope: '36', q: 0.71 }], ['Muffled', { freq: 900, slope: '24', q: 0.71 }], ['Telephone', { freq: 3400, slope: '24', q: 0.71 }], ['AM radio', { freq: 4500, slope: '24', q: 0.71 }], ['Warm', { freq: 8000, slope: '12', q: 0.71 }]],
      build: (p, c) => pass('lowpass', p.freq, p.slope, p.q, c.sr),
    },
    bandpass: {
      name: 'Band-pass',
      cat: 'filter',
      desc: 'Keeps only the band between the two cutoffs. This is most of the "radio / telephone" sound.',
      params: [HZ('low', 'Low cut', 20, 5000, 300), HZ('high', 'High cut', 300, 20000, 3400), SEL('slope', 'Slope', SLOPES, '24')],
      presets: [
        ['Telephone 300–3400', { low: 300, high: 3400, slope: '24' }],
        ['ATC radio 350–2800', { low: 350, high: 2800, slope: '36' }],
        ['Walkie-talkie 500–2500', { low: 500, high: 2500, slope: '36' }],
        ['Megaphone 600–4000', { low: 600, high: 4000, slope: '24' }],
        ['AM radio 150–4500', { low: 150, high: 4500, slope: '24' }],
      ],
      build(p, c) {
        if (p.low >= p.high) throw new Error('Band-pass: the low cut must be below the high cut');
        return `${pass('highpass', p.low, p.slope, 0, c.sr)},${pass('lowpass', p.high, p.slope, 0, c.sr)}`;
      },
    },
    eq: {
      name: 'EQ band (peak)',
      cat: 'filter',
      desc: 'Boosts or cuts a band around one frequency. A narrow boost around 1–2 kHz gives a nasal, honky radio tone.',
      params: [HZ('freq', 'Frequency', 20, 20000, 1000), DB('gain', 'Gain', -24, 24, 6), R('q', 'Width (Q)', 0.1, 10, 1, '', { log: true, hint: 'Higher = narrower' })],
      presets: [['Nasal honk', { freq: 1600, gain: 8, q: 1.4 }], ['Presence', { freq: 4000, gain: 4, q: 0.8 }], ['Cut mud', { freq: 300, gain: -6, q: 1 }], ['Telephone bump', { freq: 2000, gain: 6, q: 1 }]],
      build: (p) => `equalizer=f=${f(p.freq)}:t=q:w=${f(p.q)}:g=${f(p.gain)}`,
    },
    tone: {
      name: 'Bass & treble',
      cat: 'filter',
      desc: 'Shelving tone controls, like on a stereo.',
      params: [DB('bass', 'Bass', -20, 20, 0), HZ('bassF', 'Bass frequency', 40, 600, 120), DB('treble', 'Treble', -20, 20, 0), HZ('trebleF', 'Treble frequency', 1000, 16000, 4000)],
      presets: [['Warm', { bass: 4, bassF: 120, treble: -3, trebleF: 5000 }], ['Bright', { bass: -2, bassF: 120, treble: 5, trebleF: 4000 }], ['Small speaker', { bass: -15, bassF: 250, treble: 0, trebleF: 4000 }]],
      build(p) {
        const parts = [];
        if (p.bass) parts.push(`bass=g=${f(p.bass)}:f=${f(p.bassF)}`);
        if (p.treble) parts.push(`treble=g=${f(p.treble)}:f=${f(p.trebleF)}`);
        return parts.join(',') || 'anull';
      },
    },

    compressor: {
      name: 'Compressor',
      cat: 'dynamics',
      desc: 'Squashes loud parts down so everything sits at the same level. Heavy settings give the flat, in-your-face radio sound.',
      params: [
        DB('threshold', 'Threshold', -60, 0, -20),
        R('ratio', 'Ratio', 1, 20, 4, ':1', { step: 0.1 }),
        MS('attack', 'Attack', 0.1, 200, 10),
        MS('release', 'Release', 5, 2000, 150, { step: 1 }),
        DB('makeup', 'Makeup gain', 0, 36, 0),
        R('knee', 'Knee', 1, 8, 2.8, '', { step: 0.1 }),
      ],
      presets: [
        ['Gentle', { threshold: -18, ratio: 2, attack: 20, release: 250, makeup: 3, knee: 4 }],
        ['Vocal', { threshold: -24, ratio: 4, attack: 5, release: 120, makeup: 8, knee: 2.8 }],
        ['Radio squash', { threshold: -32, ratio: 12, attack: 1, release: 60, makeup: 18, knee: 2 }],
        ['Pumping', { threshold: -36, ratio: 20, attack: 0.5, release: 400, makeup: 20, knee: 1 }],
      ],
      build: (p) =>
        `acompressor=threshold=${f(Math.max(lin(p.threshold), 0.000976563))}:ratio=${f(p.ratio)}:attack=${f(p.attack)}:release=${f(p.release)}:makeup=${f(clamp(lin(p.makeup), 1, 64))}:knee=${f(p.knee)}`,
    },
    limiter: {
      name: 'Limiter',
      cat: 'dynamics',
      desc: 'A hard ceiling: nothing gets louder than it. Push the input gain to make things loud and dense.',
      params: [DB('gain', 'Input gain', 0, 24, 0), DB('ceiling', 'Ceiling', -24, 0, -1, { step: 0.1 }), MS('release', 'Release', 1, 1000, 50, { step: 1 })],
      presets: [['Safety', { gain: 0, ceiling: -1, release: 50 }], ['Loud', { gain: 10, ceiling: -1, release: 40 }], ['Smashed', { gain: 20, ceiling: -1, release: 20 }]],
      build: (p) => `alimiter=level_in=${f(lin(p.gain))}:limit=${f(clamp(lin(p.ceiling), 0.0625, 1))}:attack=5:release=${f(p.release)}:level=0`,
    },
    gate: {
      name: 'Noise gate',
      cat: 'dynamics',
      desc: 'Turns the sound down when it falls below the threshold — removes background hiss between words, or makes a choppy squelch.',
      params: [DB('threshold', 'Threshold', -80, 0, -40), R('ratio', 'Ratio', 1, 20, 10, ':1', { step: 0.1 }), MS('attack', 'Attack', 0.1, 200, 5), MS('release', 'Release', 5, 2000, 200, { step: 1 }), DB('range', 'Reduction', -80, 0, -40)],
      presets: [['Clean up hiss', { threshold: -45, ratio: 4, attack: 5, release: 250, range: -24 }], ['Hard gate', { threshold: -30, ratio: 20, attack: 0.5, release: 60, range: -80 }]],
      build: (p) => `agate=threshold=${f(lin(p.threshold))}:ratio=${f(p.ratio)}:attack=${f(p.attack)}:release=${f(p.release)}:range=${f(lin(p.range))}`,
    },
    gain: {
      name: 'Volume',
      cat: 'dynamics',
      desc: 'Turns the level up or down.',
      params: [DB('gain', 'Gain', -40, 40, 0)],
      build: (p) => (p.gain ? `volume=${f(p.gain)}dB` : 'anull'),
    },
    normalize: {
      name: 'Normalize',
      cat: 'dynamics',
      desc: 'Brings the overall loudness to a standard level (or evens out quiet and loud passages).',
      params: [SEL('mode', 'Mode', [['loud', 'Loudness (EBU R128)'], ['dyn', 'Dynamic (evens out quiet & loud parts)']]), R('target', 'Target', -30, -6, -16, 'LUFS', { step: 0.5, when: (p) => p.mode === 'loud' })],
      build: (p, c) => (p.mode === 'dyn' ? 'dynaudnorm=f=250:g=15:p=0.9' : `loudnorm=I=${f(p.target)}:TP=-1.5:LRA=11,aresample=${c.sr}`),
    },

    distortion: {
      name: 'Distortion',
      cat: 'dirt',
      desc: 'Drives the signal into a clipper. Low drive = warm saturation, high drive = blown-out speaker.',
      params: [
        SEL('type', 'Character', [['tanh', 'Soft (tanh)'], ['atan', 'Warm (atan)'], ['cubic', 'Tube-ish (cubic)'], ['erf', 'Smooth (erf)'], ['sin', 'Wavefold-ish (sin)'], ['hard', 'Hard clip (harsh)']]),
        DB('drive', 'Drive', 0, 48, 12),
        DB('output', 'Output', -36, 6, -6),
        PCT('mix', 'Mix', 100),
      ],
      presets: [
        ['Warm saturation', { type: 'atan', drive: 6, output: -3, mix: 100 }],
        ['Overdrive', { type: 'tanh', drive: 18, output: -10, mix: 100 }],
        ['Broken speaker', { type: 'hard', drive: 26, output: -18, mix: 100 }],
        ['Fuzz', { type: 'cubic', drive: 36, output: -20, mix: 80 }],
      ],
      build(p, c) {
        const chain = `volume=${f(p.drive)}dB,asoftclip=type=${p.type},volume=${f(p.output)}dB`;
        return p.mix >= 100 ? chain : { graph: parallel(c.uid, chain, p.mix) };
      },
    },
    bitcrush: {
      name: 'Bitcrusher',
      cat: 'dirt',
      desc: 'Fewer bits = grainy digital noise. Sample hold > 1 adds the metallic aliasing of old samplers and game consoles.',
      params: [R('bits', 'Bit depth', 1, 16, 8, 'bits', { step: 0.5 }), R('samples', 'Sample hold', 1, 50, 1, '×', { step: 1, log: true }), SEL('mode', 'Curve', [['lin', 'Linear'], ['log', 'Logarithmic (smoother)']]), PCT('mix', 'Mix', 100)],
      presets: [['Subtle grit', { bits: 12, samples: 1, mode: 'log', mix: 60 }], ['8-bit', { bits: 8, samples: 2, mode: 'lin', mix: 100 }], ['4-bit wreck', { bits: 4, samples: 6, mode: 'lin', mix: 100 }]],
      build: (p) => `acrusher=bits=${f(p.bits)}:mode=${p.mode}:samples=${f(Math.round(p.samples))}:mix=${f(p.mix / 100)}:aa=0`,
    },
    resample: {
      name: 'Low sample rate',
      cat: 'dirt',
      desc: 'Re-samples down and back up, throwing away everything above half the rate — the hallmark of phone lines and old digital audio.',
      params: [SEL('rate', 'Rate', [['4000', '4 kHz (very muffled)'], ['6000', '6 kHz'], ['8000', '8 kHz (telephone)'], ['11025', '11 kHz (old games)'], ['16000', '16 kHz (VoIP)'], ['22050', '22 kHz']], '8000'), CHK('alias', 'Aliasing (crunchy, no smoothing filter)')],
      build(p, c) {
        const r = Number(p.rate);
        if (r >= c.sr) return 'anull';
        if (p.alias) return `acrusher=bits=24:samples=${Math.max(1, Math.round(c.sr / r))}:aa=0:mix=1`;
        return `aresample=${r},aresample=${c.sr}`;
      },
    },

    noise: {
      name: 'Add noise',
      cat: 'signal',
      desc: 'Mixes in hiss, rumble or crackle. Put it before the filters to band-limit it like real radio static, or before a compressor so the noise "breathes".',
      params: [
        SEL('color', 'Kind', [['white', 'White (hiss)'], ['pink', 'Pink (soft hiss)'], ['brown', 'Brown (rumble)'], ['blue', 'Blue (bright fizz)'], ['violet', 'Violet (sizzle)'], ['velvet', 'Crackle (sparse clicks)']]),
        DB('level', 'Level', -80, -6, -40),
        R('density', 'Crackle density', 0.001, 0.5, 0.02, '', { log: true, step: 0.001, when: (p) => p.color === 'velvet' }),
      ],
      presets: [['Faint hiss', { color: 'pink', level: -50 }], ['Radio static', { color: 'white', level: -32 }], ['Vinyl crackle', { color: 'velvet', level: -26, density: 0.004 }], ['Engine rumble', { color: 'brown', level: -30 }]],
      build(p, c) {
        const amp = f(clamp(lin(p.level), 0, 1));
        const seed = c.uid * 7919;
        // Crackle is velvet noise: sparse ±1 clicks. anoisesrc only has color=velvet from ffmpeg 6, so it's
        // built from an expression instead, which sounds the same and works in older ffmpeg (and the web version).
        const half = f(p.density / 2);
        const src =
          p.color === 'velvet'
            ? `aevalsrc='if(eq(n,0),st(0,${seed}),0);st(1,random(0));${amp}*(gt(ld(1),1-${half})-lt(ld(1),${half}))':s=${c.sr}`
            : `anoisesrc=color=${p.color}:amplitude=${amp}:sample_rate=${c.sr}:seed=${seed}`;
        return { graph: (inL, outL) => `${src}[nz${c.uid}];[${inL}][nz${c.uid}]amix=inputs=2:duration=first:normalize=0[${outL}]` };
      },
    },
    dropouts: {
      name: 'Signal dropouts',
      cat: 'signal',
      desc: 'The signal randomly cuts out for a moment, like a weak radio or a bad phone line.',
      params: [R('rate', 'How often', 0.05, 5, 0.5, 'per s', { log: true }), MS('length', 'Length', 10, 1000, 120, { step: 1 }), DB('depth', 'Level during dropout', -60, 0, -60)],
      presets: [['Occasional', { rate: 0.2, length: 80, depth: -40 }], ['Weak signal', { rate: 0.8, length: 150, depth: -60 }], ['Breaking up', { rate: 2.5, length: 60, depth: -60 }]],
      build(p, c) {
        // Fixed 1024-sample blocks, so "how often" doesn't depend on the decoder's frame size.
        const chance = clamp((p.rate * 1024) / c.sr, 0, 0.9);
        const L = f(lin(p.depth));
        return `asetnsamples=n=1024:p=0,volume=eval=frame:volume='if(lt(t,ld(0)),${L},if(lt(random(1),${f(chance)}),st(0,t+${f(p.length / 1000)})*0+${L},1))'`;
      },
    },
    squelch: {
      name: 'Squelch burst',
      cat: 'signal',
      desc: 'The "kssh" of static when a radio transmission starts or ends (push-to-talk).',
      params: [SEL('where', 'When', [['end', 'End of transmission'], ['start', 'Start'], ['both', 'Start and end']]), MS('length', 'Length', 50, 800, 220, { step: 1 }), DB('level', 'Level', -40, 0, -14)],
      build(p, c) {
        const len = p.length / 1000;
        const burst = (tag, d) => `anoisesrc=c=white:a=${f(clamp(lin(p.level), 0, 1))}:r=${c.sr}:d=${f(d)}:seed=${c.uid * 31 + tag.length},highpass=f=300,lowpass=f=3200,afade=t=out:st=${f(d * 0.6)}:d=${f(d * 0.4)}`;
        const parts = [];
        const labels = [];
        if (p.where !== 'end') {
          parts.push(`${burst('a', len * 0.6)}[sqa${c.uid}]`);
          labels.push(`[sqa${c.uid}]`);
        }
        if (p.where !== 'start' && c.dur) {
          parts.push(`${burst('bb', len)},adelay=${Math.round(c.dur * 1000)}:all=1[sqb${c.uid}]`);
          labels.push(`[sqb${c.uid}]`);
        }
        if (!labels.length) return 'anull';
        return { graph: (inL, outL) => `${parts.join(';')};[${inL}]${labels.join('')}amix=inputs=${labels.length + 1}:duration=longest:normalize=0[${outL}]` };
      },
    },

    reverb: {
      name: 'Reverb',
      cat: 'space',
      desc: 'Puts the sound in a room, from a small booth to a cathedral (convolution with a synthetic room response).',
      params: [R('decay', 'Decay time', 0.1, 10, 1.5, 's', { log: true }), MS('predelay', 'Pre-delay', 0, 250, 20, { log: false, step: 1 }), HZ('damp', 'Brightness', 500, 16000, 6000, { hint: 'Lower = darker, more absorbent room' }), PCT('mix', 'Mix', 30)],
      presets: [
        ['Small room', { decay: 0.5, predelay: 5, damp: 5000, mix: 25 }],
        ['Bathroom (tiled)', { decay: 1.1, predelay: 3, damp: 9000, mix: 35 }],
        ['Concert hall', { decay: 2.4, predelay: 30, damp: 5000, mix: 30 }],
        ['Cathedral', { decay: 6, predelay: 60, damp: 3500, mix: 45 }],
        ['Huge & dark', { decay: 9, predelay: 90, damp: 1500, mix: 55 }],
      ],
      tail: (p) => p.decay * 1.2 + p.predelay / 1000,
      build(p, c) {
        const u = c.uid;
        // The IR is noise fading exponentially to -100 dB, so -60 dB (RT60) is reached at 60% of its length.
        const D = p.decay / 0.6;
        const damp = clamp(p.damp, 200, c.sr * 0.45);
        const noise = (seed) => `anoisesrc=d=${f(D)}:c=white:a=1:r=${c.sr}:seed=${seed}`;
        const ir = c.ch === 1 ? noise(u * 101) : `${noise(u * 101)}[ia${u}];${noise(u * 101 + 1)}[ib${u}];[ia${u}][ib${u}]join=inputs=2:channel_layout=stereo`;
        // afir peak-normalizes the IR, so its loudness falls with length and darkness; this brings it back to about the dry level.
        const comp = 31.6 + 10 * Math.log10(D) + 10 * Math.log10(6000 / damp);
        const m = p.mix / 100;
        const dry = Math.cos((m * Math.PI) / 2);
        const wet = Math.sin((m * Math.PI) / 2);
        const pre = p.predelay >= 1 ? `,adelay=${Math.round(p.predelay)}:all=1` : '';
        return {
          graph: (inL, outL) =>
            `${ir},afade=t=out:st=0:d=${f(D)}:curve=exp,lowpass=f=${Math.round(damp)}${pre}[ir${u}];` +
            `[${inL}]asplit=2[rd${u}][rw${u}];[rw${u}][ir${u}]afir,volume=${f(comp)}dB[rr${u}];` +
            `[rd${u}][rr${u}]amix=inputs=2:duration=first:normalize=0:weights='${f(dry)} ${f(wet)}'[${outL}]`,
        };
      },
    },
    echo: {
      name: 'Echo / delay',
      cat: 'space',
      desc: 'Repeats of the sound, each quieter than the last.',
      params: [MS('delay', 'Delay', 20, 2000, 300, { step: 1 }), PCT('feedback', 'Feedback', 40, { max: 90, hint: 'How much quieter each repeat gets' }), R('repeats', 'Repeats', 1, 12, 4, '', { step: 1 }), PCT('mix', 'Mix', 50)],
      presets: [['Slapback', { delay: 90, feedback: 0, repeats: 1, mix: 45 }], ['Stadium', { delay: 260, feedback: 35, repeats: 3, mix: 35 }], ['Canyon', { delay: 650, feedback: 55, repeats: 6, mix: 55 }], ['Dub', { delay: 375, feedback: 70, repeats: 10, mix: 50 }]],
      tail: (p) => (p.delay * Math.round(p.repeats)) / 1000 + 0.1,
      build(p) {
        const n = Math.max(1, Math.round(p.repeats));
        const fb = p.feedback / 100;
        const delays = [];
        const decays = [];
        for (let k = 1; k <= n; k++) {
          delays.push(f(p.delay * k));
          decays.push(f(clamp((p.mix / 100) * Math.pow(fb, k - 1), 0.001, 1)));
        }
        const sum = decays.reduce((a, d) => a + Number(d), 0);
        return `aecho=1:${f(Math.min(1, 1 / (1 + sum * 0.25)))}:${delays.join('|')}:${decays.join('|')}`;
      },
    },

    chorus: {
      name: 'Chorus',
      cat: 'mod',
      desc: 'Detuned copies of the sound — thicker, shimmering, a bit seasick at high depth.',
      params: [R('voices', 'Voices', 1, 4, 2, '', { step: 1 }), MS('delay', 'Delay', 10, 60, 40, { log: false, step: 1 }), MS('depth', 'Depth', 0.5, 10, 2.5), R('speed', 'Speed', 0.05, 5, 0.6, 'Hz', { log: true }), PCT('mix', 'Mix', 50)],
      presets: [['Subtle', { voices: 2, delay: 30, depth: 1.5, speed: 0.4, mix: 35 }], ['Lush', { voices: 3, delay: 40, depth: 3, speed: 0.7, mix: 55 }], ['Seasick', { voices: 2, delay: 50, depth: 8, speed: 2.5, mix: 70 }]],
      build(p) {
        const m = p.mix / 100;
        const n = Math.max(1, Math.round(p.voices));
        const d = [];
        const dec = [];
        const sp = [];
        const dep = [];
        for (let i = 0; i < n; i++) {
          d.push(f(p.delay * (1 + 0.17 * i)));
          dec.push(f(clamp(m * (1 - 0.12 * i), 0.01, 1)));
          sp.push(f(clamp(p.speed * (1 + 0.31 * i), 0.01, 90)));
          dep.push(f(p.depth * (1 + 0.13 * i)));
        }
        const inG = 1 - m * 0.4;
        const sum = inG + dec.reduce((a, x) => a + Number(x), 0) * 0.6;
        return `chorus=${f(inG)}:${f(Math.min(1, 1 / sum))}:${d.join('|')}:${dec.join('|')}:${sp.join('|')}:${dep.join('|')}`;
      },
    },
    flanger: {
      name: 'Flanger',
      cat: 'mod',
      desc: 'The sweeping jet-plane whoosh.',
      params: [MS('delay', 'Delay', 0, 30, 2, { log: false }), MS('depth', 'Depth', 0, 10, 3, { log: false }), R('regen', 'Feedback', -95, 95, 30, '%', { step: 1 }), R('speed', 'Speed', 0.1, 10, 0.4, 'Hz', { log: true }), PCT('width', 'Mix', 71), SEL('shape', 'Shape', [['sinusoidal', 'Sine'], ['triangular', 'Triangle']])],
      presets: [['Jet', { delay: 1, depth: 6, regen: 70, speed: 0.15, width: 71, shape: 'sinusoidal' }], ['Metallic', { delay: 0.5, depth: 1, regen: 85, speed: 3, width: 80, shape: 'triangular' }]],
      build: (p) => `flanger=delay=${f(p.delay)}:depth=${f(p.depth)}:regen=${f(p.regen)}:width=${f(p.width)}:speed=${f(p.speed)}:shape=${p.shape}`,
    },
    phaser: {
      name: 'Phaser',
      cat: 'mod',
      desc: 'A swirling, hollow sweep.',
      params: [R('speed', 'Speed', 0.1, 2, 0.5, 'Hz', { log: true }), PCT('decay', 'Feedback', 50, { max: 95 }), MS('delay', 'Delay', 0.5, 5, 3, { log: false }), SEL('type', 'Shape', [['t', 'Triangle'], ['s', 'Sine']])],
      build(p) {
        const d = clamp(p.decay / 100, 0, 0.99);
        // ffmpeg's default gains (0.4 / 0.74) lose ~8 dB; these keep it near the dry level.
        return `aphaser=in_gain=0.7:out_gain=${f(0.95 * (1 - 0.4 * d))}:delay=${f(p.delay)}:decay=${f(d)}:speed=${f(p.speed)}:type=${p.type}`;
      },
    },
    tremolo: {
      name: 'Tremolo',
      cat: 'mod',
      desc: 'The volume pulses up and down.',
      params: [R('rate', 'Rate', 0.1, 30, 5, 'Hz', { log: true }), PCT('depth', 'Depth', 50)],
      build: (p) => `tremolo=f=${f(p.rate)}:d=${f(clamp(p.depth / 100, 0.01, 1))}`,
    },
    vibrato: {
      name: 'Vibrato',
      cat: 'mod',
      desc: 'The pitch wobbles up and down.',
      params: [R('rate', 'Rate', 0.1, 20, 5, 'Hz', { log: true }), PCT('depth', 'Depth', 30)],
      build: (p) => `vibrato=f=${f(p.rate)}:d=${f(clamp(p.depth / 100, 0.01, 1))}`,
    },
    wow: {
      name: 'Wow & flutter',
      cat: 'mod',
      desc: 'The slow pitch drift and fast warble of a worn tape machine or turntable.',
      params: [PCT('wow', 'Wow (slow drift)', 30), PCT('flutter', 'Flutter (fast warble)', 20)],
      presets: [['Slightly worn', { wow: 20, flutter: 10 }], ['Old cassette', { wow: 50, flutter: 35 }], ['Melted', { wow: 100, flutter: 60 }]],
      build(p) {
        const parts = [];
        if (p.wow > 0) parts.push(`vibrato=f=0.55:d=${f(clamp(p.wow / 100, 0.01, 1))}`);
        if (p.flutter > 0) parts.push(`vibrato=f=9:d=${f(clamp((p.flutter / 100) * 0.12, 0.01, 1))}`);
        return parts.join(',') || 'anull';
      },
    },
    ringmod: {
      name: 'Ring modulator',
      cat: 'mod',
      desc: 'Multiplies the sound by a sine wave: robotic, metallic, alien. Low frequencies (30–80 Hz) give the classic robot voice.',
      params: [HZ('freq', 'Frequency', 5, 2000, 60), PCT('mix', 'Mix', 100)],
      presets: [['Robot', { freq: 50, mix: 100 }], ['Dalek-ish', { freq: 30, mix: 100 }], ['Alien', { freq: 420, mix: 60 }]],
      build: (p) => {
        const m = p.mix / 100;
        const k = 1 / (1 - m + m * Math.SQRT1_2); // a sine carrier halves the power; make that back up
        return `aeval=exprs='val(ch)*(${f(k * (1 - m))}+${f(k * m)}*sin(2*PI*${f(p.freq)}*t))':c=same`;
      },
    },

    pitch: {
      name: 'Pitch shift',
      cat: 'pitch',
      desc: 'Higher or lower voice. Untick "Keep speed" for the tape-speed effect (pitch and speed change together).',
      params: [R('semis', 'Semitones', -24, 24, 0, 'st', { step: 0.5 }), CHK('keep', 'Keep speed', true)],
      presets: [['Chipmunk', { semis: 7, keep: true }], ['Deep', { semis: -5, keep: true }], ['Monster', { semis: -9, keep: true }], ['Tape slowdown', { semis: -4, keep: false }]],
      speed: (p) => (p.keep || !p.semis ? 1 : 1 / Math.pow(2, p.semis / 12)),
      build(p, c) {
        if (!p.semis) return 'anull';
        const rate = Math.round(c.sr * Math.pow(2, p.semis / 12));
        const r = rate / c.sr;
        return `asetrate=${rate},aresample=${c.sr}${p.keep ? ',' + atempo(1 / r) : ''}`;
      },
    },
    tempo: {
      name: 'Speed',
      cat: 'pitch',
      desc: 'Faster or slower without changing the pitch.',
      params: [R('speed', 'Speed', 0.25, 4, 1, '×', { log: true })],
      speed: (p) => 1 / p.speed,
      build: (p) => (Math.abs(p.speed - 1) < 1e-6 ? 'anull' : atempo(p.speed)),
    },
    reverse: {
      name: 'Reverse',
      cat: 'pitch',
      desc: 'Plays backwards. For the ghostly "reverse reverb" swell: Reverse → Reverb → Reverse.',
      params: [],
      reverses: true,
      build(p, c) {
        // The end padding is now at the front, so give the tails of the effects up to the next Reverse new room.
        return c.tailAfter > 0 ? `areverse,apad=pad_dur=${f(c.tailAfter)}` : 'areverse';
      },
    },

    mono: {
      name: 'Mono',
      cat: 'util',
      desc: 'Mixes down to one channel. Radios, phones and intercoms are mono.',
      params: [CHK('keep2', 'Keep two channels (same sound in both)')],
      channels: (p) => (p.keep2 ? 2 : 1),
      build: (p) => `aformat=channel_layouts=mono${p.keep2 ? ',aformat=channel_layouts=stereo' : ''}`,
    },
    width: {
      name: 'Stereo width',
      cat: 'util',
      desc: 'Narrows (below 100%) or exaggerates (above 100%) the stereo spread.',
      params: [R('width', 'Width', 0, 300, 150, '%', { step: 1 })],
      build(p, c) {
        if (c.ch !== 2) throw new Error('Stereo width needs stereo audio — the input is mono, or a Mono effect comes before it');
        return `extrastereo=m=${f(p.width / 100)}`;
      },
    },
  };

  // ---------------------------------------------------------------- chain presets

  // [type, params (missing ones use defaults), enabled?]
  const PRESETS = [
    {
      id: 'atc',
      group: 'Radio & comms',
      name: '✈ Airport tower radio (ATC)',
      desc: 'AM aviation radio as heard on tower recordings: narrow band, crushed dynamics, gritty, hissy, with a squelch at the end of each transmission.',
      chain: [
        ['mono', {}],
        ['noise', { color: 'white', level: -44 }],
        ['bandpass', { low: 350, high: 2800, slope: '36' }],
        ['compressor', { threshold: -32, ratio: 12, attack: 1, release: 60, makeup: 18, knee: 2 }],
        ['distortion', { type: 'tanh', drive: 14, output: -9, mix: 100 }],
        ['eq', { freq: 1700, gain: 5, q: 1.2 }],
        ['resample', { rate: '8000' }],
        ['bitcrush', { bits: 10, samples: 1, mode: 'log', mix: 50 }],
        ['dropouts', { rate: 0.15, length: 70, depth: -30 }],
        ['squelch', { where: 'end', length: 220, level: -16 }],
        ['limiter', { gain: 0, ceiling: -1, release: 50 }],
      ],
    },
    {
      id: 'atc-weak',
      group: 'Radio & comms',
      name: '✈ ATC — distant aircraft (weak signal)',
      desc: 'The far-away pilot: buried in static, breaking up, more distorted.',
      chain: [
        ['mono', {}],
        ['noise', { color: 'white', level: -30 }],
        ['bandpass', { low: 450, high: 2400, slope: '36' }],
        ['compressor', { threshold: -36, ratio: 16, attack: 0.5, release: 80, makeup: 20, knee: 1.5 }],
        ['distortion', { type: 'hard', drive: 20, output: -14, mix: 100 }],
        ['eq', { freq: 1500, gain: 6, q: 1.5 }],
        ['resample', { rate: '6000' }],
        ['bitcrush', { bits: 7, samples: 1, mode: 'log', mix: 70 }],
        ['dropouts', { rate: 0.7, length: 140, depth: -50 }],
        ['squelch', { where: 'both', length: 300, level: -10 }],
        ['limiter', { gain: 2, ceiling: -1, release: 50 }],
      ],
    },
    {
      id: 'atc-cockpit',
      group: 'Radio & comms',
      name: '✈ Cockpit intercom / headset',
      desc: 'Pilot-to-pilot over the intercom: engine drone under a boxy, compressed headset mic.',
      chain: [
        ['mono', {}],
        ['noise', { color: 'brown', level: -30 }],
        ['bandpass', { low: 300, high: 3600, slope: '24' }],
        ['compressor', { threshold: -28, ratio: 8, attack: 2, release: 100, makeup: 12, knee: 2.8 }],
        ['distortion', { type: 'atan', drive: 8, output: -5, mix: 100 }],
        ['eq', { freq: 1200, gain: 4, q: 1 }],
        ['limiter', { gain: 0, ceiling: -1, release: 50 }],
      ],
    },
    {
      id: 'space',
      group: 'Radio & comms',
      name: 'Space mission radio',
      desc: 'Apollo-era air-to-ground: thin, hissy, compressed, with squelch bursts.',
      chain: [
        ['mono', {}],
        ['noise', { color: 'pink', level: -34 }],
        ['bandpass', { low: 300, high: 3000, slope: '24' }],
        ['compressor', { threshold: -30, ratio: 10, attack: 1, release: 90, makeup: 15, knee: 2 }],
        ['distortion', { type: 'tanh', drive: 10, output: -6, mix: 100 }],
        ['resample', { rate: '8000' }],
        ['squelch', { where: 'both', length: 260, level: -14 }],
        ['limiter', {}],
      ],
    },
    {
      id: 'walkie',
      group: 'Radio & comms',
      name: 'Walkie-talkie / CB',
      desc: 'Cheap handheld radio: very narrow, harshly clipped, squelch on release.',
      chain: [
        ['mono', {}],
        ['bandpass', { low: 500, high: 2500, slope: '36' }],
        ['compressor', { threshold: -30, ratio: 12, attack: 1, release: 60, makeup: 16, knee: 2 }],
        ['distortion', { type: 'hard', drive: 22, output: -14, mix: 100 }],
        ['noise', { color: 'white', level: -40 }],
        ['squelch', { where: 'end', length: 180, level: -12 }],
        ['limiter', {}],
      ],
    },
    {
      id: 'phone',
      group: 'Radio & comms',
      name: 'Telephone (landline)',
      desc: 'Classic phone line: 300–3400 Hz at 8 kHz.',
      chain: [
        ['mono', {}],
        ['bandpass', { low: 300, high: 3400, slope: '24' }],
        ['compressor', { threshold: -22, ratio: 4, attack: 5, release: 120, makeup: 6, knee: 2.8 }],
        ['eq', { freq: 2000, gain: 4, q: 1 }],
        ['resample', { rate: '8000' }],
        ['bitcrush', { bits: 8, samples: 1, mode: 'log', mix: 100 }],
        ['limiter', {}],
      ],
    },
    {
      id: 'cell',
      group: 'Radio & comms',
      name: 'Bad cell connection',
      desc: 'Low-bitrate digital voice that keeps breaking up.',
      chain: [
        ['mono', {}],
        ['bandpass', { low: 300, high: 3400, slope: '24' }],
        ['resample', { rate: '8000' }],
        ['bitcrush', { bits: 6, samples: 2, mode: 'log', mix: 80 }],
        ['dropouts', { rate: 2, length: 70, depth: -60 }],
        ['compressor', { threshold: -24, ratio: 6, attack: 3, release: 100, makeup: 8, knee: 2.8 }],
        ['limiter', {}],
      ],
    },
    {
      id: 'megaphone',
      group: 'Radio & comms',
      name: 'Megaphone / bullhorn',
      desc: 'Shouty horn speaker, honky and distorted, with a bit of street echo.',
      chain: [
        ['mono', {}],
        ['bandpass', { low: 600, high: 4000, slope: '24' }],
        ['eq', { freq: 1500, gain: 8, q: 1.2 }],
        ['distortion', { type: 'tanh', drive: 20, output: -12, mix: 100 }],
        ['echo', { delay: 140, feedback: 20, repeats: 2, mix: 25 }],
        ['limiter', {}],
      ],
    },

    {
      id: 'am1940',
      group: 'Vintage',
      name: '1940s AM radio',
      desc: 'Warm, narrow broadcast through a valve set, with crackle and a little drift.',
      chain: [
        ['mono', {}],
        ['bandpass', { low: 200, high: 4000, slope: '24' }],
        ['compressor', { threshold: -24, ratio: 4, attack: 10, release: 200, makeup: 6, knee: 4 }],
        ['distortion', { type: 'atan', drive: 8, output: -5, mix: 100 }],
        ['noise', { color: 'velvet', level: -28, density: 0.004 }],
        ['noise', { color: 'pink', level: -46 }],
        ['wow', { wow: 25, flutter: 0 }],
        ['limiter', {}],
      ],
    },
    {
      id: 'vinyl',
      group: 'Vintage',
      name: 'Old vinyl record',
      desc: 'Surface crackle, hiss, rolled-off highs and a slow wobble.',
      chain: [
        ['lowpass', { freq: 9000, slope: '12' }],
        ['tone', { bass: 2, bassF: 120, treble: -2, trebleF: 6000 }],
        ['wow', { wow: 20, flutter: 8 }],
        ['noise', { color: 'velvet', level: -24, density: 0.003 }],
        ['noise', { color: 'pink', level: -52 }],
      ],
    },
    {
      id: 'gramophone',
      group: 'Vintage',
      name: '1920s gramophone',
      desc: 'Acoustic horn playback: very boxy, honky and noisy.',
      chain: [
        ['mono', {}],
        ['bandpass', { low: 350, high: 3200, slope: '36' }],
        ['eq', { freq: 1200, gain: 7, q: 1.2 }],
        ['distortion', { type: 'atan', drive: 6, output: -3, mix: 100 }],
        ['wow', { wow: 45, flutter: 15 }],
        ['noise', { color: 'velvet', level: -20, density: 0.008 }],
        ['noise', { color: 'white', level: -40 }],
      ],
    },
    {
      id: 'cassette',
      group: 'Vintage',
      name: 'Worn cassette / VHS',
      desc: 'Dull, saturated, warbly tape with hiss.',
      chain: [
        ['lowpass', { freq: 7000, slope: '12' }],
        ['distortion', { type: 'atan', drive: 6, output: -3, mix: 100 }],
        ['wow', { wow: 50, flutter: 35 }],
        ['noise', { color: 'white', level: -46 }],
        ['tone', { bass: 3, bassF: 100, treble: -2, trebleF: 5000 }],
      ],
    },

    {
      id: 'room',
      group: 'Spaces',
      name: 'Small room',
      desc: 'A natural, close room sound.',
      chain: [['reverb', { decay: 0.5, predelay: 5, damp: 5000, mix: 25 }]],
    },
    {
      id: 'hall',
      group: 'Spaces',
      name: 'Concert hall',
      desc: 'A big, smooth hall.',
      chain: [['reverb', { decay: 2.4, predelay: 30, damp: 5000, mix: 30 }]],
    },
    {
      id: 'cathedral',
      group: 'Spaces',
      name: 'Cathedral',
      desc: 'Stone walls and a very long, dark tail.',
      chain: [['reverb', { decay: 6, predelay: 60, damp: 3500, mix: 45 }]],
    },
    {
      id: 'stadium',
      group: 'Spaces',
      name: 'Stadium PA',
      desc: 'Announcer over horn speakers, bouncing around the stands.',
      chain: [
        ['bandpass', { low: 250, high: 5000, slope: '24' }],
        ['compressor', { threshold: -24, ratio: 6, attack: 3, release: 150, makeup: 8, knee: 2.8 }],
        ['echo', { delay: 260, feedback: 35, repeats: 3, mix: 35 }],
        ['reverb', { decay: 3, predelay: 40, damp: 4000, mix: 35 }],
        ['limiter', {}],
      ],
    },
    {
      id: 'wall',
      group: 'Spaces',
      name: 'Through the wall (next door)',
      desc: 'Muffled and boomy, as if from the next room.',
      chain: [
        ['lowpass', { freq: 380, slope: '36' }],
        ['reverb', { decay: 0.6, predelay: 5, damp: 1500, mix: 25 }],
        ['gain', { gain: -4 }],
      ],
    },
    {
      id: 'underwater',
      group: 'Spaces',
      name: 'Underwater',
      desc: 'Deep muffle, wobbling pitch, swimmy reflections.',
      chain: [
        ['lowpass', { freq: 550, slope: '24' }],
        ['vibrato', { rate: 0.8, depth: 40 }],
        ['chorus', { voices: 3, delay: 40, depth: 4, speed: 0.4, mix: 50 }],
        ['reverb', { decay: 1.6, predelay: 10, damp: 1200, mix: 40 }],
      ],
    },

    {
      id: 'robot',
      group: 'Characters & FX',
      name: 'Robot',
      desc: 'Ring-modulated, crushed and metallic.',
      chain: [
        ['ringmod', { freq: 50, mix: 100 }],
        ['bitcrush', { bits: 8, samples: 2, mode: 'lin', mix: 50 }],
        ['flanger', { delay: 0.5, depth: 1, regen: 85, speed: 3, width: 60, shape: 'triangular' }],
        ['compressor', { threshold: -24, ratio: 6, attack: 3, release: 100, makeup: 8, knee: 2.8 }],
        ['limiter', {}],
      ],
    },
    {
      id: 'alien',
      group: 'Characters & FX',
      name: 'Alien transmission',
      desc: 'A signal from somewhere else: ring-modulated, phased, echoing through static.',
      chain: [
        ['pitch', { semis: -3, keep: true }],
        ['ringmod', { freq: 420, mix: 55 }],
        ['phaser', { speed: 0.3, decay: 60, delay: 3, type: 's' }],
        ['echo', { delay: 420, feedback: 50, repeats: 5, mix: 40 }],
        ['noise', { color: 'violet', level: -42 }],
        ['gain', { gain: 5 }],
        ['limiter', {}],
      ],
    },
    {
      id: 'monster',
      group: 'Characters & FX',
      name: 'Monster',
      desc: 'Pitched way down, gritty, in a cave.',
      chain: [
        ['pitch', { semis: -9, keep: true }],
        ['distortion', { type: 'tanh', drive: 10, output: -6, mix: 60 }],
        ['tone', { bass: 6, bassF: 150, treble: -3, trebleF: 4000 }],
        ['reverb', { decay: 2, predelay: 20, damp: 2500, mix: 30 }],
        ['limiter', {}],
      ],
    },
    {
      id: 'chipmunk',
      group: 'Characters & FX',
      name: 'Chipmunk',
      desc: 'Squeaky high voice at the same speed.',
      chain: [['pitch', { semis: 8, keep: true }]],
    },
    {
      id: 'ghost',
      group: 'Characters & FX',
      name: 'Ghostly reverse reverb',
      desc: 'Each word is preceded by a sucking swell of its own reverb.',
      chain: [['reverse', {}], ['reverb', { decay: 2.5, predelay: 0, damp: 4000, mix: 60 }], ['reverse', {}], ['reverb', { decay: 1.2, predelay: 10, damp: 4000, mix: 20 }]],
    },

    {
      id: 'lofi',
      group: 'Music',
      name: 'Lo-fi beat',
      desc: 'Dusty, warm and slightly wobbly.',
      chain: [
        ['lowpass', { freq: 6000, slope: '12' }],
        ['bitcrush', { bits: 12, samples: 1, mode: 'log', mix: 60 }],
        ['wow', { wow: 20, flutter: 6 }],
        ['compressor', { threshold: -18, ratio: 3, attack: 15, release: 200, makeup: 4, knee: 4 }],
        ['noise', { color: 'velvet', level: -32, density: 0.003 }],
      ],
    },
    {
      id: '8bit',
      group: 'Music',
      name: '8-bit console',
      desc: 'Aliased, crushed chip-tune grit.',
      chain: [
        ['mono', { keep2: true }],
        ['bitcrush', { bits: 5, samples: 4, mode: 'lin', mix: 100 }],
        ['resample', { rate: '11025', alias: true }],
        ['limiter', {}],
      ],
    },
    {
      id: 'dreamy',
      group: 'Music',
      name: 'Dreamy wash',
      desc: 'Chorus into echo into a big hall.',
      chain: [
        ['chorus', { voices: 3, delay: 40, depth: 3, speed: 0.5, mix: 50 }],
        ['echo', { delay: 380, feedback: 45, repeats: 5, mix: 35 }],
        ['reverb', { decay: 4, predelay: 30, damp: 6000, mix: 45 }],
        ['limiter', {}],
      ],
    },
    {
      id: 'dub',
      group: 'Music',
      name: 'Dub echo',
      desc: 'Long, filtered, repeating echoes.',
      chain: [
        ['echo', { delay: 375, feedback: 70, repeats: 10, mix: 50 }],
        ['highpass', { freq: 150, slope: '12', q: 0.71 }],
        ['reverb', { decay: 0.8, predelay: 5, damp: 4000, mix: 20 }],
        ['limiter', {}],
      ],
    },
  ];

  // ---------------------------------------------------------------- params + chains

  function defaults(type) {
    const out = {};
    for (const p of EFFECTS[type].params) out[p.key] = p.def;
    return out;
  }

  /** Validates/coerces one effect's params; unknown keys dropped, missing ones defaulted. */
  function cleanParams(type, raw) {
    const def = EFFECTS[type];
    const out = {};
    for (const p of def.params) {
      let v = raw && raw[p.key] !== undefined && raw[p.key] !== '' ? raw[p.key] : p.def;
      if (p.type === 'range') {
        v = Number(v);
        if (!Number.isFinite(v)) throw new Error(`${def.name}: ${p.label} must be a number`);
        v = clamp(v, p.min, p.max);
      } else if (p.type === 'select') {
        v = String(v);
        if (!p.opts.some(([k]) => k === v)) v = p.def;
      } else {
        v = !!v;
      }
      out[p.key] = v;
    }
    return out;
  }

  let seq = 0;
  const newId = () => `fx${Date.now().toString(36)}${(++seq).toString(36)}`;

  /** A chain item as stored in the UI. */
  function item(type, params, on = true) {
    return { id: newId(), type, on, open: true, p: { ...defaults(type), ...(params || {}) } };
  }

  function fromPreset(preset) {
    return preset.chain.filter(([t]) => EFFECTS[t]).map(([t, p, on]) => ({ ...item(t, p, on !== false), open: false }));
  }

  /**
   * Turns a chain into a filter_complex graph from `[input]` to `[aout]`.
   * env: { sr, ch, dur (content seconds or null), tails (pad so tails ring out), limiter, input }
   */
  function build(chain, env) {
    const list = (Array.isArray(chain) ? chain : []).filter((e) => e && e.on !== false && EFFECTS[e.type]);
    if (!list.length) throw new Error('Add at least one effect (or switch one back on)');
    const items = list.map((e) => ({ type: e.type, def: EFFECTS[e.type], p: cleanParams(e.type, e.p) }));
    const tails = items.map((x) => (x.def.tail ? x.def.tail(x.p) : 0));
    const totalTail = env.tails ? tails.reduce((a, b) => a + b, 0) : 0;

    const segs = [];
    let pending = [];
    let cur = env.input || '0:a:0';
    let n = 0;
    const notes = [];
    let sr = env.sr || 48000;
    let ch = env.ch || 2;
    let mult = 1;
    let dur = env.dur || null;

    if (ch > 2) {
      pending.push('aformat=channel_layouts=stereo');
      ch = 2;
      notes.push('Surround audio is mixed down to stereo.');
    }
    // Room for tails at the end; effects after a Reverse get theirs from that Reverse instead.
    const firstRev = items.findIndex((x) => x.def.reverses);
    const leadPad = env.tails ? tails.slice(0, firstRev < 0 ? items.length : firstRev).reduce((a, b) => a + b, 0) : 0;
    if (leadPad > 0) pending.push(`apad=pad_dur=${f(leadPad)}`);

    /** Tails of the effects after i, up to the next Reverse (which flips where the room is needed). */
    const tailUntilReverse = (i) => {
      let t = 0;
      for (let j = i + 1; j < items.length && !items[j].def.reverses; j++) t += tails[j];
      return t;
    };

    items.forEach((x, i) => {
      const ctx = { sr, ch, uid: i + 1, dur, tailAfter: env.tails ? tailUntilReverse(i) : 0 };
      let out;
      try {
        out = x.def.build(x.p, ctx);
      } catch (e) {
        throw new Error(e.message.startsWith(x.def.name) ? e.message : `${x.def.name}: ${e.message}`);
      }
      if (typeof out === 'string') {
        if (out !== 'anull') pending.push(out);
      } else {
        const inL = `s${n}`;
        segs.push(`[${cur}]${pending.join(',') || 'anull'}[${inL}]`);
        pending = [];
        const outL = `s${++n}`;
        segs.push(out.graph(inL, outL));
        n++;
        cur = outL;
      }
      if (x.def.channels) ch = x.def.channels(x.p, ch);
      if (x.def.speed) {
        const k = x.def.speed(x.p);
        mult *= k;
        if (dur) dur *= k;
      }
    });
    if (env.limiter) pending.push('alimiter=limit=0.97:attack=3:release=40:level=0');
    segs.push(`[${cur}]${pending.join(',') || 'anull'}[aout]`);

    return { graph: segs.join(';'), tail: totalTail, mult, count: items.length, notes };
  }

  return { EFFECTS, CATEGORIES, PRESETS, defaults, cleanParams, item, fromPreset, build };
});
