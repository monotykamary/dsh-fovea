import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], exclude: ['tests/fixtures/**'], testTimeout: 90_000, hookTimeout: 90_000 } })
