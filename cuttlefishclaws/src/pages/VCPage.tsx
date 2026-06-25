import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePalette } from '../hooks/usePalette'
import { useScrollReveal } from '../hooks/useScrollReveal'
import Footer from '../components/Footer'

interface Deal {
  id: string
  company: string
  vertical: string
  stage: string
  targetRaise: number
  projectedIRR: number
  mrr: number
  growthRate: number
  runway: number
  riskScore: string
}

const MOCK_DEALS: Deal[] = [
  {
    id: 'deal-1',
    company: 'NeuralForge AI',
    vertical: 'Enterprise SaaS',
    stage: 'Series A',
    targetRaise: 5_000_000,
    projectedIRR: 22,
    mrr: 180_000,
    growthRate: 15,
    runway: 18,
    riskScore: 'low',
  },
  {
    id: 'deal-2',
    company: 'ClimateStack',
    vertical: 'CleanTech',
    stage: 'Seed',
    targetRaise: 2_500_000,
    projectedIRR: 28,
    mrr: 85_000,
    growthRate: 22,
    runway: 14,
    riskScore: 'medium',
  },
  {
    id: 'deal-3',
    company: 'DataMesh',
    vertical: 'Infrastructure',
    stage: 'Series A',
    targetRaise: 8_000_000,
    projectedIRR: 18,
    mrr: 320_000,
    growthRate: 12,
    runway: 24,
    riskScore: 'low',
  },
]

export default function VCPage() {
  const navigate = useNavigate()
  const { palette, togglePalette } = usePalette()
  const [selectedDeal, setSelectedDeal] = useState<string | null>(null)
  
  useScrollReveal()
  
  const metrics = [
    { label: 'Total AUM', value: '$247M', subtext: '+34% YoY' },
    { label: 'Active Deals', value: '23', subtext: 'Across 8 verticals' },
    { label: 'Avg. IRR', value: '18.4%', subtext: 'Net of fees' },
    { label: 'LP Count', value: '142', subtext: 'Institutional + Family Offices' },
  ]

  const scrollTo = (id: string) => {
    if (id === 'invest' || id === 'capital') {
      navigate('/')
      setTimeout(() => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
    }
  }

  return (
    <div className="min-h-screen">
      <div className="scanline" />
      
      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-[100] px-8 py-3.5 flex items-center justify-between border-b border-[var(--border)] bg-[rgba(6,2,0,0.85)] backdrop-blur-sm">
        <a href="/" className="font-display text-base font-bold tracking-[0.2em] text-[var(--amber)] no-underline">
          Tributary
        </a>
        
        <div className="flex items-center gap-4">
          <span className="text-[10px] tracking-[0.12em] text-[var(--green)] uppercase">
            VC Access
          </span>
          <button
            onClick={() => navigate('/')}
            className="text-[10px] tracking-[0.14em] uppercase py-1.5 px-4 border border-[var(--amber2)] text-[var(--amber)] bg-[rgba(255,140,0,0.08)] hover:bg-[rgba(255,140,0,0.18)] transition-all cursor-pointer font-mono"
          >
            Main Site
          </button>
        </div>
      </nav>
      
      {/* Hero Section */}
      <section className="pt-32 pb-20 px-8">
        <div className="reveal max-w-[1200px] mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 border border-[var(--green)] bg-[rgba(0,255,204,0.08)] mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--green)] animate-pulse" />
            <span className="text-[9px] tracking-[0.14em] uppercase text-[var(--green)]">Institutional Access</span>
          </div>
          
          <h1 className="font-display text-[clamp(36px,6vw,72px)] font-bold leading-[0.95] tracking-tight text-white mb-4">
            Partner with<br />
            <em className="text-[var(--amber)] not-italic">Tributary</em>
          </h1>
          
          <p className="text-[11px] tracking-[0.08em] text-[rgba(255,160,0,0.55)] max-w-[520px] leading-[2] mt-4 mb-10">
            Access curated revenue-based financing opportunities with transparent 
            underwriting, real-time monitoring, and institutional-grade reporting.
          </p>
          
          <div className="flex flex-wrap gap-4">
            <button className="btn-primary">
              Request Data Room Access
            </button>
            <button className="btn-ghost">
              Schedule a Call
            </button>
          </div>
        </div>
      </section>

      {/* Metrics Grid */}
      <section className="py-16 px-8 border-t border-[var(--border)]">
        <div className="max-w-[1200px] mx-auto">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {metrics.map((metric) => (
              <div key={metric.label} className="reveal p-5 border border-[var(--border)] bg-[rgba(255,140,0,0.03)]">
                <p className="text-[9px] tracking-[0.12em] uppercase text-[rgba(255,160,0,0.4)] mb-2">{metric.label}</p>
                <p className="font-display text-[28px] font-semibold text-white">{metric.value}</p>
                {metric.subtext && <p className="text-[10px] tracking-[0.08em] text-[var(--green)] mt-1">{metric.subtext}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Investment Thesis */}
      <section className="py-16 px-8 border-t border-[var(--border)]">
        <div className="max-w-[1200px] mx-auto">
          <p className="section-label">Investment Thesis</p>
          <h2 className="section-title mb-10">
            Why <em>Tributary</em>
          </h2>
          
          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                title: 'Revenue-Based Returns',
                description: 'Non-dilutive capital deployment with returns tied directly to business performance. Target 15-25% IRR with monthly distributions.',
              },
              {
                title: 'AI-Enhanced Diligence',
                description: 'Proprietary agent network analyzes deal flow, conducts due diligence, and monitors portfolio performance in real-time.',
              },
              {
                title: 'Structured Protection',
                description: 'Senior position in capital stack with covenant-protected structures. Multiple exit pathways including buyback provisions.',
              },
            ].map((item) => (
              <div key={item.title} className="reveal p-6 border border-[var(--border)] bg-[rgba(255,140,0,0.03)]">
                <h3 className="font-display text-[18px] font-semibold text-white mb-3">{item.title}</h3>
                <p className="text-[10px] tracking-[0.06em] text-[rgba(255,160,0,0.55)] leading-[1.9]">{item.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Deal Pipeline */}
      <section className="py-16 px-8 border-t border-[var(--border)]">
        <div className="max-w-[1200px] mx-auto">
          <div className="flex items-center justify-between mb-10">
            <div>
              <p className="section-label">Deal Flow</p>
              <h2 className="section-title">Active <em>Pipeline</em></h2>
            </div>
            <button className="btn-ghost">View All Deals</button>
          </div>
          
          <div className="space-y-3">
            {MOCK_DEALS.map((deal) => (
              <div
                key={deal.id}
                className={`reveal p-5 border cursor-pointer transition-all duration-300 ${
                  selectedDeal === deal.id 
                    ? 'border-[var(--amber2)] bg-[rgba(255,140,0,0.08)]' 
                    : 'border-[var(--border)] bg-[rgba(255,140,0,0.03)] hover:border-[var(--amber2)]'
                }`}
                onClick={() => setSelectedDeal(selectedDeal === deal.id ? null : deal.id)}
              >
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div className="flex items-center gap-4">
                    <div 
                      className="w-10 h-10 flex items-center justify-center font-display text-[16px] font-semibold border border-[var(--amber2)] text-[var(--amber)]"
                    >
                      {deal.company[0]}
                    </div>
                    <div>
                      <h3 className="font-display text-[16px] font-semibold text-white">{deal.company}</h3>
                      <p className="text-[9px] tracking-[0.1em] text-[rgba(255,160,0,0.4)] uppercase">{deal.vertical} &middot; {deal.stage}</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-8">
                    <div className="text-right">
                      <p className="text-[8px] tracking-[0.1em] text-[rgba(255,160,0,0.4)] uppercase">Target Raise</p>
                      <p className="font-display text-[16px] font-semibold text-white">${(deal.targetRaise / 1_000_000).toFixed(1)}M</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[8px] tracking-[0.1em] text-[rgba(255,160,0,0.4)] uppercase">Projected IRR</p>
                      <p className="font-display text-[16px] font-semibold text-[var(--green)]">{deal.projectedIRR}%</p>
                    </div>
                    <div className="text-right hidden md:block">
                      <p className="text-[8px] tracking-[0.1em] text-[rgba(255,160,0,0.4)] uppercase">Revenue</p>
                      <p className="font-display text-[16px] font-semibold text-white">${(deal.mrr * 12 / 1_000_000).toFixed(1)}M ARR</p>
                    </div>
                    <svg 
                      className={`w-4 h-4 text-[rgba(255,160,0,0.4)] transition-transform ${selectedDeal === deal.id ? 'rotate-180' : ''}`} 
                      fill="none" viewBox="0 0 24 24" stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
                
                {selectedDeal === deal.id && (
                  <div className="mt-5 pt-5 border-t border-[var(--border)] grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                      <p className="text-[8px] tracking-[0.1em] text-[rgba(255,160,0,0.4)] uppercase mb-1">MRR</p>
                      <p className="font-display text-[14px] font-semibold text-white">${deal.mrr.toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-[8px] tracking-[0.1em] text-[rgba(255,160,0,0.4)] uppercase mb-1">Growth Rate</p>
                      <p className="font-display text-[14px] font-semibold text-white">{deal.growthRate}% MoM</p>
                    </div>
                    <div>
                      <p className="text-[8px] tracking-[0.1em] text-[rgba(255,160,0,0.4)] uppercase mb-1">Runway</p>
                      <p className="font-display text-[14px] font-semibold text-white">{deal.runway} months</p>
                    </div>
                    <div>
                      <p className="text-[8px] tracking-[0.1em] text-[rgba(255,160,0,0.4)] uppercase mb-1">Risk Score</p>
                      <p className="font-display text-[14px] font-semibold text-[var(--green)] capitalize">{deal.riskScore}</p>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 px-8 border-t border-[var(--border)]">
        <div className="max-w-[600px] mx-auto text-center">
          <h2 className="section-title mb-4">
            Ready to <em>explore</em><br />partnership?
          </h2>
          <p className="text-[11px] tracking-[0.08em] text-[rgba(255,160,0,0.55)] max-w-[400px] mx-auto leading-[2] mb-8">
            Get access to our data room, detailed portfolio analytics, and 
            connect with our investment team.
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <button className="btn-primary">
              Request Access
            </button>
            <button className="btn-ghost">
              Download Tear Sheet
            </button>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  )
}
