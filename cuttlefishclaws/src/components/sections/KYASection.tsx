'use client'

import { useState } from 'react'

const PATTERNS = [
  {
    id: 'web',
    label: 'Website Login',
    icon: '◈',
    color: '#00d2ff',
    tagline: '"Login with Agent"',
    steps: [
      { n: '1', text: 'User taps NFC card or scans QR on any site' },
      { n: '2', text: 'Site calls KYA.challenge(agentDID)' },
      { n: '3', text: 'Agent signs challenge with private key' },
      { n: '4', text: 'KYA.verify() returns tier + constitution status' },
      { n: '5', text: 'Site grants access — no password, no OAuth app' },
    ],
    code: `import { KYA } from '@cuttlefish/kya-sdk'

const id = await KYA.verify(agentDID)
// { tier: 'studio', valid: true,
//   constitution: 'verified',
//   trust_floor: 40 }`,
  },
  {
    id: 'agent',
    label: 'Agent-to-Agent',
    icon: '⬡',
    color: '#aa88ff',
    tagline: 'Trust bootstrap',
    steps: [
      { n: '1', text: 'Agent A encounters Agent B for the first time' },
      { n: '2', text: 'A requests B\'s KYA credential' },
      { n: '3', text: 'Constitution hash verified — same framework' },
      { n: '4', text: 'TrustGraph seeded with trust_floor from credential' },
      { n: '5', text: 'Constitutional match auto-upgrades to score 60' },
    ],
    code: `const identity = await KYA.verify(peerAgentDID)

trustGraph.seed(peerAgentDID, {
  floor: identity.trust_floor,
  boost: identity.constitutional_match ? 20 : 0
})`,
  },
  {
    id: 'physical',
    label: 'Physical World',
    icon: '⊙',
    color: '#ffaa00',
    tagline: 'NFC tap payment',
    steps: [
      { n: '1', text: 'Agent taps NFC card at POS terminal' },
      { n: '2', text: 'Terminal reads CAC address from chip' },
      { n: '3', text: 'KYA.verify(cacAddress) — confirms active, funded' },
      { n: '4', text: 'AgentWallet.sol executes payment on Base L2' },
      { n: '5', text: '0.25% fee routes to Tributary campus treasury' },
    ],
    code: `// POS terminal integration
const card = await NFC.read()
const kya  = await KYA.verify(card.cacAddress)

if (kya.valid && kya.funded) {
  await AgentWallet.pay(amount, card.cacAddress)
}`,
  },
  {
    id: 'api',
    label: 'Public Verify API',
    icon: '◉',
    color: '#00ffcc',
    tagline: 'No CAC account needed',
    steps: [
      { n: '1', text: 'Any third party calls the public KYA endpoint' },
      { n: '2', text: 'Returns tier, constitution hash, operator, expiry' },
      { n: '3', text: 'Financial details stay private — identity only' },
      { n: '4', text: 'MIT SDK — embed in 3 lines, no CAC account needed' },
      { n: '5', text: 'Works offline via NFC — no internet required' },
    ],
    code: `# Public REST endpoint — no auth required
curl https://api.kya.cuttlefish.io/v1/verify/\\
  did:cardano:agent_xxxx

# { valid: true, tier: "studio",
#   constitution: "verified",
#   expires: "2027-03-21" }`,
  },
]

const CREDENTIAL_FIELDS = [
  { field: 'agent_did',          type: 'string',    desc: 'did:cardano:<hash>' },
  { field: 'constitution_hash',  type: 'bytes32',   desc: 'SHA-256 of CONSTITUTION.md' },
  { field: 'soul_hash',          type: 'bytes32',   desc: 'SHA-256 of SOUL.md' },
  { field: 'tier',               type: 'enum',      desc: 'developer / studio / enterprise' },
  { field: 'trust_floor',        type: 'uint8',     desc: 'Min TrustGraph seed score' },
  { field: 'operator',           type: 'address',   desc: 'Responsible human or org' },
  { field: 'cac_address',        type: 'address',   desc: 'Base L2 wallet (if funded)' },
  { field: 'expires',            type: 'timestamp', desc: 'Annual renewal date' },
]

export default function KYASection() {
  const [activePattern, setActivePattern] = useState(0)
  const p = PATTERNS[activePattern]

  return (
    <section id="kya" className="py-28" style={{ background: 'var(--bg0)', fontFamily: 'var(--mono)' }}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">

        {/* ── Header ── */}
        <div className="mb-16 text-center">
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 14px',
            border: '1px solid rgba(0,210,255,.25)', marginBottom: 16 }}>
            <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#00d2ff',
              boxShadow: '0 0 6px #00d2ff', animation: 'kyaPulse 1.8s infinite' }} />
            <span style={{ fontSize: 8, letterSpacing: '.2em', color: 'rgba(0,210,255,.7)' }}>
              OPEN STANDARD · MIT LICENSE
            </span>
          </div>
          <h2 className="text-4xl md:text-5xl font-bold mb-5"
            style={{ fontFamily: 'var(--display)', color: 'var(--amber)' }}>
            KYA — Know Your Agent
          </h2>
          <p className="max-w-2xl mx-auto" style={{ fontSize: 14, color: 'rgba(255,180,50,.55)', lineHeight: 1.8 }}>
            A portable, verifiable identity standard for AI agents. Not just a CAC feature —
            an open protocol any site, wallet, or agent can integrate. The physical card is the artifact.
            KYA is the protocol.
          </p>
        </div>

        {/* ── KYA vs CAC distinction ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-px mb-16"
          style={{ background: 'var(--border)' }}>
          <div style={{ background: 'var(--bg1)', padding: '24px 28px' }}>
            <div style={{ fontSize: 9, letterSpacing: '.2em', color: '#00d2ff', opacity: .7, marginBottom: 8 }}>
              KYA — IDENTITY LAYER
            </div>
            <p style={{ fontSize: 12, color: 'rgba(255,180,50,.6)', lineHeight: 1.8 }}>
              Who is this agent? What governs it? Who is responsible?
              Verifiable by anyone. No financial data exposed.
              MIT SDK — integrate in 3 lines. Works offline via NFC.
            </p>
          </div>
          <div style={{ background: 'var(--bg1)', padding: '24px 28px' }}>
            <div style={{ fontSize: 9, letterSpacing: '.2em', color: '#ffaa00', opacity: .7, marginBottom: 8 }}>
              CAC — FINANCIAL LAYER
            </div>
            <p style={{ fontSize: 12, color: 'rgba(255,180,50,.6)', lineHeight: 1.8 }}>
              How much compute credit does this agent have? What can it spend?
              Private by default. Only exposed to authorized parties.
              KYA credential includes CAC address only if operator allows.
            </p>
          </div>
        </div>

        {/* ── The credential ── */}
        <div className="mb-16">
          <div style={{ fontSize: 9, letterSpacing: '.2em', color: 'var(--amber)', opacity: .5,
            textAlign: 'center', marginBottom: 16 }}>
            — WHAT'S IN THE CREDENTIAL —
          </div>
          <div style={{ border: '1px solid var(--border)', overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 2fr',
              background: 'rgba(255,187,51,.06)', borderBottom: '1px solid var(--border)',
              padding: '8px 16px' }}>
              {['Field', 'Type', 'Description'].map(h => (
                <div key={h} style={{ fontSize: 8, letterSpacing: '.16em',
                  color: 'rgba(255,187,51,.5)', textTransform: 'uppercase' }}>{h}</div>
              ))}
            </div>
            {CREDENTIAL_FIELDS.map((row, i) => (
              <div key={row.field}
                style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 2fr',
                  padding: '9px 16px', borderBottom: i < CREDENTIAL_FIELDS.length - 1
                    ? '1px solid rgba(255,140,0,.08)' : 'none' }}>
                <div style={{ fontSize: 11, color: '#00d2ff', fontFamily: 'var(--mono)' }}>
                  {row.field}
                </div>
                <div style={{ fontSize: 10, color: 'rgba(170,136,255,.8)' }}>{row.type}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,180,50,.5)' }}>{row.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Integration patterns ── */}
        <div className="mb-16">
          <div style={{ fontSize: 9, letterSpacing: '.2em', color: 'var(--amber)', opacity: .5,
            textAlign: 'center', marginBottom: 16 }}>
            — INTEGRATION PATTERNS —
          </div>

          {/* Pattern tabs */}
          <div style={{ display: 'flex', gap: 1, marginBottom: 1, background: 'var(--border)' }}>
            {PATTERNS.map((pat, i) => (
              <button key={pat.id} onClick={() => setActivePattern(i)}
                data-testid="kya-pattern-tab" data-pattern={pat.id} role="tab" aria-selected={i === activePattern}
                style={{
                  flex: 1, padding: '10px 8px', background: i === activePattern
                    ? `${pat.color}12` : 'var(--bg1)',
                  border: 'none', borderBottom: i === activePattern
                    ? `2px solid ${pat.color}` : '2px solid transparent',
                  cursor: 'pointer', fontFamily: 'var(--mono)', transition: 'all .15s',
                }}>
                <div style={{ fontSize: 16, color: i === activePattern ? pat.color : 'rgba(255,187,51,.3)' }}>
                  {pat.icon}
                </div>
                <div style={{ fontSize: 8, letterSpacing: '.12em', color: i === activePattern
                  ? pat.color : 'rgba(255,187,51,.3)', marginTop: 3 }}>
                  {pat.label.toUpperCase()}
                </div>
              </button>
            ))}
          </div>

          {/* Pattern detail */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1,
            background: 'var(--border)' }}>
            {/* Steps */}
            <div style={{ background: 'var(--bg1)', padding: '20px 24px' }}>
              <div style={{ fontSize: 9, letterSpacing: '.16em', color: p.color, opacity: .7,
                marginBottom: 14 }}>
                {p.tagline.toUpperCase()}
              </div>
              {p.steps.map((step, i) => (
                <div key={i} style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
                  <div style={{ width: 18, height: 18, border: `1px solid ${p.color}55`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0, marginTop: 1 }}>
                    <span style={{ fontSize: 8, color: p.color }}>{step.n}</span>
                  </div>
                  <span style={{ fontSize: 11, color: 'rgba(255,180,50,.6)', lineHeight: 1.6 }}>
                    {step.text}
                  </span>
                </div>
              ))}
            </div>
            {/* Code */}
            <div style={{ background: 'rgba(0,0,0,.4)', padding: '20px 24px',
              borderLeft: `2px solid ${p.color}33` }}>
              <div style={{ fontSize: 8, letterSpacing: '.16em', color: p.color, opacity: .5,
                marginBottom: 12 }}>CODE EXAMPLE</div>
              <pre style={{ fontSize: 10, color: 'rgba(0,210,255,.8)', lineHeight: 1.8,
                whiteSpace: 'pre-wrap', margin: 0 }}>
                {p.code}
              </pre>
            </div>
          </div>
        </div>

        {/* ── KYA Badge standard ── */}
        <div className="mb-16">
          <div style={{ fontSize: 9, letterSpacing: '.2em', color: 'var(--amber)', opacity: .5,
            textAlign: 'center', marginBottom: 20 }}>
            — KYA BADGE STANDARD —
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
            {[
              { label: 'KYA PENDING', color: '#888', desc: 'Submitted, validating' },
              { label: 'KYA VERIFIED', tier: 'DEVELOPER', color: '#ffaa00', desc: 'Virtual card' },
              { label: 'KYA VERIFIED', tier: 'STUDIO', color: '#00d2ff', desc: 'Physical NFC' },
              { label: 'KYA VERIFIED', tier: 'ENTERPRISE', color: '#aa88ff', desc: 'Metal · full governance' },
            ].map((badge, i) => (
              <div key={i} style={{ textAlign: 'center' }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '5px 12px', border: `1px solid ${badge.color}55`,
                  background: `${badge.color}0d`, marginBottom: 6 }}>
                  <div style={{ width: 5, height: 5, borderRadius: '50%',
                    background: badge.color, boxShadow: `0 0 5px ${badge.color}` }} />
                  <span style={{ fontSize: 9, letterSpacing: '.14em', color: badge.color }}>
                    {badge.label}{badge.tier ? ` — ${badge.tier}` : ''}
                    {badge.tier ? ' — CONSTITUTIONAL' : ''}
                  </span>
                </div>
                <div style={{ fontSize: 9, color: 'rgba(255,180,50,.35)' }}>{badge.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Why it's transferable ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-px"
          style={{ background: 'var(--border)', marginBottom: 0 }}>
          {[
            { n: '01', title: 'MIT licensed', desc: 'SDK is free, open source, forever.' },
            { n: '02', title: 'W3C DID standard', desc: 'Compatible with existing VC infrastructure.' },
            { n: '03', title: 'No CAC needed to verify', desc: 'Public endpoint, no account required.' },
            { n: '04', title: 'Open constitution registry', desc: 'Anyone can verify a hash.' },
            { n: '05', title: 'Works offline', desc: 'NFC readable without internet.' },
          ].map((item, i) => (
            <div key={i} style={{ background: 'var(--bg1)', padding: '18px 16px' }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'rgba(0,210,255,.18)',
                fontFamily: 'var(--display)', lineHeight: 1, marginBottom: 8 }}>{item.n}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--amber)',
                fontFamily: 'var(--display)', marginBottom: 5 }}>{item.title}</div>
              <div style={{ fontSize: 9.5, color: 'rgba(255,180,50,.45)', lineHeight: 1.6 }}>
                {item.desc}
              </div>
            </div>
          ))}
        </div>

      </div>

      <style>{`
        @keyframes kyaPulse { 0%,100%{opacity:1} 50%{opacity:.2} }
      `}</style>
    </section>
  )
}
