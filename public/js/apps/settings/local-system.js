// The computer this page is shown on: its system and browser, as far as the
// browser tells.
export function localSystem() {
  const ua = navigator.userAgent;
  const os = /Windows NT 10/.test(ua) ? 'Windows 10 / 11'
    : /Windows/.test(ua) ? 'Windows'
      : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
        : /Android/.test(ua) ? 'Android'
          : /CrOS/.test(ua) ? 'ChromeOS'
            : /Mac OS X/.test(ua) ? 'macOS'
              : /Linux/.test(ua) ? 'Linux'
                : navigator.platform || '—';
  const pick = (re) => ua.match(re)?.[1];
  const browser = pick(/Edg\/(\d+)/) ? 'Edge ' + pick(/Edg\/(\d+)/)
    : pick(/OPR\/(\d+)/) ? 'Opera ' + pick(/OPR\/(\d+)/)
      : pick(/Firefox\/(\d+)/) ? 'Firefox ' + pick(/Firefox\/(\d+)/)
        : pick(/Chrome\/(\d+)/) ? 'Chrome ' + pick(/Chrome\/(\d+)/)
          : pick(/Version\/(\d+)[\d.]* .*Safari/) ? 'Safari ' + pick(/Version\/(\d+)[\d.]* .*Safari/)
            : '';
  return [os, browser].filter(Boolean).join(' · ');
}
