/**
 * Kardasti — Popup Script
 *
 * Handles:
 *  - Loading/saving settings from chrome.storage.local
 *  - Auto-fetching available models from AI API
 *  - Resume file upload with drag-and-drop (PDF & TXT)
 *  - Basic PDF text extraction (no external dependencies)
 *  - Collapsible card sections
 *  - Status indicator
 */

// ──────────────────────────────────────────────
// DOM References
// ──────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);

const els = {
  // API fields
  apiKey: $('#apiKey'),
  apiBaseUrl: $('#apiBaseUrl'),
  apiModel: $('#apiModel'),
  apiModelCustom: $('#apiModelCustom'),
  customModelWrapper: $('#customModelWrapper'),
  toggleApiKey: $('#toggleApiKey'),
  refreshModels: $('#refreshModels'),
  modelCount: $('#modelCount'),
  modelHint: $('#modelHint'),

  // Resume
  uploadZone: $('#uploadZone'),
  fileInput: $('#fileInput'),
  fileInfo: $('#fileInfo'),
  fileName: $('#fileName'),
  removeFile: $('#removeFile'),
  resumeTextSection: $('#resumeTextSection'),
  resumeText: $('#resumeText'),

  // UI
  saveBtn: $('#saveBtn'),
  btnText: $('.btn-text'),
  btnLoader: $('.btn-loader'),
  btnCheck: $('.btn-check'),
  statusBar: $('#statusBar'),
  statusDot: $('#statusDot'),
  statusText: $('#statusText'),

  // Collapsible sections
  advancedToggle: $('#advancedToggle'),
  advancedBody: $('#advancedBody'),
  advancedChevron: $('#advancedChevron'),
};

// Debounce timer for API key input
let fetchDebounceTimer = null;

// ──────────────────────────────────────────────
// Initialization
// ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  updateStatus();
  setupEventListeners();
  // Auto-fetch models if API key is already set
  if (els.apiKey.value.trim()) {
    await fetchAndPopulateModels();
  }
});

// ──────────────────────────────────────────────
// Settings Load/Save
// ──────────────────────────────────────────────

async function loadSettings() {
  const {
    apiKey = '',
    apiBaseUrl = '',
    apiModel = '',
    cachedModels = [],
    resumeText = '',
    resumeFileName = ''
  } = await chrome.storage.local.get([
    'apiKey', 'apiBaseUrl', 'apiModel', 'cachedModels', 'resumeText', 'resumeFileName'
  ]);

  els.apiKey.value = apiKey;
  els.apiBaseUrl.value = apiBaseUrl;
  els.resumeText.value = resumeText;

  // Restore cached models into dropdown
  if (cachedModels.length > 0) {
    populateModelDropdown(cachedModels, apiModel);
  } else if (apiModel) {
    // No cached list but a saved model — show it as the only option
    populateModelDropdown([apiModel], apiModel);
  }

  if (resumeText) {
    els.resumeTextSection.hidden = false;
  }

  if (resumeFileName) {
    showFileInfo(resumeFileName);
  }
}

async function saveSettings() {
  const selectedModel = els.apiModel.value;
  // Use custom input if "__custom__" is selected, otherwise use dropdown value
  const model = selectedModel === '__custom__'
    ? els.apiModelCustom.value.trim()
    : selectedModel;

  const data = {
    apiKey: els.apiKey.value.trim(),
    apiBaseUrl: els.apiBaseUrl.value.trim(),
    apiModel: model,
    resumeText: els.resumeText.value.trim(),
  };

  await chrome.storage.local.set(data);
}

// ──────────────────────────────────────────────
// Event Listeners
// ──────────────────────────────────────────────

function setupEventListeners() {
  // API key visibility toggle
  els.toggleApiKey.addEventListener('click', () => {
    const isPassword = els.apiKey.type === 'password';
    els.apiKey.type = isPassword ? 'text' : 'password';
    els.toggleApiKey.title = isPassword ? 'Hide API key' : 'Show API key';
  });

  // API key change — debounced auto-fetch models
  els.apiKey.addEventListener('input', () => {
    clearTimeout(fetchDebounceTimer);
    fetchDebounceTimer = setTimeout(async () => {
      const key = els.apiKey.value.trim();
      if (key.length >= 10) {
        autoDetectProvider(key);
        await fetchAndPopulateModels();
      }
    }, 800);
  });

  // Base URL change — re-fetch models
  els.apiBaseUrl.addEventListener('change', async () => {
    if (els.apiKey.value.trim()) {
      await fetchAndPopulateModels();
    }
  });

  // Refresh models button
  els.refreshModels.addEventListener('click', () => fetchAndPopulateModels());

  // Model dropdown — show custom input when "Custom" is selected
  els.apiModel.addEventListener('change', () => {
    const isCustom = els.apiModel.value === '__custom__';
    els.customModelWrapper.hidden = !isCustom;
    if (isCustom) els.apiModelCustom.focus();
  });

  // Collapsible sections
  setupCollapsible(els.advancedToggle, els.advancedBody, els.advancedChevron);

  // File upload — click
  els.uploadZone.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', handleFileSelect);

  // File upload — drag and drop
  els.uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.uploadZone.classList.add('drag-over');
  });
  els.uploadZone.addEventListener('dragleave', () => {
    els.uploadZone.classList.remove('drag-over');
  });
  els.uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.uploadZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
      processFile(e.dataTransfer.files[0]);
    }
  });

  // Remove file
  els.removeFile.addEventListener('click', async () => {
    els.resumeText.value = '';
    els.fileInfo.hidden = true;
    els.resumeTextSection.hidden = true;
    els.fileInput.value = '';
    await chrome.storage.local.remove(['resumeFileName']);
    updateStatus();
  });

  // Save button
  els.saveBtn.addEventListener('click', handleSave);
}

function setupCollapsible(toggleBtn, body, chevron) {
  toggleBtn.addEventListener('click', () => {
    const isCollapsed = body.classList.toggle('collapsed');
    chevron.classList.toggle('collapsed', isCollapsed);
  });
}

// ──────────────────────────────────────────────
// Model Fetching & Auto-Detection
// ──────────────────────────────────────────────

/**
 * Detect if the API key is a Google Gemini key and auto-fill base URL.
 */
function autoDetectProvider(apiKey) {
  if (apiKey.startsWith('AIza') && !els.apiBaseUrl.value.trim()) {
    els.apiBaseUrl.value = 'https://generativelanguage.googleapis.com/v1beta/openai';
    els.modelHint.textContent = 'Gemini API detected — base URL auto-filled';
  }
}

/**
 * Determine if current configuration points to Google Gemini.
 */
function isGeminiProvider() {
  const key = els.apiKey.value.trim();
  const url = els.apiBaseUrl.value.trim();
  return key.startsWith('AIza') || url.includes('generativelanguage.googleapis.com');
}

/**
 * Fetch models from the API and populate the dropdown.
 */
async function fetchAndPopulateModels() {
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    els.modelHint.textContent = 'Enter an API key to load models';
    return;
  }

  const refreshBtn = els.refreshModels;
  refreshBtn.classList.add('loading');
  els.apiModel.disabled = true;
  els.modelHint.textContent = 'Loading models…';

  try {
    let models;

    if (isGeminiProvider()) {
      models = await fetchGeminiModels(apiKey);
    } else {
      models = await fetchOpenAIModels(apiKey);
    }

    if (models.length === 0) {
      els.modelHint.textContent = 'No models found — try a different key or enter custom';
      populateModelDropdown([], '');
    } else {
      // Cache the model list
      await chrome.storage.local.set({ cachedModels: models });

      // Get previously selected model
      const { apiModel: savedModel = '' } = await chrome.storage.local.get('apiModel');
      populateModelDropdown(models, savedModel);

      els.modelHint.textContent = `${models.length} models loaded from API`;
    }
  } catch (err) {
    console.error('Model fetch error:', err);
    els.modelHint.textContent = `Failed to load models: ${err.message}`;
    populateModelDropdown([], '');
  } finally {
    refreshBtn.classList.remove('loading');
    els.apiModel.disabled = false;
  }
}

/**
 * Fetch models from an OpenAI-compatible /models endpoint.
 */
async function fetchOpenAIModels(apiKey) {
  const baseUrl = (els.apiBaseUrl.value.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');

  const response = await fetch(`${baseUrl}/models`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });

  if (!response.ok) {
    throw new Error(`API returned ${response.status}`);
  }

  const data = await response.json();
  const models = (data.data || data.models || [])
    .map(m => m.id || m.name || '')
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  return models;
}

/**
 * Fetch models from Google Gemini's native API, then normalize names.
 * Uses the native /models endpoint which gives richer metadata.
 */
async function fetchGeminiModels(apiKey) {
  // Try native Gemini API first (better model info)
  const nativeUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`;

  const response = await fetch(nativeUrl);
  if (!response.ok) {
    // Fallback to OpenAI-compat endpoint
    return fetchOpenAIModels(apiKey);
  }

  const data = await response.json();
  const models = (data.models || [])
    .filter(m => {
      // Only show models that support generateContent (chat)
      const methods = m.supportedGenerationMethods || [];
      return methods.includes('generateContent');
    })
    .map(m => m.name?.replace('models/', '') || '')
    .filter(Boolean)
    .sort((a, b) => {
      // Sort: flash models first, then pro, then others
      const rank = (s) => s.includes('flash') ? 0 : s.includes('pro') ? 1 : 2;
      return rank(a) - rank(b) || a.localeCompare(b);
    });

  return models;
}

/**
 * Populate the model select dropdown with a list of model IDs.
 */
function populateModelDropdown(models, selectedModel) {
  const select = els.apiModel;
  select.innerHTML = '';

  if (models.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No models available';
    select.appendChild(opt);
  } else {
    for (const model of models) {
      const opt = document.createElement('option');
      opt.value = model;
      opt.textContent = model;
      if (model === selectedModel) opt.selected = true;
      select.appendChild(opt);
    }

    // If saved model isn't in the list, add it at the top
    if (selectedModel && !models.includes(selectedModel)) {
      const opt = document.createElement('option');
      opt.value = selectedModel;
      opt.textContent = `${selectedModel} (saved)`;
      opt.selected = true;
      select.insertBefore(opt, select.firstChild);
    }
  }

  // Always add "Custom model" option at the end
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = '✏️  Enter custom model name…';
  select.appendChild(customOpt);

  // Update count badge
  if (models.length > 0) {
    els.modelCount.textContent = `${models.length}`;
    els.modelCount.hidden = false;
  } else {
    els.modelCount.hidden = true;
  }

  // Hide custom input if not selected
  els.customModelWrapper.hidden = select.value !== '__custom__';
}

// ──────────────────────────────────────────────
// File Upload Handling
// ──────────────────────────────────────────────

function handleFileSelect(e) {
  if (e.target.files.length > 0) {
    processFile(e.target.files[0]);
  }
}

async function processFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (!['pdf', 'txt', 'text'].includes(ext)) {
    showStatusMessage('Unsupported file type. Please use PDF or TXT.', 'error');
    return;
  }

  showFileInfo(file.name);
  await chrome.storage.local.set({ resumeFileName: file.name });

  try {
    let text;
    if (ext === 'pdf') {
      const arrayBuffer = await file.arrayBuffer();
      text = await extractTextFromPDF(arrayBuffer);
      if (!text || text.trim().length < 20) {
        text = '⚠️ Could not extract enough text from this PDF.\n\nPlease paste your resume content manually below.';
      }
    } else {
      text = await file.text();
    }

    els.resumeText.value = text;
    els.resumeTextSection.hidden = false;
    updateStatus();
  } catch (err) {
    console.error('File processing error:', err);
    els.resumeText.value = '';
    els.resumeTextSection.hidden = false;
    showStatusMessage('Failed to read file. Please paste your resume text manually.', 'error');
  }
}

function showFileInfo(name) {
  els.fileName.textContent = name;
  els.fileInfo.hidden = false;
}

// ──────────────────────────────────────────────
// PDF Text Extraction (no external dependencies)
// ──────────────────────────────────────────────

async function extractTextFromPDF(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const rawStr = new TextDecoder('latin1').decode(bytes);

  // Find all stream…endstream blocks
  const chunks = [];
  const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
  let match;

  while ((match = streamRegex.exec(rawStr)) !== null) {
    const streamStart = match.index + match[0].indexOf('\n') + 1;
    const streamEnd = match.index + match[0].lastIndexOf('endstream');
    const rawContent = match[1];

    // Check if the preceding object dict specifies FlateDecode
    const dictStart = rawStr.lastIndexOf('<<', match.index);
    const dictContent = rawStr.substring(dictStart, match.index);
    const isFlate = dictContent.includes('FlateDecode');

    let decoded;

    if (isFlate) {
      // Extract raw stream bytes from the original buffer
      // Find the actual byte positions
      const headerBytes = new TextEncoder().encode('stream\n');
      let byteStart = -1;
      const matchBytes = new TextEncoder().encode(match[0].substring(0, 20));

      // Find stream start in bytes (search near the match position)
      for (let i = Math.max(0, match.index - 10); i < Math.min(bytes.length, match.index + 100); i++) {
        if (bytes[i] === 0x73 && bytes[i+1] === 0x74 && bytes[i+2] === 0x72 &&
            bytes[i+3] === 0x65 && bytes[i+4] === 0x61 && bytes[i+5] === 0x6D) { // "stream"
          // Skip "stream" + newline(s)
          byteStart = i + 6;
          if (bytes[byteStart] === 0x0D) byteStart++; // \r
          if (bytes[byteStart] === 0x0A) byteStart++; // \n
          break;
        }
      }

      if (byteStart === -1) continue;

      // Find endstream
      const endMarker = [0x65, 0x6E, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6D]; // "endstream"
      let byteEnd = -1;
      for (let i = byteStart; i < Math.min(bytes.length, match.index + match[0].length + 50); i++) {
        let found = true;
        for (let j = 0; j < endMarker.length; j++) {
          if (bytes[i + j] !== endMarker[j]) { found = false; break; }
        }
        if (found) {
          byteEnd = i;
          // Remove trailing whitespace before endstream
          while (byteEnd > byteStart && (bytes[byteEnd - 1] === 0x0A || bytes[byteEnd - 1] === 0x0D)) {
            byteEnd--;
          }
          break;
        }
      }

      if (byteEnd === -1 || byteEnd <= byteStart) continue;

      const compressedData = bytes.slice(byteStart, byteEnd);

      try {
        decoded = await decompressFlate(compressedData);
      } catch {
        continue; // Skip streams we can't decompress
      }
    } else {
      decoded = rawContent;
    }

    // Extract text from the PDF content stream
    const extracted = extractTextFromContentStream(decoded);
    if (extracted.trim()) {
      chunks.push(extracted);
    }
  }

  return chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Decompress FlateDecode (zlib) data using the DecompressionStream API.
 */
async function decompressFlate(compressedBytes) {
  // Try 'deflate' first (zlib-wrapped), then 'raw' if that fails
  for (const format of ['deflate', 'raw']) {
    try {
      const ds = new DecompressionStream(format);
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();

      writer.write(compressedBytes);
      writer.close();

      const outputChunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        outputChunks.push(value);
      }

      // Combine chunks
      const totalLength = outputChunks.reduce((sum, c) => sum + c.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of outputChunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }

      return new TextDecoder('latin1').decode(result);
    } catch {
      continue;
    }
  }
  throw new Error('Decompression failed');
}

/**
 * Extract human-readable text from a PDF content stream.
 * Handles Tj, TJ, ', and " text operators.
 */
function extractTextFromContentStream(stream) {
  const lines = [];
  let inText = false;

  // Split by lines for processing
  const streamLines = stream.split('\n');

  for (const line of streamLines) {
    const trimmed = line.trim();

    if (trimmed === 'BT') { inText = true; continue; }
    if (trimmed === 'ET') { inText = false; continue; }

    if (!inText) continue;

    // Handle Tj operator: (text) Tj
    const tjMatches = trimmed.matchAll(/\(([^)]*)\)\s*Tj/g);
    for (const m of tjMatches) {
      lines.push(decodePdfString(m[1]));
    }

    // Handle TJ operator: [(text)(text)] TJ
    if (trimmed.endsWith('TJ')) {
      const arrayMatch = trimmed.match(/\[([^\]]*)\]\s*TJ/);
      if (arrayMatch) {
        const content = arrayMatch[1];
        const textParts = content.matchAll(/\(([^)]*)\)/g);
        const combined = [];
        for (const p of textParts) {
          combined.push(decodePdfString(p[1]));
        }
        if (combined.length > 0) lines.push(combined.join(''));
      }
    }

    // Handle ' operator (move to next line and show text)
    const tickMatch = trimmed.match(/\(([^)]*)\)\s*'/);
    if (tickMatch) {
      lines.push(decodePdfString(tickMatch[1]));
    }

    // Handle text positioning that implies newline (Td, TD, T*)
    if (trimmed.endsWith('T*') || trimmed.match(/[-\d.]+ [-\d.]+ Td/)) {
      // Potential line break
      if (lines.length > 0 && lines[lines.length - 1] !== '') {
        lines.push('');
      }
    }
  }

  return lines.join(' ').replace(/\s+/g, ' ').replace(/ {2,}/g, '\n');
}

/**
 * Decode basic PDF string escape sequences.
 */
function decodePdfString(str) {
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

// ──────────────────────────────────────────────
// Save Handler
// ──────────────────────────────────────────────

async function handleSave() {
  const btn = els.saveBtn;

  // Show loading state
  btn.classList.add('saving');
  els.btnText.hidden = true;
  els.btnLoader.hidden = false;
  els.btnCheck.hidden = true;

  try {
    await saveSettings();

    // Brief delay for visual feedback
    await new Promise(r => setTimeout(r, 400));

    // Show success state
    els.btnLoader.hidden = true;
    els.btnCheck.hidden = false;
    btn.classList.remove('saving');
    btn.classList.add('saved');

    updateStatus();

    // Reset button after 1.5s
    setTimeout(() => {
      btn.classList.remove('saved');
      els.btnCheck.hidden = true;
      els.btnText.hidden = false;
    }, 1500);

  } catch (err) {
    console.error('Save failed:', err);
    btn.classList.remove('saving');
    els.btnLoader.hidden = true;
    els.btnText.hidden = false;
    els.btnText.textContent = 'Save Failed';
    setTimeout(() => {
      els.btnText.textContent = 'Save Settings';
    }, 2000);
  }
}

// ──────────────────────────────────────────────
// Status Indicator
// ──────────────────────────────────────────────

async function updateStatus() {
  const apiKey = els.apiKey.value.trim();
  const resumeText = els.resumeText.value.trim();

  if (apiKey && resumeText) {
    els.statusBar.className = 'status-bar ready';
    els.statusText.textContent = 'Ready — right-click selected text to generate';
  } else {
    const missing = [];
    if (!apiKey) missing.push('API key');
    if (!resumeText) missing.push('resume');
    els.statusBar.className = 'status-bar error';
    els.statusText.textContent = `Missing: ${missing.join(' & ')}`;
  }
}

function showStatusMessage(message, type) {
  els.statusBar.className = `status-bar ${type}`;
  els.statusText.textContent = message;
}
