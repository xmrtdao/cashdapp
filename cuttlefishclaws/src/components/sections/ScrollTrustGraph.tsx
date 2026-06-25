'use client'

import { useRef, useState, useEffect } from 'react'

interface NodeDef {
  id: string
  label: string
  sub: string
  x: number
  y: number
  color: string
}

interface EdgeDef {
  from: string
  to: string
  label: string
  color: string
  delay: number
}

const W = 560
const H = 340
const R = 32

const NODES: NodeDef[] = [
  { id: 'nav',   label: 'NAVIGATOR',  sub: 'Human Authority',    x: 280, y: 55,  color: '#ffaa00' },
  { id: 'cac',   label: 'CAC',        sub: 'Compute Credential', x: 88,  y: 195, color: '#6274ea' },
  { id: 'agent', label: 'AGENT',      sub: 'Constitutional AI',  x: 472, y: 195, color: '#00ffcc' },
  { id: 'trust', label: 'TRUSTGRAPH', sub: 'Scoring Engine',     x: 280, y: 295, color: '#ff8800' },
  { id: 'dao',   label: 'DAO GOV',    sub: 'On-Chain',           x: 88,  y: 295, color: '#9945ff' },
]

const EDGE_DEFS: EdgeDef[] = [
  { from: 'nav',   to: 'cac',   label: 'licenses',  color: '#ffaa00', delay: 0    },
  { from: 'nav',   to: 'agent', label: 'commands',  color: '#ffaa00', delay: 200  },
  { from: 'cac',   to: 'trust', label: 'depletes',  color: '#6274ea', delay: 400  },
  { from: 'agent', to: 'trust', label: 'reports',   color: '#00ffcc', delay: 600  },
  { from: 'trust', to: 'dao',   label: 'scores',    color: '#ff8800', delay: 800  },
  { from: 'dao',   to: 'nav',   label: 'governs',   color: '#9945ff', delay: 1000 },
]

function getNode(id: string): NodeDef {
  return NODES.find(n => n.id === id)!
}

function edgePoints(fromId: string, toId: string) {
  const a = getNode(fromId)
  const b = getNode(toId)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  const ux = dx / dist
  const uy = dy / dist
  return {
    x1: a.x + ux * R,
    y1: a.y + uy * R,
    x2: b.x - ux * R,
    y2: b.y - uy * R,
    len: Math.round(dist - 2 * R),
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
  }
}

export default function ScrollTrustGraph() {
  const ref = useRef<HTMLDivElement>(null)
  const [vis, setVis] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVis(true)
          obs.disconnect()
        }
      },
      { threshold: 0.2 }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const edgeData = EDGE_DEFS.map(ed => ({
    ...ed,
    ...edgePoints(ed.from, ed.to),
  }))

  return (
    <div ref={ref} style={{ background: 'var(--bg0)', border: '0.5px solid var(--border)' }}>
      <div className="px-8 pt-6 pb-2">
        <div className="text-[9px] tracking-[0.16em] text-[rgba(255,160,0,0.4)] uppercase mb-1">
          Constitutional Trust Architecture
        </div>
        <div className="text-[8px] tracking-[0.06em] text-[rgba(255,160,0,0.28)]">
          Every agent action flows through TrustGraph scoring. Human authority is structurally sovereign.
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ maxHeight: 320 }}
        aria-hidden="true"
      >
        {/* Edge lines */}
        {edgeData.map((ed, i) => (
          <g key={`edge-${i}`}>
            <line
              x1={ed.x1} y1={ed.y1} x2={ed.x2} y2={ed.y2}
              stroke={ed.color}
              strokeWidth={1}
              strokeOpacity={0.4}
              strokeDasharray={ed.len}
              strokeDashoffset={vis ? 0 : ed.len}
              style={{ transition: `stroke-dashoffset 0.75s ease ${ed.delay}ms` }}
            />
            <text
              x={ed.midX}
              y={ed.midY - (ed.from === 'dao' && ed.to === 'nav' ? 12 : 8)}
              textAnchor="middle"
              fill={ed.color}
              fontSize={6}
              fontFamily="monospace"
              letterSpacing={0.8}
              style={{
                opacity: vis ? 0.5 : 0,
                transition: `opacity 0.4s ease ${ed.delay + 500}ms`,
              }}
            >
              {ed.label.toUpperCase()}
            </text>
          </g>
        ))}

        {/* Flow dots (only rendered when visible) */}
        {vis && edgeData.map((ed, i) => (
          <circle key={`dot-${i}`} r={2.5} fill={ed.color} opacity={0.8}>
            <animateMotion
              path={`M ${ed.x1} ${ed.y1} L ${ed.x2} ${ed.y2}`}
              dur={`${1.6 + i * 0.25}s`}
              repeatCount="indefinite"
            />
          </circle>
        ))}

        {/* Nodes */}
        {NODES.map((n, i) => (
          <g
            key={n.id}
            style={{
              opacity: vis ? 1 : 0,
              transition: `opacity 0.55s ease ${i * 150}ms`,
            }}
          >
            <circle cx={n.x} cy={n.y} r={R + 10} fill={n.color} opacity={0.04} />
            <circle cx={n.x} cy={n.y} r={R + 4} fill="none" stroke={n.color} strokeWidth={0.5} strokeOpacity={0.18} />
            <circle cx={n.x} cy={n.y} r={R} fill="var(--bg1)" stroke={n.color} strokeWidth={0.75} strokeOpacity={0.55} />
            <text
              x={n.x} y={n.y - 5}
              textAnchor="middle"
              fill={n.color}
              fontSize={n.label === 'TRUSTGRAPH' ? 6.5 : 7.5}
              fontFamily="monospace"
              fontWeight="bold"
              letterSpacing={0.3}
            >
              {n.label}
            </text>
            <text
              x={n.x} y={n.y + 9}
              textAnchor="middle"
              fill={n.color}
              fontSize={5.5}
              fontFamily="monospace"
              opacity={0.5}
            >
              {n.sub}
            </text>
          </g>
        ))}
      </svg>

      <div className="flex justify-center gap-5 px-8 pb-5 flex-wrap">
        {NODES.map(n => (
          <div key={n.id} className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: n.color }} />
            <span className="text-[7px] tracking-[0.1em] uppercase" style={{ color: `${n.color}99` }}>
              {n.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
