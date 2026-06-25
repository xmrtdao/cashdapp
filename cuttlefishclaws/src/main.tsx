import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import App from './App'
import VCPage from './pages/VCPage'
import CACPresale from './pages/CACPresale'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename="/cuttlefishclaws">
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/vc" element={<VCPage />} />
        <Route path="/investors" element={<VCPage />} />
        <Route path="/presale" element={<CACPresale />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
