// ssh2 compiles an optional native crypto addon at install time. A Worker
// cannot load .node files (and the bundler refuses them), so remove the build
// output; ssh2 then uses its node:crypto code paths.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(join(root, 'node_modules', 'ssh2', 'lib', 'protocol', 'crypto', 'build'), {
  recursive: true,
  force: true,
});
