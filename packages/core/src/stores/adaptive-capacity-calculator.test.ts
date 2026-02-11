import { AdaptiveCapacityCalculator } from './adaptive-capacity-calculator.js';

describe('AdaptiveCapacityCalculator', () => {
  const fixedNow = 1_700_000_000_000;

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses schema defaults when config is omitted', () => {
    const calculator = new AdaptiveCapacityCalculator();

    expect(calculator.config.monitoringWindowMs).toBe(15 * 60 * 1000);
    expect(calculator.config.highActivityThreshold).toBe(10);
    expect(calculator.config.moderateActivityThreshold).toBe(3);
  });

  it('throws for invalid threshold ordering', () => {
    expect(
      () =>
        new AdaptiveCapacityCalculator({
          highActivityThreshold: 4,
          moderateActivityThreshold: 4,
        }),
    ).toThrow(/moderateActivityThreshold/);
  });

  it('prioritizes users and can pause background on high increasing activity', () => {
    const calculator = new AdaptiveCapacityCalculator({
      highActivityThreshold: 5,
      moderateActivityThreshold: 2,
      monitoringWindowMs: 900_000,
    });

    const now = Date.now();
    const requests = [
      now - 299_000,
      now - 250_000,
      now - 60_000,
      now - 40_000,
      now - 20_000,
      now - 10_000,
    ];

    const result = calculator.calculateDynamicCapacity('items', 100, {
      recentUserRequests: requests,
      recentBackgroundRequests: [now - 5_000],
      userActivityTrend: 'stable',
    });

    expect(result.userReserved).toBeGreaterThan(0);
    expect(result.backgroundMax).toBeLessThan(100);
    expect(result.backgroundPaused).toBe(true);
    expect(result.reason).toContain('High user activity');
  });

  it('keeps background active when pause-on-increase is disabled', () => {
    const calculator = new AdaptiveCapacityCalculator({
      highActivityThreshold: 5,
      moderateActivityThreshold: 2,
      backgroundPauseOnIncreasingTrend: false,
      monitoringWindowMs: 900_000,
    });

    const now = Date.now();
    const requests = [
      now - 299_000,
      now - 260_000,
      now - 50_000,
      now - 40_000,
      now - 20_000,
      now - 5_000,
    ];

    const result = calculator.calculateDynamicCapacity('items', 100, {
      recentUserRequests: requests,
      recentBackgroundRequests: [],
      userActivityTrend: 'stable',
    });

    expect(result.backgroundPaused).toBe(false);
  });

  it('uses dynamic scaling during moderate activity', () => {
    const calculator = new AdaptiveCapacityCalculator({
      highActivityThreshold: 10,
      moderateActivityThreshold: 3,
      monitoringWindowMs: 900_000,
    });

    const now = Date.now();
    const result = calculator.calculateDynamicCapacity('items', 100, {
      recentUserRequests: [
        now - 250_000,
        now - 200_000,
        now - 20_000,
        now - 10_000,
      ],
      recentBackgroundRequests: [],
      userActivityTrend: 'none',
    });

    expect(result.userReserved).toBeGreaterThanOrEqual(40);
    expect(result.userReserved).toBeLessThanOrEqual(70);
    expect(result.backgroundPaused).toBe(false);
    expect(result.reason).toContain('Moderate user activity');
  });

  it('applies decreasing-trend multiplier during moderate activity', () => {
    const calculator = new AdaptiveCapacityCalculator({
      highActivityThreshold: 10,
      moderateActivityThreshold: 3,
      monitoringWindowMs: 900_000,
    });

    const now = Date.now();
    const result = calculator.calculateDynamicCapacity('items', 100, {
      recentUserRequests: [
        now - 500_000,
        now - 450_000,
        now - 400_000,
        now - 350_000,
        now - 100_000,
      ],
      recentBackgroundRequests: [],
      userActivityTrend: 'none',
    });

    expect(result.reason).toContain('Moderate user activity');
    expect(result.userReserved).toBeGreaterThan(40);
    expect(result.userReserved).toBeLessThan(56);
  });

  it('returns initial default allocation when there is no activity', () => {
    const calculator = new AdaptiveCapacityCalculator({ minUserReserved: 5 });

    const result = calculator.calculateDynamicCapacity('items', 100, {
      recentUserRequests: [],
      recentBackgroundRequests: [],
      userActivityTrend: 'none',
    });

    expect(result.userReserved).toBe(30);
    expect(result.backgroundMax).toBe(70);
    expect(result.reason).toContain('Initial state');
  });

  it('allocates mostly to background when there have been no user requests yet', () => {
    const calculator = new AdaptiveCapacityCalculator({ minUserReserved: 7 });

    const result = calculator.calculateDynamicCapacity('items', 100, {
      recentUserRequests: [],
      recentBackgroundRequests: [Date.now() - 1_000],
      userActivityTrend: 'none',
    });

    expect(result.userReserved).toBe(7);
    expect(result.backgroundMax).toBe(93);
    expect(result.reason).toContain('No user activity yet');
  });

  it('gives full capacity to background after sustained inactivity', () => {
    const calculator = new AdaptiveCapacityCalculator({
      sustainedInactivityThresholdMs: 60_000,
      monitoringWindowMs: 120_000,
    });

    const result = calculator.calculateDynamicCapacity('items', 50, {
      recentUserRequests: [Date.now() - 120_000],
      recentBackgroundRequests: [Date.now() - 1_000],
      userActivityTrend: 'none',
    });

    expect(result.userReserved).toBe(0);
    expect(result.backgroundMax).toBe(50);
    expect(result.reason).toContain('Sustained zero activity');
  });

  it('uses minimal user buffer for recent zero activity', () => {
    const calculator = new AdaptiveCapacityCalculator({
      monitoringWindowMs: 1_000,
      sustainedInactivityThresholdMs: 60_000,
      minUserReserved: 9,
    });

    const result = calculator.calculateDynamicCapacity('items', 50, {
      recentUserRequests: [Date.now() - 5_000],
      recentBackgroundRequests: [Date.now() - 1_000],
      userActivityTrend: 'none',
    });

    expect(result.userReserved).toBe(9);
    expect(result.backgroundMax).toBe(41);
    expect(result.reason).toContain('Recent zero activity');
  });

  it('uses low-activity allocation for very small non-zero traffic', () => {
    const calculator = new AdaptiveCapacityCalculator({ minUserReserved: 12 });

    const result = calculator.calculateDynamicCapacity('items', 20, {
      recentUserRequests: [Date.now() - 100],
      recentBackgroundRequests: [],
      userActivityTrend: 'stable',
    });

    expect(result.userReserved).toBe(12);
    expect(result.backgroundMax).toBe(8);
    expect(result.reason).toContain('Low user activity');
  });

  it('calculates recent activity inside monitoring window', () => {
    const calculator = new AdaptiveCapacityCalculator({
      monitoringWindowMs: 1_000,
    });
    const now = Date.now();

    expect(
      calculator.getRecentActivity([now - 1_001, now - 999, now - 100]),
    ).toBe(2);
  });

  it('detects all activity trend states', () => {
    const calculator = new AdaptiveCapacityCalculator({
      monitoringWindowMs: 900,
    });
    const now = Date.now();

    expect(calculator.calculateActivityTrend([])).toBe('none');

    expect(
      calculator.calculateActivityTrend([
        now - 550,
        now - 200,
        now - 100,
        now - 50,
      ]),
    ).toBe('increasing');

    expect(
      calculator.calculateActivityTrend([
        now - 500,
        now - 450,
        now - 400,
        now - 350,
        now - 100,
      ]),
    ).toBe('decreasing');

    expect(
      calculator.calculateActivityTrend([
        now - 500,
        now - 480,
        now - 210,
        now - 190,
      ]),
    ).toBe('stable');
  });

  it('returns zero sustained inactivity when called with no requests', () => {
    const calculator = new AdaptiveCapacityCalculator();

    expect(
      (
        calculator as unknown as {
          getSustainedInactivityPeriod: (requests: Array<number>) => number;
        }
      ).getSustainedInactivityPeriod([]),
    ).toBe(0);
  });
});
