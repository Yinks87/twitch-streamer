import styled from '@emotion/styled';

export default function NumberInput({ value, onChange, min, max, step = 1 }) {
  function changeBy(amount) {
    const current = Number(value);
    const next = (Number.isFinite(current) ? current : min) + amount;
    onChange(String(Math.min(max, Math.max(min, next))));
  }

  return (
    <Wrapper>
      <StepButton
        type="button"
        onClick={() => changeBy(-step)}
        disabled={Number(value) <= min}
        aria-label="Wert verringern"
      >
        −
      </StepButton>
      <NumberField
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-valuemin={min}
        aria-valuemax={max}
      />
      <StepButton
        type="button"
        onClick={() => changeBy(step)}
        disabled={Number(value) >= max}
        aria-label="Wert erhöhen"
      >
        +
      </StepButton>
    </Wrapper>
  );
}

const Wrapper = styled.div`
  display: flex;
  width: 100%;
`;

const NumberField = styled.input`
  min-width: 0;
  border-radius: 0;
  text-align: center;
  appearance: textfield;
  background: var(--panel-raised);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 9px 10px;
  font-family: var(--font-mono);
  font-size: 0.88rem;

  &::-webkit-inner-spin-button,
  &::-webkit-outer-spin-button {
    appearance: none;
    margin: 0;
  }

  &:focus {
    outline: 2px solid var(--signal);
    outline-offset: 1px;
    position: relative;
    z-index: 1;
  }
`;

const StepButton = styled.button`
  width: 42px;
  border: 1px solid var(--border);
  background: var(--panel-raised);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 1rem;
  cursor: pointer;

  &:first-of-type {
    border-radius: 4px 0 0 4px;
  }

  &:last-of-type {
    border-radius: 0 4px 4px 0;
  }

  &:hover:not(:disabled) {
    background: var(--border);
  }

  &:focus-visible {
    outline: 2px solid var(--signal);
    outline-offset: 1px;
    position: relative;
    z-index: 1;
  }

  &:disabled {
    color: var(--text-dim);
    opacity: 0.45;
    cursor: not-allowed;
  }
`;

