// The prompt field, showing what the model will actually receive.
//
// A textarea cannot colour its own contents, so this is the standard mirror
// trick: a div rendering the same text with the same metrics sits exactly
// behind a transparent-text textarea. The textarea stays the single source of
// truth, which means selection, undo, IME, spellcheck and every keyboard
// shortcut keep working — the things a contenteditable rewrite would have had
// to reimplement and would have got subtly wrong.
//
// The mirror is pointer-events:none, so hovering is resolved by hit-testing the
// rendered spans' client rects rather than by CSS :hover. That keeps clicks
// going to the textarea (the caret lands where you clicked, as it should) while
// still letting a block offer its own 'x'.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, RotateCcw, X } from 'lucide-react';

import { promptSegments } from './promptDecorations.js';

/**
 * The project's pre/post prompt, shown attached to the field it wraps.
 *
 * Not part of the editable text: it belongs to the project, and inlining it
 * into every shot's prompt is how it would end up baked into a hundred shots
 * that then drift apart. Click it and it *becomes* your text — for this
 * generation only — which is the escape hatch for the one shot that needs to
 * say it differently.
 */
function Affix({ text, side, onDisable, onInline }) {
  if (!text) return null;
  return (
    <div className={`prompt-affix prompt-affix-${side}`}>
      <button
        type="button"
        className="prompt-affix-text"
        onClick={onInline}
        title="Click to make this part of the prompt so you can edit it, for this generation only"
      >
        {text}
      </button>
      <button
        type="button"
        className="prompt-affix-remove"
        onClick={onDisable}
        title={`Leave the ${side === 'pre' ? 'pre' : 'post'}-prompt off this generation`}
      >
        <X size={11} />
      </button>
    </div>
  );
}

export default function PromptEditor({
  value,
  onChange,
  decorations = [],
  marks = [],
  prePrompt = '',
  postPrompt = '',
  usePre = true,
  usePost = true,
  onTogglePre,
  onTogglePost,
  onInlinePre,
  onInlinePost,
  onUndecorate,
  onRemoveDecoration,
  onSelectionChange,
  inputRef,
  caretRequest,
  placeholder = '',
  footer = null
}) {
  // Exposed to the caller: a chip inserting "at the cursor" has to read the
  // caret off the element itself at the moment it inserts. Tracking it through
  // onSelect alone is not enough — React derives that event from selectionchange
  // and it does not fire for every way a caret can move, which silently sends
  // the insert to offset 0.
  const innerRef = useRef(null);
  const textareaRef = inputRef || innerRef;
  const mirrorRef = useRef(null);
  const spanRefs = useRef(new Map());
  const [hovered, setHovered] = useState(null); // { id, left, top }

  const segments = promptSegments(value, [...decorations, ...marks]);

  // Keep the mirror aligned when the textarea scrolls; they are the same height
  // but only one of them has a scrollbar the user can drive.
  const syncScroll = useCallback(() => {
    if (mirrorRef.current && textareaRef.current) {
      mirrorRef.current.scrollTop = textareaRef.current.scrollTop;
      mirrorRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, [textareaRef]);

  useLayoutEffect(syncScroll, [value, syncScroll]);

  // Put the caret back after an insert. It has to happen *after* the new value
  // is committed to the DOM — setting the range against the old text just gets
  // reset when React writes the new one — hence a layout effect rather than a
  // callback at the insertion site. `nonce` rather than `pos` so two inserts
  // landing on the same offset still both move the caret.
  useLayoutEffect(() => {
    if (!caretRequest || !textareaRef.current) return;
    const el = textareaRef.current;
    el.focus();
    el.setSelectionRange(caretRequest.pos, caretRequest.pos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caretRequest?.nonce]);

  // A block under the caret has been claimed by the user, so it stops being
  // marked as inserted. This is the "click into it and edit it" behaviour, and
  // it deliberately fires on arrow keys too — however you got in there, you are
  // in there.
  const handleCaret = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (onSelectionChange) onSelectionChange({ start: el.selectionStart, end: el.selectionEnd });
    if (!onUndecorate) return;
    const caret = el.selectionStart;
    const inside = decorations.find(d => caret > d.start && caret < d.end);
    if (inside) onUndecorate(inside.id);
  }, [decorations, onUndecorate, onSelectionChange, textareaRef]);

  // Hit-test the mirror's spans. getClientRects() rather than
  // getBoundingClientRect() because a block that wraps across lines is several
  // rectangles, and its bounding box would swallow the text beside it.
  const handleMouseMove = useCallback((event) => {
    const { clientX, clientY } = event;
    let found = null;
    spanRefs.current.forEach((node, id) => {
      if (found || !node) return;
      const rects = node.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const rect = rects[i];
        if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
          const host = mirrorRef.current.getBoundingClientRect();
          found = { id, left: rect.right - host.left, top: rect.top - host.top };
          break;
        }
      }
    });
    setHovered(prev => {
      if (!found && !prev) return prev;
      if (found && prev && found.id === prev.id && Math.abs(found.left - prev.left) < 1) return prev;
      return found;
    });
  }, []);

  useEffect(() => {
    // A removed or dissolved block must not leave its 'x' floating.
    setHovered(prev => (prev && spanRefs.current.has(prev.id) ? prev : null));
  }, [value, decorations, marks]);

  const hoveredMark = hovered
    ? [...decorations, ...marks].find(m => m.id === hovered.id)
    : null;

  return (
    <div className="prompt-editor">
      {usePre && (
        <Affix text={prePrompt} side="pre" onDisable={onTogglePre} onInline={onInlinePre} />
      )}

      <div className="prompt-editor-body" onMouseLeave={() => setHovered(null)}>
        <div className="prompt-mirror" ref={mirrorRef} aria-hidden="true">
          {segments.map((segment, index) => (
            segment.kind === 'plain' ? (
              <span key={`${segment.start}-${index}`}>{segment.text}</span>
            ) : (
              <span
                key={`${segment.start}-${index}`}
                className={`prompt-mark prompt-mark-${segment.kind}`}
                ref={node => {
                  if (node) spanRefs.current.set(segment.id, node);
                  else spanRefs.current.delete(segment.id);
                }}
              >
                {segment.text}
              </span>
            )
          ))}
          {/* A trailing newline is not rendered by a div the way a textarea
              renders it, so the mirror comes up one line short and every
              highlight below it drifts. */}
          {'\n'}
        </div>

        <textarea
          ref={textareaRef}
          className="prompt-input"
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onClick={handleCaret}
          onKeyUp={handleCaret}
          onSelect={handleCaret}
          onMouseMove={handleMouseMove}
        />

        {hovered && hoveredMark && hoveredMark.removable !== false && (
          <button
            type="button"
            className="prompt-mark-remove"
            style={{ left: `${hovered.left}px`, top: `${hovered.top}px` }}
            title={hoveredMark.label ? `Remove ${hoveredMark.label}` : 'Remove this block'}
            onClick={() => {
              onRemoveDecoration(hovered.id);
              setHovered(null);
            }}
          >
            <X size={10} />
          </button>
        )}
      </div>

      {usePost && (
        <Affix text={postPrompt} side="post" onDisable={onTogglePost} onInline={onInlinePost} />
      )}

      {footer}
    </div>
  );
}

/**
 * What the model will actually be sent, after tags, pre/post and trimming.
 *
 * This exists because the editor above it cannot answer the question. The
 * editor holds the *source* — "<Sara>" — which is the portable form: it
 * survives a model change, it renumbers itself, it keeps the link to the asset.
 * The model never sees that string. It sees "@image2", or Sara's full written
 * description, depending on which model is selected. One field cannot be both
 * forms at once, so there are two: source above, result here.
 *
 * Clicking the result claims it, exactly as clicking an inserted block in the
 * editor does. From that point the text is sent verbatim and the composition
 * above stops driving it — because the alternative, diffing hand edits back
 * onto the source, has no correct answer when the edit lands inside an expanded
 * tag, and would silently drop the asset rather than admit it.
 *
 * The override replaces the prompt *text* only. Reference images still follow
 * the tags and the thumbnails, so deleting "@image3" here unbinds that image
 * without silently unsending it — removing it is what the thumbnail's ✕ is for.
 */
export function EffectivePrompt({
  text,
  overridden,
  onEdit,
  onChange,
  onRevert,
  expanded,
  onToggleExpanded,
  capacity,
  imageCount
}) {
  const editorRef = useRef(null);

  // Entering edit mode should put you in the text, not make you click twice.
  useLayoutEffect(() => {
    if (overridden && editorRef.current) editorRef.current.focus();
  }, [overridden]);

  return (
    <div className={`effective-prompt ${overridden ? 'is-overridden' : ''}`}>
      <div className="effective-prompt-head">
        <button
          type="button"
          className="effective-prompt-toggle"
          onClick={onToggleExpanded}
          title={expanded ? 'Collapse' : 'Expand to see the whole prompt'}
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          Effective Prompt Sent to Model
        </button>
        <span className="effective-prompt-stats">
          {text.length} chars · {imageCount}/{capacity} image{capacity === 1 ? '' : 's'}
        </span>
        {overridden && (
          <button type="button" className="btn btn-secondary effective-prompt-revert" onClick={onRevert}>
            <RotateCcw size={11} /> Revert
          </button>
        )}
      </div>

      {overridden && (
        <div className="effective-prompt-banner">
          <AlertTriangle size={12} />
          <span>
            Edited — sent exactly as written below. The prompt, tags and pre/post above no longer
            change it. Reference images still follow the thumbnails.
          </span>
        </div>
      )}

      {overridden ? (
        <textarea
          ref={editorRef}
          className="effective-prompt-body effective-prompt-input"
          style={{ maxHeight: expanded ? '420px' : '120px' }}
          value={text}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <button
          type="button"
          className="effective-prompt-body effective-prompt-readonly"
          style={{ maxHeight: expanded ? '420px' : '120px' }}
          onClick={() => onEdit(text)}
          title="Click to edit this text directly. It will then be sent exactly as written."
        >
          {text || <em>Empty — nothing will be generated.</em>}
        </button>
      )}
    </div>
  );
}
