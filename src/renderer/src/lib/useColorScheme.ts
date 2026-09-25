import { useEffect, useState } from 'react'

const query = '(prefers-color-scheme: dark)'

export function useColorScheme(): 'dark' | 'light' {
  const [dark, setDark] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = (): void => setDark(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return dark ? 'dark' : 'light'
}
