const WINDOWS_TITLEBAR_OVERLAYS = Object.freeze({
  dark: Object.freeze({ color: '#111613', symbolColor: '#f2f6f2', height: 40 }),
  light: Object.freeze({ color: '#ffffff', symbolColor: '#172033', height: 40 })
});

function dashboardTitleBarOverlay(theme = 'dark') {
  return WINDOWS_TITLEBAR_OVERLAYS[theme === 'light' ? 'light' : 'dark'];
}

function dashboardWindowChrome(platform = process.platform, theme = 'dark') {
  if (platform === 'win32') {
    return Object.freeze({
      platform: 'win32',
      customTitleBar: true,
      controls: 'native',
      windowOptions: Object.freeze({
        frame: false,
        thickFrame: true,
        titleBarStyle: 'hidden',
        titleBarOverlay: dashboardTitleBarOverlay(theme),
        hasShadow: true,
        roundedCorners: true
      })
    });
  }
  if (platform === 'darwin') {
    return Object.freeze({
      platform: 'darwin',
      customTitleBar: true,
      controls: 'native',
      windowOptions: Object.freeze({
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: Object.freeze({ x: 14, y: 13 })
      })
    });
  }
  return Object.freeze({
    platform: platform === 'linux' ? 'linux' : 'other',
    customTitleBar: false,
    controls: 'native',
    windowOptions: Object.freeze({})
  });
}

function dashboardWindowChromeState(win, platform = process.platform) {
  const chrome = dashboardWindowChrome(platform);
  return {
    platform: chrome.platform,
    customTitleBar: chrome.customTitleBar,
    controls: chrome.controls,
    maximized: readWindowFlag(win, 'isMaximized'),
    minimized: readWindowFlag(win, 'isMinimized'),
    fullScreen: readWindowFlag(win, 'isFullScreen')
  };
}

function readWindowFlag(win, method) {
  try {
    return Boolean(win && typeof win[method] === 'function' && win[method]());
  } catch {
    return false;
  }
}

export { dashboardTitleBarOverlay, dashboardWindowChrome, dashboardWindowChromeState };
