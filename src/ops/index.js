// Op registry: the name the browser sends -> handler(ctx, msg).
// To add an op, write a handler in this folder and list it here.
import { realpath, list, stat, read, write, readChunk, writeChunk, mkdir } from './files.js';
import { stats } from './stats.js';
import { sysInfo } from './sysinfo.js';
import { remove, copy, move, chmod } from './manage.js';
import { procInfo, kill } from './process.js';
import { accountInfo, changePassword, createUser } from './account.js';
import { termOpen, termInput, termResize, termClose } from './terminal.js';
import { streamOpen, streamClose } from '../streams.js';
// Server side of Procoder's add-on modules (public/js/apps/editor/modules).
import { pyCollect } from './procoder/python.js';
import { jsCollect } from './procoder/node.js';

export const ops = {
  realpath, list, stat, read, write, readChunk, writeChunk, mkdir,
  remove, copy, move, chmod,
  stats, sysInfo, procInfo, kill,
  accountInfo, changePassword, createUser,
  termOpen, termInput, termResize, termClose,
  streamOpen, streamClose,
  pyCollect, jsCollect,
};
