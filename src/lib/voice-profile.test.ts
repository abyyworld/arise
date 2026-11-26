// How someone writes (lib/voice-profile.ts): their traits from their own messages, and edits
// added as new samples.

import { describe, expect, it } from 'vitest';
import { addSample, samplesOf, traits, traitsText } from './voice-profile';

const voice = ['hey!! no worries at all, see you sat\ncheers', 'sounds good, no worries\ncheers', 'cant make it today sorry 😅 no worries if not\ncheers'].join('\n\n');

describe('a voice profile', () => {
  it('reads the traits from their own messages', () => {
    const t = traits(voice);
    expect(t).toMatchObject({ samples: 3, lowercaseStart: true, emoji: true, signoff: 'cheers' });
    expect(t.phrases).toContain('no worries');
    expect(traitsText(t)).toEqual(expect.arrayContaining(['Often starts sentences in lower case.', 'Uses emoji.', 'Often ends with "cheers".']));
    expect(traitsText(traits(''))).toEqual([]);
  });

  it('adds an edited draft as a new sample, keeping the newest when it gets long', () => {
    const v = addSample(voice, 'ok see you there\ncheers');
    expect(samplesOf(v)).toHaveLength(4);
    expect(samplesOf(v).at(-1)).toBe('ok see you there\ncheers');
    const long = addSample(`${'a'.repeat(2990)}`, 'newest one', 3000);
    expect(samplesOf(long)).toEqual(['newest one']);
  });
});
