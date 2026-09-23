import styled from '@emotion/styled';

// Shared base look for native text/password inputs and selects (former global
// `input[type='text'|'password'], select` rule in App.css).
const baseFieldCss = `
  background: var(--panel-raised);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 9px 10px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 0.88rem;

  &:focus {
    outline: 2px solid var(--signal);
    outline-offset: 1px;
  }
`;

export const Input = styled.input`
  ${baseFieldCss}
`;

export const Select = styled.select`
  ${baseFieldCss}
`;
