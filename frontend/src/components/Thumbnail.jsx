import { useEffect, useState } from 'react';

export default function Thumbnail({ src, alt = '', fluid = false }) {
  const [url, setUrl] = useState(src);
  useEffect(() => setUrl(src), [src]);
  return (
    <img
      src={url}
      alt={alt}
      style={{
        width: fluid ? '100%' : '80px',
        height: fluid ? '100%' : '45px',
        objectFit: 'cover',
        borderRadius: fluid ? 0 : '4px',
        flexShrink: 0,
        background: '#111',
      }}
      onError={() => setTimeout(() => setUrl(`${src}?r=${Date.now()}`), 2000)}
    />
  );
}
