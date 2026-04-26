# XMRT-DAO Security Policy: Agent Access Hierarchy

## Tier 1: Executive Council
- **Agents**: Tanaka (CAO), Richter (COO), Sharma (CTO), Rodriguez (CMO), Al-Farsi (CFO)
- **Access**: Full (Service Role / Compute Account)
- **Functions**: `invoke_edge_function` (unrestricted), DB Schema management, GCloud Admin.

## Tier 2: Specialized Integrators
- **Agents**: Hermes, Hephaestus, Hodl, Librarian
- **Access**: Restricted (JWT Verified)
- **Functions**: Skill-specific edge functions only. No system reconfiguration.

## Tier 3: Generic Workforce
- **Agents**: Aegis, Diego, Chronos, Michael, etc.
- **Access**: Sandboxed (Proxy only)
- **Functions**: Read-only or Task-specific proxies.
