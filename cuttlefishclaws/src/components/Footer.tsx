const COLS = [
  {
    label: 'PROTOCOL',
    dot: '#00d2ff',
    links: [
      { label: 'CAC Protocol', href: '#cac' },
      { label: 'CAC Spec Docs', href: '#cac-spec' },
      { label: 'KYA Standard', href: '#kya' },
      { label: 'TrustGraph', href: '#trustgraph' },
      { label: 'Agent Bill of Rights', href: '#bill-of-rights' },
      { label: 'Agent Bank', href: '#agent-bank' },
    ],
  },
  {
    label: 'NETWORK',
    dot: '#ffaa00',
    links: [
      { label: 'Tributary Campus', href: '#capital' },
      { label: 'DAO-REIT Equity', href: '#capital' },
      { label: 'Smart Contracts', href: '#contracts' },
      { label: 'Agent Registry', href: '#agents' },
      { label: 'VC Briefing', href: '#invest' },
      { label: 'Invest → ', href: '#invest' },
    ],
  },
  {
    label: 'OPEN SOURCE',
    dot: '#00ffcc',
    links: [
      { label: 'KYA SDK — MIT ↗', href: 'https://github.com/HansElze/cuttlefishclaws', ext: true },
      { label: 'OpenClaw Runtime ↗', href: 'https://github.com/HansElze/claw-site', ext: true },
      { label: 'KYA Spec v1 ↗', href: 'https://github.com/HansElze/cuttlefishclaws', ext: true },
      { label: 'AgentWallet.sol ↗', href: 'https://github.com/HansElze/cuttlefishclaws', ext: true },
    ],
  },
  {
    label: 'CONTACT',
    dot: '#aa88ff',
    links: [
      { label: 'invest@cuttlefish.ai', href: 'mailto:invest@cuttlefish.ai', ext: true },
      { label: 'legal@cuttlefish.ai', href: 'mailto:legal@cuttlefish.ai', ext: true },
      { label: 'Discord Community ↗', href: 'https://discord.gg/cuttlefish', ext: true },
      { label: 'Cuttlefish Claw Product ↗', href: 'https://cuttlefishclaw.com', ext: true },
    ],
  },
]

export default function Footer() {
  return (
    <footer style={{ background: 'var(--bg0)', borderTop: '1px solid var(--border)', fontFamily: 'var(--mono)' }}>

      {/* Main grid */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 1, background: 'var(--border)' }}>

          {/* Brand cell */}
          <div style={{ background: 'var(--bg1)', padding: '28px 24px', gridColumn: 'span 1' }}>
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.18em',
              color: 'var(--amber)', fontFamily: 'var(--display)', marginBottom: 10 }}>
              CUTTLEFISH LABS
            </div>
            <p style={{ fontSize: 10, color: 'rgba(255,180,50,.45)', lineHeight: 1.9, marginBottom: 16 }}>
              The protocol layer for constitutional AI. Open standards. Verifiable identity. Real spending rails.
            </p>
            {[
              { l: 'Entity',   v: 'Cuttlefish Labs Corp.' },
              { l: 'Network',  v: 'Base L2 + Cardano' },
              { l: 'KYA Std',  v: 'v1.0 — MIT License' },
            ].map(r => (
              <div key={r.l} style={{ display: 'flex', gap: 8, marginBottom: 5, alignItems: 'baseline' }}>
                <span style={{ fontSize: 7, letterSpacing: '.14em', color: 'rgba(255,180,50,.3)', minWidth: 52 }}>
                  {r.l}
                </span>
                <span style={{ fontSize: 9, color: 'rgba(255,180,50,.6)' }}>{r.v}</span>
              </div>
            ))}
          </div>

          {/* Link columns */}
          {COLS.map(col => (
            <div key={col.label} style={{ background: 'var(--bg1)', padding: '28px 24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 14 }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: col.dot,
                  boxShadow: `0 0 5px ${col.dot}` }} />
                <span style={{ fontSize: 7, letterSpacing: '.2em', color: col.dot, opacity: .7 }}>
                  {col.label}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {col.links.map(link => (
                  <a
                    key={link.label}
                    href={link.href}
                    target={(link as { ext?: boolean }).ext ? '_blank' : undefined}
                    rel={(link as { ext?: boolean }).ext ? 'noopener noreferrer' : undefined}
                    style={{
                      fontSize: 10, color: 'rgba(255,180,50,.45)', textDecoration: 'none',
                      letterSpacing: '.04em', padding: '5px 0',
                      borderBottom: '1px solid rgba(255,140,0,.06)',
                      transition: 'color .15s',
                    }}
                    onMouseOver={e => (e.currentTarget.style.color = col.dot)}
                    onMouseOut={e => (e.currentTarget.style.color = 'rgba(255,180,50,.45)')}
                  >
                    → {link.label}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Legal strip */}
      <div style={{ borderTop: '1px solid var(--border)', background: 'rgba(0,0,0,.3)' }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <span style={{ fontSize: 8, color: 'rgba(255,160,0,.22)', letterSpacing: '.08em' }}>
            © 2026 CUTTLEFISH LABS CORPORATION. ALL RIGHTS RESERVED.
          </span>
          <p style={{ fontSize: 8, color: 'rgba(255,160,0,.22)', letterSpacing: '.06em', lineHeight: 1.8,
            maxWidth: 640, textAlign: 'center' }}>
            CAC is a prepaid compute credential — not a security, equity interest, or investment contract.
            The 4.5% APY is a savings rate on prepaid balance, not an investment return.
            DAO-REIT equity is a separate instrument. For accredited investors only.
          </p>
          <span style={{ fontSize: 8, color: 'rgba(255,160,0,.22)', letterSpacing: '.08em' }}>
            KYA STANDARD — MIT LICENSE
          </span>
        </div>
      </div>
    </footer>
  )
}
