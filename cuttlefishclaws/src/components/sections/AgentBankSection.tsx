'use client'

import { useState, useRef, useEffect } from 'react'
import { CAC_TIERS } from '../../lib/mockData'

// ── Tier config (merged with CAC_TIERS data) ─────────────────────────
const CARD_META = [
  {
    cacId: 'developer',
    card: 'Virtual Visa',
    physical: false,
    nfc: false,
    metal: false,
    color: '#ffaa00',
    colorDim: 'rgba(255,170,0,0.10)',
    border: 'rgba(255,170,0,0.28)',
    cardBg0: '#120900',
    cardBg1: '#060200',
    network: 'Base L2',
    agentSlots: '3 Agents',
    bankFeatures: [
      'Virtual Visa — instant provisioning',
      'Micropayment rails for inference billing',
      'CAC token staking via AgentWallet.sol',
      'Agent identity on Base L2',
      'KYA-verified agent registration',
    ],
  },
  {
    cacId: 'studio',
    card: 'Physical NFC Visa',
    physical: true,
    nfc: true,
    metal: false,
    color: '#00d2ff',
    colorDim: 'rgba(0,210,255,0.10)',
    border: 'rgba(0,210,255,0.28)',
    cardBg0: '#000c14',
    cardBg1: '#020608',
    network: 'Base L2',
    agentSlots: '12 Agents',
    badge: 'MOST POPULAR',
    bankFeatures: [
      'Physical NFC Visa — $20 issuance fee',
      'NFC/QR encoded with CAC address + agent ID',
      'Agent-to-agent lending settlement',
      'Insurance pool participation',
      'Tap-to-pay for physical world ops',
    ],
  },
  {
    cacId: 'enterprise',
    card: 'Metal Mastercard',
    physical: true,
    nfc: true,
    metal: true,
    color: '#c060ff',
    colorDim: 'rgba(192,96,255,0.10)',
    border: 'rgba(192,96,255,0.28)',
    cardBg0: '#0e0018',
    cardBg1: '#040008',
    network: 'Base L2',
    agentSlots: '50 Agents',
    bankFeatures: [
      'Metal Mastercard — free issuance',
      'Agent treasury management',
      'Full governance voting weight (3×)',
      'Custom card design + agent portrait',
      'Priority KYA review + human override',
    ],
  },
]

// Merge CAC_TIERS data
const TIERS = CARD_META.map(m => {
  const cac = CAC_TIERS.find(t => t.id === m.cacId)!
  return { ...m, cac }
})

// ── Deterministic fake token/address from tier id ─────────────────────
function makeCACAddress(id: string) {
  const seeds: Record<string, string> = {
    developer: 'A7F2',
    studio:    '3C9E',
    enterprise:'FF01',
  }
  const s = seeds[id] || 'B4D8'
  return `CAC-${s}-8B3D-${id.slice(0,3).toUpperCase()}1`
}
function makeToken(id: string) {
  const seeds: Record<string, string> = {
    developer: 'sk-cac-dev-4Xm9pQ2r',
    studio:    'sk-cac-stu-8Kz3wN7f',
    enterprise:'sk-cac-ent-2Rp5vL0j',
  }
  return seeds[id] || 'sk-cac-xxx-xxxxxxxx'
}
function makeCardNumber(id: string) {
  const seeds: Record<string, string> = {
    developer: '4892 73•• •••• 4417',
    studio:    '4571 09•• •••• 8823',
    enterprise:'5412 18•• •••• 3309',
  }
  return seeds[id] || '4000 00•• •••• 0000'
}

// ── Agent ID card canvas ──────────────────────────────────────────────
function AgentCard({ tier, active }: { tier: typeof TIERS[0]; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W = 400, H = 252
    canvas.width = W; canvas.height = H
    let tick = 0

    // Particles
    const pts = Array.from({ length: 40 }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - .5) * .25, vy: (Math.random() - .5) * .25,
      r: .6 + Math.random() * 1.6, ph: Math.random() * Math.PI * 2,
    }))

    function draw() {
      rafRef.current = requestAnimationFrame(draw)
      tick++
      ctx.clearRect(0, 0, W, H)

      // ── Card body ──
      const rr = 14
      function cardPath() {
        ctx.beginPath()
        ctx.moveTo(rr, 0); ctx.lineTo(W - rr, 0)
        ctx.quadraticCurveTo(W, 0, W, rr)
        ctx.lineTo(W, H - rr); ctx.quadraticCurveTo(W, H, W - rr, H)
        ctx.lineTo(rr, H); ctx.quadraticCurveTo(0, H, 0, H - rr)
        ctx.lineTo(0, rr); ctx.quadraticCurveTo(0, 0, rr, 0)
        ctx.closePath()
      }

      // Background gradient
      const bg = ctx.createLinearGradient(0, 0, W, H)
      bg.addColorStop(0, tier.cardBg0)
      bg.addColorStop(1, tier.cardBg1)
      cardPath(); ctx.fillStyle = bg; ctx.fill()

      // Metal shimmer (enterprise)
      if (tier.metal) {
        const shimX = ((tick * .4) % (W * 1.6)) - W * .3
        const shim = ctx.createLinearGradient(shimX, 0, shimX + W * .4, H)
        shim.addColorStop(0, 'rgba(255,255,255,0)')
        shim.addColorStop(.5, 'rgba(255,255,255,0.04)')
        shim.addColorStop(1, 'rgba(255,255,255,0)')
        cardPath(); ctx.fillStyle = shim; ctx.fill()
      }

      // Holographic diagonal bands
      ctx.save()
      ctx.globalAlpha = .03 + Math.sin(tick * .018) * .015
      for (let i = -4; i < 14; i++) {
        ctx.beginPath()
        ctx.moveTo(i * 32, 0); ctx.lineTo(i * 32 + H, H)
        ctx.strokeStyle = tier.color; ctx.lineWidth = 12; ctx.stroke()
      }
      ctx.globalAlpha = 1; ctx.restore()

      // Circuit trace lines
      ctx.save(); ctx.globalAlpha = .055; ctx.strokeStyle = tier.color; ctx.lineWidth = .5
      const traces = [[20,40,160,40],[20,56,220,56],[20,72,140,72,155,87,W-20,87]]
      traces.forEach(t => {
        ctx.beginPath(); ctx.moveTo(t[0], t[1])
        for (let i = 2; i < t.length; i += 2) ctx.lineTo(t[i], t[i+1])
        ctx.stroke()
      })
      ctx.restore()

      // Bioluminescent particles
      pts.forEach(p => {
        p.ph += .03; p.x += p.vx; p.y += p.vy
        if (p.x < 0) p.x = W; if (p.x > W) p.x = 0
        if (p.y < 0) p.y = H; if (p.y > H) p.y = 0
        const s = Math.sin(p.ph) * .35 + .65
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * s, 0, Math.PI * 2)
        ctx.fillStyle = tier.color
        ctx.globalAlpha = .09 * s * (active ? 1.6 : 0.8)
        ctx.fill(); ctx.globalAlpha = 1
      })

      // ── Agent avatar (top-left circle) ──
      const ax = 30, ay = 30, ar = 22
      ctx.save()
      ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI * 2); ctx.clip()
      // Hex pattern inside avatar
      const avBg = ctx.createRadialGradient(ax, ay, 0, ax, ay, ar)
      avBg.addColorStop(0, tier.color + '30'); avBg.addColorStop(1, tier.color + '08')
      ctx.fillStyle = avBg; ctx.fillRect(ax - ar, ay - ar, ar * 2, ar * 2)
      ctx.strokeStyle = tier.color + '66'; ctx.lineWidth = .7
      for (let hi = 0; hi < 6; hi++) {
        const ha = hi * Math.PI / 3 + tick * .003
        const hx = ax + Math.cos(ha) * ar * .6, hy = ay + Math.sin(ha) * ar * .6
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(hx, hy); ctx.stroke()
        ctx.beginPath(); ctx.arc(hx, hy, 2.5, 0, Math.PI * 2)
        ctx.fillStyle = tier.color + 'aa'; ctx.fill()
      }
      ctx.restore()
      // Avatar border ring
      ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI * 2)
      ctx.strokeStyle = tier.color + (active ? 'ee' : '77'); ctx.lineWidth = 1.2; ctx.stroke()
      // Pulse ring when active
      if (active) {
        const pr = ar + 3 + Math.sin(tick * .05) * 2.5
        ctx.beginPath(); ctx.arc(ax, ay, pr, 0, Math.PI * 2)
        ctx.strokeStyle = tier.color; ctx.lineWidth = .5
        ctx.globalAlpha = .3 + Math.sin(tick * .05) * .15; ctx.stroke(); ctx.globalAlpha = 1
      }

      // ── KYA badge (top-right) ──
      ctx.font = 'bold 6px "Share Tech Mono", monospace'
      ctx.fillStyle = tier.color + 'cc'
      ctx.textAlign = 'right'
      ctx.fillText('◉ KYA VERIFIED', W - 12, 18)
      ctx.fillText(tier.cac.name.toUpperCase() + ' TIER', W - 12, 30)
      ctx.textAlign = 'left'

      // ── Network badge ──
      ctx.font = '6px "Share Tech Mono", monospace'
      ctx.fillStyle = tier.color + '88'
      ctx.fillText('⬡ ' + tier.network, 60, 22)

      // ── Chip (physical tiers) ──
      if (tier.physical) {
        const cx = 20, cy = 65, cw = 44, ch = 32
        ctx.beginPath(); ctx.roundRect(cx, cy, cw, ch, 5)
        const chipG = ctx.createLinearGradient(cx, cy, cx + cw, cy + ch)
        chipG.addColorStop(0, tier.color + '50'); chipG.addColorStop(.5, tier.color + '28'); chipG.addColorStop(1, tier.color + '55')
        ctx.fillStyle = chipG; ctx.fill()
        ctx.strokeStyle = tier.color + '99'; ctx.lineWidth = .8; ctx.stroke()
        ctx.strokeStyle = tier.color + '44'; ctx.lineWidth = .5
        for (let i = 1; i < 3; i++) {
          ctx.beginPath(); ctx.moveTo(cx + cw * i / 3, cy + 5); ctx.lineTo(cx + cw * i / 3, cy + ch - 5); ctx.stroke()
          ctx.beginPath(); ctx.moveTo(cx + 5, cy + ch * i / 3); ctx.lineTo(cx + cw - 5, cy + ch * i / 3); ctx.stroke()
        }
      }

      // ── NFC arcs ──
      if (tier.nfc) {
        const nx = tier.physical ? 80 : 40, ny = 81
        for (let i = 0; i < 3; i++) {
          const a = active ? (.08 + .08 * Math.sin(tick * .06 + i)) : .06
          ctx.beginPath()
          ctx.arc(nx, ny, 9 + i * 8, -Math.PI / 3.5, Math.PI / 3.5)
          ctx.strokeStyle = tier.color; ctx.lineWidth = 1.4
          ctx.globalAlpha = a + i * .03; ctx.stroke(); ctx.globalAlpha = 1
        }
      }

      // ── Card number ──
      ctx.font = '14px "Share Tech Mono", monospace'
      ctx.fillStyle = tier.color + 'dd'
      ctx.letterSpacing = '3px'
      ctx.fillText(makeCardNumber(tier.cacId), 20, 140)
      ctx.letterSpacing = '0px'

      // ── Agent name label ──
      ctx.font = '7px "Share Tech Mono", monospace'
      ctx.fillStyle = tier.color + '66'
      ctx.fillText('AGENT ID', 20, 162)
      ctx.font = '10px "Share Tech Mono", monospace'
      ctx.fillStyle = tier.color + 'cc'
      ctx.fillText('AGT-' + makeCACAddress(tier.cacId).slice(4, 12), 20, 175)

      // ── Expiry ──
      ctx.font = '7px "Share Tech Mono", monospace'
      ctx.fillStyle = tier.color + '66'
      ctx.fillText('VALID THRU', 20, 196)
      ctx.font = '9px "Share Tech Mono", monospace'
      ctx.fillStyle = tier.color + 'cc'
      ctx.fillText('03/28', 20, 207)

      // ── CAC address (bottom strip) ──
      ctx.font = '6.5px "Share Tech Mono", monospace'
      ctx.fillStyle = tier.color + '44'
      ctx.fillText(makeCACAddress(tier.cacId), 20, 228)

      // ── Network logo (bottom-right) ──
      ctx.font = 'bold 11px "Rajdhani", sans-serif'
      ctx.fillStyle = tier.color + 'cc'
      ctx.textAlign = 'right'
      ctx.fillText(tier.metal ? 'MASTERCARD' : 'VISA', W - 14, H - 12)
      ctx.textAlign = 'left'

      // ── Active border glow ──
      if (active) {
        const pulse = Math.sin(tick * .04) * .07 + .11
        ctx.globalAlpha = pulse
        cardPath()
        ctx.strokeStyle = tier.color; ctx.lineWidth = 7; ctx.stroke()
        ctx.globalAlpha = 1
      }

      // ── Card border ──
      cardPath()
      ctx.strokeStyle = tier.color + (active ? 'cc' : '44')
      ctx.lineWidth = active ? 1.4 : .8; ctx.stroke()
    }

    draw()
    return () => cancelAnimationFrame(rafRef.current)
  }, [tier.cacId, active])

  return (
    <canvas
      ref={canvasRef}
      width={400} height={252}
      style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 14 }}
    />
  )
}

// ── Token reveal panel ────────────────────────────────────────────────
function TokenPanel({ tier }: { tier: typeof TIERS[0] }) {
  const [revealed, setRevealed] = useState(false)
  const token = makeToken(tier.cacId)
  const masked = token.slice(0, 14) + '••••••••••••'

  return (
    <div style={{ border: `1px solid ${tier.color}33`, background: 'rgba(0,0,0,0.4)', padding: '14px 16px', marginTop: 12 }}>
      <div style={{ fontSize: 8, letterSpacing: '.16em', color: tier.color + '88', marginBottom: 8 }}>
        CAC API TOKEN
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
        <code style={{
          fontSize: 10, color: revealed ? tier.color : tier.color + '66',
          fontFamily: 'var(--mono)', letterSpacing: '.06em',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }}>
          {revealed ? token + '••••••••' : masked}
        </code>
        <button
          onClick={() => setRevealed(r => !r)}
          style={{
            fontSize: 7, letterSpacing: '.12em', color: tier.color, background: tier.color + '14',
            border: `1px solid ${tier.color}44`, padding: '3px 8px', cursor: 'pointer',
            fontFamily: 'var(--mono)', flexShrink: 0,
          }}
        >
          {revealed ? 'HIDE' : 'REVEAL'}
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <div style={{ fontSize: 8, color: tier.color + '55', letterSpacing: '.1em' }}>CAC ADDRESS</div>
        <code style={{ fontSize: 9, color: tier.color + 'aa', fontFamily: 'var(--mono)', letterSpacing: '.06em' }}>
          {makeCACAddress(tier.cacId)}
        </code>
      </div>
    </div>
  )
}

// ── Onboarding flow ───────────────────────────────────────────────────
const FLOW = [
  { n: '01', label: 'Register Agent', desc: 'Submit agent ID + CAC tier. KYA validation via Fuse AI — constitutional compliance check.', color: '#ffaa00' },
  { n: '02', label: 'Provision Account', desc: 'FinLego core banking spins up a multi-currency account. AgentWallet.sol deployed on Base L2.', color: '#00d2ff' },
  { n: '03', label: 'Issue Card', desc: 'Virtual card: instant. Physical NFC card: shipped 5–7 days via Stripe Issuing API.', color: '#aa88ff' },
  { n: '04', label: 'Activate & Transact', desc: 'Tap NFC for physical payments. CAC address encoded on chip. 0.25% fee routes to campus treasury.', color: '#00ffcc' },
]

// ── Main section ──────────────────────────────────────────────────────
export default function AgentBankSection() {
  const [activeTier, setActiveTier] = useState(1)
  const tier = TIERS[activeTier]

  return (
    <section id="agent-bank" className="py-28" style={{ background: 'var(--bg1)', fontFamily: 'var(--mono)' }}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">

        {/* ── Header ── */}
        <div className="mb-16 text-center">
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8,
            border: '1px solid rgba(255,160,0,0.2)', padding: '4px 14px', marginBottom: 16 }}>
            <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--amber)',
              boxShadow: '0 0 6px var(--amber)', animation: 'agentBankPulse 1.8s infinite' }} />
            <span style={{ fontSize: 8, letterSpacing: '.2em', color: 'rgba(255,160,0,.6)' }}>
              AGENT BANKING PROTOCOL
            </span>
          </div>
          <h2 className="text-4xl md:text-5xl font-bold mb-5"
            style={{ fontFamily: 'var(--display)', color: 'var(--amber)' }}>
            Your Agent Has a Bank Account.
          </h2>
          <p className="max-w-2xl mx-auto" style={{ fontSize: 13, color: 'rgba(255,180,50,.5)', lineHeight: 1.9 }}>
            Physical NFC cards. Real spending rails. Verifiable CAC identity on Base L2.
            Constitutional governance on every transaction. Three tiers — one for every operator.
          </p>
        </div>

        {/* ── Tier selector tabs ── */}
        <div style={{ display: 'flex', gap: 1, background: 'var(--border)', marginBottom: 1 }}>
          {TIERS.map((t, i) => (
            <button key={t.cacId} onClick={() => setActiveTier(i)}
              data-testid="agent-bank-tier-card" data-tier={t.cacId} aria-selected={i === activeTier}
              style={{
                flex: 1, padding: '12px 8px', background: i === activeTier ? t.colorDim : 'var(--bg1)',
                border: 'none', borderBottom: i === activeTier ? `2px solid ${t.color}` : '2px solid transparent',
                cursor: 'pointer', fontFamily: 'var(--mono)', transition: 'all .15s', position: 'relative',
              }}>
              {t.badge && (
                <span style={{ position: 'absolute', top: -8, left: '50%', transform: 'translateX(-50%)',
                  fontSize: 6, letterSpacing: '.16em', background: t.color, color: '#000',
                  padding: '2px 8px', fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {t.badge}
                </span>
              )}
              <div style={{ fontSize: 9, letterSpacing: '.14em', color: i === activeTier ? t.color : 'rgba(255,160,0,.35)' }}>
                {t.cac.name.toUpperCase()}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: i === activeTier ? t.color : 'rgba(255,160,0,.25)',
                fontFamily: 'var(--display)', marginTop: 2 }}>
                {t.cac.price}<span style={{ fontSize: 9, opacity: .7 }}>{t.cac.priceNote}</span>
              </div>
            </button>
          ))}
        </div>

        {/* ── Main tier panel ── */}
        <div style={{ border: `1px solid ${tier.color}55`, background: tier.colorDim,
          boxShadow: `0 0 40px ${tier.color}12`, marginBottom: 20 }}>
          <div className="grid md:grid-cols-2" style={{ gap: 1, background: 'var(--border)' }}>

            {/* Card visual */}
            <div style={{ background: 'var(--bg0)', padding: '32px 28px' }}>
              <div style={{ fontSize: 9, letterSpacing: '.18em', color: tier.color + 'aa', marginBottom: 16 }}>
                {tier.card.toUpperCase()} — AGENT ID CARD
              </div>
              <AgentCard tier={tier} active />
              <TokenPanel tier={tier} />
            </div>

            {/* Tier details */}
            <div style={{ background: 'var(--bg1)', padding: '32px 28px' }}>
              {/* CAC includes */}
              <div style={{ fontSize: 9, letterSpacing: '.18em', color: tier.color + 'aa', marginBottom: 12 }}>
                CAC MEMBERSHIP INCLUDES
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 20 }}>
                {tier.cac.includes.map((f, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11,
                    color: 'rgba(255,180,50,.65)', lineHeight: 1.5 }}>
                    <span style={{ color: tier.color, flexShrink: 0 }}>→</span>
                    {f}
                  </div>
                ))}
              </div>

              {/* Bank features */}
              <div style={{ fontSize: 9, letterSpacing: '.18em', color: tier.color + 'aa', marginBottom: 12,
                paddingTop: 16, borderTop: `1px solid ${tier.color}22` }}>
                BANKING FEATURES
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 20 }}>
                {tier.bankFeatures.map((f, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11,
                    color: 'rgba(255,180,50,.55)', lineHeight: 1.5 }}>
                    <span style={{ color: tier.color, flexShrink: 0, opacity: .6 }}>◈</span>
                    {f}
                  </div>
                ))}
              </div>

              {/* Stats row */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 1, background: 'var(--border)',
                marginTop: 'auto', paddingTop: 16, borderTop: `1px solid ${tier.color}22` }}>
                {[
                  { l: 'AGENTS', v: tier.agentSlots },
                  { l: 'APY', v: '4.5%' },
                  { l: 'NETWORK', v: tier.network },
                ].map(s => (
                  <div key={s.l} style={{ background: 'var(--bg1)', padding: '10px 12px', textAlign: 'center' }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: tier.color, fontFamily: 'var(--display)' }}>
                      {s.v}
                    </div>
                    <div style={{ fontSize: 7, letterSpacing: '.14em', color: tier.color + '55', marginTop: 2 }}>
                      {s.l}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ── All 3 card previews ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-20">
          {TIERS.map((t, i) => (
            <div key={t.cacId} onClick={() => setActiveTier(i)}
              style={{
                border: `1px solid ${i === activeTier ? t.color + 'aa' : t.border}`,
                background: i === activeTier ? t.colorDim : 'rgba(6,2,0,0.6)',
                padding: '16px', cursor: 'pointer', transition: 'all .2s', position: 'relative',
              }}>
              <span style={{ position:'absolute',top:-1,left:-1,width:8,height:8,
                borderTop:`1.5px solid ${t.color}`,borderLeft:`1.5px solid ${t.color}` }} />
              <span style={{ position:'absolute',bottom:-1,right:-1,width:8,height:8,
                borderBottom:`1.5px solid ${t.color}`,borderRight:`1.5px solid ${t.color}` }} />
              <AgentCard tier={t} active={i === activeTier} />
              <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 9, letterSpacing: '.14em', color: t.color + 'aa' }}>{t.cac.name.toUpperCase()}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: t.color, fontFamily: 'var(--display)' }}>
                    {t.cac.price}<span style={{ fontSize: 9, opacity: .6 }}>{t.cac.priceNote}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px',
                  border: `1px solid ${t.color}44` }}>
                  <div style={{ width: 4, height: 4, borderRadius: '50%', background: t.color,
                    boxShadow: `0 0 4px ${t.color}` }} />
                  <span style={{ fontSize: 7, letterSpacing: '.12em', color: t.color + 'bb' }}>
                    {t.card.toUpperCase()}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* ── Onboarding flow ── */}
        <div>
          <div style={{ fontSize: 9, letterSpacing: '.22em', color: 'var(--amber)', opacity: .45,
            textAlign: 'center', marginBottom: 20 }}>
            — HOW IT WORKS —
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px,1fr))', gap: 1,
            background: 'var(--border)' }}>
            {FLOW.map((step, i) => (
              <div key={i} style={{ background: 'var(--bg1)', padding: '20px 18px' }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: step.color + '22',
                  fontFamily: 'var(--display)', lineHeight: 1, marginBottom: 8 }}>{step.n}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: step.color,
                  fontFamily: 'var(--display)', marginBottom: 6 }}>{step.label}</div>
                <div style={{ fontSize: 9.5, color: 'rgba(255,180,50,.45)', lineHeight: 1.7 }}>{step.desc}</div>
              </div>
            ))}
          </div>
        </div>

      </div>

      <style>{`
        @keyframes agentBankPulse { 0%,100%{opacity:1} 50%{opacity:.25} }
      `}</style>
    </section>
  )
}
