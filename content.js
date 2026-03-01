/**
 * JITRACK Chrome Extension - Content Script
 * Scrapes JIRA issue data using multiple strategies (selectors + XPath)
 */

(function() {
  'use strict';

  // Prevent duplicate injection
  if (window.__jitrackInjected) return;
  window.__jitrackInjected = true;

  // Configuration
  const JITRACK_PORTS = [8765, 8766, 8767, 8768, 8769];
  const AUTH_TOKEN_KEY = 'jitrack_auth_token';
  let authToken = localStorage.getItem(AUTH_TOKEN_KEY);
  
  /**
   * Get auth token from server
   */
  async function getAuthToken(port) {
    try {
      const response = await fetch(`http://localhost:${port}/api/config`, {
        method: 'GET',
        mode: 'cors',
        headers: { 'Accept': 'application/json' }
      });
      
      if (response.ok) {
        const data = await response.json();
        authToken = data.token;
        localStorage.setItem(AUTH_TOKEN_KEY, authToken);
        return authToken;
      }
    } catch (e) {
      console.error('Failed to get auth token:', e);
    }
    return null;
  }

  /**
   * Helper: Evaluate XPath expression
   */
  function $x(xpath, context) {
    context = context || document;
    const result = document.evaluate(
      xpath, 
      context, 
      null, 
      XPathResult.FIRST_ORDERED_NODE_TYPE, 
      null
    );
    return result.singleNodeValue;
  }

  /**
   * Helper: Get text content safely
   */
  function getText(element) {
    return element ? element.textContent.trim() : null;
  }

  /**
   * Extract issue key using multiple strategies
   */
  function extractIssueKey() {
    // Strategy 1: Meta tag (most reliable)
    const metaKey = document.querySelector('meta[name="ajs-issue-key"]');
    if (metaKey?.content) return metaKey.content;

    // Strategy 2: From URL
    const urlMatch = window.location.href.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
    if (urlMatch) return urlMatch[1];

    // Strategy 3: XPath - issue key in breadcrumb
    const keyXPath = $x("//a[contains(@id, 'key-val') or contains(@class, 'issue-link') and contains(@href, '/browse/')]");
    if (keyXPath) {
      const match = keyXPath.textContent.match(/([A-Z][A-Z0-9]+-\d+)/);
      if (match) return match[1];
    }

    // Strategy 4: From page title
    const titleMatch = document.title.match(/\[([A-Z][A-Z0-9]+-\d+)\]/);
    if (titleMatch) return titleMatch[1];

    return null;
  }

  /**
   * Extract summary using multiple strategies
   */
  function extractSummary() {
    // Strategy 1: ID selector (JIRA Server)
    const summaryEl = document.getElementById('summary-val');
    if (summaryEl) return getText(summaryEl);

    // Strategy 2: XPath - h1 containing summary
    const h1XPath = $x("//h1[@id='summary-val'] | //h1[contains(@class, 'summary')]");
    if (h1XPath) return getText(h1XPath);

    // Strategy 3: From page title (fallback)
    const title = document.title;
    // Remove issue key and "- JIRA" suffix
    const cleanTitle = title.replace(/\[[^\]]+\]\s*/, '').replace(/\s+-\s+JIRA$/, '');
    if (cleanTitle) return cleanTitle;

    return null;
  }

  /**
   * Extract project name
   */
  function extractProject() {
    // Strategy 1: From project link
    const projectLink = document.getElementById('project-name-val');
    if (projectLink) return getText(projectLink);

    // Strategy 2: XPath - project name in breadcrumb
    const projectXPath = $x("//a[@id='project-name-val'] | //ol[contains(@class, 'breadcrumb')]//a[contains(@href, '/browse/')]");
    if (projectXPath) return getText(projectXPath);

    // Strategy 3: From issue key (first part)
    const issueKey = extractIssueKey();
    if (issueKey) return issueKey.split('-')[0];

    return null;
  }

  /**
   * Extract estimated time (Original Estimate)
   */
  function extractEstimatedHours() {
    // Strategy 1: Direct ID (JIRA Server 6.x)
    const estimateEl = document.getElementById('tt_single_values_orig');
    if (estimateEl) {
      const parsed = parseTimeEstimate(getText(estimateEl));
      if (parsed !== null) return parsed;
    }

    // Strategy 2: XPath - find by label text
    const xpathPatterns = [
      "//dl[contains(., 'Estimated')]//dd[contains(@class, 'tt_values')]",
      "//dt[contains(text(), 'Estimated') or contains(@id, 'orig')]//following-sibling::dd[1]",
      "//div[@id='timetrackingmodule']//dd[contains(@id, 'orig')]"
    ];

    for (const xpath of xpathPatterns) {
      const el = $x(xpath);
      if (el) {
        const parsed = parseTimeEstimate(getText(el));
        if (parsed !== null) return parsed;
      }
    }

    // Strategy 3: Look for any element with time-like content near "Original Estimate"
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (el.textContent.includes('Original Estimate') || el.textContent.includes('Estimated:')) {
        // Check next sibling or parent
        const sibling = el.nextElementSibling;
        if (sibling) {
          const parsed = parseTimeEstimate(getText(sibling));
          if (parsed !== null) return parsed;
        }
        // Check parent
        const parent = el.parentElement;
        if (parent) {
          const dd = parent.querySelector('dd');
          if (dd) {
            const parsed = parseTimeEstimate(getText(dd));
            if (parsed !== null) return parsed;
          }
        }
      }
    }

    return null;
  }

  /**
   * Parse time estimate from JIRA format to hours
   * Supports: 2h, 2 hours, 1d 2h, 1w 3d, 30m, 3600s
   */
  function parseTimeEstimate(text) {
    if (!text || text === '-' || text === 'None' || text === 'Not Specified' || text.toLowerCase().includes('none')) {
      return null;
    }

    text = text.trim();
    
    // If already parsed number
    const pureNumber = parseFloat(text);
    if (!isNaN(pureNumber) && pureNumber >= 0 && !text.match(/[a-z]/i)) {
      return pureNumber;
    }

    let totalHours = 0;
    let hasMatch = false;

    // Weeks (1w = 40h business hours)
    const weeks = text.match(/(\d+(?:\.\d+)?)\s*w(?:eeks?)?/i);
    if (weeks) {
      totalHours += parseFloat(weeks[1]) * 40;
      hasMatch = true;
    }

    // Days (1d = 8h business hours)
    const days = text.match(/(\d+(?:\.\d+)?)\s*d(?:ays?)?/i);
    if (days) {
      totalHours += parseFloat(days[1]) * 8;
      hasMatch = true;
    }

    // Hours
    const hours = text.match(/(\d+(?:\.\d+)?)\s*h(?:ours?)?/i);
    if (hours) {
      totalHours += parseFloat(hours[1]);
      hasMatch = true;
    }

    // Minutes (m not followed by s)
    const minutes = text.match(/(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?(?!s)/i);
    if (minutes) {
      totalHours += parseFloat(minutes[1]) / 60;
      hasMatch = true;
    }

    // Seconds
    const seconds = text.match(/(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?/i);
    if (seconds) {
      totalHours += parseFloat(seconds[1]) / 3600;
      hasMatch = true;
    }

    return hasMatch ? totalHours : null;
  }

  /**
   * Main function: Extract all issue data
   */
  function extractIssueData() {
    const issueKey = extractIssueKey();
    if (!issueKey) return null;

    const summary = extractSummary();
    const project = extractProject();
    const estimatedHours = extractEstimatedHours();

    return {
      issueKey,
      summary: summary || issueKey,
      project: project || issueKey.split('-')[0],
      url: window.location.href,
      estimatedHours
    };
  }

  /**
   * Check if JITRACK server is available
   */
  async function findServer() {
    for (const port of JITRACK_PORTS) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        
        const response = await fetch(`http://localhost:${port}/health`, {
          method: 'GET',
          mode: 'cors',
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
          const data = await response.json();
          if (data.status === 'ok') {
            return port;
          }
        }
      } catch (e) {
        // Server not available on this port
      }
    }
    return null;
  }

  /**
   * Send import request to server
   */
  async function sendImportRequest(port, issueData) {
    const response = await fetch(`http://localhost:${port}/api/import`, {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Jitrack-Token': authToken || 'development'
      },
      body: JSON.stringify({
        issueKey: issueData.issueKey,
        summary: issueData.summary,
        project: issueData.project,
        url: issueData.url,
        estimatedHours: issueData.estimatedHours
      })
    });
    return response;
  }

  /**
   * Export task to JITRACK
   */
  async function exportToJitrack(issueData, button) {
    const originalText = button.textContent;
    button.textContent = '⏳ Exporting...';
    button.disabled = true;

    try {
      const port = await findServer();

      if (!port) {
        showNotification('❌ JITRACK not running. Start jitrack in terminal first.', 'error');
        button.textContent = originalText;
        button.disabled = false;
        return;
      }

      // Get auth token if not available
      if (!authToken) {
        authToken = await getAuthToken(port);
      }

      // Try to send request
      let response = await sendImportRequest(port, issueData);

      // If unauthorized, get new token and retry
      if (response.status === 401) {
        console.log('Token expired, fetching new one...');
        authToken = await getAuthToken(port);
        
        if (authToken) {
          response = await sendImportRequest(port, issueData);
        } else {
          showNotification('❌ Failed to get auth token', 'error');
          button.textContent = originalText;
          button.disabled = false;
          return;
        }
      }

      if (response.ok) {
        const data = await response.json();
        const estimateInfo = issueData.estimatedHours ? ` (${issueData.estimatedHours}h)` : '';
        showNotification(`✅ Exported ${issueData.issueKey}${estimateInfo} to JITRACK!`, 'success');
        button.textContent = '✓ Exported';
        button.style.backgroundColor = '#36b37e';

        setTimeout(() => {
          button.textContent = originalText;
          button.disabled = false;
          button.style.backgroundColor = '';
        }, 3000);
      } else {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        showNotification(`❌ Export failed: ${error.error}`, 'error');
        button.textContent = originalText;
        button.disabled = false;
      }
    } catch (error) {
      showNotification(`❌ Error: ${error.message}`, 'error');
      button.textContent = originalText;
      button.disabled = false;
    }
  }

  /**
   * Show notification toast
   */
  function showNotification(message, type = 'info') {
    const existing = document.getElementById('jitrack-notification');
    if (existing) existing.remove();

    const notification = document.createElement('div');
    notification.id = 'jitrack-notification';
    notification.textContent = message;

    const colors = {
      success: '#36b37e',
      error: '#de350b',
      info: '#0052cc'
    };

    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 12px 24px;
      background: ${colors[type] || colors.info};
      color: white;
      border-radius: 4px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 500;
      z-index: 999999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      animation: jitrack-slide-in 0.3s ease-out;
      max-width: 400px;
      word-wrap: break-word;
    `;

    // Add animation styles if not present
    if (!document.getElementById('jitrack-styles')) {
      const style = document.createElement('style');
      style.id = 'jitrack-styles';
      style.textContent = `
        @keyframes jitrack-slide-in {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes jitrack-slide-out {
          from { transform: translateX(0); opacity: 1; }
          to { transform: translateX(100%); opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.style.animation = 'jitrack-slide-out 0.3s ease-in';
      setTimeout(() => notification.remove(), 300);
    }, 4000);
  }

  /**
   * Create and inject export button
   */
  function injectButton() {
    // Remove existing button to avoid duplicates
    const existingBtn = document.getElementById('jitrack-export-btn');
    if (existingBtn) existingBtn.remove();

    const issueData = extractIssueData();
    if (!issueData) return;

    // Try to find appropriate container (JIRA Server 6.x specific)
    const containerSelectors = [
      '#stalker .aui-page-header-actions',  // Header actions
      '.command-bar .ops-cont',             // Command bar
      '#viewissuesidebar',                  // Sidebar (fallback)
      'body'                                // Absolute fallback
    ];

    let container = null;
    for (const selector of containerSelectors) {
      container = document.querySelector(selector);
      if (container) break;
    }

    if (!container) return;

    // Create button
    const button = document.createElement('button');
    button.id = 'jitrack-export-btn';
    button.innerHTML = '<img src="' + chrome.runtime.getURL('logo.png') + '" alt="JITRACK" style="width:36px;height:36px;margin-right:10px;object-fit:contain;"> Export to JITRACK';
    button.className = 'jitrack-export-button';

    // Check if already exported (optional enhancement)
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      exportToJitrack(issueData, button);
    });

    // Insert into container
    if (container.tagName === 'BODY') {
      // Fixed position fallback
      button.style.cssText = `
        position: fixed;
        top: 80px;
        right: 20px;
        z-index: 9999;
      `;
    }

    container.appendChild(button);
  }

  /**
   * Initialize extension
   */
  function init() {
    // Initial injection
    setTimeout(injectButton, 1000); // Delay to let JIRA render

    // Watch for URL changes (SPA navigation)
    let lastUrl = location.href;
    new MutationObserver(() => {
      const url = location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        // Remove old button
        const oldBtn = document.getElementById('jitrack-export-btn');
        if (oldBtn) oldBtn.remove();
        // Inject new button
        setTimeout(injectButton, 1000);
      }
    }).observe(document, { subtree: true, childList: true });

    // Periodic check as fallback
    setInterval(() => {
      if (!document.getElementById('jitrack-export-btn')) {
        injectButton();
      }
    }, 5000);
  }

  // Run initialization
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
