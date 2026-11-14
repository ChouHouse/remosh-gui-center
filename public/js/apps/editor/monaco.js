// Loads Monaco (the VS Code editor component) on demand and configures it.
import { on } from '../../core/events.js';
import { getLang } from '../../core/i18n.js';
import { effectiveMode, onDeviceModeChange } from '../../shell/style.js';
import { data, themePref } from './prefs.js';
export let monacoPromise = null;
// Monaco's own menus and messages, in the system language (English is built in).
const MONACO_LOCALE = { 'zh-TW': 'zh-tw', ja: 'ja' };
// The code editor is its own app with its own colours: it does not take the
// system colour. Light or dark is the user's choice for Procoder (prefs.js);
// until they have chosen, it goes by the desktop.
export const procoderMode = () => themePref() || (effectiveMode() === 'dark' ? 'dark' : 'light');
export const themeName = () => (procoderMode() === 'dark' ? 'vs-dark' : 'vs');

export function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    // Absolute URL: the language-service web workers resolve it from a blob: context.
    window.require.config({ paths: { vs: location.origin + '/vs' }, 'vs/nls': { availableLanguages: MONACO_LOCALE[getLang()] ? { '*': MONACO_LOCALE[getLang()] } : {} } });
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
      const sync = () => monaco.editor.setTheme(themeName());
      onDeviceModeChange(sync);
      on('settings:changed', sync);
      data.onChange(sync);
      sync();
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
