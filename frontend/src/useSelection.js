import { useCallback, useRef, useState } from 'react';

/**
 * Multi-select over an ordered list of ids, with the modifier conventions people
 * already have in their fingers from every file browser: plain click replaces
 * the selection, ⌘/Ctrl-click adds one, shift-click extends from the last item
 * touched, and a bare checkbox click always toggles just that one.
 *
 * The anchor for shift-extension is the last id that was clicked *without*
 * shift, which is what makes repeated shift-clicks grow and shrink one range
 * instead of leaving a trail of disconnected ones.
 *
 * `orderedIds` is passed per call rather than held in the hook because the grid
 * reorders under filtering and grouping, and a range should always mean "what is
 * between these two on screen right now".
 */
export function useSelection() {
  const [selected, setSelected] = useState(() => new Set());
  const anchorRef = useRef(null);

  const clear = useCallback(() => {
    setSelected(new Set());
    anchorRef.current = null;
  }, []);

  const isSelected = useCallback(id => selected.has(id), [selected]);

  /** Toggle exactly one id, leaving the rest of the selection alone. */
  const toggle = useCallback((id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    anchorRef.current = id;
  }, []);

  /** A click on a card, honouring shift / ⌘ / Ctrl. */
  const handleClick = useCallback((id, orderedIds, event = {}) => {
    const additive = event.metaKey || event.ctrlKey;
    const ranged = event.shiftKey;

    if (ranged && anchorRef.current) {
      const from = orderedIds.indexOf(anchorRef.current);
      const to = orderedIds.indexOf(id);
      if (from !== -1 && to !== -1) {
        const range = orderedIds.slice(Math.min(from, to), Math.max(from, to) + 1);
        setSelected(prev => {
          // Shift extends the existing selection rather than replacing it, so a
          // range can be added to ids picked earlier with ⌘-click.
          const next = additive ? new Set(prev) : new Set();
          range.forEach(rangeId => next.add(rangeId));
          return next;
        });
        return;
      }
    }

    if (additive) {
      toggle(id);
      return;
    }

    setSelected(prev => (prev.size === 1 && prev.has(id) ? new Set() : new Set([id])));
    anchorRef.current = id;
  }, [toggle]);

  /** Select every id in a group — or clear them if they are all already in. */
  const toggleAll = useCallback((ids) => {
    setSelected(prev => {
      const next = new Set(prev);
      const allIn = ids.length > 0 && ids.every(id => next.has(id));
      ids.forEach(id => (allIn ? next.delete(id) : next.add(id)));
      return next;
    });
  }, []);

  /** Drop ids that no longer exist, after a delete or a filter change. */
  const retain = useCallback((validIds) => {
    const valid = new Set(validIds);
    setSelected(prev => {
      const next = new Set([...prev].filter(id => valid.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, []);

  return {
    selected,
    selectedIds: [...selected],
    count: selected.size,
    isSelected,
    toggle,
    toggleAll,
    handleClick,
    clear,
    retain,
    setSelected
  };
}
