import { useState, useEffect } from 'react'

export type PaletteKey = 'amber' | 'cyan'

export function usePalette() {
  const [palette, setPalette] = useState<PaletteKey>('amber')

  useEffect(() => {
    if (palette === 'cyan') {
      document.documentElement.dataset.palette = 'cyan'
    } else {
      delete document.documentElement.dataset.palette
    }
  }, [palette])

  const togglePalette = () => {
    setPalette(prev => prev === 'amber' ? 'cyan' : 'amber')
  }

  return { palette, togglePalette }
}
