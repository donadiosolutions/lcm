# Security Policy

Donadio Solutions takes security reports seriously. If you believe you have found a vulnerability in any repository,
service, package, infrastructure component, or other asset maintained by the Donadio Solutions organization
(`@donadiosolutions`), please report it privately.

Please **do not open a public GitHub issue** for security vulnerabilities. Use one of the private reporting channels
below instead.

## Reporting a Vulnerability

You may report security vulnerabilities using either of the following methods.

### Option 1: GitHub Private Vulnerability Reporting

For repositories that support GitHub private vulnerability reporting, please use GitHub’s private security report
feature:

1. Open the affected repository on GitHub.
2. Go to the **Security** tab.
3. Select **Report a vulnerability**.
4. Submit the report privately.

This is the preferred method when available, since it keeps the report attached to the affected repository and allows
coordinated handling through GitHub.

### Option 2: Encrypted Email

You may also send a GPG-encrypted report to:

`security@donadio.solutions`

Please encrypt the message to the following encryption subkey fingerprint:

`2F7D 25B7 EE28 BC68 3FB8 D106 17EE A4FE 9979 6826`

For convenience, the subkey ID is:

`rsa4096/0x17EEA4FE99796826` <!-- gitleaks:allow -->

This subkey belongs to the master key with fingerprint:

`D6F5 6A78 FF53 9A35 C425 35EA A016 0768 C300 5604`

The public key can be obtained and/or verified from:

- `https://bcdonadio.com/pgp`
- `https://keybase.io/bcdonadio`

Before sending sensitive details, please verify the key fingerprint.

## What to Include

To help us validate and address the issue efficiently, please include as much of the following information as possible:

- A clear description of the vulnerability.
- The affected repository, package, service, URL, branch, commit, version, or configuration.
- Steps to reproduce the issue.
- Proof-of-concept code, logs, screenshots, or request/response examples, when useful.
- The potential impact.
- Any known mitigations or workarounds.
- Whether the vulnerability is already public or has been shared with anyone else.

Please avoid including unnecessary personal data, secrets, credentials, production customer data, or destructive
payloads.

## Scope

This policy applies to software, infrastructure, documentation, packages, automation, and other assets maintained under
the Donadio Solutions GitHub organization:

`https://github.com/donadiosolutions`

If you are unsure whether something is in scope, report it privately anyway and make the uncertainty clear.

## Handling Process

After receiving a report, we will make a reasonable effort to:

1. Acknowledge receipt of the report.
2. Validate the vulnerability.
3. Assess severity and affected components.
4. Develop and test a fix or mitigation.
5. Coordinate disclosure when appropriate.
6. Credit the reporter if desired and appropriate.

Response times may vary depending on severity, complexity, and maintainer availability, but reports involving active
exploitation, credential exposure, remote code execution, authentication bypass, or data exposure will be prioritized.

## Coordinated Disclosure

Please allow reasonable time for investigation and remediation before publicly disclosing the issue.

We ask that you do not publicly disclose the vulnerability, exploit details, or proof-of-concept code until we have had
an opportunity to investigate and address the issue, unless there is an immediate public safety concern or active
exploitation requiring broader notification.

## Safe Harbor

We will not pursue legal action against researchers who make a good-faith effort to comply with this policy and who
avoid:

- Accessing, modifying, or deleting data that does not belong to them.
- Exfiltrating sensitive information beyond what is necessary to demonstrate impact.
- Disrupting production systems or services.
- Performing denial-of-service attacks.
- Using social engineering, phishing, spam, or physical attacks.
- Publicly disclosing the vulnerability before coordination.

Good-faith security research helps improve the ecosystem. Please keep it focused, proportionate, and private.

## Public Issues

Security vulnerabilities should not be reported through public GitHub issues, discussions, pull requests, or comments.

For non-security bugs, feature requests, documentation fixes, and general questions, use the normal public issue tracker
for the affected repository.
