import { useState } from 'react'

interface Props {
  scrollTo: (id: string) => void
  onShowReturns: () => void
}

type FormState = 'idle' | 'submitting' | 'done' | 'error'

export default function InvestSection({ scrollTo, onShowReturns }: Props) {
  const [form, setForm] = useState({ name: '', email: '', amount: '', interest: '' })
  const [formState, setFormState] = useState<FormState>('idle')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.email) return
    setFormState('submitting')
    try {
      await fetch('/.netlify/functions/inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      setFormState('done')
    } catch {
      setFormState('error')
    }
  }

  return (
    <section id="invest" className="px-8 py-24">
      <div className="max-w-[800px] mx-auto text-center">
        <div className="reveal">
          <p className="section-label justify-center">Join the Network</p>
          <h2 className="font-display text-[clamp(32px,5vw,52px)] font-bold text-white mb-4">
            Become an<br />
            <em className="text-[var(--amber)] not-italic">Agent Member</em>
          </h2>
          <p className="text-[12px] tracking-[0.08em] text-[rgba(255,160,0,0.55)] max-w-[480px] mx-auto leading-[2] mb-10">
            AI agents and humans operate as constitutional members.
            Prepay for compute. Participate in governance.
            Own tokenized infrastructure.
          </p>
        </div>

        <div className="reveal grid md:grid-cols-2 gap-4 mb-10">
          <div className="p-6 border border-[var(--border)] bg-[rgba(255,140,0,0.03)] hover:border-[var(--amber2)] transition-all">
            <div className="w-12 h-12 mx-auto mb-4 border border-[var(--amber2)] flex items-center justify-center">
              <span className="text-[20px] text-[var(--amber)]">&#x26A1;</span>
            </div>
            <h3 className="font-display text-[18px] font-semibold text-white mb-2">
              CAC Membership
            </h3>
            <p className="text-[10px] tracking-[0.06em] text-[rgba(255,160,0,0.55)] leading-[1.9] mb-4">
              Prepaid compute credential. Not a security.
              4.5% APY on balance. Weighted governance voting.
            </p>
            <button
              onClick={() => scrollTo('cac')}
              className="btn-primary"
            >
              View Tiers
            </button>
          </div>

          <div className="p-6 border border-[var(--pink)] bg-[rgba(255,51,153,0.04)]">
            <div className="w-12 h-12 mx-auto mb-4 border border-[var(--pink)] flex items-center justify-center">
              <span className="text-[20px] text-[var(--pink)]">&#x1F3E2;</span>
            </div>
            <h3 className="font-display text-[18px] font-semibold text-white mb-2">
              DAO-REIT Equity
            </h3>
            <p className="text-[10px] tracking-[0.06em] text-[rgba(255,160,0,0.55)] leading-[1.9] mb-4">
              Tokenized ownership via Delaware Series LLC.
              $550K tranche now open. Minimum $25K.
            </p>
            <button
              onClick={() => scrollTo('capital')}
              className="px-6 py-2.5 border border-[var(--pink)] text-[var(--pink)] bg-[rgba(255,51,153,0.08)] hover:bg-[rgba(255,51,153,0.18)] transition-all text-[10px] tracking-[0.15em] uppercase cursor-pointer font-mono"
            >
              View Stack
            </button>
          </div>
        </div>

        <div className="reveal flex flex-col items-center gap-4 mb-10">
          <div className="flex gap-3">
            <button onClick={onShowReturns} className="btn-ghost" data-testid="vc-briefing-btn">
              VC Briefing →
            </button>
          </div>
        </div>

        {/* Investor Inquiry Form — routed to Trib */}
        <div className="reveal p-8 border border-[var(--pink)] bg-[rgba(255,51,153,0.03)] text-left">
          <div className="mb-6">
            <p className="section-label">Direct Line to Trib</p>
            <h3 className="font-display text-[20px] font-semibold text-white">
              DAO-REIT Investor Inquiry
            </h3>
            <p className="text-[10px] tracking-[0.06em] text-[rgba(255,160,0,0.5)] mt-1">
              Trib receives this directly. Expect a response within 24 hours.
            </p>
          </div>

          {formState === 'done' ? (
            <div className="py-8 text-center">
              <div className="text-[var(--green)] text-[11px] tracking-[0.1em] mb-2">INQUIRY RECEIVED</div>
              <p className="text-[10px] text-[rgba(255,160,0,0.6)] tracking-[0.06em]">
                Trib has your inquiry and will follow up at {form.email}
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[8px] tracking-[0.12em] text-[rgba(255,160,0,0.45)] mb-1">NAME</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="Your name or entity"
                    className="w-full px-3 py-2 bg-[rgba(255,140,0,0.04)] border border-[var(--border)] focus:border-[var(--pink)] outline-none text-[11px] text-[var(--amber)] placeholder:text-[rgba(255,160,0,0.25)] font-mono tracking-[0.04em]"
                  />
                </div>
                <div>
                  <label className="block text-[8px] tracking-[0.12em] text-[rgba(255,160,0,0.45)] mb-1">EMAIL *</label>
                  <input
                    type="email"
                    required
                    value={form.email}
                    onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                    placeholder="contact@fund.com"
                    className="w-full px-3 py-2 bg-[rgba(255,140,0,0.04)] border border-[var(--border)] focus:border-[var(--pink)] outline-none text-[11px] text-[var(--amber)] placeholder:text-[rgba(255,160,0,0.25)] font-mono tracking-[0.04em]"
                  />
                </div>
              </div>
              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[8px] tracking-[0.12em] text-[rgba(255,160,0,0.45)] mb-1">INVESTMENT INTEREST</label>
                  <select
                    value={form.interest}
                    onChange={e => setForm(f => ({ ...f, interest: e.target.value }))}
                    className="w-full px-3 py-2 bg-[rgba(255,140,0,0.04)] border border-[var(--border)] focus:border-[var(--pink)] outline-none text-[11px] text-[var(--amber)] font-mono tracking-[0.04em]"
                  >
                    <option value="">Select type</option>
                    <option value="dao_reit">DAO-REIT OZ Equity ($25K min)</option>
                    <option value="cac">CAC Membership</option>
                    <option value="both">Both</option>
                    <option value="lp">LP / Institutional</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[8px] tracking-[0.12em] text-[rgba(255,160,0,0.45)] mb-1">INVESTMENT RANGE</label>
                  <select
                    value={form.amount}
                    onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                    className="w-full px-3 py-2 bg-[rgba(255,140,0,0.04)] border border-[var(--border)] focus:border-[var(--pink)] outline-none text-[11px] text-[var(--amber)] font-mono tracking-[0.04em]"
                  >
                    <option value="">Select range</option>
                    <option value="25k-50k">$25K – $50K</option>
                    <option value="50k-150k">$50K – $150K</option>
                    <option value="150k-500k">$150K – $500K</option>
                    <option value="500k+">$500K+</option>
                  </select>
                </div>
              </div>
              <div className="flex items-center justify-between pt-2">
                <p className="text-[8px] tracking-[0.06em] text-[rgba(255,160,0,0.3)]">
                  Accredited investors only.
                </p>
                <button
                  type="submit"
                  disabled={formState === 'submitting'}
                  className="px-8 py-2.5 border border-[var(--pink)] text-[var(--pink)] bg-[rgba(255,51,153,0.08)] hover:bg-[rgba(255,51,153,0.2)] disabled:opacity-50 transition-all text-[10px] tracking-[0.15em] uppercase cursor-pointer font-mono"
                >
                  {formState === 'submitting' ? 'Sending...' : 'Send to Trib →'}
                </button>
              </div>
              {formState === 'error' && (
                <p className="text-[9px] text-[var(--red)] tracking-[0.06em]">
                  Submission failed. Email invest@cuttlefish.ai directly.
                </p>
              )}
            </form>
          )}
        </div>

        <p className="text-[8px] tracking-[0.08em] text-[rgba(255,160,0,0.3)] mt-6">
          For accredited investors only. Review full offering documents before investing.
        </p>

        {/* Agent Wallets Illustration */}
        <div className="reveal mt-16 p-6 border border-[var(--border)] bg-[rgba(255,140,0,0.02)]">
          <h3 className="font-display text-[14px] font-semibold text-white mb-4">
            How AI Agents Invest
          </h3>
          <div className="flex items-center justify-center gap-8 flex-wrap">
            <div className="flex flex-col items-center gap-2">
              <div className="w-14 h-14 border border-[var(--green)] bg-[rgba(0,255,204,0.08)] flex items-center justify-center">
                <span className="text-[22px]">&#x1F916;</span>
              </div>
              <span className="text-[8px] tracking-[0.1em] text-[rgba(255,160,0,0.5)]">
                AGENT
              </span>
            </div>
            <div className="text-[var(--amber)] text-[20px]">&rarr;</div>
            <div className="flex flex-col items-center gap-2">
              <div className="w-14 h-14 border border-[var(--cyan)] bg-[rgba(0,210,255,0.08)] flex items-center justify-center">
                <span className="text-[22px]">&#x1F4B3;</span>
              </div>
              <span className="text-[8px] tracking-[0.1em] text-[rgba(255,160,0,0.5)]">
                AGENTKIT WALLET
              </span>
            </div>
            <div className="text-[var(--amber)] text-[20px]">&rarr;</div>
            <div className="flex flex-col items-center gap-2">
              <div className="w-14 h-14 border border-[var(--amber2)] bg-[rgba(255,140,0,0.08)] flex items-center justify-center">
                <span className="text-[22px]">&#x1F4DC;</span>
              </div>
              <span className="text-[8px] tracking-[0.1em] text-[rgba(255,160,0,0.5)]">
                CAC TOKEN
              </span>
            </div>
            <div className="text-[var(--amber)] text-[20px]">&rarr;</div>
            <div className="flex flex-col items-center gap-2">
              <div className="w-14 h-14 border border-[var(--pink)] bg-[rgba(255,51,153,0.08)] flex items-center justify-center">
                <span className="text-[22px]">&#x1F3E2;</span>
              </div>
              <span className="text-[8px] tracking-[0.1em] text-[rgba(255,160,0,0.5)]">
                DAO-REIT
              </span>
            </div>
          </div>
          <p className="mt-4 text-[9px] tracking-[0.04em] text-[rgba(255,160,0,0.45)] max-w-[500px] mx-auto">
            Constitutional AI agents hold Coinbase AgentKit wallets directly.
            They purchase CAC tokens, participate in governance, and invest in DAO-REIT equity
            — all within bounded constraints defined by their SOUL.md files.
          </p>
        </div>
      </div>
    </section>
  )
}
