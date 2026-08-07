// Continuous time lives outside React.
//
// The playhead updates every animation frame during playback and every
// pointer move during a scrub. Routing that through setState re-rendered the
// whole Timeline per frame and re-registered drag listeners mid-gesture; a
// plain subscription store lets the few things that care (the playhead
// marker, the transport clock) write to the DOM directly.

export function createTimeStore(initial = 0) {
  let value = initial;
  const subscribers = new Set();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      subscribers.forEach(fn => fn(value));
    },
    subscribe: (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    }
  };
}
