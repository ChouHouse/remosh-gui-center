// Cloudflare Workers: TCP through cloudflare:sockets, and only the SSH
// algorithms that workerd's node:crypto can run.
import { connect } from 'cloudflare:sockets';
import { ALGORITHMS, socketToDuplex } from '../ssh.js';
import { withTimeout } from '../util.js';

export const workerPlatform = {
  name: 'worker',
  blocksPrivateHosts: true,
  algorithms: ALGORITHMS,
  async openSocket(host, port, timeoutMs) {
    const socket = connect({ hostname: host, port });
    try {
      await withTimeout(socket.opened, timeoutMs, 'connect-timeout');
    } catch (err) {
      socket.close().catch(() => {});
      throw err;
    }
    return socketToDuplex(socket);
  },
};
