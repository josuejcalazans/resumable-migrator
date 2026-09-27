import { describe, expect, it } from 'vitest';
import { computeBackoff } from '../src/backoff';

describe('computeBackoff', () => {
  it('grows exponentially from the base delay', () => {
    const options = { baseMs: 100, capMs: 10_000, jitterRatio: 0, rand: () => 0 };
    expect(computeBackoff(0, options)).toBe(100);
    expect(computeBackoff(1, options)).toBe(200);
    expect(computeBackoff(2, options)).toBe(400);
  });

  it('caps at capMs', () => {
    const options = { baseMs: 100, capMs: 250, jitterRatio: 0, rand: () => 0 };
    expect(computeBackoff(10, options)).toBe(250);
  });

  it('adds bounded jitter on top of the exponential delay', () => {
    const options = { baseMs: 1000, capMs: 10_000, jitterRatio: 0.25 };
    expect(computeBackoff(0, { ...options, rand: () => 1 })).toBe(1250);
    expect(computeBackoff(0, { ...options, rand: () => 0.5 })).toBe(1125);
    expect(computeBackoff(0, { ...options, rand: () => 0 })).toBe(1000);
  });
});
