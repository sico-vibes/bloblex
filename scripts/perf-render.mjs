// The render budget: a 1,000-message conversation mounted in a test, on its own because it takes about a minute.
import { spawnSync } from 'node:child_process'

const result = spawnSync('npx', ['vitest', 'run', 'src/ui/perf.mounted.test.tsx', '--testTimeout=300000'], {
  cwd: new URL('../apps/desktop/', import.meta.url),
  env: { ...process.env, BITBOTS_PERF_RENDER: '1' },
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
process.exit(result.status ?? 1)
