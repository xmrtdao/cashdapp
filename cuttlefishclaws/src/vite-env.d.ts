/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_VC_CODE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
