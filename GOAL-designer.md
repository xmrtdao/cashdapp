# /goal — PFP Designer

A production-quality, MuAPI-powered **Designer** that booked Party Favor Photo
clients use on their own event, with permissioned access by UUID.

## Done
- [x] Template engine proven. MuAPI paints ornament only; a local headless-
      Chromium compositor owns geometry, the client's original logo file, and
      typography. Measured basis: both nano-banana-2-1 ($0.04) and
      nano-banana-pro ($0.12), given "exactly three windows, strict 3:2", both
      returned four near-square windows; and a genuinely uploaded logo still
      got redrawn. 13 rules baked into `relay/tools/pfp-template-designer.mjs`.
- [x] Print file verified: 1200x1800 @300dpi, 6 windows at 510x340 (1.50:1),
      alpha measured 0 in all six, both strips identical, full bleed.
- [x] Contrast derived from the artwork, not assumed. A cream wedding ground
      originally got white-on-cream type plus a dark green band — caught by
      walking the flow, not by the unit test.
- [x] API + branded studio built and mounted at /api/visual/pfp and /prints.
- [x] Host routing + Cloudflare ingress for prints.partyfavorphoto.com.
- [x] DNS created (proxied CNAME to the tunnel), apex verified untouched.

## Blocked
- [ ] **prints.partyfavorphoto.com returns 1033.** cloudflared starts but holds
      zero established connections; the supervisor calls it HEALTHY because its
      only check is process existence. QUIC/UDP 7844 is the suspected cause.

## To do
- [ ] Name the service `designer`.
- [ ] Payment-triggered Resend email to the client carrying their UUID link.
- [ ] UUID as the access credential: the link IS the permission.
- [ ] End-to-end verification from a clean browser, as a client.