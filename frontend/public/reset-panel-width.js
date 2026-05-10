// Emergency script to reset agent panel width if it gets corrupted
// Run this in browser console if panel is truncated:
// localStorage.setItem('velxio.agent.panel.width', '480');
// Then refresh the page

(function() {
  const key = 'velxio.agent.panel.width';
  const currentWidth = localStorage.getItem(key);
  const numericWidth = Number(currentWidth);
  
  console.log('[Panel Width Check]', {
    stored: currentWidth,
    numeric: numericWidth,
    isValid: numericWidth >= 360 && numericWidth <= 800
  });
  
  // Auto-fix if corrupted
  if (!currentWidth || isNaN(numericWidth) || numericWidth < 360 || numericWidth > 800) {
    console.warn('[Panel Width] Corrupted value detected, resetting to 480px');
    localStorage.setItem(key, '480');
    console.log('[Panel Width] Fixed! Please refresh the page.');
  } else {
    console.log('[Panel Width] OK');
  }
})();
