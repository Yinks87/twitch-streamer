import TimeInput from './TimeInput';

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
}

function parseDuration(value) {
  const match = value.match(/^(\d+):([0-5]\d):([0-5]\d)$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export default function DurationInput({ value, onChange, maxSeconds }) {
  // Enough hour digits to represent maxSeconds without the segment silently truncating.
  const hoursDigits = Math.max(2, String(Math.floor(maxSeconds / 3600)).length);

  function handleChange(nextValue) {
    const seconds = parseDuration(nextValue);
    if (seconds !== null && seconds <= maxSeconds) onChange(seconds);
  }

  return (
    <TimeInput
      value={formatDuration(value)}
      onChange={handleChange}
      hoursDigits={hoursDigits}
      title="Dauer im Format HH:MM:SS"
    />
  );
}