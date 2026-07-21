const DOI_RE = /(10\.\d{4,9}\/\S+)/i;
const ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';

export function extractDoi(raw) {
  const m = DOI_RE.exec(raw || '');
  if (!m) return null;
  return m[1].replace(/[.,;)\]]+$/, '');
}

async function pubmedFetch(url) {
  const res = await fetch(url);
  if (res.status === 429) {
    const err = new Error('rate_limited');
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

// Ищет статью в PubMed по DOI и возвращает её аннотацию (если найдена и есть).
export async function fetchAbstract(doi) {
  const searchUrl = `${ESEARCH}?db=pubmed&retmode=json&term=${encodeURIComponent(doi + '[DOI]')}`;
  const searchRes = await pubmedFetch(searchUrl);
  const searchData = await searchRes.json();
  const pmid = searchData?.esearchresult?.idlist?.[0];
  if (!pmid) return '';

  const fetchUrl = `${EFETCH}?db=pubmed&rettype=abstract&retmode=xml&id=${encodeURIComponent(pmid)}`;
  const fetchRes = await pubmedFetch(fetchUrl);
  const xmlText = await fetchRes.text();
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parts = [...doc.querySelectorAll('AbstractText')].map((node) => node.textContent.trim());
  return parts.join(' ');
}
