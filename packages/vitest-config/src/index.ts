export const sharedVitestConfig = {
  test: {
    globals: true,
    silent: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // Type-only contracts have no runtime to execute.
        'src/types/**/*.ts',
        'src/stores/cache-store.ts',
        'src/stores/dedupe-store.ts',
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
      perFile: true,
    },
  },
};
