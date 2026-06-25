import { CONTRACTS } from '../../lib/mockData'

export default function ContractsSection() {
  return (
    <section id="contracts" className="px-8 py-20">
      <div className="max-w-[1200px] mx-auto">
        <div className="reveal">
          <p className="section-label">On-Chain Infrastructure</p>
          <h2 className="section-title">
            Smart<br />
            <em>Contracts</em>
          </h2>
          <p className="text-[11px] tracking-[0.08em] text-[rgba(255,160,0,0.55)] max-w-[560px] leading-[2] mt-4 mb-10">
            Constitutional governance enforced on-chain.
            All contracts are open source and auditable.
            Deployed on Base with Coinbase AgentKit integration.
          </p>
        </div>

        <div className="reveal overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="text-left py-3 px-4 text-[8px] tracking-[0.14em] text-[rgba(255,160,0,0.4)] uppercase font-normal">
                  Status
                </th>
                <th className="text-left py-3 px-4 text-[8px] tracking-[0.14em] text-[rgba(255,160,0,0.4)] uppercase font-normal">
                  Contract
                </th>
                <th className="text-left py-3 px-4 text-[8px] tracking-[0.14em] text-[rgba(255,160,0,0.4)] uppercase font-normal hidden md:table-cell">
                  Address
                </th>
                <th className="text-left py-3 px-4 text-[8px] tracking-[0.14em] text-[rgba(255,160,0,0.4)] uppercase font-normal">
                  Description
                </th>
              </tr>
            </thead>
            <tbody>
              {CONTRACTS.map((contract, i) => (
                <tr 
                  key={i}
                  className="border-b border-[var(--border)] hover:bg-[rgba(255,140,0,0.03)] transition-colors"
                >
                  <td className="py-3 px-4">
                    <span className={`px-2 py-0.5 text-[7px] tracking-[0.1em] uppercase border ${
                      contract.status === 'deployed'
                        ? 'border-[var(--green)] text-[var(--green)] bg-[rgba(0,255,204,0.08)]'
                        : 'border-[var(--amber2)] text-[var(--amber)] bg-[rgba(255,140,0,0.08)]'
                    }`}>
                      {contract.status}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <span className="font-mono text-[11px] text-[var(--cyan)]">
                      {contract.name}
                    </span>
                  </td>
                  <td className="py-3 px-4 hidden md:table-cell">
                    <span className="font-mono text-[9px] text-[rgba(255,160,0,0.4)]">
                      {contract.address.slice(0, 10)}...{contract.address.slice(-6)}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <span className="text-[10px] tracking-[0.04em] text-[rgba(255,160,0,0.6)]">
                      {contract.description}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="reveal mt-10 grid md:grid-cols-3 gap-4">
          <div className="p-4 border border-[var(--border)] bg-[rgba(255,140,0,0.02)]">
            <div className="text-[8px] tracking-[0.12em] text-[rgba(255,160,0,0.4)] uppercase mb-2">
              Network
            </div>
            <div className="font-display text-[16px] font-semibold text-white mb-1">
              Base (Coinbase L2)
            </div>
            <div className="text-[9px] tracking-[0.04em] text-[rgba(255,160,0,0.5)]">
              Low fees, Coinbase AgentKit native
            </div>
          </div>

          <div className="p-4 border border-[var(--border)] bg-[rgba(255,140,0,0.02)]">
            <div className="text-[8px] tracking-[0.12em] text-[rgba(255,160,0,0.4)] uppercase mb-2">
              Audit Status
            </div>
            <div className="font-display text-[16px] font-semibold text-[var(--amber)] mb-1">
              In Progress
            </div>
            <div className="text-[9px] tracking-[0.04em] text-[rgba(255,160,0,0.5)]">
              Trail of Bits Q2 2026
            </div>
          </div>

          <div className="p-4 border border-[var(--border)] bg-[rgba(255,140,0,0.02)]">
            <div className="text-[8px] tracking-[0.12em] text-[rgba(255,160,0,0.4)] uppercase mb-2">
              Agent Integration
            </div>
            <div className="font-display text-[16px] font-semibold text-[var(--green)] mb-1">
              AgentKit Ready
            </div>
            <div className="text-[9px] tracking-[0.04em] text-[rgba(255,160,0,0.5)]">
              AI agents hold wallets directly
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
