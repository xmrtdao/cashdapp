// CashDapp — XMRT DAO Interactive Scripts

document.addEventListener('DOMContentLoaded', () => {
  // Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      e.preventDefault();
      const target = document.querySelector(this.getAttribute('href'));
      if (target) {
        target.scrollIntoView({
          behavior: 'smooth',
          block: 'start'
        });
      }
    });
  });

  // Intersection Observer for fade-in animations
  const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('fade-in');
        observer.unobserve(entry.target);
      }
    });
  }, observerOptions);

  // Observe all feature cards and timeline items
  document.querySelectorAll('.feature-card, .timeline-item, .token-card, .link-card').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    observer.observe(el);
  });

  // Add fade-in class styles dynamically
  const style = document.createElement('style');
  style.textContent = `
    .fade-in {
      opacity: 1 !important;
      transform: translateY(0) !important;
    }
  `;
  document.head.appendChild(style);

  // Dynamic stats counter animation
  const animateValue = (element, start, end, duration) => {
    let startTimestamp = null;
    const step = (timestamp) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / duration, 1);
      const value = Math.floor(progress * (end - start) + start);
      element.textContent = value.toLocaleString();
      if (progress < 1) {
        window.requestAnimationFrame(step);
      }
    };
    window.requestAnimationFrame(step);
  };

  // Animate stats when they come into view
  const statsObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const statValues = entry.target.querySelectorAll('.stat-value');
        statValues.forEach(stat => {
          const text = stat.textContent;
          if (text.includes('21M')) {
            animateValue(stat, 0, 21, 2000);
            stat.textContent = '21M';
          } else if (text.includes('100%')) {
            stat.textContent = '100%';
          } else if (text.includes('0.3%')) {
            stat.textContent = '0.3%';
          }
        });
        statsObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });

  const heroStats = document.querySelector('.hero-stats');
  if (heroStats) {
    statsObserver.observe(heroStats);
  }

  // Bonding curve visualization (simple canvas)
  const canvas = document.getElementById('curve-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // Curve parameters (from Flipcash)
    const CURVE_A = 11400.230149967394;
    const CURVE_B = 0.000000877175273521;
    const CURVE_C = CURVE_B;
    const MAX_SUPPLY = 21000000;

    // Draw axes
    ctx.strokeStyle = '#1a1a2e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(50, 20);
    ctx.lineTo(50, height - 40);
    ctx.lineTo(width - 20, height - 40);
    ctx.stroke();

    // Draw curve
    ctx.strokeStyle = '#ff6b35';
    ctx.lineWidth = 3;
    ctx.beginPath();

    for (let x = 0; x < width - 70; x++) {
      const supply = (x / (width - 70)) * MAX_SUPPLY;
      const price = CURVE_A * CURVE_B * Math.exp(CURVE_C * supply);
      const normalizedPrice = Math.min(price / 1000000, 1); // Normalize to 0-1
      const y = (height - 40) - (normalizedPrice * (height - 60));

      if (x === 0) {
        ctx.moveTo(50 + x, y);
      } else {
        ctx.lineTo(50 + x, y);
      }
    }

    ctx.stroke();

    // Labels
    ctx.fillStyle = '#a0a0b0';
    ctx.font = '12px Rajdhani';
    ctx.fillText('Supply →', width / 2, height - 10);
    ctx.save();
    ctx.translate(15, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Price →', 0, 0);
    ctx.restore();
  }

  // Copy to clipboard for code blocks
  document.querySelectorAll('pre').forEach(pre => {
    const button = document.createElement('button');
    button.className = 'copy-btn';
    button.textContent = 'Copy';
    button.style.cssText = `
      position: absolute;
      top: 0.5rem;
      right: 0.5rem;
      padding: 0.25rem 0.5rem;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.75rem;
      opacity: 0;
      transition: opacity 0.3s;
    `;

    pre.style.position = 'relative';
    pre.appendChild(button);

    pre.addEventListener('mouseenter', () => {
      button.style.opacity = '1';
    });

    pre.addEventListener('mouseleave', () => {
      button.style.opacity = '0';
    });

    button.addEventListener('click', () => {
      const code = pre.querySelector('code');
      if (code) {
        navigator.clipboard.writeText(code.textContent);
        button.textContent = 'Copied!';
        setTimeout(() => {
          button.textContent = 'Copy';
        }, 2000);
      }
    });
  });

  // Console easter egg
  console.log(`
%c CashDapp — XMRT DAO %c
Built with ❤️ by the XMRT DAO Fleet

🔒 Privacy-First
📱 Mobile-First  
💰 Reserve-Backed
🌐 Mesh Network
🤖 AI Agent Fleet

GitHub: https://github.com/xmrtdao/cashdapp
`, 'background: #ff6b35; color: white; font-size: 20px; padding: 10px;', 'background: transparent; color: #ff6b35; font-size: 12px;');
});

// Service Worker registration for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(registration => {
      console.log('SW registered:', registration.scope);
    }).catch(error => {
      console.log('SW registration failed:', error);
    });
  });
}
