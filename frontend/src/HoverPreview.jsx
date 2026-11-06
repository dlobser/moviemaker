// A thumbnail that grows on hover.
//
// Wrap any small image or video with this and, after a short rest, a medium
// preview floats beside it — big enough to judge a take without opening the
// zoom viewer. The popup is portalled to <body> so it escapes overflow:hidden
// rows and modal scroll areas, and it ignores the pointer so it can never
// steal the hover that opened it.
//
// Nothing here changes on click: double-click (the zoom viewer) and click
// (jump to shot) keep working on the wrapped element, and any press closes
// the preview so it does not sit over a dialog that just opened.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AssetImage, AssetVideo } from './AssetMedia.jsx';

const SHOW_DELAY_MS = 150;
const PREVIEW_WIDTH = 480;
const MARGIN = 12;

/**
 * Where to put the popup: beside the anchor, on whichever side has room,
 * vertically centred on it and clamped to the viewport.
 */
function placePreview(anchor, viewport, width = PREVIEW_WIDTH) {
  const height = Math.round(width * 9 / 16) + 24; // 16:9 plus the label row; a guess, clamped below
  let x = anchor.left - width - MARGIN;
  if (x < MARGIN) x = anchor.right + MARGIN;
  if (x + width > viewport.width - MARGIN) x = Math.max(MARGIN, viewport.width - width - MARGIN);
  let y = anchor.top + anchor.height / 2 - height / 2;
  y = Math.max(MARGIN, Math.min(y, viewport.height - height - MARGIN));
  return { x: Math.round(x), y: Math.round(y) };
}

export default function HoverPreview({
  path,
  kind = 'image',
  label = '',
  width = PREVIEW_WIDTH,
  children,
  ...rest
}) {
  const [pos, setPos] = useState(null);
  const anchorRef = useRef(null);
  const timerRef = useRef(null);

  const close = () => {
    clearTimeout(timerRef.current);
    timerRef.current = null;
    setPos(null);
  };

  const open = () => {
    if (!path) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPos(placePreview(rect, { width: window.innerWidth, height: window.innerHeight }, width));
    }, SHOW_DELAY_MS);
  };

  useEffect(() => () => clearTimeout(timerRef.current), []);
  // The thumbnail's media changed (new select, cleared): drop any open popup.
  useEffect(() => { setPos(null); }, [path]);

  const { onMouseEnter, onMouseLeave, onMouseDown, ...anchorProps } = rest;

  return (
    <div
      ref={anchorRef}
      onMouseEnter={(e) => { open(); onMouseEnter?.(e); }}
      onMouseLeave={(e) => { close(); onMouseLeave?.(e); }}
      onMouseDown={(e) => { close(); onMouseDown?.(e); }}
      {...anchorProps}
    >
      {children}
      {pos && path && createPortal(
        <div className="hover-preview" style={{ left: pos.x, top: pos.y, width }} aria-hidden="true">
          {kind === 'video'
            ? <AssetVideo path={path} autoPlay muted loop playsInline />
            : <AssetImage path={path} alt={label} />}
          {label && <div className="hover-preview-label">{label}</div>}
        </div>,
        document.body
      )}
    </div>
  );
}
