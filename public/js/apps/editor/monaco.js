// Loads Monaco (the VS Code editor component) on demand and configures it.
import { on } from '../../core/events.js';
import { currentTint } from '../../shell/style.js';
export let monacoPromise = null;
export const darkQuery = matchMedia('(prefers-color-scheme: dark)');
// With a tint chosen in 設定 → 樣式 the editor gets a matching theme;
// otherwise it follows the system light/dark setting.
export const themeName = () => (currentTint().vars ? 'remosh-tint' : darkQuery.matches ? 'vs-dark' : 'vs');

function syncTheme(monaco) {
  const tint = currentTint();
  if (tint.vars) {
    monaco.editor.defineTheme('remosh-tint', {
      base: tint.dark ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': tint.vars['--surface'],
        'editor.lineHighlightBackground': tint.vars['--surface-2'],
        'editorLineNumber.foreground': tint.vars['--muted'],
        'editorLineNumber.activeForeground': tint.vars['--text'],
        'editor.selectionBackground': tint.vars['--select'],
        'editorWidget.background': tint.vars['--surface-2'],
        'editorWidget.border': tint.vars['--border'],
      },
    });
  }
  monaco.editor.setTheme(themeName());
}

export function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    // Absolute URL: the language-service web workers resolve it from a blob: context.
    window.require.config({ paths: { vs: location.origin + '/vs' }, 'vs/nls': { availableLanguages: { '*': 'zh-tw' } } });
    window.require(['vs/editor/editor.main'], () => {
      const monaco = window.monaco;
      const ts = monaco.languages.typescript;
      for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) {
        d.setCompilerOptions({
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.NodeJs,
          allowNonTsExtensions: true,
          allowJs: true,
          jsx: ts.JsxEmit.Preserve,
          noEmit: true,
        });
        // Each file is checked alone (its imports are not on this machine),
        // so silence "cannot find module / node types" noise.
        d.setDiagnosticsOptions({ diagnosticCodesToIgnore: [2307, 2792, 7016, 2580, 2591, 2688] });
      }
      darkQuery.addEventListener('change', () => syncTheme(monaco));
      on('settings:changed', () => syncTheme(monaco));
      syncTheme(monaco);
      resolve(monaco);
    }, reject);
  });
  monacoPromise.catch(() => {
    monacoPromise = null;
  });
  return monacoPromise;
}

export const NAME_LANG = {
  '.bashrc': 'shell', '.bash_profile': 'shell', '.bash_logout': 'shell', '.profile': 'shell', '.zshrc': 'shell',
  '.gitconfig': 'ini', '.editorconfig': 'ini', '.npmrc': 'ini', '.env': 'ini',
  makefile: 'makefile', dockerfile: 'dockerfile',
};
export const EXT_LANG = { conf: 'ini', cfg: 'ini', service: 'ini', asp: 'html', asa: 'html', inc: 'php', jsonc: 'json', mjs: 'javascript', cjs: 'javascript', env: 'ini' };
