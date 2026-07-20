const API = 'https://api.semanticscholar.org/graph/v1/paper/DOI:';
const DOI_RE = /(10\.\d{4,9}\/\S+)/i;

export function extractDoi(code) {
  const m = DOI_RE.exec(code || '');
  if (!m) return null;
  return m[1].replace(/[.,;)\]]+$/, '');
}

export async function fetchAbstract(doi) {
  const res = await fetch(`${API}${encodeURIComponent(doi)}?fields=abstract`);
  if (res.status === 429) {
    const err = new Error('rate_limited');
    err.rateLimited = true;
    throw err;
  }
  if (res.status === 404) return '';
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.abstract || '';
}
