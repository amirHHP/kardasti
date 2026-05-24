/**
 * Minimal PDF generator — creates professional cover letter PDFs
 * without any external dependencies. Uses standard PDF 1.4 format
 * with built-in Helvetica/Helvetica-Bold fonts.
 *
 * Returns a Uint8Array containing the raw PDF bytes.
 */

// Helvetica character widths (per 1000 em-units) — ASCII subset
const WIDTHS = {
  32:278,33:278,34:355,35:556,36:556,37:889,38:667,39:191,40:333,41:333,
  42:389,43:584,44:278,45:333,46:278,47:278,48:556,49:556,50:556,51:556,
  52:556,53:556,54:556,55:556,56:556,57:556,58:278,59:278,60:584,61:584,
  62:584,63:556,64:1015,65:667,66:667,67:722,68:722,69:667,70:611,71:778,
  72:722,73:278,74:500,75:667,76:556,77:833,78:722,79:778,80:667,81:778,
  82:722,83:667,84:611,85:722,86:667,87:944,88:667,89:667,90:611,91:278,
  92:278,93:278,94:469,95:556,96:333,97:556,98:556,99:500,100:556,101:556,
  102:278,103:556,104:556,105:222,106:222,107:500,108:222,109:833,110:556,
  111:556,112:556,113:556,114:333,115:500,116:278,117:556,118:500,119:722,
  120:500,121:500,122:500,123:334,124:260,125:334,126:584
};

const PAGE_W = 612; // Letter width in points
const PAGE_H = 792; // Letter height in points
const MARGIN_X = 72; // 1-inch horizontal margin
const MARGIN_TOP = 72;
const MARGIN_BOTTOM = 72;
const FONT_SIZE = 11;
const LINE_HEIGHT = 16; // points between baselines
const MAX_TEXT_W = PAGE_W - 2 * MARGIN_X; // usable text width

/**
 * Measure the width of a string in points at FONT_SIZE.
 */
function measureText(str) {
  let w = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    w += (WIDTHS[code] || 500); // default 500 for unknown chars
  }
  return (w / 1000) * FONT_SIZE;
}

/**
 * Escape special PDF string characters: \, (, )
 */
function escPdf(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/**
 * Clamp a character to WinAnsiEncoding range (most Latin chars).
 * Non-Latin chars are replaced with '?'.
 * Also strip control chars except \n.
 */
function toWinAnsi(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 10 || c === 13) {
      out += str[i]; // keep newlines
    } else if (c < 32) {
      // skip control chars
    } else if (c <= 255) {
      out += str[i];
    } else {
      out += '?';
    }
  }
  return out;
}

/**
 * Word-wrap a single paragraph into lines that fit within MAX_TEXT_W.
 */
function wrapParagraph(text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (measureText(candidate) <= MAX_TEXT_W) {
      currentLine = candidate;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

/**
 * Convert text content into an array of pages, each containing
 * an array of line-text strings.
 */
function layoutPages(text) {
  const usableHeight = PAGE_H - MARGIN_TOP - MARGIN_BOTTOM;
  const maxLinesPerPage = Math.floor(usableHeight / LINE_HEIGHT);
  const paragraphs = text.split(/\n/);

  const allLines = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i].trim();
    if (para === '') {
      allLines.push(''); // blank line for paragraph spacing
    } else {
      const wrapped = wrapParagraph(toWinAnsi(para));
      for (const line of wrapped) {
        allLines.push(line);
      }
    }
  }

  // Split into pages
  const pages = [];
  for (let i = 0; i < allLines.length; i += maxLinesPerPage) {
    pages.push(allLines.slice(i, i + maxLinesPerPage));
  }
  if (pages.length === 0) pages.push([]);
  return pages;
}

/**
 * Build the PDF content stream for a single page.
 * Uses explicit Td moves per line instead of TL/T* to avoid
 * leading-direction bugs.
 */
function buildContentStream(lines) {
  const startY = PAGE_H - MARGIN_TOP - FONT_SIZE; // baseline of first line
  let stream = 'BT\n';
  stream += `/F1 ${FONT_SIZE} Tf\n`;

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (i === 0) {
      // Move to the first line position (absolute)
      stream += `${MARGIN_X} ${startY} Td\n`;
    } else {
      // Move down by LINE_HEIGHT from previous line (relative)
      stream += `0 -${LINE_HEIGHT} Td\n`;
    }
    stream += `(${escPdf(lineText)}) Tj\n`;
  }

  stream += 'ET\n';
  return stream;
}

/**
 * Encode a string as PDF-safe bytes (Latin-1).
 * Returns a Uint8Array.
 */
function strToBytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xFF;
  }
  return bytes;
}

/**
 * Build a complete PDF document from text and return as Uint8Array.
 * @param {string} coverLetterText - The cover letter content
 * @returns {Uint8Array} PDF file bytes
 */
export function generatePDF(coverLetterText) {
  const pages = layoutPages(coverLetterText);

  // We will build the PDF by accumulating byte arrays for exact offsets.
  const chunks = [];
  let totalLen = 0;

  const write = (str) => {
    const b = strToBytes(str);
    chunks.push(b);
    totalLen += b.length;
  };

  const getOffset = () => totalLen;

  // Track object byte-offsets for xref
  const objOffsets = []; // objOffsets[objNum] = byte offset
  let nextObj = 1;

  const allocObj = () => nextObj++;

  // Pre-allocate object numbers
  const catalogNum = allocObj(); // 1
  const pagesNum = allocObj();   // 2
  const fontRegNum = allocObj(); // 3
  const fontBoldNum = allocObj(); // 4

  // Allocate page + stream object numbers
  const pageObjNums = [];
  const streamObjNums = [];
  for (let i = 0; i < pages.length; i++) {
    streamObjNums.push(allocObj());
    pageObjNums.push(allocObj());
  }

  // ── Header ─────────────────────────────
  write('%PDF-1.4\n%\xC0\xC1\xC2\xC3\n');

  // ── Catalog ────────────────────────────
  objOffsets[catalogNum] = getOffset();
  write(`${catalogNum} 0 obj\n<< /Type /Catalog /Pages ${pagesNum} 0 R >>\nendobj\n\n`);

  // ── Pages ──────────────────────────────
  const kids = pageObjNums.map(n => `${n} 0 R`).join(' ');
  objOffsets[pagesNum] = getOffset();
  write(`${pagesNum} 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageObjNums.length} >>\nendobj\n\n`);

  // ── Fonts ──────────────────────────────
  objOffsets[fontRegNum] = getOffset();
  write(`${fontRegNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n\n`);

  objOffsets[fontBoldNum] = getOffset();
  write(`${fontBoldNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n\n`);

  // ── Pages content ──────────────────────
  for (let i = 0; i < pages.length; i++) {
    const streamText = buildContentStream(pages[i]);
    const streamBytes = strToBytes(streamText);

    // Stream object — /Length must match the exact byte count between stream\n and \nendstream
    objOffsets[streamObjNums[i]] = getOffset();
    write(`${streamObjNums[i]} 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n`);
    chunks.push(streamBytes);
    totalLen += streamBytes.length;
    write('endstream\nendobj\n\n');

    // Page object
    objOffsets[pageObjNums[i]] = getOffset();
    write(`${pageObjNums[i]} 0 obj\n`);
    write(`<< /Type /Page /Parent ${pagesNum} 0 R`);
    write(` /MediaBox [0 0 ${PAGE_W} ${PAGE_H}]`);
    write(` /Contents ${streamObjNums[i]} 0 R`);
    write(` /Resources << /Font << /F1 ${fontRegNum} 0 R /F2 ${fontBoldNum} 0 R >> >> >>\n`);
    write('endobj\n\n');
  }

  // ── Cross-reference table ──────────────
  const xrefOffset = getOffset();
  write(`xref\n0 ${nextObj}\n`);
  write('0000000000 65535 f \r\n');
  for (let i = 1; i < nextObj; i++) {
    const off = String(objOffsets[i]).padStart(10, '0');
    write(`${off} 00000 n \r\n`);
  }

  // ── Trailer ────────────────────────────
  write(`trailer\n<< /Size ${nextObj} /Root ${catalogNum} 0 R >>\n`);
  write(`startxref\n${xrefOffset}\n%%EOF\n`);

  // ── Combine all chunks ─────────────────
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
