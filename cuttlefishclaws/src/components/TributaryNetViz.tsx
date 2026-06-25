import { useEffect, useRef } from 'react'
import { initVizEngine, type VizEngine } from '../lib/vizEngine'

interface Props {
  palette: string
  visibleLayers: Record<string, boolean>
  onEngineReady: (engine: VizEngine) => void
}

export default function TributaryNetViz({ palette, visibleLayers, onEngineReady }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<VizEngine | null>(null)

  useEffect(() => {
    if (!canvasRef.current || !wrapRef.current) return
    const engine = initVizEngine(canvasRef.current, wrapRef.current)
    engineRef.current = engine
    onEngineReady(engine)
    return () => engine.destroy()
  }, [onEngineReady])

  useEffect(() => { 
    engineRef.current?.setPalette(palette) 
  }, [palette])
  
  useEffect(() => { 
    engineRef.current?.setVisibleLayers(visibleLayers) 
  }, [visibleLayers])

  return (
    <div ref={wrapRef} className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className="block w-full h-full"
        onContextMenu={e => e.preventDefault()}
      />
    </div>
  )
}
