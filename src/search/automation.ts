/** Retained identity helper for saved cooldown settings; acquisition automation is deferred. */
export const showCooldownSettingKey = (sourceFingerprint: string, serviceId: number): string =>
  `automation:show-cooldown:${sourceFingerprint}:${serviceId}`;
