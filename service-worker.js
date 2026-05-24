/**
 * Kardasti — Service Worker
 *
 * Handles context menu creation, AI API calls, clipboard copy,
 * PDF generation & download, and toast notifications.
 *
 * All state is stored in chrome.storage.local — no global variables.
 * All event listeners registered synchronously at the top level.
 */

import { generatePDF } from './lib/pdf-generator.js';

// ──────────────────────────────────────────────
// Event Listeners (registered synchronously)
// ──────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'generate-cover-letter',
      title: 'Generate Cover Letter',
      contexts: ['selection']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'generate-cover-letter') return;
  await handleGenerateCoverLetter(info.selectionText, tab);
});

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_STATUS') {
    (async () => {
      const data = await chrome.storage.local.get(['apiKey', 'resumeText']);
      sendResponse({
        hasApiKey: Boolean(data.apiKey),
        hasResume: Boolean(data.resumeText)
      });
    })();
    return true;
  }
});

// ──────────────────────────────────────────────
// Core Logic
// ──────────────────────────────────────────────

async function handleGenerateCoverLetter(selectionText, tab) {
  if (!selectionText || !selectionText.trim()) return;

  const jobDescription = selectionText.trim();

  // Show loading toast
  await showToast(tab.id, '⏳ Generating your cover letter…', 'loading');

  try {
    // Read settings from storage
    const {
      apiKey = '',
      apiBaseUrl = 'https://api.openai.com/v1',
      apiModel = 'gpt-4o-mini',
      resumeText = ''
    } = await chrome.storage.local.get([
      'apiKey', 'apiBaseUrl', 'apiModel', 'resumeText'
    ]);

    if (!apiKey) {
      await showToast(tab.id, '🔑 Please set your API key in Kardasti settings', 'error');
      return;
    }

    if (!resumeText) {
      await showToast(tab.id, '📄 Please upload your resume in Kardasti settings', 'error');
      return;
    }

    // Call the AI API
    const coverLetter = await callAI(apiKey, apiBaseUrl, apiModel, resumeText, jobDescription);

    // Copy to clipboard (via content script injection)
    await copyToClipboard(tab.id, coverLetter);

    // Generate PDF and trigger download
    await downloadCoverLetterPDF(coverLetter);

    // Show success toast
    await showToast(tab.id, '✅ Cover letter copied to clipboard & PDF downloaded!', 'success');

  } catch (err) {
    console.error('Kardasti error:', err);
    const errorMsg = err.message.length > 120
      ? err.message.substring(0, 120) + '…'
      : err.message;
    await showToast(tab.id, `❌ ${errorMsg}`, 'error');
  }
}

// ──────────────────────────────────────────────
// AI API Call
// ──────────────────────────────────────────────

async function callAI(apiKey, baseUrl, model, resume, jobDescription) {
  const systemPrompt = `You are an expert career coach and professional cover letter writer. Generate a compelling, personalized cover letter based on the candidate's resume and the job description provided.

Guidelines:
- Write a professionally formatted cover letter
- Highlight relevant experience and skills from the resume that match the job requirements
- Show genuine interest in the role and company
- Keep it concise (300–400 words)
- Match the language of the job description (if the job is in French, write in French, etc.)
- Do NOT include placeholder brackets or template text — write a complete, ready-to-send letter
- Use a natural, confident tone — not robotic or generic
- Start with a proper greeting and end with a professional sign-off`;

  const userPrompt = `Here is my resume:

${resume}

---

Here is the job description:

${jobDescription}

Please write a personalized cover letter for this position.`;

  // Normalize base URL (remove trailing slash)
  const normalizedUrl = baseUrl.replace(/\/+$/, '');

  const response = await fetch(`${normalizedUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 2048
    })
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    let errorMsg = `API error ${response.status}`;
    try {
      const parsed = JSON.parse(errorBody);
      errorMsg = parsed.error?.message || errorMsg;
    } catch {
      if (errorBody) errorMsg += `: ${errorBody.substring(0, 200)}`;
    }
    throw new Error(errorMsg);
  }

  const data = await response.json();

  if (!data.choices || !data.choices[0]) {
    throw new Error('Unexpected API response format');
  }

  return data.choices[0].message.content.trim();
}

// ──────────────────────────────────────────────
// Clipboard Copy (via content script)
// ──────────────────────────────────────────────

async function copyToClipboard(tabId, text) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: async (coverLetter) => {
        try {
          await navigator.clipboard.writeText(coverLetter);
        } catch {
          // Fallback for pages where clipboard API is restricted
          const textarea = document.createElement('textarea');
          textarea.value = coverLetter;
          textarea.style.cssText = 'position:fixed;opacity:0;left:-9999px';
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
        }
      },
      args: [text]
    });
  } catch (err) {
    console.error('Clipboard copy failed:', err);
  }
}

// ──────────────────────────────────────────────
// PDF Download
// ──────────────────────────────────────────────

async function downloadCoverLetterPDF(coverLetterText) {
  const pdfBytes = generatePDF(coverLetterText);

  // Convert Uint8Array to base64 data URL
  let binary = '';
  for (let i = 0; i < pdfBytes.length; i++) {
    binary += String.fromCharCode(pdfBytes[i]);
  }
  const base64 = btoa(binary);
  const dataUrl = `data:application/pdf;base64,${base64}`;

  // Generate a readable filename with date
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const filename = `cover-letter-${dateStr}.pdf`;

  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false
  });
}

// ──────────────────────────────────────────────
// Toast Notifications (injected into active tab)
// ──────────────────────────────────────────────

async function showToast(tabId, message, type = 'info') {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg, toastType) => {
        // Remove any existing Kardasti toasts
        document.querySelectorAll('.kardasti-toast').forEach(el => el.remove());

        const toast = document.createElement('div');
        toast.className = 'kardasti-toast';

        const gradients = {
          loading: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          success: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)',
          error: 'linear-gradient(135deg, #eb3349 0%, #f45c43 100%)',
          info: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)'
        };

        toast.textContent = msg;

        Object.assign(toast.style, {
          position: 'fixed',
          top: '24px',
          right: '24px',
          zIndex: '2147483647',
          padding: '16px 28px',
          borderRadius: '14px',
          background: gradients[toastType] || gradients.info,
          color: '#fff',
          fontSize: '14px',
          fontWeight: '600',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          letterSpacing: '0.01em',
          lineHeight: '1.4',
          boxShadow: '0 12px 48px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.12) inset',
          backdropFilter: 'blur(16px)',
          maxWidth: '420px',
          transform: 'translateY(-20px) scale(0.95)',
          opacity: '0',
          transition: 'all 0.45s cubic-bezier(0.34, 1.56, 0.64, 1)',
          pointerEvents: 'none'
        });

        document.body.appendChild(toast);

        // Animate in
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            toast.style.transform = 'translateY(0) scale(1)';
            toast.style.opacity = '1';
          });
        });

        // Auto-dismiss (except loading)
        if (toastType !== 'loading') {
          setTimeout(() => {
            toast.style.transform = 'translateY(-20px) scale(0.95)';
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 450);
          }, 5000);
        }
      },
      args: [message, type]
    });
  } catch (err) {
    console.error('Failed to show toast:', err);
  }
}
