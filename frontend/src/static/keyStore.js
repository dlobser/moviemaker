// API credentials for the static build.
//
// Keys live in this browser's localStorage and are sent straight from the page
// to each provider. Nothing is uploaded to the site host — a static site has no
// server to receive them. The trade-off is that any script running on this
// origin can read them, so treat them like any other browser-stored secret and
// prefer keys scoped to this use.

const STORAGE_KEY = 'moviemaker-credentials';

export const CREDENTIAL_FIELDS = [
  'geminiKey', 'openaiKey', 'claudeKey', 'falKey',
  'runwayKey', 'klingKey', 'klingSecret',
  'higgsfieldKey', 'higgsfieldSecret',
  'atlasKey',
  'corsProxy'
];

const EMPTY = CREDENTIAL_FIELDS.reduce((acc, field) => { acc[field] = ''; return acc; }, {});

export function loadCredentials() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    return { ...EMPTY };
  }
}

export function saveCredentials(values) {
  const next = { ...EMPTY };
  CREDENTIAL_FIELDS.forEach(field => {
    if (typeof values[field] === 'string') next[field] = values[field];
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function clearCredentials() {
  localStorage.removeItem(STORAGE_KEY);
}
