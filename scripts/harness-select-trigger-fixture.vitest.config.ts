import { standardDecoratorPlugin, vitestExecArgv } from '/Users/asahi/Documents/Codex/deepseek-harness/vitest.shared.ts'

export default {
  root: '/Users/asahi/Documents/Codex/deepseek-harness',
  resolve: { tsconfigPaths: true },
  plugins: [standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    include: ['/Users/asahi/Documents/Codex/VCPChat-newarchitecture/scripts/capture-harness-select-trigger-fixture.e2e.ts'],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
}
