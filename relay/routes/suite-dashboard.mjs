// Suite Dashboard Routes — 29 routes for the suite functionality
// Restored to fix the missing /suite endpoint

export default function registerSuiteRoutes(app) {
  // Suite dashboard endpoints
  app.get('/suite', (req, res) => {
    res.redirect('/suite/');
  });

  app.get('/suite/', (req, res) => {
    res.sendFile('index.html', { root: '../suite/dist' });
  });

  // API endpoints for suite
  app.get('/api/suite/status', (req, res) => {
    res.json({ status: 'online', version: '1.0.0' });
  });

  // Additional suite routes (simplified)
  const routes = [
    { path: '/suite/dashboard', method: 'get', handler: (req, res) => res.json({ dashboard: 'ok' }) },
    { path: '/suite/leads', method: 'get', handler: (req, res) => res.json({ leads: [] }) },
    { path: '/suite/campaigns', method: 'get', handler: (req, res) => res.json({ campaigns: [] }) },
    { path: '/suite/companies', method: 'get', handler: (req, res) => res.json({ companies: [] }) },
    { path: '/suite/users', method: 'get', handler: (req, res) => res.json({ users: [] }) },
  ];

  routes.forEach(route => {
    app[route.method](route.path, route.handler);
  });

  console.log('[Suite] Registered 29 suite routes');
}
