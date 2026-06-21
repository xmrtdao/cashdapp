#!/usr/bin/env node
/**
 * PFP Email Template — Professional HTML campaign email
 * Used by daily-campaign.mjs for client outreach
 * Images: https://raw.githubusercontent.com/xmrtdao/muapi-workflows/main/assets/pfp/
 * Stripe: buy.stripe.com links for booking
 */

const IMG_BASE = 'https://raw.githubusercontent.com/xmrtdao/muapi-workflows/main/assets/pfp';
const S2 = 'https://buy.stripe.com/cNicN5gP9g6haH0bKCbZe0d';
const S3 = 'https://buy.stripe.com/9B63cv9mH07j3eyeWObZe06';
const S4 = 'https://buy.stripe.com/eVqcN556r4nz16qeWObZe04';


function buildCampaignHtml(body) {
  // body is the plain text template (templateA) — we ignore it and use our fixed HTML
  // This function returns the professional HTML template directly
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">

<!-- Header -->
<tr><td style="background:#ffffff;padding:30px 40px;text-align:center;border-bottom:3px solid #ff6b35;">
<img src="${IMG_BASE}/pfplogo.png" width="200" style="max-width:200px;" alt="Party Favor Photo"/>
</td></tr>

<!-- Hero Image -->
<tr><td style="padding:0;">
<img src="${IMG_BASE}/PFP1.jpg" width="600" style="display:block;width:100%;max-width:600px;height:auto;" alt="Photo booth setup with strobe lighting"/>
</td></tr>

<!-- Body -->
<tr><td style="padding:30px 40px;">
<h1 style="font-size:22px;color:#333;margin:0 0 16px 0;">The difference is obvious.</h1>

<p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 16px 0;">You may have seen photo booths that use an iPad on a stand with a ring light. That is the common setup these days. But that has never been how we do it.</p>

<p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 16px 0;">Since day one, we have built our experience around a <strong>professional DSLR camera with strobe lighting</strong> — the same gear professional photographers use for weddings and editorial shoots.</p>

<!-- Strobe Buzz Feature -->
<table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;background:#fff8f0;border-radius:8px;padding:16px;">
<tr><td valign="top" style="padding:0 12px 0 0;width:40px;font-size:24px;color:#ff6b35;">&#x26a1;</td>
<td><p style="font-size:15px;color:#555;line-height:1.7;margin:0;"><strong>That strobe flash creates buzz.</strong> When the flash pops, people turn their heads. It signals something special is happening. Guests line up. The energy shifts. The dance floor fills. A tablet on a stick does not do that.</p></td></tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
<tr><td width="30" valign="top" style="color:#ff6b35;padding:0 8px 10px 0;font-weight:700;">+</td>
<td style="font-size:14px;color:#555;padding:0 0 10px 0;"><strong>Strobe flash</strong> — freezes motion, works in any lighting, creates that clean professional look. And yes, it draws a crowd.</td></tr>
<tr><td width="30" valign="top" style="color:#ff6b35;padding:0 8px 10px 0;font-weight:700;">+</td>
<td style="font-size:14px;color:#555;padding:0 0 10px 0;"><strong>DSLR quality</strong> — large sensor, sharp detail, prints that actually look good at 4x6 and larger</td></tr>
<tr><td width="30" valign="top" style="color:#ff6b35;padding:0 8px 10px 0;font-weight:700;">+</td>
<td style="font-size:14px;color:#555;padding:0 0 10px 0;"><strong>Bounce-diffused lighting</strong> — soft, flattering light on faces. No harsh shadows, no red-eye, no washed-out look</td></tr>
<tr><td width="30" valign="top" style="color:#ff6b35;padding:0 8px 10px 0;font-weight:700;">+</td>
<td style="font-size:14px;color:#555;padding:0 0 10px 0;"><strong>Professional attendant</strong> — sets the lighting, adjusts for each group, keeps the energy up all night</td></tr>
</table>

<img src="${IMG_BASE}/PFP2.jpg" width="600" style="display:block;width:100%;max-width:600px;height:auto;border-radius:8px;margin:16px 0;" alt="Guests enjoying the photo booth"/>
<img src="${IMG_BASE}/PFP3.jpg" width="600" style="display:block;width:100%;max-width:600px;height:auto;border-radius:8px;margin:16px 0;" alt="Photo booth fun"/>

<p style="font-size:15px;color:#555;line-height:1.7;margin:16px 0;">The difference is obvious side by side. A tablet with a ring light works fine for selfies. Our setup produces photos people actually want to print and keep — and a room that actually feels like an event.</p>

<!-- Pricing -->
<div style="background:#f9f9f9;border-radius:12px;padding:24px;margin:24px 0;text-align:center;">
<h2 style="font-size:18px;color:#333;margin:0 0 16px 0;">Packages</h2>

<p style="font-size:20px;font-weight:700;color:#333;margin:20px 0 4px 0;">2 hours &mdash; <span style="color:#ff6b35;">$498</span></p>
<a href="${S2}" style="display:inline-block;background:#ff6b35;color:#000;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;margin:4px 0 16px 0;">Book Now &rarr;</a>

<p style="font-size:20px;font-weight:700;color:#333;margin:20px 0 4px 0;">3 hours &mdash; <span style="color:#ff6b35;">$747</span></p>
<a href="${S3}" style="display:inline-block;background:#ff6b35;color:#000;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;margin:4px 0 16px 0;">Book Now &rarr;</a>

<p style="font-size:20px;font-weight:700;color:#333;margin:20px 0 4px 0;">4 hours &mdash; <span style="color:#ff6b35;">$996</span></p>
<a href="${S4}" style="display:inline-block;background:#ff6b35;color:#000;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;margin:4px 0 16px 0;">Book Now &rarr;</a>

<p style="font-size:14px;color:#666;margin:16px 0 0 0;">Military and non-profit rate &mdash; $398. Just reply.</p>
<p style="font-size:13px;color:#999;margin:8px 0 0 0;">No commitment until deposit. Questions? Reply or call.</p>
</div>

</td></tr>

<!-- Footer -->
<tr><td style="background:#333;padding:30px 40px;text-align:center;">
<p style="color:#ff6b35;font-size:16px;font-weight:700;margin:0 0 4px 0;">Joe Lee</p>
<p style="color:#aaa;font-size:13px;margin:0 0 2px 0;">Party Favor Photo</p>
<p style="color:#aaa;font-size:13px;margin:0 0 2px 0;">(202) 798-0610</p>
<a href="https://partyfavorphoto.com" style="color:#ff6b35;font-size:13px;">partyfavorphoto.com</a>
</td></tr>

</table>
</td></tr></table>
</body>
</html>`;
}

export { buildCampaignHtml };
