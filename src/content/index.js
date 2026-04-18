import { watchForEmail } from './detector.js';
import { injectAnalyzeButton, removeAnalyzeButton } from './button.js';
import { toggle as toggleSidebar } from '../sidebar/sidebar.js';

(function init() {
  const stopWatching = watchForEmail(onEmailOpen);
  window.addEventListener('beforeunload', stopWatching);
})();

function onEmailOpen(messageEl) {
  injectAnalyzeButton(() => onAnalyzeClick(messageEl));
}

async function onAnalyzeClick(_messageEl) {
  toggleSidebar();
}
