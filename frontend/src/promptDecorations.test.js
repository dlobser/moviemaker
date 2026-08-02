// node --test frontend/src/promptDecorations.test.js
//
// The decorations are a claim about *someone else's* text: they say "the studio
// put this here", and they are drawn as coloured ranges over a textarea the
// user is free to edit. Every bug in that arrangement looks the same from the
// outside — a highlight sitting one word to the left, an 'x' that deletes the
// wrong thing — so what is pinned down here is that a range always still covers
// the characters it was created for, whatever was typed around it.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decorationAt,
  insertIntoPrompt,
  promptSegments,
  remapDecorations,
  removeDecoration,
  undecorate
} from './promptDecorations.js';

/** The text a decoration actually covers — the only thing worth asserting. */
const covered = (text, decorations) => decorations.map(d => text.slice(d.start, d.end));

test('inserting at the caret splits the text rather than appending', () => {
  const { text, decorations } = insertIntoPrompt('wide shot of a road', [], { start: 10, end: 10 }, 'at dusk');
  assert.equal(text, 'wide shot at dusk, of a road');
  assert.deepEqual(covered(text, decorations), ['at dusk']);
});

test('the joining comma belongs to the block, so removing it leaves no orphan', () => {
  const first = insertIntoPrompt('a lonely road', [], { start: 13, end: 13 }, 'golden hour');
  assert.equal(first.text, 'a lonely road, golden hour');
  const cleared = removeDecoration(first.text, first.decorations, first.decorations[0].id);
  assert.equal(cleared.text, 'a lonely road');
});

test('no joiner is invented at the start of an empty prompt', () => {
  const { text } = insertIntoPrompt('', [], { start: 0, end: 0 }, 'grainy 16mm');
  assert.equal(text, 'grainy 16mm');
});

test('text that already separates itself does not get a second comma', () => {
  assert.equal(insertIntoPrompt('a road, ', [], { start: 8, end: 8 }, 'at dusk').text, 'a road, at dusk');
  assert.equal(insertIntoPrompt('a road ', [], { start: 7, end: 7 }, 'at dusk').text, 'a road at dusk');
});

// A post-prompt is conventionally written with its own leading comma so it
// reads correctly when appended. Inlining one has to notice that, or every
// inlined post-prompt arrives at the model as ", , 35mm".
test('an insert carrying its own leading comma is not given a second one', () => {
  const { text } = insertIntoPrompt('a road', [], { start: 6, end: 6 }, ', 35mm, shallow focus');
  assert.equal(text, 'a road, 35mm, shallow focus');
});

test('the same holds for a pre-prompt with its own trailing comma', () => {
  const { text } = insertIntoPrompt('a road', [], { start: 0, end: 0 }, 'cinematic film still,');
  assert.equal(text, 'cinematic film still, a road');
});

test('a second insert before the first moves the first, it does not smear it', () => {
  const first = insertIntoPrompt('a road', [], { start: 6, end: 6 }, 'at dusk');
  const second = insertIntoPrompt(first.text, first.decorations, { start: 0, end: 0 }, 'grainy 16mm');
  // Both blocks still name their own words.
  assert.deepEqual(covered(second.text, second.decorations).sort(), ['grainy 16mm', ', at dusk'].sort());
});

test('the caret lands after what was just inserted', () => {
  const { text, cursor } = insertIntoPrompt('a road', [], { start: 6, end: 6 }, 'at dusk');
  assert.equal(text.slice(0, cursor), 'a road, at dusk');
});

test('inserting over a selection replaces it', () => {
  const { text } = insertIntoPrompt('a red road', [], { start: 2, end: 5 }, 'blue');
  assert.equal(text, 'a blue road');
});

// --- surviving the user's typing -------------------------------------------

test('typing before a block shifts it by exactly what was typed', () => {
  const before = 'a road, at dusk';
  const decorations = [{ id: 'd1', kind: 'snippet', start: 6, end: 15 }];
  const after = 'a long road, at dusk';
  const moved = remapDecorations(decorations, before, after);
  assert.deepEqual(covered(after, moved), [', at dusk']);
});

test('typing after a block leaves it exactly where it was', () => {
  const before = 'a road, at dusk';
  const decorations = [{ id: 'd1', kind: 'snippet', start: 6, end: 15 }];
  const after = 'a road, at dusk, handheld';
  assert.deepEqual(covered(after, remapDecorations(decorations, before, after)), [', at dusk']);
});

test('deleting before a block shifts it back', () => {
  const before = 'a long road, at dusk';
  const decorations = [{ id: 'd1', kind: 'snippet', start: 11, end: 20 }];
  const after = 'a road, at dusk';
  assert.deepEqual(covered(after, remapDecorations(decorations, before, after)), [', at dusk']);
});

// The rule that keeps the whole thing honest: a decoration says the studio
// wrote this text, so the moment the user edits inside one it stops being true.
// Dissolving it is both the correct claim and the requested behaviour — edit a
// block and it becomes ordinary text you own.
test('editing inside a block dissolves it instead of half-covering a word', () => {
  const before = 'a road, at dusk';
  const decorations = [{ id: 'd1', kind: 'snippet', start: 6, end: 15 }];
  const after = 'a road, at midnight';
  assert.deepEqual(remapDecorations(decorations, before, after), []);
});

test('an edit spanning two blocks dissolves both and spares a third', () => {
  const before = 'one, two, three';
  const decorations = [
    { id: 'a', kind: 'snippet', start: 0, end: 3 },
    { id: 'b', kind: 'snippet', start: 5, end: 8 },
    { id: 'c', kind: 'snippet', start: 10, end: 15 }
  ];
  const after = 'oNe, tWo, three';
  const moved = remapDecorations(decorations, before, after);
  assert.deepEqual(moved.map(d => d.id), ['c']);
  assert.deepEqual(covered(after, moved), ['three']);
});

// The other half of that rule: typing hard up against a block is not typing
// *in* it. Dissolving on adjacency would mean a block could not survive the
// user continuing the sentence right after it.
test('typing immediately after a block leaves the block intact', () => {
  const decorations = [{ id: 'a', kind: 'snippet', start: 0, end: 3 }];
  const moved = remapDecorations(decorations, 'one, two', 'oneX, two');
  assert.deepEqual(covered('oneX, two', moved), ['one']);
});

test('clearing the prompt clears the blocks with it', () => {
  const decorations = [{ id: 'd1', kind: 'snippet', start: 0, end: 6 }];
  assert.deepEqual(remapDecorations(decorations, 'a road', ''), []);
});

test('a no-op change keeps every block', () => {
  const decorations = [{ id: 'd1', kind: 'snippet', start: 0, end: 6 }];
  assert.equal(remapDecorations(decorations, 'a road', 'a road').length, 1);
});

// --- removing and claiming --------------------------------------------------

test('removing one block reindexes the blocks after it', () => {
  const text = 'one, two, three';
  const decorations = [
    { id: 'a', kind: 'snippet', start: 0, end: 3 },
    { id: 'b', kind: 'snippet', start: 3, end: 8 },
    { id: 'c', kind: 'snippet', start: 8, end: 15 }
  ];
  const result = removeDecoration(text, decorations, 'b');
  assert.equal(result.text, 'one, three');
  assert.deepEqual(covered(result.text, result.decorations), ['one', ', three']);
});

test('undecorating keeps the words and drops only the claim', () => {
  const decorations = [{ id: 'a', kind: 'snippet', start: 0, end: 3 }];
  assert.deepEqual(undecorate(decorations, 'a'), []);
});

test('the caret has to be inside a block, not merely touching it', () => {
  const decorations = [{ id: 'a', kind: 'snippet', start: 4, end: 9 }];
  assert.equal(decorationAt(decorations, 4), null); // typing just before it
  assert.equal(decorationAt(decorations, 9), null); // typing just after it
  assert.equal(decorationAt(decorations, 6)?.id, 'a');
});

// --- rendering --------------------------------------------------------------

test('segments reassemble into exactly the original text', () => {
  const text = 'wide shot of <Rex>, golden hour';
  const marks = [
    { id: 't1', kind: 'tag', start: 13, end: 18 },
    { id: 's1', kind: 'snippet', start: 18, end: 31 }
  ];
  const segments = promptSegments(text, marks);
  assert.equal(segments.map(s => s.text).join(''), text);
  assert.deepEqual(
    segments.map(s => [s.kind, s.text]),
    [['plain', 'wide shot of '], ['tag', '<Rex>'], ['snippet', ', golden hour']]
  );
});

test('a tag inside an inserted snippet still reads as a tag', () => {
  const text = 'a shot with <Rex> in it';
  const segments = promptSegments(text, [
    { id: 's1', kind: 'snippet', start: 0, end: 23 },
    { id: 't1', kind: 'tag', start: 12, end: 17 }
  ]);
  assert.deepEqual(segments.map(s => s.kind), ['snippet', 'tag', 'snippet']);
  assert.equal(segments.map(s => s.text).join(''), text);
});

test('plain text with no marks is one segment', () => {
  assert.deepEqual(promptSegments('just words', []), [
    { text: 'just words', kind: 'plain', start: 0, end: 10, id: null }
  ]);
});

test('an empty prompt renders nothing', () => {
  assert.deepEqual(promptSegments('', []), []);
});

test('a stale range pointing past the end of the text cannot break rendering', () => {
  const segments = promptSegments('short', [{ id: 'x', kind: 'snippet', start: 2, end: 99 }]);
  assert.equal(segments.map(s => s.text).join(''), 'short');
});
