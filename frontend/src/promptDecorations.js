// Which parts of a prompt the user typed, and which parts the studio put there.
//
// The generation modal used to answer that question with a second, read-only
// "effective prompt" box underneath the editor: you wrote in one field and read
// the real prompt in another. It showed the truth but you could not touch it —
// the pre/post prompt could not be turned off for one shot, and an inserted
// snippet was indistinguishable from your own words the moment it landed.
//
// So the composed prompt is now the editable field, and the inserted parts are
// marked *in place*. A decoration is a half-open range [start, end) over the
// prompt text plus what put it there:
//
//   { id, kind: 'snippet' | 'affix', start, end, label }
//
// Everything here is pure string maths so it can be tested without a DOM; the
// component in PromptEditor.jsx owns the pixels.
//
// The one rule that governs all of it: a decoration is a claim that the studio
// wrote this text, and the moment the user edits inside one the claim is false.
// Rather than trying to patch a range around someone's typing — which produces
// half-highlighted words and an 'x' that deletes the wrong thing — an edit that
// lands inside a decoration simply dissolves it into ordinary text. That is
// also exactly the behaviour asked for when you click into a block to edit it.

let counter = 0;
const nextId = () => `dec_${Date.now().toString(36)}_${(counter++).toString(36)}`;

const clamp = (value, max) => Math.max(0, Math.min(max, value));

/** Decorations sorted by position, with anything degenerate discarded. */
function tidy(decorations, textLength) {
  return (decorations || [])
    .map(d => ({ ...d, start: clamp(d.start, textLength), end: clamp(d.end, textLength) }))
    .filter(d => d.end > d.start)
    .sort((a, b) => a.start - b.start);
}

/**
 * Move decorations across an arbitrary edit to the text.
 *
 * The edit is located by the longest common prefix and suffix, which is all a
 * textarea's onChange gives us. Ranges wholly before it are untouched, ranges
 * wholly after it shift, and a range the edit reached into is dropped.
 */
export function remapDecorations(decorations, oldText, newText) {
  if (oldText === newText) return tidy(decorations, newText.length);

  const shortest = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < shortest && oldText[prefix] === newText[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < shortest - prefix
    && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) suffix++;

  const changedEnd = oldText.length - suffix; // end of the edited region, in old coordinates
  const delta = newText.length - oldText.length;

  const moved = [];
  tidy(decorations, oldText.length).forEach(d => {
    if (d.end <= prefix) moved.push(d);
    else if (d.start >= changedEnd) moved.push({ ...d, start: d.start + delta, end: d.end + delta });
    // else: the user edited inside it — it is their text now.
  });
  return tidy(moved, newText.length);
}

/**
 * Insert text at the caret (replacing the selection, if there is one) and mark
 * the result as inserted.
 *
 * The separator is part of the decoration rather than of the surrounding text,
 * so removing the block later takes its comma with it instead of leaving the
 * prompt with a dangling ", ,".
 */
export function insertIntoPrompt(text, decorations, selection, insertText, options = {}) {
  // `decorate: false` inserts without claiming the text. Asset tags go in that
  // way: a <Tag> is highlighted wherever it appears, typed or inserted, so
  // marking it as inserted as well would put two claims on the same characters.
  const { kind = 'snippet', label = '', joiner = ', ', decorate = true } = options;
  const source = String(text || '');
  const value = String(insertText || '').trim();
  if (!value) return { text: source, decorations: tidy(decorations, source.length), cursor: source.length };

  const start = clamp(selection?.start ?? source.length, source.length);
  const end = clamp(Math.max(selection?.end ?? start, start), source.length);

  const before = source.slice(0, start);
  const after = source.slice(end);

  // Only bridge a gap that needs bridging, and bridge it with the least that
  // will do. Three outcomes: nothing where the text already runs on cleanly, a
  // bare space where there is punctuation but no gap, and the full joiner
  // otherwise. Both sides of the seam matter — a post-prompt is conventionally
  // written starting with its own comma (", 35mm, shallow focus"), and looking
  // only at the text before it yields ", , 35mm".
  const lead = before.trim() === '' || /\s$/.test(before) || /^[,;:.]/.test(value) ? ''
    : /[,;:.(-]$/.test(before) ? ' '
      : joiner;
  const trail = after.trim() === '' || /^[\s,;:.)]/.test(after) ? ''
    : /[,;:.(-]$/.test(value) ? ' '
      : joiner;

  const block = lead + value;
  const inserted = block + trail;
  const nextText = before + inserted + after;

  const blockStart = start + 0;
  const blockEnd = start + block.length;
  const delta = inserted.length - (end - start);

  const moved = [];
  tidy(decorations, source.length).forEach(d => {
    if (d.end <= start) moved.push(d);
    else if (d.start >= end) moved.push({ ...d, start: d.start + delta, end: d.end + delta });
    // else: inserting into the middle of a block breaks it — plain text now.
  });
  if (decorate) moved.push({ id: nextId(), kind, label: label || value, start: blockStart, end: blockEnd });

  return {
    text: nextText,
    decorations: tidy(moved, nextText.length),
    cursor: blockEnd + trail.length
  };
}

/** The decoration the caret is *inside*, ignoring the two boundary positions. */
export function decorationAt(decorations, offset) {
  return (decorations || []).find(d => offset > d.start && offset < d.end) || null;
}

/** Any decoration touching [start, end), for a dragged selection. */
export function decorationsInRange(decorations, start, end) {
  return (decorations || []).filter(d => d.start < end && d.end > start);
}

/** Turn a block back into ordinary text, keeping the text itself. */
export function undecorate(decorations, id) {
  return (decorations || []).filter(d => d.id !== id);
}

/** Delete a block's text and the decoration with it. */
export function removeDecoration(text, decorations, id) {
  const source = String(text || '');
  const target = (decorations || []).find(d => d.id === id);
  if (!target) return { text: source, decorations: tidy(decorations, source.length) };

  const nextText = source.slice(0, target.start) + source.slice(target.end);
  const width = target.end - target.start;
  const moved = [];
  tidy(decorations, source.length).forEach(d => {
    if (d.id === id) return;
    if (d.end <= target.start) moved.push(d);
    else if (d.start >= target.end) moved.push({ ...d, start: d.start - width, end: d.end - width });
    // A block overlapping the one being removed cannot happen — insertion never
    // produces overlaps — but if it somehow did, dropping it is the safe read.
  });
  return { text: nextText, decorations: tidy(moved, nextText.length) };
}

/**
 * Slice the prompt into contiguous runs for rendering.
 *
 * `marks` is the decorations plus whatever else wants colouring — the <Tag>
 * occurrences, which are computed from the text rather than stored. Where the
 * two overlap the tag wins: a tag inside an inserted snippet is still a tag,
 * and knowing what it expands to matters more than knowing where it came from.
 */
export function promptSegments(text, marks = []) {
  const source = String(text || '');
  const valid = tidy(marks, source.length);
  if (valid.length === 0) return source ? [{ text: source, kind: 'plain', start: 0, end: source.length, id: null }] : [];

  const points = new Set([0, source.length]);
  valid.forEach(m => { points.add(m.start); points.add(m.end); });
  const boundaries = [...points].sort((a, b) => a - b);

  const segments = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (end <= start) continue;
    const covering = valid.filter(m => m.start <= start && m.end >= end);
    const mark = covering.find(m => m.kind === 'tag' || m.kind === 'missing-tag') || covering[0] || null;
    segments.push({
      text: source.slice(start, end),
      start,
      end,
      kind: mark ? mark.kind : 'plain',
      id: mark ? mark.id : null,
      label: mark ? mark.label : '',
      removable: mark ? mark.removable !== false : false
    });
  }
  return segments;
}
