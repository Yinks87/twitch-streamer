import styled from '@emotion/styled';

const Checkbox = ({
  checked,
  onChange,
  label,
  size = 'medium',
  variant = 'primary',
}) => (
  <label
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      cursor: 'pointer',
      userSelect: 'none',
      gap: '4px',
    }}
  >
    <StyledCheckbox
      // style={variantStyle({ variant, size })}
      size={size}
      variant={variant}
      type="checkbox"
      checked={checked}
      onChange={onChange}
    />
    {label}
  </label>
);

export default Checkbox;

const StyledCheckbox = styled.input`
  width: ${(props) =>
    props.size === 'medium'
      ? '16px'
      : props.size === 'large'
        ? '24px'
        : '16px'};
  height: ${(props) =>
    props.size === 'medium'
      ? '16px'
      : props.size === 'large'
        ? '24px'
        : '16px'};
  accent-color: ${(props) =>
    props.variant === 'primary' ? 'var(--signal)' : undefined};
  background-color: ${(props) =>
    props.variant === 'primary' ? 'var(--signal)' : undefined};
`;
