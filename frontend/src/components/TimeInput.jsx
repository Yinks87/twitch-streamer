import { useRef } from 'react';
import styled from '@emotion/styled';
import { baseFieldCss } from './FormControls';

// ── Segmented hh:mm:ss field: three independently editable number segments inside
// one input-styled box (like a native time picker), instead of one free-text field
// that has to be typed left-to-right and validated/padded on blur. ─────────────────
export default function TimeInput({
  value = '00:00:00',
  onChange,
  disabled,
  title,
  hoursDigits = 2,
}) {
  const digitCounts = [hoursDigits, 2, 2];
  const maxValues = [10 ** hoursDigits - 1, 59, 59];
  const parts = (value || '00:00:00').split(':');
  const segments = digitCounts.map((digits, i) =>
    (parts[i] ?? '0').padStart(digits, '0'),
  );
  const refs = [useRef(null), useRef(null), useRef(null)];

  function focusSegment(index) {
    const el = refs[index]?.current;
    if (!el) return;
    el.focus();
    el.select();
  }

  function commit(index, numericValue) {
    const clamped = Math.min(maxValues[index], Math.max(0, numericValue));
    const next = [...segments];
    next[index] = String(clamped).padStart(digitCounts[index], '0');
    onChange(next.join(':'));
  }

  function handleChange(index, event) {
    const digits = event.target.value.replace(/\D/g, '').slice(-digitCounts[index]);
    commit(index, Number(digits || 0));
    if (digits.length >= digitCounts[index] && index < 2) focusSegment(index + 1);
  }

  function handleKeyDown(index, event) {
    const input = event.target;
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        event.preventDefault();
        const max = maxValues[index];
        const delta = event.key === 'ArrowUp' ? 1 : -1;
        const current = Number(segments[index]);
        commit(index, (current + delta + max + 1) % (max + 1));
        break;
      }
      case 'ArrowLeft':
        if (input.selectionStart === 0 && index > 0) {
          event.preventDefault();
          focusSegment(index - 1);
        }
        break;
      case 'ArrowRight':
        if (input.selectionEnd === input.value.length && index < 2) {
          event.preventDefault();
          focusSegment(index + 1);
        }
        break;
      case ':':
        event.preventDefault();
        if (index < 2) focusSegment(index + 1);
        break;
      case 'Backspace':
        if (input.selectionStart === 0 && input.selectionEnd === 0 && index > 0) {
          event.preventDefault();
          focusSegment(index - 1);
        }
        break;
      default:
        break;
    }
  }

  return (
    <Wrapper $disabled={disabled} title={title}>
      {segments.map((seg, index) => (
        <Segment key={index}>
          {index > 0 && <Colon>:</Colon>}
          <Digit
            ref={refs[index]}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={seg}
            disabled={disabled}
            $digits={digitCounts[index]}
            onChange={(e) => handleChange(index, e)}
            onKeyDown={(e) => handleKeyDown(index, e)}
            onFocus={(e) => e.target.select()}
          />
        </Segment>
      ))}
    </Wrapper>
  );
}

const Wrapper = styled.div`
  ${baseFieldCss}
  display: inline-flex;
  align-items: center;
  width: fit-content;
  cursor: text;

  ${({ $disabled }) => $disabled && `opacity: 0.55; cursor: not-allowed;`}

  &:focus-within {
    outline: 2px solid var(--signal);
    outline-offset: 1px;
  }
`;

const Segment = styled.div`
  display: flex;
  align-items: center;
`;

const Colon = styled.span`
  opacity: 0.6;
  padding: 0 1px;
`;

const Digit = styled.input`
  width: ${({ $digits }) => $digits}ch;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 0;
  text-align: center;

  &:focus {
    outline: none;
    background: rgba(255, 255, 255, 0.12);
    border-radius: 2px;
  }
`;
