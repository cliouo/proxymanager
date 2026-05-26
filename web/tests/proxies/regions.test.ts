import { describe, expect, it } from 'vitest';
import { codeFromFlag, detectRegion, flagFromCode, stripFlags } from '@/lib/proxies/regions';

describe('flagFromCode', () => {
  it('builds regional-indicator emoji', () => {
    expect(flagFromCode('HK')).toBe('🇭🇰');
    expect(flagFromCode('us')).toBe('🇺🇸');
  });
  it('returns empty for non 2-letter input', () => {
    expect(flagFromCode('USA')).toBe('');
  });
});

describe('codeFromFlag / stripFlags', () => {
  it('extracts a code from a leading flag', () => {
    expect(codeFromFlag('🇯🇵 日本 01')).toBe('JP');
  });
  it('strips flags and tidies separators', () => {
    expect(stripFlags('🇭🇰 香港 01')).toBe('香港 01');
    expect(stripFlags('🇺🇸-US')).toBe('US');
  });
});

describe('detectRegion', () => {
  it('prefers an explicit flag', () => {
    expect(detectRegion('🇸🇬 some random name')).toBe('SG');
  });
  it('matches Chinese keywords', () => {
    expect(detectRegion('香港 IEPL 专线')).toBe('HK');
    expect(detectRegion('日本东京 01')).toBe('JP');
    expect(detectRegion('美国洛杉矶')).toBe('US');
  });
  it('matches English names and bounded codes', () => {
    expect(detectRegion('Tokyo Premium')).toBe('JP');
    expect(detectRegion('Node US-1')).toBe('US');
  });
  it('does not false-match a code inside a longer word', () => {
    // "Russia" contains "us" — must NOT be detected as US.
    expect(detectRegion('Russia node')).toBe('RU');
  });
  it('returns null when no region is found', () => {
    expect(detectRegion('Premium Direct 01')).toBeNull();
  });
});
