import { describe, expect, it } from 'vitest';
import type { Stack } from '../src/compose';
import { withFreshOperatorActions } from '../src/operator-cli';
import { State } from '../src/core/state';
import { defaultSettings } from '../src/settings';

describe('operator CLI settings refresh', () => {
  it('uses a new enabled settings snapshot for each preparation/commit service call', async () => {
    const state = State.open(':memory:');
    let settings = { ...defaultSettings, safety: { ...defaultSettings.safety, allowOperatorActions: true } };
    state.saveSettings(settings);
    const snapshots: string[] = [];
    const calls: string[] = [];
    const stack = {
      state,
      createSnapshot(current: typeof settings) {
        snapshots.push(current.ai.preferences);
        return {
          config: { ALLOW_OPERATOR_ACTIONS: current.safety.allowOperatorActions },
          operatorActions: {
            prepareReviewAction: async () => { calls.push(`prepare:${current.ai.preferences}`); return 'prepared'; },
            releaseIntentHold: async () => { calls.push(`commit:${current.ai.preferences}`); return 'committed'; },
          },
        } as unknown as Stack;
      },
    } as unknown as Stack;

    try {
      const prepared = await withFreshOperatorActions(stack, async (actions) => actions.prepareReviewAction({ reviewId: 1, operation: 'release_intent_hold' }));
      expect(prepared).toBe('prepared');
      settings = { ...settings, ai: { ...settings.ai, preferences: 'changed while prompting' } };
      state.saveSettings(settings);
      const committed = await withFreshOperatorActions(stack, async (actions) => actions.releaseIntentHold({ reviewId: 1, token: 'prepared-token', challengeResponse: 'challenge', note: 'operator note' }));
      expect(committed).toBe('committed');
      expect(snapshots).toEqual(['', 'changed while prompting']);
      expect(calls).toEqual(['prepare:', 'commit:changed while prompting']);

      settings = { ...settings, safety: { ...settings.safety, allowOperatorActions: false } };
      state.saveSettings(settings);
      await expect(withFreshOperatorActions(stack, async () => 'unexpected')).rejects.toThrow(/disabled/);
    } finally {
      state.close();
    }
  });
});
