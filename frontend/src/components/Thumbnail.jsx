import { useState } from 'react';

export default function Thumbnail({ src, alt = '' }) {
  const [url, setUrl] = useState(src);
  return (
    <img
      src={url}
      alt={alt}
      style={{
        width: '80px',
        height: '45px',
        objectFit: 'cover',
        borderRadius: '4px',
        flexShrink: 0,
        background: '#111',
      }}
      onError={() => setTimeout(() => setUrl(`${src}?r=${Date.now()}`), 2000)}
    />
  );
}
