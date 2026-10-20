# Dashboard Redesign Plan - Mobile First, Responsive

## Core Principles:
1. **Mobile First**: Start with single column layout, enhance for larger screens
2. **Clear Hierarchy**: Most important information at top
3. **Consistent Spacing**: Use rem units for scalable spacing
4. **Logical Grouping**: Related information together
5. **Performance**: Minimize DOM complexity

## Tile Order (by priority):
1. **Campus Comms** (tile-p1) - Fleet chat, most interactive
2. **Signal Visualizers** (tile-p2) - Trust trajectory + Galaxy side-by-side
3. **Campus Command** (tile-p3) - Consolidated command center
4. **Agent Security** (tile-p4) - TrustGraph, CAC, IAL, Certs
5. **Task Pipeline** (tile-p5) - Fleet task board
6. **DAO & Ecosystem** (tile-p6) - Health, Ecosystem, Tools
7. **Mining & Rewards** (tile-p7) - Pool stats, leaderboard, heartbeat
8. **Campaigns & Leads** (tile-p8) - PFP campaign, leads, 31 Harbor
9. **Incoming Mail** (tile-p9) - Resend inboxes (4 tiles)
10. **Campus Forum Full Board** (tile-p10) - Full bulletin board

## CSS Approach:
- Mobile: 1 column (100% width)
- Tablet (≥640px): 2 columns (50% each)
- Desktop (≥1024px): 3 columns (33% each) OR 2 columns with wide tiles
- Full-width tiles: Always span full container width regardless of breakpoint

## Tile Types:
- `.tile` - Standard tile (takes 1 column in multi-column layout)
- `.tile-wide` - Wide tile (spans 2 columns in 2+ column layouts, full width in mobile)
- `.tile-full` - Full width tile (always spans container width)

## Responsive Breakpoints:
```css
/* Mobile first - single column */
.grid { 
  display: grid; 
  grid-template-columns: 1fr; 
  gap: 1rem; 
  margin-bottom: 1rem; 
}

/* Tablet - 2 columns */
@media (min-width: 640px) {
  .grid { 
    grid-template-columns: repeat(2, 1fr); 
    gap: 1.5rem; 
  }
  .tile-wide { grid-column: span 2; } /* Full width in 2-col layout */
}

/* Desktop - 3 columns */
@media (min-width: 1024px) {
  .grid { 
    grid-template-columns: repeat(3, 1fr); 
    gap: 2rem; 
  }
  .tile-wide { grid-column: span 2; } /* Spans 2 of 3 columns */
  .tile-full { grid-column: 1 / -1; } /* Always full width */
}
```

## Special Containers:
- `.quarterdeck-mid` - Inside Campus Command for internal layout
- `.quarterdeck-bottom` - Inside Campus Command for internal layout  
- `.subgrid-2`, `.subgrid-3`, `.subgrid-4` - Internal grid layouts within tiles

## Tile Content Guidelines:
1. Keep headers consistent size
2. Use consistent spacing inside tiles (padding: 1rem)
3. Make charts/canvases responsive (width: 100%; height: auto or fixed ratio)
4. Use flexbox/grid internally for alignment
5. Avoid fixed heights where possible for content that varies

## Implementation Steps:
1. Replace existing CSS grid rules with mobile-first approach
2. Reorder tiles in HTML according to priority
3. Ensure all element IDs remain the same for dashboard.js compatibility
4. Test at mobile, tablet, desktop breakpoints
5. Verify all functionality works (charts update, data refreshes, etc.)

## Key Tiles to Verify:
- Campus Comms (fleet chat) - tile-p1
- Signal Visualizers (trust trajectory + galaxy) - tile-p2  
- Campus Command (consolidated view) - tile-p3
- Agent Security (inline grid) - tile-p4
- Task Pipeline - tile-p5
- DAO & Ecosystem - tile-p6