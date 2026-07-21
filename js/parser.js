export function parseFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const sheetName = wb.SheetNames[0];
        const sheet = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
        const columns = rows.length ? Object.keys(rows[0]) : [];
        resolve({ rows, columns });
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

const TITLE_HINTS = ['title', 'название', 'наименование', 'article', 'статья', 'заголовок', 'name'];
const LINK_HINTS = ['ссылка', 'link', 'url', 'источник'];
const DOI_HINTS = ['doi'];
const ABSTRACT_HINTS = ['abstract', 'аннотация', 'annotation', 'summary', 'реферат'];

function guessColumn(columns, hints, fallbackIndex) {
  const lower = columns.map(c => c.toLowerCase());
  for (const hint of hints) {
    const idx = lower.findIndex(c => c.includes(hint));
    if (idx !== -1) return columns[idx];
  }
  return columns[fallbackIndex] || '';
}

export function guessMapping(columns) {
  return {
    title: guessColumn(columns, TITLE_HINTS, 0),
    link: guessColumn(columns, LINK_HINTS, 1),
    doi: guessColumn(columns, DOI_HINTS, 2),
    abstract: guessColumn(columns, ABSTRACT_HINTS, -1)
  };
}
