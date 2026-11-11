// Op registry: the name the browser sends -> handler(ctx, msg).
// To add an op, write a handler in this folder and list it here.
import { realpath, list, stat, read, write, mkdir } from './files.js';
import { stats } from './stats.js';
import { remove, copy, move, chmod } from './manage.js';
import { termOpen, termInput, termResize, termClose } from './terminal.js';

export const ops = {
  realpath, list, stat, read, write, mkdir,
  remove, copy, move, chmod,
  stats,
  termOpen, termInput, termResize, termClose,
};
