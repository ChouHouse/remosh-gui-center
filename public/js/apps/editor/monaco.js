// Loads Monaco (the VS Code editor component) on demand and configures it.
import { tintOf, registerTintTarget, reapplyTint } from '../../shell/style.js';
export let monacoPromise = null;
export const darkQuery = matchMedia('(prefers-color-scheme: dark)');
// The editor follows the system light/dark setting; its own tint (設定 → 樣式
// → 編輯器) only colours the cursor, selection and active line number.
export const themeName = () => (tintOf('editor').color ? 'remosh-tint' : darkQuery.matches ? 'vs-dark' : 'vs');

function syncTheme(monaco) {
  const t = tintOf('editor');
  if (t.color) {
    monaco.editor.defineTheme('remosh-tint', {
      base: darkQuery.matches ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editorCursor.foreground': t.shade,
        'editor.selectionBackground': t.shade + '55',
        'editor.inactiveSelectionBackground': t.shade + '30',
        'editorLineNumber.activeForeground': t.shade,
      },
    });
  }
  monaco.editor.setTheme(themeName());
}

registerTintTarget({
  id: 'editor',
  label: '編輯器',
  description: '游標、選取範圍與目前行號的顏色',
  apply() {
    if (window.monaco) syncTheme(window.monaco); // before Monaco loads there is nothing to colour yet
  },
});

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
      reapplyTint('editor');
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
