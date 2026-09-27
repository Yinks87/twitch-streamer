export function isDirtyCheck(currentSettings, initialSettings) {
  return JSON.stringify(currentSettings) !== JSON.stringify(initialSettings);
}