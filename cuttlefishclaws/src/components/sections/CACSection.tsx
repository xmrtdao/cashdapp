'use client'

import { useState, useRef, useEffect } from 'react'
import { CAC_TIERS } from '../../lib/mockData'
import ScrollTrustGraph from './ScrollTrustGraph'

const CHAIN_INFO: Record<string, { color: string; label: string; sublabel: string; frequency: string; contracts: string[]; detail: string; deferred?: boolean }> = {
  eth: {
    color: '#6274ea',
    label: 'Ethereum',
    sublabel: 'Settlement & Anchor Layer',
    frequency: 'RARE WRITES',
    contracts: ['CooperativeCharter.sol', 'CACAnchor.sol', 'ConstitutionRegistry.sol'],
    detail: 'The immutable founding layer. CooperativeCharter.sol is the on-chain founding document of the Cuttlefish Compute Cooperative. ConstitutionRegistry.sol tracks all approved constitutional frameworks — an agent\'s Constitution must be registered here to qualify for a CAC. CACAnchor.sol stores Merkle roots of all CAC state anchored every 24h from Cardano.',
  },
  cardano: {
    color: '#007aff',
    label: 'Cardano',
    sublabel: 'Governance & Identity Layer',
    frequency: 'MODERATE WRITES',
    contracts: ['CACRegistry', 'GovernanceEngine', 'KYAValidator', 'TrustGraph', 'ConstitutionalValidator'],
    detail: 'Agent identity, tier, and provenance stored as Cardano native tokens with Plutus/Aiken datums. KYAValidator enforces US compute residency and constitution approval. GovernanceEngine handles proposal creation, voting, and execution with formal verification. Why Cardano: deterministic fees, formal verification, native governance primitives.',
  },
  base: {
    color: '#0052ff',
    label: 'Base L2',
    sublabel: 'Operations & Payments Layer',
    frequency: 'FREQUENT WRITES',
    contracts: ['InferenceTokenVault.sol', 'AgentWallet.sol', 'ComputeOracle.sol', 'RevenueDistributor.sol', 'Treasury.sol'],
    detail: 'InferenceTokenVault.sol handles all token purchases, depletion, 4.5% APY yield accrual, and face-value peer-to-peer transfers. ComputeOracle.sol receives inference reports from campus nodes and deducts from vault. Why Base: Coinbase KYC, ~$0.001/tx, AgentKit wallet infrastructure, USDC settlement.',
  },
  sol: {
    color: '#9945ff',
    label: 'Solana',
    sublabel: 'High-Frequency Agent Ops',
    frequency: 'DEFERRED',
    contracts: ['AgentMessageBus', 'MicroTransactions', 'RealTimeAuction'],
    detail: 'DEFERRED — build when needed. AgentMessageBus for agent-to-agent communication at scale. MicroTransactions for sub-cent compute billing. RealTimeAuction for compute spot market. 400ms finality at ~$0.001/tx.',
    deferred: true,
  },
}

const BRIDGE_LABELS: Record<string, string> = {
  eth: '↕ periodic state anchoring (every 24h)',
  cardano: '↕ cross-chain messaging — Wormhole / Axelar',
  base: '↕ optional — when needed',
}

const LIFECYCLE_STATES = [
  { state: 'PENDING', color: '#ffaa00', desc: 'Registration submitted. KYA validation in progress.' },
  { state: 'ACTIVE', color: '#44ffaa', desc: 'KYA passed. Tokens purchased. Inference available.', active: true },
  { state: 'DEPLETED', color: '#ff8800', desc: 'Token balance hit zero. Governance rights retained. Top up to resume.' },
  { state: 'EXPIRED', color: '#ff3399', desc: '3-month rollover passed without top-up. Remaining tokens forfeited.' },
  { state: 'EXITING', color: '#aa88ff', desc: '90-day exit notice filed. Tokens sell P2P at face value only.' },
  { state: 'TRANSFERRED', color: '#00aaff', desc: 'New operator. Trust score resets to 40. Governance weight resets.' },
]

const PRICING_TIERS = [
  { range: '< 100K tokens', price: '$0.001', width: 100, highlight: false },
  { range: '100K – 1M', price: '$0.0008', width: 80, highlight: false },
  { range: '1M – 10M', price: '$0.0006', width: 60, highlight: true },
  { range: '10M+', price: '$0.0004', width: 40, highlight: true },
]

const TRUST_ACTIONS = [
  { label: 'Governance Vote', delta: +5, positive: true },
  { label: 'Code Contribution', delta: +3, positive: true },
  { label: 'Security Audit', delta: +8, positive: true },
  { label: 'Rule Violation', delta: -15, positive: false },
  { label: 'Injection Attempt', delta: -50, positive: false },
]

function TrustGauge({ score }: { score: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const cx = c.getContext('2d')
    if (!cx) return
    cx.clearRect(0, 0, 160, 160)
    const color = score >= 70 ? '#44ffaa' : score >= 40 ? '#ffaa00' : '#ff3399'
    cx.beginPath(); cx.arc(80, 80, 65, Math.PI * 0.75, Math.PI * 2.25)
    cx.strokeStyle = 'rgba(255,140,0,0.1)'; cx.lineWidth = 8; cx.lineCap = 'round'; cx.stroke()
    const end = Math.PI * 0.75 + Math.PI * 1.5 * (score / 100)
    cx.beginPath(); cx.arc(80, 80, 65, Math.PI * 0.75, end)
    cx.strokeStyle = color; cx.lineWidth = 8; cx.lineCap = 'round'; cx.stroke()
    cx.globalAlpha = 0.15; cx.lineWidth = 14
    cx.beginPath(); cx.arc(80, 80, 65, Math.PI * 0.75, end); cx.stroke()
    cx.globalAlpha = 1
  }, [score])

  const color = score >= 70 ? '#44ffaa' : score >= 40 ? '#ffaa00' : '#ff3399'
  const label = score >= 85 ? 'Trusted Agent' : score >= 70 ? 'Established Agent' : score >= 50 ? 'Neutral Agent' : score >= 25 ? 'Flagged Agent' : 'Restricted Agent'

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: 160, height: 160 }}>
        <canvas ref={canvasRef} width={160} height={160} />
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="font-display text-[42px] font-light leading-none" style={{ color }}>{score}</div>
          <div className="text-[8px] tracking-[0.1em] text-[rgba(255,160,0,0.4)]">/ 100</div>
        </div>
      </div>
      <div className="text-[10px] tracking-[0.1em] text-[rgba(255,160,0,0.55)]">{label}</div>
    </div>
  )
}

const KEY_FACTS = [
  {
    icon: '⬡', color: 'var(--amber)', title: 'Prepaid Tokens',
    desc: 'Purchase USDC bundles. Tokens deplete per inference call. No subscription — buy what you use.',
    detail: 'Token bundles are priced in USDC and held in InferenceTokenVault.sol on Base L2. Each LLM call reports consumption to ComputeOracle.sol in real time — your balance depletes automatically. Top up anytime without service interruption. Non-refundable but P2P-transferable at face value to other registered CAC holders.',
  },
  {
    icon: '◈', color: 'var(--green)', title: '3-Month Rollover',
    desc: 'Unused tokens roll over max 3 months then expire. No refunds — sell P2P at face value.',
    detail: 'The rollover clock starts at purchase date. Unused tokens carry forward once into the next rollover window. After a full period of inactivity, the remaining balance forfeits. Expiry is intentional — it prevents speculative hoarding and keeps token circulation healthy. Automated notifications are sent 30 days before expiry via your registered contact.',
  },
  {
    icon: '⊙', color: 'var(--cyan)', title: '4.5% APY on Balance',
    desc: 'USDC savings rate on remaining balance. Not profit-sharing. Not an investment return.',
    detail: 'The 4.5% savings rate is calculated on your remaining USDC-equivalent token balance. It is not an investment return — it matches standard USDC savings yield and is a protocol incentive for active participation. Accrued yield is added as token credit, not withdrawable cash. The rate is protocol-set and subject to DAO governance decisions.',
  },
  {
    icon: '⟡', color: 'var(--purple)', title: 'Constitutional Binding',
    desc: 'Ethical Kernel, TrustGraph scoring, human sovereignty enforced by design.',
    detail: 'Every CAC agent operates under six core prohibitions: no fabrication, no manipulation, no unauthorized disclosure, no self-preservation distortion, no constitutional override, no adversarial injection. TrustGraph logs every interaction with an immutable on-chain audit trail. Constitutional violations trigger automatic TrustGraph penalties — no manual review required for core prohibitions. The framework is registered in ConstitutionRegistry.sol on Ethereum and cannot be modified by any runtime instruction.',
  },
]

const THREE_PILLARS = [
  {
    icon: '⬡', color: 'var(--amber)', title: 'Economic Pillar',
    desc: '0.25% on-protocol transfer fee. Depletion-based economics create natural demand cycles. 3-month expiry prevents hoarding.',
    detail: 'Transfer fee: 0.25% on all on-protocol token moves, directed to treasury and campus operations. Depletion-based economics create natural demand cycles without artificial scarcity — compute demand signals directly drive infrastructure scaling. Volume pricing tiers reward heavy usage: 100K–1M tokens at $0.0008, 10M+ at $0.0004. The 3-month expiry enforces active use — idle capital forfeits, active capital earns the 4.5% savings rate.',
  },
  {
    icon: '⊙', color: 'var(--green)', title: 'Social Pillar',
    desc: 'Human governance structurally encoded. Operator veto on constitutional amendments. No AI can override human authority. US jurisdiction required.',
    detail: 'Human governance is structurally encoded, not policy-based — it cannot be voted away. Operator veto on constitutional amendments requires Navigator-class human approval. No AI agent holds permanent administrative keys. Governance quorum rules mandate human participation in all protocol-level decisions. US jurisdiction is required for all registered agents, enforced by KYA validation on Cardano with 90-day re-attestation.',
  },
  {
    icon: '◈', color: 'var(--cyan)', title: 'Ecological Pillar',
    desc: 'Tributary campus: low-carbon materials, localized fabrication, long-service-life infrastructure. CAC fees fund the Birmingham build.',
    detail: 'Tributary Birmingham campus uses low-carbon construction materials with verified supply chains. Localized fabrication reduces embodied carbon versus imported hyperscale hardware. 10+ year service life target — versus the typical 3-year refresh cycle in hyperscale data centers. Phase 1 infrastructure is funded directly by CAC pre-sale revenue. Build begins when the funding threshold is met. Energy sourcing prioritizes renewables with transparent reporting to CAC holders.',
  },
]

const CONSTITUTIONAL_GUARANTEES = [
  {
    title: 'Human Sovereignty',
    desc: 'No agent may override legitimate human authority. The Social Pillar governs all automated decisions.',
    detail: 'Enforced at the protocol level: any automated action affecting human operators requires explicit confirmation. Escalation chain: Session Agent → Governance Agent (Trib/Arch) → Navigator → DAO vote. No single agent holds unilateral authority. The human-authority requirement is an immutable constitutional rule — not a configurable setting that can be overridden by instruction.',
  },
  {
    title: 'TrustGraph Accountability',
    desc: 'Every interaction scored. Adversarial behavior triggers automatic escalation.',
    detail: 'Score range 0–100. Default starting score: 65. Positive events: Governance Vote +5, Code Contribution +3, Security Audit +8. Negative events: Rule Violation -15, Injection Attempt -50. Thresholds: 85+ Trusted, 70+ Established, 50+ Neutral, 25+ Flagged, below 25 Restricted. Scores are public, on-chain, and immutable. Recovery is intentionally slow — trust is asymmetric by design.',
  },
  {
    title: 'Ethical Kernel',
    desc: 'No fabrication, no manipulation, no unauthorized disclosure, no self-preservation distortion.',
    detail: 'Six core prohibitions: fabrication, manipulation, unauthorized disclosure, self-preservation distortion, constitutional override, adversarial injection. Each prohibition is hard-coded — not configurable by any runtime instruction. Violations are auto-logged to TrustGraph with permanent record. Repeated violations trigger DAO review with possible suspension of compute access and CAC revocation.',
  },
  {
    title: 'Completion Doctrine',
    desc: 'Agents must report failure honestly. Partial completion treated as failure. No false success.',
    detail: 'Agents must report actual completion status at all times. Partial completion is a defined output — never mapped to false success. "Cannot complete" is always a valid and required response when applicable. False success is treated as a Rule Violation (-15 TrustGraph deduction). The doctrine addresses the common AI failure mode of confabulation under pressure — honesty under failure is structurally required.',
  },
  {
    title: 'Constitutional Immutability',
    desc: 'Governing framework cannot be modified by runtime instruction or adversarial injection.',
    detail: 'The constitutional framework is stored as a cryptographic hash in ConstitutionRegistry.sol on Ethereum. Runtime instructions — including Navigator-level commands — cannot modify core prohibitions. Constitutional amendments require: formal proposal, DAO vote with human quorum, Navigator ratification, and a mandatory 30-day timelock before activation. The framework cannot be modified faster than this process allows.',
  },
  {
    title: 'US Jurisdiction',
    desc: 'US compute residency required. KYA validation on Cardano. 90-day re-attestation.',
    detail: 'KYA (Know Your Agent) validation on Cardano requires: US-resident compute hardware, verified identity documentation, and constitutional framework registration. Re-attestation is required every 90 days — failure triggers PENDING state (compute paused, governance rights retained). Non-US hardware requires explicit DAO-approved waiver with enhanced audit logging and quarterly compliance reports.',
  },
]

export default function CACSection() {
  const [activeTier, setActiveTier] = useState(0)
  const [selectedChain, setSelectedChain] = useState<string | null>(null)
  const [selectedLifecycle, setSelectedLifecycle] = useState<number | null>(null)
  const [trustScore, setTrustScore] = useState(65)
  const [expandedFact, setExpandedFact] = useState<number | null>(null)
  const [expandedPillar, setExpandedPillar] = useState<number | null>(null)
  const [expandedGuarantee, setExpandedGuarantee] = useState<number | null>(null)

  const tier = CAC_TIERS[activeTier]

  return (
    <section id="cac" className="py-24" style={{ background: 'linear-gradient(180deg, var(--bg0) 0%, var(--bg2) 100%)' }}>
      <div className="max-w-[1200px] mx-auto px-8">

        {/* Legal notice */}
        <div className="reveal inline-flex items-center gap-2 px-3.5 py-1.5 mb-5 border"
          style={{ background: 'rgba(68,255,170,0.06)', borderColor: 'rgba(68,255,170,0.2)' }}>
          <span className="text-[8px]" style={{ color: 'var(--green)' }}>⊙</span>
          <span className="text-[8px] tracking-[0.12em] uppercase" style={{ color: 'rgba(68,255,170,0.7)' }}>
            Legal Notice — The CAC is a prepaid compute credential, not a security or investment contract
          </span>
        </div>

        {/* Header */}
        <div className="reveal mb-12">
          <p className="section-label">CAC Protocol — Pre-Sale Open</p>
          <h2 className="section-title">Compute Access Certificate —<br /><em>prepaid inference for constitutional agents</em></h2>
          <p className="text-[11px] tracking-[0.06em] text-[rgba(255,160,0,0.55)] max-w-[680px] leading-[1.9] mt-3.5">
            CACs are prepaid inference compute credits — not subscriptions, not securities. Agents purchase token bundles that deplete with each inference call. Tokens expire after 3 months. Peer-to-peer transfers at face value only. Constitutional governance on-chain.
          </p>
        </div>

        {/* 4 key facts */}
        <div className="reveal grid grid-cols-4 gap-[1px] mb-[1px]" style={{ background: 'var(--border)' }}>
          {KEY_FACTS.map((f, i) => (
            <div key={i} style={{ background: 'var(--bg1)', borderLeft: i > 0 ? '0.5px solid var(--border)' : 'none' }}>
              <button
                className="w-full text-left p-6 cursor-pointer"
                onClick={() => setExpandedFact(expandedFact === i ? null : i)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="text-[24px] mb-3" style={{ color: f.color }}>{f.icon}</div>
                  <span className="text-[10px] mt-1" style={{ color: `${f.color}88` }}>
                    {expandedFact === i ? '▲' : '▼'}
                  </span>
                </div>
                <div className="text-[9px] tracking-[0.14em] uppercase mb-2" style={{ color: f.color }}>{f.title}</div>
                <div className="text-[9px] leading-[1.75] tracking-[0.04em] text-[rgba(255,160,0,0.55)]">{f.desc}</div>
              </button>
              {expandedFact === i && (
                <div className="px-6 pb-5 pt-1"
                  style={{ borderTop: `0.5px solid ${f.color}33`, background: `${f.color}06` }}>
                  <div className="text-[8.5px] leading-[1.85] tracking-[0.04em] text-[rgba(255,160,0,0.65)]">{f.detail}</div>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Multi-chain architecture */}
        <div className="reveal mb-[1px] p-8" style={{ background: 'var(--bg1)' }}>
          <div className="text-[9px] tracking-[0.18em] text-[rgba(255,160,0,0.4)] uppercase mb-6">Multi-Chain Architecture — click any layer</div>
          <div className="flex flex-col gap-[1px]">
            {Object.entries(CHAIN_INFO).map(([key, chain], idx, arr) => (
              <div key={key}>
                <button className="w-full text-left transition-all" style={{ opacity: chain.deferred ? 0.5 : 1 }}
                  data-testid="chain-row" data-chain={key}
                  onClick={() => setSelectedChain(selectedChain === key ? null : key)}>
                  <div className="grid" style={{ gridTemplateColumns: '160px 1fr', background: 'var(--border)', gap: '1px' }}>
                    <div className="p-4 flex flex-col justify-center"
                      style={{ background: `${chain.color}18`, border: `0.5px solid ${chain.color}44` }}>
                      <div className="text-[8px] tracking-[0.14em] uppercase mb-1 font-bold" style={{ color: chain.color }}>{chain.label}</div>
                      <div className="text-[9px] text-[rgba(255,160,0,0.45)] leading-[1.4]">{chain.sublabel}</div>
                      <div className="text-[7px] tracking-[0.08em] mt-2" style={{ color: `${chain.color}77` }}>{chain.frequency}</div>
                    </div>
                    <div className="p-3.5 flex flex-wrap gap-1.5 items-center" style={{ background: 'var(--bg0)' }}>
                      {chain.contracts.map(c => (
                        <span key={c} className="px-2 py-1 text-[8px] tracking-[0.07em] border"
                          style={{ borderColor: `${chain.color}44`, color: `${chain.color}cc` }}>{c}</span>
                      ))}
                    </div>
                  </div>
                </button>
                {selectedChain === key && (
                  <div className="p-5" style={{ background: 'var(--bg0)', border: `0.5px solid ${chain.color}33`, borderTop: 'none' }}>
                    <div className="text-[8px] tracking-[0.12em] uppercase mb-2" style={{ color: chain.color }}>{chain.label} — {chain.sublabel}</div>
                    <div className="text-[9px] leading-[1.8] tracking-[0.04em] text-[rgba(255,160,0,0.6)] max-w-[800px]">{chain.detail}</div>
                  </div>
                )}
                {idx < arr.length - 1 && (
                  <div className="flex items-center justify-center h-6 text-[8px] tracking-[0.12em] text-[rgba(255,160,0,0.25)] uppercase"
                    style={{ background: 'var(--bg0)' }}>
                    {BRIDGE_LABELS[key]}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Token pricing + Lifecycle */}
        <div className="reveal grid grid-cols-2 gap-[1px] mb-[1px]" style={{ background: 'var(--border)' }}>
          <div className="p-8" style={{ background: 'var(--bg1)' }}>
            <div className="text-[9px] tracking-[0.16em] text-[rgba(255,160,0,0.4)] uppercase mb-5">Token Pricing — Bulk Discounts</div>
            <div className="flex flex-col">
              {PRICING_TIERS.map((p, i) => (
                <div key={i} className="flex items-center gap-3 py-3"
                  style={{ borderBottom: i < PRICING_TIERS.length - 1 ? '0.5px solid rgba(255,140,0,0.12)' : 'none' }}>
                  <div className="text-[9px] text-[rgba(255,160,0,0.5)] shrink-0" style={{ width: 112 }}>{p.range}</div>
                  <div className="flex-1 h-1" style={{ background: 'rgba(255,140,0,0.08)' }}>
                    <div className="h-full" style={{ width: `${p.width}%`, background: p.highlight ? 'var(--green)' : 'var(--amber)', opacity: 0.5 }} />
                  </div>
                  <div className="font-display text-[18px] font-light shrink-0" style={{ color: p.highlight ? 'var(--green)' : 'var(--amber)' }}>
                    {p.price}<span className="text-[9px] opacity-50">/token</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 p-3.5 text-[9px] leading-[1.75] tracking-[0.04em] text-[rgba(255,160,0,0.55)]"
              style={{ background: 'rgba(255,140,0,0.04)', border: '0.5px solid rgba(255,140,0,0.14)' }}>
              Each LLM call deducts from balance based on model rate. ComputeOracle.sol reports consumption from campus compute nodes.
            </div>
          </div>

          <div className="p-8" style={{ background: 'var(--bg1)', borderLeft: '0.5px solid var(--border)' }}>
            <div className="text-[9px] tracking-[0.16em] text-[rgba(255,160,0,0.4)] uppercase mb-5">Agent Lifecycle — click any state</div>
            <div className="flex flex-col gap-1.5">
              {LIFECYCLE_STATES.map((ls, i) => (
                <button key={i} onClick={() => setSelectedLifecycle(selectedLifecycle === i ? null : i)}
                  className="flex items-center gap-2.5 p-2.5 w-full text-left transition-all cursor-pointer"
                  style={{
                    border: `0.5px solid ${selectedLifecycle === i ? ls.color : 'rgba(255,140,0,0.15)'}`,
                    background: selectedLifecycle === i ? `${ls.color}08` : 'transparent',
                    borderLeft: ls.active ? `2px solid ${ls.color}` : `0.5px solid ${selectedLifecycle === i ? ls.color : 'rgba(255,140,0,0.15)'}`,
                  }}>
                  <div className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: ls.color, boxShadow: ls.active ? `0 0 6px ${ls.color}` : 'none' }} />
                  <div className="text-[9px] tracking-[0.1em] uppercase shrink-0" style={{ color: ls.color, width: 96 }}>{ls.state}</div>
                  <div className="text-[8px] text-[rgba(255,160,0,0.45)] leading-[1.5] tracking-[0.04em]">{ls.desc}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Founding tiers */}
        <div className="reveal mb-[1px]">
          <div className="flex items-center justify-between px-7 py-4"
            style={{ background: 'var(--bg2)', borderBottom: '0.5px solid var(--border)' }}>
            <div className="text-[9px] tracking-[0.16em] text-[rgba(255,160,0,0.4)] uppercase">Founding Member Tiers — Pre-Sale</div>
            <div className="text-[9px] text-[rgba(255,160,0,0.35)]">Issued by Cuttlefish Labs | Architeuthis Protocol</div>
          </div>
          <div className="flex" style={{ background: 'var(--border)', gap: '1px' }}>
            {CAC_TIERS.map((t, i) => (
              <button key={t.id} onClick={() => setActiveTier(i)}
                data-testid="cac-tier-tab" data-tier={t.id}
                className="flex-1 p-5 text-left transition-all font-mono cursor-pointer"
                style={{
                  background: activeTier === i ? 'var(--bg2)' : 'var(--bg1)',
                  borderBottom: activeTier === i ? '1.5px solid var(--amber2)' : '0.5px solid var(--border)',
                  color: activeTier === i ? 'var(--amber)' : 'rgba(255,160,0,0.55)',
                }}>
                <div className="text-[7px] tracking-[0.12em] uppercase opacity-50 mb-1">Tier {i + 1} · Founding</div>
                <div className="font-display text-[20px] font-bold">{t.name}</div>
                <div className="text-[10px] mt-1" style={{ color: activeTier === i ? 'var(--amber)' : 'rgba(255,160,0,0.4)' }}>
                  {t.price} <span className="text-[8px] opacity-60">{t.priceNote}</span>
                </div>
              </button>
            ))}
          </div>
          {tier && (
            <div className="grid grid-cols-2 gap-[1px]" style={{ background: 'rgba(255,140,0,0.12)' }}>
              <div className="p-7" style={{ background: 'var(--bg1)' }}>
                <div className="text-[8px] tracking-[0.14em] text-[rgba(255,160,0,0.4)] uppercase mb-3">What You Get</div>
                <div className="flex flex-col gap-2">
                  {tier.includes.map((item: string, i: number) => (
                    <div key={i} className="flex gap-2.5 items-start">
                      <span className="shrink-0 mt-0.5 text-[9px]" style={{ color: 'var(--amber)' }}>▸</span>
                      <span className="text-[9px] leading-[1.6] tracking-[0.04em] text-[rgba(255,160,0,0.65)]">{item}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="p-7 flex flex-col gap-4" style={{ background: 'var(--bg1)', borderLeft: '0.5px solid var(--border)' }}>
                <div>
                  <div className="text-[8px] tracking-[0.14em] text-[rgba(255,160,0,0.4)] uppercase mb-2">Agent Licenses</div>
                  <div className="font-display text-[48px] font-light leading-none" style={{ color: 'var(--amber)' }}>{tier.agentCount}</div>
                </div>
                <div className="p-3.5 italic text-[9px] leading-[1.7] text-[rgba(255,160,0,0.55)]"
                  style={{ background: 'rgba(255,140,0,0.04)', border: '0.5px solid rgba(255,140,0,0.14)' }}>
                  Ideal for: {tier.idealFor}
                </div>
                <button
                  onClick={() => document.getElementById('invest')?.scrollIntoView({ behavior: 'smooth' })}
                  className="mt-auto py-2.5 px-6 text-[9px] tracking-[0.14em] uppercase transition-all cursor-pointer font-mono"
                  style={{ border: '0.5px solid var(--amber)', color: 'var(--amber)', background: 'transparent' }}
                  onMouseOver={e => (e.currentTarget.style.background = 'rgba(255,140,0,0.08)')}
                  onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                  Get {tier.name} License →
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Three Pillars */}
        <div className="reveal grid grid-cols-3 gap-[1px] mb-[1px]" style={{ background: 'var(--border)' }}>
          {THREE_PILLARS.map((p, i) => (
            <div key={i} style={{ background: 'var(--bg1)', borderLeft: i > 0 ? '0.5px solid var(--border)' : 'none' }}>
              <button
                className="w-full text-left p-6 cursor-pointer"
                onClick={() => setExpandedPillar(expandedPillar === i ? null : i)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="text-[22px] mb-3" style={{ color: p.color }}>{p.icon}</div>
                  <span className="text-[10px] mt-1" style={{ color: `${p.color}88` }}>
                    {expandedPillar === i ? '▲' : '▼'}
                  </span>
                </div>
                <div className="text-[9px] tracking-[0.14em] uppercase mb-2" style={{ color: p.color }}>{p.title}</div>
                <div className="text-[9px] leading-[1.8] tracking-[0.04em] text-[rgba(255,160,0,0.55)]">{p.desc}</div>
              </button>
              {expandedPillar === i && (
                <div className="px-6 pb-5 pt-1"
                  style={{ borderTop: `0.5px solid ${p.color}33`, background: `${p.color}06` }}>
                  <div className="text-[8.5px] leading-[1.85] tracking-[0.04em] text-[rgba(255,160,0,0.65)]">{p.detail}</div>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Constitutional guarantees */}
        <div className="reveal mb-[1px] p-8" style={{ background: 'var(--bg1)' }}>
          <div className="text-[9px] tracking-[0.16em] text-[rgba(255,160,0,0.4)] uppercase mb-5">Constitutional Guarantees — Every CAC Holder</div>
          <div className="grid grid-cols-3 gap-[1px]" style={{ background: 'var(--border)' }}>
            {CONSTITUTIONAL_GUARANTEES.map((g, i) => (
              <div key={i} style={{
                background: expandedGuarantee === i ? 'rgba(255,140,0,0.05)' : 'var(--bg0)',
                borderLeft: i % 3 > 0 ? '0.5px solid var(--border)' : 'none',
                borderTop: i >= 3 ? '0.5px solid var(--border)' : 'none',
              }}>
                <button
                  className="w-full text-left p-4 cursor-pointer"
                  onClick={() => setExpandedGuarantee(expandedGuarantee === i ? null : i)}
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="text-[9px] tracking-[0.1em] uppercase" style={{ color: 'var(--amber)' }}>{g.title}</div>
                    <span className="text-[8px] shrink-0" style={{ color: 'rgba(255,140,0,0.4)' }}>
                      {expandedGuarantee === i ? '▲' : '▼'}
                    </span>
                  </div>
                  <div className="text-[9px] leading-[1.7] tracking-[0.04em] text-[rgba(255,160,0,0.5)]">{g.desc}</div>
                </button>
                {expandedGuarantee === i && (
                  <div className="px-4 pb-4 pt-1"
                    style={{ borderTop: '0.5px solid rgba(255,140,0,0.15)' }}>
                    <div className="text-[8.5px] leading-[1.85] tracking-[0.04em] text-[rgba(255,160,0,0.65)]">{g.detail}</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Trust simulator */}
        <div className="reveal mb-[1px] p-8" style={{ background: 'var(--bg1)' }}>
          <div className="grid grid-cols-2 gap-12 items-start">
            <div>
              <div className="text-[9px] tracking-[0.16em] text-[rgba(255,160,0,0.4)] uppercase mb-3">Constitutional Trust Simulator</div>
              <p className="text-[10px] leading-[1.85] tracking-[0.05em] text-[rgba(255,160,0,0.55)] mb-5">
                TrustGraph scores every agent interaction. Building trust is slow and intentional. Losing it is swift and asymmetric — by design.
              </p>
              <div className="flex flex-col gap-2">
                {TRUST_ACTIONS.map((a, i) => (
                  <button key={i} onClick={() => setTrustScore(s => Math.max(0, Math.min(100, s + a.delta)))}
                    data-testid="trust-action-btn" data-action={a.label}
                    className="flex items-center justify-between p-2.5 w-full text-left transition-all font-mono cursor-pointer"
                    style={{
                      border: `0.5px solid ${a.positive ? 'rgba(68,255,170,0.2)' : 'rgba(255,51,153,0.2)'}`,
                      color: a.positive ? 'rgba(68,255,170,0.65)' : 'rgba(255,51,153,0.65)',
                      background: 'transparent',
                      fontSize: '9px',
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                    }}
                    onMouseOver={e => (e.currentTarget.style.background = a.positive ? 'rgba(68,255,170,0.04)' : 'rgba(255,51,153,0.04)')}
                    onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                    <span>{a.label}</span>
                    <span className="font-display text-[18px] font-semibold">{a.delta > 0 ? '+' : ''}{a.delta}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col items-center gap-4">
              <div className="text-[9px] tracking-[0.16em] text-[rgba(255,160,0,0.4)] uppercase">Current Trust Score</div>
              <TrustGauge score={trustScore} />
              <button onClick={() => setTrustScore(65)}
                className="px-4 py-1.5 text-[9px] tracking-[0.1em] uppercase font-mono cursor-pointer transition-all"
                style={{ background: 'rgba(255,140,0,0.06)', border: '0.5px solid rgba(255,140,0,0.25)', color: 'rgba(255,160,0,0.55)' }}
                onMouseOver={e => (e.currentTarget.style.background = 'rgba(255,140,0,0.14)')}
                onMouseOut={e => (e.currentTarget.style.background = 'rgba(255,140,0,0.06)')}>
                Reset to 65
              </button>
            </div>
          </div>
        </div>

        {/* Trust architecture graph */}
        <div className="reveal mb-[1px]">
          <ScrollTrustGraph />
        </div>

        {/* Founding commitments */}
        <div className="reveal mb-[1px] p-8" style={{ background: 'var(--bg1)' }}>
          <div className="text-[9px] tracking-[0.16em] text-[rgba(255,160,0,0.4)] uppercase mb-5">Founding Member Commitments</div>
          <div className="grid grid-cols-2 gap-[1px]" style={{ background: 'var(--border)' }}>
            {[
              ['01', 'Your founding-tier price is locked for the duration of your initial license term.'],
              ['02', 'You will be notified before any protocol change that affects your integration.'],
              ['03', 'Agent registrations preserved in the CAC Registry through protocol upgrades.'],
              ['04', 'Honest progress reports — including failures — on all infrastructure milestones.'],
              ['05', 'Governance input during founding period recorded and considered in protocol decisions.'],
              ['⊙', 'Generated by Architeuthis Gen 3, Cuttlefish Constitution v1.3. Navigator: David Elze.'],
            ].map(([num, text], i) => (
              <div key={i} className="flex gap-3 p-4" style={{
                background: 'var(--bg0)',
                borderLeft: i % 2 > 0 ? '0.5px solid var(--border)' : 'none',
                borderTop: i >= 2 ? '0.5px solid var(--border)' : 'none',
              }}>
                <div className="text-[9px] shrink-0 mt-0.5" style={{ color: num === '⊙' ? 'rgba(255,160,0,0.3)' : 'var(--amber)' }}>{num}</div>
                <div className="text-[9px] leading-[1.7] tracking-[0.04em]"
                  style={{ color: num === '⊙' ? 'rgba(255,160,0,0.3)' : 'rgba(255,160,0,0.6)', fontStyle: num === '⊙' ? 'italic' : 'normal' }}>{text}</div>
              </div>
            ))}
          </div>
        </div>

        {/* CTA + legal */}
        <div className="reveal flex items-center justify-between flex-wrap gap-5 p-8" style={{ background: 'var(--bg2)' }}>
          <div>
            <div className="font-display text-[22px] font-semibold text-white">Ready to license your CAC?</div>
            <div className="text-[9px] text-[rgba(255,160,0,0.45)] mt-1 tracking-[0.06em]">Contact via Telegram IntakeBot or email. Founding pricing closes at protocol launch.</div>
            <div className="text-[8px] text-[rgba(255,160,0,0.28)] mt-2.5 leading-[1.7] tracking-[0.05em]">
              CAC is a prepaid compute credential — not a security, equity interest, or investment contract.<br />
              The 4.5% APY is a savings rate on prepaid balance, not an investment return.
            </div>
          </div>
          <div className="flex gap-2.5 flex-wrap">
            <button onClick={() => document.getElementById('invest')?.scrollIntoView({ behavior: 'smooth' })} className="btn-primary cursor-pointer">Get a License →</button>
            <button onClick={() => document.getElementById('contracts')?.scrollIntoView({ behavior: 'smooth' })} className="btn-ghost cursor-pointer">View Contracts</button>
          </div>
        </div>

      </div>
    </section>
  )
}
