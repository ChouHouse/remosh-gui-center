// Accounts on the SSH host: who am I, change my password, create a user.
// Commands are fixed; the only thing interpolated is a strictly validated user
// name. Passwords travel on stdin, never on a command line.
import { execCapture } from '../ssh.js';
import { codeError } from '../util.js';

const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const run = (client, command, stdin) => execCapture(client, command, 64 * 1024, 20000, stdin);

function secret(value, what) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\r\n]/.test(value)) throw codeError('bad-request', `Invalid ${what}`);
  return value;
}

async function whoami(client) {
  const out = await run(client, 'echo "$(id -u):$(id -un):$(id -nG)"; sudo -n true 2>/dev/null && echo NOPASSWD');
  const [uid, user, groups = ''] = out.split('\n')[0].split(':');
  const sudo = Number(uid) === 0 ? 'root' : /NOPASSWD/.test(out) ? 'nopasswd' : /(^|\s)(sudo|wheel|admin)(\s|$)/.test(groups) ? 'password' : 'none';
  return { uid: Number(uid), user, sudo };
}

// sudo: 'root' | 'nopasswd' | 'password' (sudo will ask for one) | 'none'
export async function accountInfo({ client }) {
  const me = await whoami(client);
  const list = await run(client, "getent passwd | awk -F: '($3 == 0 || $3 >= 1000) && $3 < 65000 && $7 !~ /(nologin|false)$/ { print $1 \":\" $3 \":\" $6 }'");
  const users = list.split('\n').filter(Boolean).map((line) => {
    const [name, uid, home] = line.split(':');
    return { name, uid: Number(uid), home };
  });
  return { ...me, users };
}

export async function changePassword({ client }, msg) {
  const next = secret(msg.newPassword, 'new password');
  const me = await whoami(client);
  const out = me.uid === 0
    ? await run(client, 'chpasswd 2>&1; echo "rc=$?"', `${me.user}:${next}\n`)
    : await run(client, 'LC_ALL=C passwd 2>&1; echo "rc=$?"', `${secret(msg.oldPassword, 'current password')}\n${next}\n${next}\n`);
  if (/rc=0\s*$/.test(out)) return { user: me.user };
  const reason = out.split('\n').find((l) => /BAD PASSWORD|too short|too simple|similar/i.test(l));
  throw codeError('wrong-password', reason ? reason.trim() : 'Password not changed');
}

export async function createUser({ client }, msg) {
  const name = String(msg.username || '');
  if (!USER_NAME.test(name)) throw codeError('bad-username', 'Invalid user name');
  const password = secret(msg.password, 'password');
  const me = await whoami(client);
  const make = `useradd -m -s /bin/bash -- ${name} && chpasswd`;
  let out;
  if (me.sudo === 'root') out = await run(client, `{ ${make}; } 2>&1; echo "rc=$?"`, `${name}:${password}\n`);
  else if (me.sudo === 'nopasswd') out = await run(client, `sudo -n sh -c '${make}' 2>&1; echo "rc=$?"`, `${name}:${password}\n`);
  else if (me.sudo === 'password') {
    // sudo -S takes its password from the first line; the rest reaches chpasswd.
    out = await run(client, `sudo -S -p '' sh -c '${make}' 2>&1; echo "rc=$?"`, `${secret(msg.sudoPassword, 'sudo password')}\n${name}:${password}\n`);
  } else throw codeError('permission-denied', 'Needs root or sudo');
  if (/rc=0\s*$/.test(out)) return { username: name };
  if (/already exists/i.test(out)) throw codeError('exists', 'User already exists');
  if (/incorrect password|try again|password is required|not in the sudoers|not allowed/i.test(out)) throw codeError('sudo-failed', 'sudo refused');
  throw codeError('failure', out.replace(/rc=\d+\s*$/, '').trim().split('\n').pop() || 'Could not create the user');
}
