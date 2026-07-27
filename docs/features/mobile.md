---
label: Mobile App
icon: device-mobile
order: 750
description: Installable field-technician app served at /m — passwords, articles, assets, search, and Ask anything, tuned for phones.
---

# Mobile App

Weavestream ships a dedicated mobile app for field technicians, served from your existing instance at **`/m`**. It is a purpose-built interface — not a shrunken desktop — that answers one question: *what does a technician need while standing in a client's server closet?*

No extra deployment, no separate server, no app store: the mobile app is part of the normal Weavestream container and uses the same accounts, sessions, and permissions as the desktop app. Everything a technician does on mobile is authorized server-side exactly like a desktop request and lands in the same audit trail.

## Opening the mobile app

Open your profile menu in the desktop header and choose **Mobile app**, or browse directly to `https://your-instance/m` on a phone. Sign-in (including MFA) works exactly as on desktop.

## Installing it on a phone

The app is an installable PWA, so it gets a home-screen icon, a standalone full-screen window, and instant startup:

- **Android (Chrome):** open **More → Install app** inside the mobile app, or accept the browser's install prompt.
- **iOS (Safari):** tap Safari's **Share** button, then **Add to Home Screen**. The **More** tab shows these steps when opened in Safari.

The row disappears once the app is installed.

## What's included

| Area | On mobile |
|---|---|
| **Passwords** | Full create/edit/archive, reveal with the same step-up re-authentication and reveal auditing as desktop, one-time codes with countdown, copy with automatic clipboard clearing. |
| **Documentation** | Read-only article viewer for both rich-text and Markdown articles. Editing stays on desktop. |
| **Assets** | Full create/edit/archive across custom layouts, including file fields with direct **camera capture** for photographing serial plates and racks. Rich-text fields are view-only on mobile. |
| **Search** | Instance search across passwords, assets, and articles — always scoped to the currently selected organization. |
| **Ask anything** | The AI assistant, when AI is configured, in a full-screen chat. Change proposals are review-on-desktop. |

Admin, settings, integrations, IPAM, domains, exports, and reporting deliberately stay desktop-only.

## Appearance

The mobile app follows the account's appearance preferences — dark, light, or system theme plus the accent color — and picks them up automatically when they change on desktop. **More → Appearance** changes them from the phone; the choice syncs back to the account.

## Offline behaviour

The app itself opens offline once installed, but **data is never stored on the device**: passwords, articles, and assets require a connection, and screens show an honest "no connection" state instead of stale records. Revealed secrets live only in memory and clear when the app goes to the background. This is a deliberate security posture for a tool that handles credentials on portable hardware.

## Notes for administrators

- The mobile app is served same-origin from the web container — there is nothing separate to enable, expose, or license.
- Sessions, MFA enforcement, IP rules, role scoping, and audit behave identically to desktop; the mobile client introduces no new authorization surface.
- Client-portal users can sign in too; they see the same read-only scope the portal grants them, and the Ask anything tab is hidden for them.
