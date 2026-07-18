# Security Policy

## Supported version

Security fixes are applied to the latest published release. The current development line is `0.2.x`.

## Reporting a vulnerability

Do not open a public issue containing an exploit, private structure, server address, credential, license information, or filesystem layout. Use the repository owner's private security-reporting channel. Include the affected version, minimal reproduction, impact, and suggested mitigation when available.

## Deployment guidance

Keep raw MaterialsScript and external paths disabled, keep the Dashboard on loopback, use a dedicated workspace, and never commit generated local configuration. Review [LOCAL-HARDENING.md](LOCAL-HARDENING.md) before enabling additional capabilities.
