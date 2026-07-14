# Domains, expirations, and IP address management

## Monitor a domain or hostname
<!-- aliases: new domain | add domain | ssl monitoring | certificate expiry | whois monitoring | DNS check | website monitoring -->
<!-- requires: domain.manage -->

Open a company’s **Domains** section and select **New domain**. Enter a hostname such as `example.com` or `api.example.com`, choose enabled checks, set expiry thresholds where relevant, and save. The worker performs the first check in the background.

Available checks are:

- **WHOIS expiry**: registration renewal deadline. Disable it for a subdomain or TLD where public WHOIS does not supply a usable expiry.
- **DNS validity**: whether the hostname resolves.
- **TLS/SSL expiry**: certificate expiry and chain validity. Internal hosts with untrusted/self-signed certificates normally fail chain validation.
- **HTTP availability**, where enabled: supplies website-down alert state.

Check statuses are **OK**, **WARN**, **FAIL**, or **SKIP**. WARN means an expiry is inside its configured days-before-expiry threshold; FAIL means expired, invalid, or unreachable; SKIP means disabled or not applicable. Open a domain to inspect its append-only check history and set **Visible to clients** when the portal should show it.

## Use the expirations dashboard and expiration alerts
<!-- aliases: expirations | renewal dashboard | upcoming expiry | warranty expiring | expired password | certificate alerts -->
<!-- requires: asset.read | password.read | domain.read -->

Open **Admin → Expirations** for cross-company visibility, or a company’s **Expirations** page for that company. It consolidates:

- Date/Date-time asset fields configured with **Expiry tracking**
- Password expiry dates
- Domain WHOIS and TLS expiry dates

Use it to find certificates, warranties, licenses, contracts, registrations, and credentials that need rotation or renewal. Asset expiry fields use the layout-level warning configuration; domain checks use their individual thresholds.

For email notifications, configure an expiration alert in **Admin → Alerts**. A **Single expiration** alert sends for individual matching items, while an **Expiration list** alert sends a daily digest. Select the relevant source kinds and optional company scope. Alerts deduplicate repeated scans; they are notifications, not a replacement for confirming the record’s current state.

## Create and manage an IPAM subnet
<!-- aliases: IPAM | new subnet | IP address management | network subnet | CIDR | VLAN | gateway | address space -->
<!-- requires: asset.write | asset.read -->

Open a company’s **IPAM** section and select **New subnet**. Enter a descriptive name, a normalized IPv4 CIDR, and optionally VLAN, gateway, and notes. Save it. A company cannot have duplicate subnet CIDRs. Use the subnet action menu to edit, archive, restore, or include archived subnets in the browser.

Open a subnet to view utilization and address space. Weavestream automatically detects occupants from asset fields of type **IP address** whose IPv4 values fall inside that subnet. The address-space view distinguishes free, asset-occupied, reserved, conflicting, and network/broadcast addresses. Large subnets use a compact assigned-address list instead of rendering every address.

Use separate subnet records for separate company networks. An IP address field can accept IPv4 only, IPv6 only, or both, but current subnet management is IPv4-focused.

## Reserve an IP address and resolve IPAM conflicts
<!-- aliases: reserve IP | IP reservation | static IP | duplicate IP | IP address conflict | subnet occupant -->
<!-- requires: asset.write | asset.read -->

On a subnet detail page, add a reservation for infrastructure that is not yet represented by an asset. A reservation must be a valid IPv4 address inside that subnet and must not duplicate another reservation in that subnet. Give it a useful name or context so the reservation can later be replaced by an asset record.

When two asset IP fields point at the same address, IPAM marks the address as a **Conflict**. Open the affected assets, verify which device owns the address, then correct the asset values or network configuration. A reservation and an asset occupant provide useful overlap context but do not grant a reservation authority over the asset. IPAM records are company-scoped and client portal IPAM is read-only.
