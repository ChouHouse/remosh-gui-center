// The interface language is a system setting: it follows the account's
// settings as soon as they are known. (core/i18n.js keeps the last choice in
// the browser, which is what the login screen uses.)
import { on } from '../core/events.js';
import { getSettings } from '../core/settings.js';
import { setLang, translateDom } from '../core/i18n.js';

const follow = () => setLang(getSettings().system.lang);
on('settings:changed', follow);
translateDom();
