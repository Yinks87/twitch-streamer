import { useEffect, useState } from 'react';
import styled from '@emotion/styled';
import { Input } from './FormControls';

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const hours = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const remaining = String(seconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${remaining}`;
}

function parseDuration(value) {
  const match = value.match(/^(\d+):([0-5]\d):([0-5]\d)$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export default function DurationInput({ value, onChange, maxSeconds }) {
  const [text, setText] = useState(() => formatDuration(value));

  useEffect(() => setText(formatDuration(value)), [value]);

  function handleChange(event) {
    const nextText = event.target.value;
    setText(nextText);
    const seconds = parseDuration(nextText);
    if (seconds !== null && seconds <= maxSeconds) onChange(seconds);
  }

  function handleBlur() {
    const seconds = parseDuration(text);
    if (seconds === null || seconds > maxSeconds) setText(formatDuration(value));
  }

  return (
    <DurationField
      type="text"
      inputMode="numeric"
      value={text}
      pattern="\d+:[0-5]\d:[0-5]\d"
      placeholder="HH:MM:SS"
      title="Dauer im Format HH:MM:SS"
      onChange={handleChange}
      onBlur={handleBlur}
      required
    />
  );
}

const DurationField = styled(Input)`
  width: 100%;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
`;