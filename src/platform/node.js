// Node (the Docker image): plain net sockets, every algorithm ssh2 supports,
// and private/LAN addresses are reachable.
import net from 'node:net';
import { codeError } from '../util.js';

export const nodePlatform = {
  name: 'node',
  blocksPrivateHosts: false,
  algorithms: undefined,
  openSocket(host, port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(codeError('connect-timeout', 'Timed out'));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  },
};
