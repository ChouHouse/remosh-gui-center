// Stand-in for native Node addons that cannot load inside a Worker.
// ssh2 requires them inside try/catch and falls back to pure JS / node:crypto.
throw new Error('native addon unavailable in Workers');
