// <img>/<video> wrappers that understand project-relative asset paths.
//
// In server mode a path maps straight to an HTTP URL, but in the static build
// it has to be read off disk and turned into a blob: URL, which is async. These
// components hide that difference so call sites just pass `path`.

import { useEffect, useState } from 'react';
import { resolveAssetUrl } from './client.js';

/** Resolve a project asset path to something an <img> can display. */
export function useAssetUrl(assetPath) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!assetPath) {
      setUrl(null);
      return undefined;
    }
    resolveAssetUrl(assetPath).then(resolved => {
      if (!cancelled) setUrl(resolved);
    });
    return () => { cancelled = true; };
  }, [assetPath]);

  return url;
}

export function AssetImage({ path, alt = '', fallback = null, ...rest }) {
  const url = useAssetUrl(path);
  if (!url) return fallback;
  return <img src={url} alt={alt} {...rest} />;
}

export function AssetVideo({ path, fallback = null, ...rest }) {
  const url = useAssetUrl(path);
  if (!url) return fallback;
  // crossOrigin keeps the canvas untainted so a frame can be captured off the
  // playhead. The backend sends permissive CORS headers; blob: URLs in the
  // static build are same-origin and ignore the attribute.
  return <video src={url} crossOrigin="anonymous" {...rest} />;
}
