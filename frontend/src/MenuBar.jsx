import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * The global menu bar.
 *
 * Replaces the thirteen peer buttons the header had grown, where a destination
 * (Storyboard) and an expensive irreversible action (Concatenate Video) were the
 * same shape and weight. Menus restore the distinction: destinations sit under
 * Library, actions under Generate and Render, and anything that opens a dialog
 * is suffixed with an ellipsis.
 *
 * Only live state stays outside the menus — the project name, the view toggle
 * and the batch chip — because those report rather than command.
 */

/** A single top-level menu. Closes on outside click, Escape, or item choice. */
export function Menu({ label, icon: Icon, badge, children, align = 'left' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        // Return focus to the trigger so keyboard users are not dumped at the
        // top of the document.
        ref.current?.querySelector('button')?.focus();
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button
        className={`menu-trigger ${open ? 'open' : ''}`}
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {Icon && <Icon size={15} />}
        <span>{label}</span>
        {badge}
        <ChevronDown size={12} className="menu-caret" />
      </button>

      {open && (
        <div className="menu-dropdown" role="menu" style={align === 'right' ? { right: 0, left: 'auto' } : undefined}>
          {/* Clicking any item closes the menu — the alternative is a menu that
              stays open behind the dialog it just launched. */}
          <div onClick={() => setOpen(false)}>{children}</div>
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon: Icon, children, hint, badge, danger, disabled, onClick, title }) {
  return (
    <button
      className={`menu-item ${danger ? 'danger' : ''}`}
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {Icon ? <Icon size={14} /> : <span className="menu-item-spacer" />}
      <span className="menu-item-label">{children}</span>
      {badge}
      {hint && <span className="menu-item-hint">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-separator" role="separator" />;
}

export function MenuLabel({ children }) {
  return <div className="menu-label">{children}</div>;
}

/**
 * A submenu that expands in place rather than flying out sideways — a flyout
 * inside a panel this narrow ends up off-screen on the right-hand menus.
 */
export function MenuGroup({ label, icon: Icon, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`menu-group ${open ? 'open' : ''}`}>
      <button
        className="menu-item"
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
      >
        {Icon ? <Icon size={14} /> : <span className="menu-item-spacer" />}
        <span className="menu-item-label">{label}</span>
        <ChevronDown size={12} className="menu-caret" />
      </button>
      {open && <div className="menu-group-body">{children}</div>}
    </div>
  );
}
