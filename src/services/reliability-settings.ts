import type { Workspace, ReliabilitySettings } from '../models/types.js';
export const defaultReliability: ReliabilitySettings = {
  syncEnabled: true,
  syncIntervalMinutes: 1,
  initialLookbackDays: 7,
  maxMessageAgeHours: 24,
  recoveryMessaging: 'SEND_ELIGIBLE',
};
export function reliability(w: Workspace): ReliabilitySettings {
  return { ...defaultReliability, ...w.settings.reliability };
}
