'use client'

import { useState } from 'react'
import { SCENARIOS } from '../../lib/mockData'

interface Props {
  unlocked: boolean
  onUnlock: (code: string) => boolean
  onLock: () => void
}

export default function ReturnsSection({ unlocked, onUnlock, onLock }: Props) {
  const [code, setCode] = useState('')
  const [error, setError] = useState(false)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (onUnlock(code)) {
      setError(false)
    } else {
      setError(true)
      setTimeout(() => setError(false), 2000)
    }
  }

  if (!unlocked) {
    return (
      <section id="returns" className="px-8 py-24" style={{ background: 'var(--bg1)' }}>
        <div className="max-w-[480px] mx-auto text-center">
          <div className="reveal">
            <div className="w-14 h-14 mx-auto mb-6 flex items-center justify-center text-[24px]"
              style={{ border: '0.5px solid var(--border2)', color: 'var(--amber)' }}>⊙</div>
            <div className="text-[9px] tracking-[0.2em] text-[rgba(255,160,0,0.35)] uppercase mb-4">Restricted Access</div>
            <h2 className="font-display text-[28px] font-semibold text-white mb-2">VC Briefing Materials</h2>
            <p className="text-[10px] tracking-[0.06em] text-[rgba(255,160,0,0.5)] leading-[1.8] mb-8">
              Return projections are restricted to direct equity participants in Cuttlefish Labs. Not for public distribution.
            </p>
            <form onSubmit={handleSubmit} className="max-w-[300px] mx-auto flex flex-col gap-3">
              <input
                type="password"
                value={code}
                onChange={e => setCode(e.target.value)}
                placeholder="ENTER ACCESS CODE"
                className="w-full px-4 py-3 text-center text-[11px] tracking-[0.18em] outline-none font-mono transition-all"
                style={{
                  background: 'rgba(255,140,0,0.04)',
                  border: `0.5px solid ${error ? '#ff3399' : 'var(--border)'}`,
                  color: 'var(--amber)',
                }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--amber2)')}
                onBlur={e => (e.currentTarget.style.borderColor = error ? '#ff3399' : 'var(--border)')}
              />
              {error && <div className="text-[9px] text-[#ff3399] tracking-[0.08em]">Incorrect access code</div>}
              <button type="submit" className="btn-primary cursor-pointer">Access →</button>
            </form>
            <p className="mt-6 text-[8px] tracking-[0.06em] text-[rgba(255,160,0,0.3)]">
              Request access: nav@cuttlefishlabs.com
            </p>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section id="returns" style={{ background: 'var(--bg0)' }}>

      {/* Access banner */}
      <div className="flex items-center justify-between px-8 py-3"
        style={{ background: 'var(--bg0)', borderBottom: '0.5px solid var(--border)' }}>
        <div className="flex items-center gap-2.5">
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--green)', boxShadow: '0 0 6px var(--green)', animation: 'pulse-dot 2s infinite' }} />
          <span className="text-[8px] tracking-[0.14em] uppercase" style={{ color: 'rgba(68,255,170,0.7)' }}>VC Access Granted — Confidential</span>
        </div>
        <button onClick={onLock}
          className="text-[8px] tracking-[0.12em] uppercase px-3 py-1 cursor-pointer font-mono transition-all"
          style={{ color: 'rgba(255,160,0,0.4)', background: 'transparent', border: '0.5px solid var(--border)' }}
          onMouseOver={e => { e.currentTarget.style.color = 'var(--amber)'; e.currentTarget.style.borderColor = 'var(--amber2)' }}
          onMouseOut={e => { e.currentTarget.style.color = 'rgba(255,160,0,0.4)'; e.currentTarget.style.borderColor = 'var(--border)' }}>
          ⊠ Lock
        </button>
      </div>

      {/* DAO-REIT vs CAC distinction — LEGALLY CRITICAL */}
      <div className="grid grid-cols-2 gap-[1px] px-8 py-0" style={{ background: 'var(--border)', maxWidth: '100%' }}>
        <div className="p-5" style={{ background: 'rgba(68,255,170,0.04)', border: '0.5px solid rgba(68,255,170,0.18)' }}>
          <div className="text-[8px] tracking-[0.14em] uppercase mb-2" style={{ color: 'rgba(68,255,170,0.7)' }}>DAO-REIT Returns — What This Is</div>
          <div className="text-[9px] leading-[1.8] tracking-[0.04em] text-[rgba(255,160,0,0.65)]">
            These projections represent potential returns on <strong style={{ color: 'var(--amber)' }}>direct equity participation in the Tributary AI Campus DAO-REIT</strong> — a Delaware Series LLC with tokenized real estate ownership. This is a property investment with capital appreciation and NOI distributions.
          </div>
        </div>
        <div className="p-5" style={{ background: 'rgba(255,51,153,0.04)', border: '0.5px solid rgba(255,51,153,0.18)' }}>
          <div className="text-[8px] tracking-[0.14em] uppercase mb-2" style={{ color: 'rgba(255,51,153,0.7)' }}>CAC Protocol — What This Is NOT</div>
          <div className="text-[9px] leading-[1.8] tracking-[0.04em] text-[rgba(255,160,0,0.65)]">
            CAC (Constitutional Agent License) is a <strong style={{ color: '#ff3399' }}>prepaid compute credential</strong> — not a security, equity interest, or investment contract. CAC does not carry these return projections. The 4.5% APY on CAC balance is a savings rate, not an investment return.
          </div>
        </div>
      </div>

      <div className="max-w-[1200px] mx-auto px-8 py-20">
        <div className="reveal mb-10">
          <p className="section-label">2030 Return Scenarios — DAO-REIT Equity Only</p>
          <h2 className="section-title">Conservative to <em>exponential</em> upside</h2>
          <p className="text-[11px] tracking-[0.08em] text-[rgba(255,160,0,0.55)] max-w-[560px] leading-[2] mt-4">
            Three scenarios based on tenant mix, compute density, and energy infrastructure deployment. All assume $34M all-in basis. These are projections, not guarantees.
          </p>
        </div>

        <div className="grid gap-[1px] mb-[1px]" style={{ gridTemplateColumns: 'repeat(3, 1fr)', background: 'var(--border)' }}>
          {SCENARIOS.map((scenario, i) => (
            <div key={scenario.name} className="p-8" style={{
              background: scenario.featured ? 'rgba(255,140,0,0.04)' : 'var(--bg1)',
              borderTop: scenario.featured ? '1.5px solid var(--amber2)' : undefined,
            }}>
              <div className="text-[8px] tracking-[0.18em] uppercase text-[rgba(255,160,0,0.4)] mb-5">{scenario.tier}</div>
              <div className="font-display text-[20px] font-semibold text-white mb-1">{scenario.name}</div>
              <div className="text-[9px] text-[rgba(255,160,0,0.4)] tracking-[0.1em] mb-6">{scenario.subtitle}</div>
              <div className="font-display text-[52px] font-light leading-none mb-1" style={{ color: scenario.multipleColor }}>{scenario.multiple}</div>
              <div className="text-[8px] tracking-[0.14em] text-[rgba(255,160,0,0.35)] mb-5">Multiple on all-in cost</div>
              <div className="w-8 h-[0.5px] mb-5" style={{ background: 'var(--amber2)', opacity: scenario.featured ? 0.6 : 0.3 }} />
              <div className="flex flex-col gap-2.5">
                {scenario.metrics.map((m, mi) => (
                  <div key={mi} className="flex justify-between items-center">
                    <span className="text-[9px] text-[rgba(255,160,0,0.45)] tracking-[0.06em]">{m.label}</span>
                    <span className="text-[10px] text-[var(--amber)]">{m.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* IRR stats */}
        <div className="flex items-center justify-between flex-wrap gap-6 p-7 mb-[1px]" style={{ background: 'var(--bg1)' }}>
          <div className="flex gap-12 flex-wrap">
            {[
              { label: 'Base Case IRR', value: '21.9%' },
              { label: 'Target Multiple', value: '7.3×' },
              { label: 'All-In Basis', value: '$34M' },
              { label: 'Target Exit', value: '2031' },
            ].map((s, i) => (
              <div key={i}>
                <div className="text-[8px] tracking-[0.14em] text-[rgba(255,160,0,0.4)] uppercase mb-1">{s.label}</div>
                <div className="font-display text-[26px] font-light" style={{ color: 'var(--amber)' }}>{s.value}</div>
              </div>
            ))}
          </div>
          <div className="text-[8px] text-[rgba(255,160,0,0.3)] tracking-[0.06em] max-w-[260px] leading-[1.7]">
            Forward-looking projections, not guarantees. DAO-REIT equity participation only. Consult your legal counsel.
          </div>
        </div>

      </div>
    </section>
  )
}
