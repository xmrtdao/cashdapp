export interface AgentProfile {
  id: string
  name: string
  role: string
  type: 'governance' | 'investor' | 'system'
  status: 'online' | 'standby' | 'system'
  version: string
  trustScore?: number
  color: string
  description: string
  greeting: string
  responses: string[]
  files: AgentFile[]
}

export interface AgentFile {
  name: string
  type: 'md' | 'py' | 'json' | 'ts' | 'sol'
  size: string
  status: 'active' | 'live'
}

export interface Pool {
  id: string
  label: string
  tvl: number
  apr: number
  nodeId: string
  status: 'active' | 'pending'
}

export interface CACTier {
  id: string
  name: string
  price: string
  priceNote: string
  badge?: string
  featured?: boolean
  includes: string[]
  agentCount: string
  idealFor: string
}

export interface Contract {
  status: 'built' | 'deployed'
  name: string
  address: string
  description: string
}

export interface StackLayer {
  name: string
  amount: string
  color: string
  bgColor: string
  borderColor: string
  percent: string
  description: string
  details: string
}

export interface Scenario {
  tier: string
  name: string
  subtitle: string
  multiple: string
  multipleColor: string
  featured?: boolean
  metrics: { label: string; value: string }[]
}
