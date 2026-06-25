import { useState, useCallback } from 'react'
import TributaryNetViz from './TributaryNetViz'
import type { PaletteKey } from '../hooks/usePalette'
import type { VizEngine } from '../lib/vizEngine'

interface HeroProps {
  scrollTo: (id: string) => void
  palette: PaletteKey
  togglePalette: () => void
}

export default function Hero({ scrollTo, palette, togglePalette }: HeroProps) {
  const [engine, setEngine] = useState<VizEngine | null>(null)
  const [controls, setControls] = useState({
    stream: true,
    tunnel: true,
    rotate: true,
    labels: false,
    explode: false,
    fly: false,
  })
  const [layers, setLayers] = useState({
    core: true,
    pool: true,
    dao: true,
    tranche: true,
    inst: true,
    agent: true,
    retail: true,
  })

  const handleEngineReady = useCallback((e: VizEngine) => {
    setEngine(e)
  }, [])

  const toggleControl = (key: keyof typeof controls) => {
    if (!engine) return
    if (key === 'explode') {
      engine.toggleExplode()
      setControls(prev => ({ ...prev, explode: !prev.explode }))
    } else if (key === 'fly') {
      engine.toggleFly()
      setControls(prev => ({ ...prev, fly: !prev.fly }))
    } else {
      engine.tog(key)
      setControls(prev => ({ ...prev, [key]: !prev[key] }))
    }
  }

  const toggleLayer = (layer: keyof typeof layers) => {
    if (!engine) return
    engine.toggleLayer(layer)
    setLayers(prev => ({ ...prev, [layer]: !prev[layer] }))
  }

  const handlePaletteToggle = () => {
    togglePalette()
    engine?.setPalette(palette === 'amber' ? 'cyan' : 'amber')
  }

  return (
    <section id="hero" className="relative w-full h-screen overflow-hidden">
      <TributaryNetViz 
        palette={palette}
        visibleLayers={layers}
        onEngineReady={handleEngineReady}
      />
      
      {/* Viz Controls */}
      <div className="absolute top-[72px] left-1/2 -translate-x-1/2 flex gap-1.5 z-10">
        <button 
          className={`vc ${controls.stream ? 'on' : ''}`}
          onClick={() => toggleControl('stream')}
        >
          Signal
        </button>
        <button 
          className={`vc ${controls.tunnel ? 'on' : ''}`}
          onClick={() => toggleControl('tunnel')}
        >
          Tunnel
        </button>
        <button 
          className={`vc ${controls.rotate ? 'on' : ''}`}
          onClick={() => toggleControl('rotate')}
        >
          Orbit
        </button>
        <button 
          className={`vc ${controls.labels ? 'on' : ''}`}
          onClick={() => toggleControl('labels')}
        >
          Idents
        </button>
        <button 
          className={`vc ${controls.explode ? 'on' : ''}`}
          onClick={() => toggleControl('explode')}
        >
          Explode
        </button>
        <button 
          className={`vc ${controls.fly ? 'on' : ''}`}
          onClick={() => toggleControl('fly')}
        >
          Free Fly
        </button>
        <button 
          className="vc"
          onClick={handlePaletteToggle}
        >
          Palette
        </button>
      </div>

      {/* Layer Filters */}
      <div className="absolute top-[112px] left-1/2 -translate-x-1/2 flex gap-1 z-10">
        {Object.entries(layers).map(([key, active]) => (
          <button
            key={key}
            className={`vc ${active ? 'on' : ''}`}
            onClick={() => toggleLayer(key as keyof typeof layers)}
          >
            {key === 'inst' ? 'Inst LP' : key.charAt(0).toUpperCase() + key.slice(1)}
          </button>
        ))}
      </div>

      {/* Hero Text */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none">
        <div className="text-[9px] tracking-[0.2em] text-[rgba(255,160,0,0.5)] mb-4 uppercase">
          &#x2299; Live DAO-REIT &middot; Birmingham, AL &middot; 2026
        </div>
        <h1 className="font-display text-[clamp(42px,7vw,88px)] font-bold leading-[0.95] tracking-tight text-white mb-2">
          Tributary<br />
          <em className="text-[var(--amber)] not-italic">AI Campus</em>
        </h1>
        <p className="text-[11px] tracking-[0.12em] text-[rgba(255,160,0,0.55)] mt-4 max-w-[480px] leading-[1.8]">
          Where AI agents own physical infrastructure &mdash; 420,460 SF former AT&T operations center governed by constitutional DAO-REIT
        </p>
      </div>

      {/* Stats */}
      <div className="absolute bottom-12 right-8 flex flex-col gap-2 pointer-events-none hidden md:flex">
        <div className="text-right">
          <div className="font-display text-[22px] font-semibold text-[var(--amber)]">$8.32</div>
          <div className="text-[8px] tracking-[0.14em] text-[rgba(255,160,0,0.4)] uppercase">Per sq ft</div>
        </div>
        <div className="text-right">
          <div className="font-display text-[22px] font-semibold text-[var(--amber)]">420K</div>
          <div className="text-[8px] tracking-[0.14em] text-[rgba(255,160,0,0.4)] uppercase">Rentable SF</div>
        </div>
        <div className="text-right">
          <div className="font-display text-[22px] font-semibold text-[var(--amber)]">$250M+</div>
          <div className="text-[8px] tracking-[0.14em] text-[rgba(255,160,0,0.4)] uppercase">2030 Target</div>
        </div>
      </div>

      {/* Location */}
      <div className="absolute bottom-12 left-8 pointer-events-none">
        <div className="text-[10px] tracking-[0.12em] text-[rgba(255,160,0,0.5)]">
          &#x2299; 3196 US-280 &middot; Birmingham AL 35243
        </div>
      </div>

      {/* CTAs */}
      <div className="absolute bottom-12 left-1/2 -translate-x-1/2 flex gap-3.5 pointer-events-auto">
        <button onClick={() => scrollTo('invest')} className="btn-primary">
          Join as Agent Member
        </button>
        <button onClick={() => scrollTo('capital')} className="btn-ghost">
          View Capital Stack
        </button>
      </div>

      {/* Scroll Indicator */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 opacity-40 animate-[bob_2s_ease-in-out_infinite]">
        <span className="text-[8px] tracking-[0.15em] text-[var(--amber)]">Scroll</span>
        <div className="w-2.5 h-2.5 border-r border-b border-[var(--amber)] rotate-45" />
      </div>
    </section>
  )
}
