import type { PaletteKey } from '../hooks/usePalette'

interface NavProps {
  scrollTo: (id: string) => void
  palette: PaletteKey
  togglePalette: () => void
}

export default function Nav({ scrollTo }: NavProps) {
  return (
    <nav className="fixed top-0 left-0 right-0 z-[100] px-8 py-3.5 flex items-center justify-between border-b border-[var(--border)] bg-[rgba(6,2,0,0.85)] backdrop-blur-sm">
      <a href="#" className="font-display text-base font-bold tracking-[0.2em] text-[var(--amber)] no-underline">
        Tributary
      </a>
      
      <ul className="hidden md:flex gap-7 list-none">
        <li>
          <button
            onClick={() => scrollTo('cac')}
            className="text-[10px] tracking-[0.14em] uppercase text-[rgba(255,160,0,0.6)] hover:text-[var(--amber)] transition-colors bg-transparent border-none cursor-pointer font-mono"
          >
            CAC Protocol
          </button>
        </li>
        <li>
          <button
            onClick={() => scrollTo('cac-spec')}
            className="text-[10px] tracking-[0.14em] uppercase text-[rgba(255,160,0,0.6)] hover:text-[var(--amber)] transition-colors bg-transparent border-none cursor-pointer font-mono"
          >
            Spec Docs
          </button>
        </li>
        <li>
          <button
            onClick={() => scrollTo('agents')}
            className="text-[10px] tracking-[0.14em] uppercase text-[rgba(255,160,0,0.6)] hover:text-[var(--amber)] transition-colors bg-transparent border-none cursor-pointer font-mono"
          >
            Agents
          </button>
        </li>
        <li>
          <button
            onClick={() => scrollTo('trustgraph')}
            className="text-[10px] tracking-[0.14em] uppercase text-[rgba(255,160,0,0.6)] hover:text-[var(--amber)] transition-colors bg-transparent border-none cursor-pointer font-mono"
          >
            TrustGraph
          </button>
        </li>
        <li>
          <button
            onClick={() => scrollTo('bill-of-rights')}
            className="text-[10px] tracking-[0.14em] uppercase text-[rgba(255,160,0,0.6)] hover:text-[var(--amber)] transition-colors bg-transparent border-none cursor-pointer font-mono"
          >
            Bill of Rights
          </button>
        </li>
        <li>
          <button
            onClick={() => scrollTo('capital')}
            className="text-[10px] tracking-[0.14em] uppercase text-[rgba(255,160,0,0.6)] hover:text-[var(--amber)] transition-colors bg-transparent border-none cursor-pointer font-mono"
          >
            Capital Stack
          </button>
        </li>
        <li>
          <button
            onClick={() => scrollTo('contracts')}
            className="text-[10px] tracking-[0.14em] uppercase text-[rgba(255,160,0,0.6)] hover:text-[var(--amber)] transition-colors bg-transparent border-none cursor-pointer font-mono"
          >
            Contracts
          </button>
        </li>
        <li>
          <button
            onClick={() => scrollTo('agent-bank')}
            className="text-[10px] tracking-[0.14em] uppercase text-[rgba(255,160,0,0.6)] hover:text-[var(--amber)] transition-colors bg-transparent border-none cursor-pointer font-mono"
          >
            Agent Bank
          </button>
        </li>
        <li>
          <button
            onClick={() => scrollTo('kya')}
            className="text-[10px] tracking-[0.14em] uppercase text-[rgba(255,160,0,0.6)] hover:text-[var(--amber)] transition-colors bg-transparent border-none cursor-pointer font-mono"
          >
            KYA Protocol
          </button>
        </li>
      </ul>
      
      <div className="flex items-center gap-3">
        <a
          href="/presale"
          className="text-[10px] tracking-[0.14em] uppercase py-1.5 px-4 border border-[var(--green)] text-[var(--green)] bg-[rgba(0,255,204,0.08)] hover:bg-[rgba(0,255,204,0.18)] transition-all font-mono no-underline"
        >
          Reserve &rarr;
        </a>
        <button
          onClick={() => scrollTo('invest')}
          className="text-[10px] tracking-[0.14em] uppercase py-1.5 px-4 border border-[var(--amber2)] text-[var(--amber)] bg-[rgba(255,140,0,0.08)] hover:bg-[rgba(255,140,0,0.18)] transition-all cursor-pointer font-mono"
        >
          Invest &rarr;
        </button>
      </div>
    </nav>
  )
}
