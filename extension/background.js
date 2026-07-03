// Opens the Task List app as a tab when Chrome starts, and once on install.
const APP_URL = 'http://localhost:4000';

function openApp() {
  chrome.tabs.create({ url: APP_URL });
}

// Fires when a Chrome profile with this extension starts up.
chrome.runtime.onStartup.addListener(openApp);

// Open once right after installing so the user sees it immediately.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') openApp();
});
