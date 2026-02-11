import * as core from './index.js';

describe('core index exports', () => {
  it('re-exports runtime modules', () => {
    expect(core.HttpClient).toBeTypeOf('function');
    expect(core.HttpClientError).toBeTypeOf('function');
    expect(core.hashRequest).toBeTypeOf('function');
    expect(core.AdaptiveConfigSchema).toBeDefined();
    expect(core.DEFAULT_RATE_LIMIT).toBeDefined();
    expect(core.AdaptiveCapacityCalculator).toBeTypeOf('function');
  });
});
